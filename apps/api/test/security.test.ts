import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../src/plugins/security.js";

function createMemoryStore(): SessionStorePort {
  const store = new Map<string, StoredSessionRecord>();
  return {
    async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
      const record: StoredSessionRecord = {
        ...input,
        revokedAt: null,
        createdAt: new Date(),
      };
      store.set(record.id, record);
      return record;
    },
    async findByTokenHash(tokenHash: string) {
      for (const item of store.values()) {
        if (item.tokenHash === tokenHash) {
          return item;
        }
      }
      return null;
    },
    async revokeById(id: string, revokedAt: Date) {
      const item = store.get(id);
      if (item) {
        store.set(id, { ...item, revokedAt });
      }
    },
    async revokeAllForUser() {
      // Não utilizado neste teste.
    },
  };
}

describe("Security plugin (CORS, CSRF, headers, and login rate limit)", () => {
  it("sets strict security headers and enforces CORS allowlist", async () => {
    const app = buildApp({
      logger: false,
      secureCookies: true,
      security: { allowedOrigins: ["https://ged.empresa.local"] },
    });

    const allowedRes = await app.inject({
      method: "GET",
      url: "/api/v1/health/live",
      headers: { origin: "https://ged.empresa.local" },
    });
    expect(allowedRes.statusCode).toBe(200);
    expect(allowedRes.headers["access-control-allow-origin"]).toBe("https://ged.empresa.local");
    expect(allowedRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(allowedRes.headers["x-frame-options"]).toBe("DENY");
    expect(allowedRes.headers["strict-transport-security"]).toContain("max-age=");

    const blockedRes = await app.inject({
      method: "GET",
      url: "/api/v1/health/live",
      headers: { origin: "https://attacker.invalid" },
    });
    expect(blockedRes.statusCode).toBe(403);
    expect(blockedRes.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("blocks mutating requests without matching CSRF cookie and header", async () => {
    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService: createAuthService({
        users: {
          async findCredentialByEmail() {
            return null;
          },
          async findProfileById() {
            return null;
          },
        },
        passwordService: createPasswordService({ memoryCost: 8_192, timeCost: 2, parallelism: 1 }),
        sessionService: createSessionService({ store: createMemoryStore() }),
      }),
    });

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@docuflow.invalid", password: "Password123!" },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().error.code).toBe("FORBIDDEN");

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.json().data.csrfToken as string;

    const withCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { email: "user@docuflow.invalid", password: "Password123!" },
    });
    expect(withCsrf.statusCode).toBe(401);

    await app.close();
  });

  it("rate limits excessive login attempts and recovers after window", async () => {
    let nowMs = 1_700_000_000_000;
    const app = buildApp({
      logger: false,
      secureCookies: false,
      security: {
        loginRateLimit: { maxAttempts: 2, windowMs: 30_000 },
        now: () => nowMs,
      },
      authService: createAuthService({
        users: {
          async findCredentialByEmail() {
            return null;
          },
          async findProfileById() {
            return null;
          },
        },
        passwordService: createPasswordService({ memoryCost: 8_192, timeCost: 2, parallelism: 1 }),
        sessionService: createSessionService({ store: createMemoryStore() }),
      }),
    });

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.json().data.csrfToken as string;

    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        payload: { email: "user@docuflow.invalid", password: "Password123!" },
      });

    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);

    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBeDefined();

    // Advance clock past windowMs
    nowMs += 31_000;
    expect((await attempt()).statusCode).toBe(401);

    await app.close();
  });
});
