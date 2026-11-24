import { randomUUID } from "node:crypto";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@papyrus/auth";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { type AuthCredentialRecord, createAuthService } from "../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../src/plugins/security.js";

describe("Health & Readiness endpoints (Step 14.07)", () => {
  it("separates liveness (200) from fail-closed readiness (503) when database check is unconfigured", async () => {
    const app = buildApp({ logger: false });

    const liveRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/health/live`,
    });
    expect(liveRes.statusCode).toBe(200);
    expect(liveRes.json()).toEqual({ status: "ok" });

    const readyRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/health/ready`,
    });
    expect(readyRes.statusCode).toBe(503);
    expect(readyRes.json()).toMatchObject({
      status: "not_ready",
      checks: { database: "unavailable" },
    });

    await app.close();
  });

  it("returns 200 ready when database and critical dependencies pass, and 503 not_ready without leaking internal details when dependencies fail", async () => {
    let dbHealthy = true;
    let storageHealthy = true;

    const app = buildApp({
      logger: false,
      healthDeps: {
        checkDatabase: async () => {
          if (!dbHealthy) {
            throw new Error(
              "connect ECONNREFUSED postgresql://papyrus:SuperSecretDbPass@10.20.30.40:5432/prod_db",
            );
          }
          return { healthy: true, message: "PostgreSQL ativo" };
        },
        checkWorker: async () => ({ healthy: true, message: "Worker respondendo" }),
        criticalDependencies: [
          {
            name: "storageDefault",
            critical: true,
            check: async () => ({
              healthy: storageHealthy,
              message: storageHealthy
                ? "OK"
                : "Falha ao acessar s3://bucket-secreto em https://10.0.0.9:9000",
            }),
          },
        ],
        now: () => new Date("2026-11-21T20:00:00.000Z"),
      },
    });

    const readyOk = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/health/ready`,
    });
    expect(readyOk.statusCode).toBe(200);
    expect(readyOk.json()).toEqual({
      status: "ready",
      checkedAt: "2026-11-21T20:00:00.000Z",
      checks: {
        database: "ok",
        worker: "ok",
        storageDefault: "ok",
      },
    });

    // Degrade database & storage: liveness must STAY 200, readiness MUST return 503 with zero leaks
    dbHealthy = false;
    storageHealthy = false;

    const liveStillOk = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/health/live`,
    });
    expect(liveStillOk.statusCode).toBe(200);

    const readyFail = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/health/ready`,
    });
    expect(readyFail.statusCode).toBe(503);
    expect(readyFail.json()).toEqual({
      status: "not_ready",
      checkedAt: "2026-11-21T20:00:00.000Z",
      checks: {
        database: "degraded",
        worker: "ok",
        storageDefault: "degraded",
      },
    });

    const rawText = readyFail.body;
    expect(rawText).not.toContain("SuperSecretDbPass");
    expect(rawText).not.toContain("10.20.30.40");
    expect(rawText).not.toContain("postgresql://");
    expect(rawText).not.toContain("ECONNREFUSED");
    expect(rawText).not.toContain("bucket-secreto");
    expect(rawText).not.toContain("10.0.0.9");

    await app.close();
  });

  it("restricts /admin/system-status to authorized administrators and redacts sensitive URIs", async () => {
    const now = new Date("2026-11-21T20:05:00.000Z");
    const orgId = randomUUID();
    const adminId = randomUUID();
    const viewerId = randomUUID();
    const sessionsMap = new Map<string, StoredSessionRecord>();
    const users = new Map<string, AuthCredentialRecord>();

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const hash = await passwordService.hashPassword("SenhaOperacional!2026");

    users.set("admin@papyrus.local", {
      user: {
        id: adminId,
        organizationId: orgId,
        email: "admin@papyrus.local",
        fullName: "Admin",
        status: "ACTIVE",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      passwordHash: hash,
    });
    users.set("viewer@papyrus.local", {
      user: {
        id: viewerId,
        organizationId: orgId,
        email: "viewer@papyrus.local",
        fullName: "Leitor",
        status: "ACTIVE",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      passwordHash: hash,
    });

    const sessionService = createSessionService({
      store: {
        async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
          const rec: StoredSessionRecord = { ...input, revokedAt: null, createdAt: now };
          sessionsMap.set(rec.id, rec);
          return rec;
        },
        async findByTokenHash(tokenHash: string) {
          for (const s of sessionsMap.values()) {
            if (s.tokenHash === tokenHash) {
              return s;
            }
          }
          return null;
        },
        async revokeById() {},
        async revokeAllForUser() {},
      } satisfies SessionStorePort,
      now: () => now,
    });

    const authService = createAuthService({
      passwordService,
      sessionService,
      users: {
        async findCredentialByEmail(email) {
          return users.get(email) ?? null;
        },
        async findProfileById(id) {
          const cred = Array.from(users.values()).find((u) => u.user.id === id);
          if (!cred) {
            return null;
          }
          const isAdmin = id === adminId;
          return {
            user: cred.user,
            groups: [],
            roles: [
              {
                id: randomUUID(),
                key: isAdmin ? "admin" : "viewer",
                name: isAdmin ? "Administrador" : "Consulta",
                description: null,
                isSystem: true,
              },
            ],
            permissions: [],
          };
        },
      },
      now: () => now,
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      authService,
      security: {
        allowedOrigins: ["http://localhost:5173"],
        enforceCsrf: true,
      },
      healthDeps: {
        checkDatabase: async () => ({
          healthy: false,
          message: "Erro ao conectar em postgresql://dbuser:topsecret@db.internal:5432/papyrus",
        }),
        checkWorker: async () => ({ healthy: true, message: "Em execução contínua" }),
        listStorageConnections: async () => [
          {
            id: randomUUID(),
            name: "Storage Principal",
            kind: "local",
            isDefault: true,
            status: "ACTIVE",
            lastHealthCheckAt: "2026-11-21T20:00:00.000Z",
            lastHealthMessage: "Diretório disponível.",
          },
        ],
        now: () => now,
      },
    });

    const unauth = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/admin/system-status`,
    });
    expect(unauth.statusCode).toBe(401);

    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    const csrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const loginAs = async (email: string) => {
      const res = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: csrfToken },
        headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: csrfToken },
        payload: { email, password: "SenhaOperacional!2026" },
      });
      const sessionCookie = res.cookies.find((c) => c.name === "papyrus_session")?.value ?? "";
      return `${CSRF_COOKIE_NAME}=${csrfToken}; papyrus_session=${sessionCookie}`;
    };

    const viewerCookie = await loginAs("viewer@papyrus.local");
    const forbidden = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/admin/system-status`,
      headers: { cookie: viewerCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const adminCookie = await loginAs("admin@papyrus.local");
    const okRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/admin/system-status`,
      headers: { cookie: adminCookie },
    });
    expect(okRes.statusCode).toBe(200);
    const body = okRes.json().data;
    expect(body.overallStatus).toBe("degraded");
    expect(body.components.database.status).toBe("degraded");
    expect(body.components.database.message).not.toContain("topsecret");
    expect(body.components.worker.status).toBe("ok");
    expect(body.storageConnections).toHaveLength(1);

    await app.close();
  });
});
