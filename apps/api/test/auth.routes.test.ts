import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import { authMeResponseSchema, createApiResponseSchema } from "@docuflow/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  type AuthCredentialRecord,
  type AuthUserLookupPort,
  createAuthService,
} from "../src/modules/auth/auth.service.js";

function createTestMemorySessionStore(): SessionStorePort {
  const map = new Map<string, StoredSessionRecord>();
  return {
    async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
      const record: StoredSessionRecord = {
        ...input,
        revokedAt: null,
        createdAt: new Date(),
      };
      map.set(record.id, record);
      return record;
    },
    async findByTokenHash(tokenHash: string): Promise<StoredSessionRecord | null> {
      for (const item of map.values()) {
        if (item.tokenHash === tokenHash) {
          return item;
        }
      }
      return null;
    },
    async revokeById(sessionId: string, revokedAt: Date): Promise<void> {
      const item = map.get(sessionId);
      if (item) {
        map.set(sessionId, { ...item, revokedAt });
      }
    },
    async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
      for (const [id, item] of map.entries()) {
        if (item.userId === userId && item.revokedAt === null) {
          map.set(id, { ...item, revokedAt });
        }
      }
    },
  };
}

describe("Auth routes (/api/v1/auth/*)", () => {
  it("logs in with HttpOnly cookie, serves /auth/me without secrets, and revokes on logout", async () => {
    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 8,
    });
    const passwordHash = await passwordService.hashPassword("SenhaSegura123!");
    const orgId = "550e8400-e29b-41d4-a716-446655440000";
    const userId = "550e8400-e29b-41d4-a716-446655440001";

    const credential: AuthCredentialRecord = {
      user: {
        id: userId,
        organizationId: orgId,
        email: "admin@docuflow.invalid",
        fullName: "Administrador DocuFlow",
        status: "ACTIVE",
        createdAt: "2026-11-20T10:00:00.000Z",
        updatedAt: "2026-11-20T10:00:00.000Z",
      },
      passwordHash,
    };

    const users: AuthUserLookupPort = {
      async findCredentialByEmail(email) {
        return email === credential.user.email ? credential : null;
      },
      async findProfileById(id) {
        return id === userId
          ? { user: credential.user, groups: [], roles: [], permissions: [] }
          : null;
      },
    };

    const sessionService = createSessionService({
      store: createTestMemorySessionStore(),
      secretPepper: "test-session-pepper-at-least-32-chars",
    });
    const authService = createAuthService({ users, passwordService, sessionService });
    const app = buildApp({ logger: false, authService, secureCookies: false });

    // Obtain CSRF token for mutating requests
    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    expect(csrfRes.statusCode).toBe(200);
    const csrfToken = csrfRes.json().data.csrfToken as string;

    // 1. Unauthenticated /auth/me returns 401
    const unauthMe = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(unauthMe.statusCode).toBe(401);

    // 2. Invalid credentials return 401
    const badLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { docuflow_csrf: csrfToken },
      headers: { "x-csrf-token": csrfToken },
      payload: { email: "admin@docuflow.invalid", password: "wrong" },
    });
    expect(badLogin.statusCode).toBe(401);

    // 3. Valid login sets HttpOnly cookie and returns sanitized AuthMeResponse
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { docuflow_csrf: csrfToken },
      headers: { "x-csrf-token": csrfToken },
      payload: { email: "Admin@Docuflow.Invalid", password: "SenhaSegura123!" },
    });
    expect(loginRes.statusCode).toBe(200);
    const bodyText = loginRes.body;
    expect(bodyText).not.toContain("passwordHash");
    expect(bodyText).not.toContain("$argon2id$");
    expect(createApiResponseSchema(authMeResponseSchema).safeParse(loginRes.json()).success).toBe(
      true,
    );

    const setCookieHeader = loginRes.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    expect(cookieStr).toContain("docuflow_session=");
    expect(cookieStr).toContain("HttpOnly");
    expect(cookieStr).toContain("SameSite=Lax");

    const sessionCookie = loginRes.cookies.find((c) => c.name === "docuflow_session");
    expect(sessionCookie).toBeDefined();

    // 4. Authenticated /auth/me succeeds
    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { docuflow_session: sessionCookie?.value ?? "" },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().data.user.email).toBe("admin@docuflow.invalid");

    // 5. Logout revokes session so /auth/me returns 401 afterwards
    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: {
        docuflow_session: sessionCookie?.value ?? "",
        docuflow_csrf: csrfToken,
      },
      headers: { "x-csrf-token": csrfToken },
    });
    expect(logoutRes.statusCode).toBe(200);

    const postLogoutMe = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { docuflow_session: sessionCookie?.value ?? "" },
    });
    expect(postLogoutMe.statusCode).toBe(401);

    await app.close();
  });
});
