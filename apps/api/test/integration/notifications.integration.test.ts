import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import {
  CONTRACTS_API_PREFIX,
  notificationDetailResponseSchema,
  notificationListResponseSchema,
} from "@docuflow/contracts";
import {
  createInAppNotificationRepository,
  notifications,
  organizations,
  sessions,
  users,
} from "@docuflow/database";
import { createInAppNotificationService } from "@docuflow/notifications";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE_NAME } from "../../src/modules/auth/auth.routes.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Internal notifications HTTP API & idempotency integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;

  beforeAll(async () => {
    const externalUrl = process.env.DATABASE_URL;
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = container.getConnectionUri();
    }

    pool = new Pool({ connectionString });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container?.stop();
  });

  it("creates idempotent notifications, isolates listing by user/org, and enforces individual read with CSRF", async () => {
    const db = drizzle(pool);
    let currentTime = new Date("2026-11-21T15:00:00.000Z");

    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const aliceId = randomUUID();
    const bobId = randomUUID();
    const docId = randomUUID();
    const taskId = randomUUID();
    const decisionId = randomUUID();

    await db.insert(organizations).values([
      { id: orgId, name: "Org Notif A", slug: `notif-a-${orgId.slice(0, 8)}` },
      { id: otherOrgId, name: "Org Notif B", slug: `notif-b-${otherOrgId.slice(0, 8)}` },
    ]);

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });
    const passwordHash = await passwordService.hashPassword("SenhaNotif123!");

    await db.insert(users).values([
      {
        id: aliceId,
        organizationId: orgId,
        email: "alice-notif@docuflow.local",
        fullName: "Alice Revisora",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: bobId,
        organizationId: orgId,
        email: "bob-notif@docuflow.local",
        fullName: "Bob Gestor",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    const notificationService = createInAppNotificationService({
      repository: createInAppNotificationRepository(db),
      now: () => currentTime,
    });

    // Dispatch all three notification types + duplicates to verify SQL idempotency
    const assign1 = await notificationService.notifyTaskAssigned({
      organizationId: orgId,
      recipientUserIds: [aliceId],
      taskId,
      documentId: docId,
      documentTitle: "Contrato Sigma",
      workflowName: "Fluxo Contratos",
      stepOrder: 1,
      stepName: "Jurídico",
      dueAt: new Date("2026-11-25T18:00:00.000Z"),
    });
    const assignRetry = await notificationService.notifyTaskAssigned({
      organizationId: orgId,
      recipientUserIds: [aliceId],
      taskId,
      documentId: docId,
      documentTitle: "Contrato Sigma",
      workflowName: "Fluxo Contratos",
      stepOrder: 1,
      stepName: "Jurídico",
    });
    expect(assign1.createdCount).toBe(1);
    expect(assignRetry.createdCount).toBe(0);
    expect(assignRetry.deduplicatedCount).toBe(1);

    await notificationService.notifyTaskDecision({
      organizationId: orgId,
      recipientUserIds: [bobId],
      decisionId,
      taskId,
      documentId: docId,
      documentTitle: "Contrato Sigma",
      decision: "APPROVE",
      actorDisplayName: "Alice Revisora",
      stepName: "Jurídico",
    });

    await notificationService.notifyDocumentExpiration({
      organizationId: orgId,
      recipientUserIds: [aliceId, bobId],
      documentId: docId,
      documentTitle: "Contrato Sigma",
      expirationDate: "2026-11-30",
      alertWindowKey: "15-days",
      isExpired: false,
    });

    // Retry expiration alert -> zero duplicates inserted in DB
    const expRetry = await notificationService.notifyDocumentExpiration({
      organizationId: orgId,
      recipientUserIds: [aliceId, bobId],
      documentId: docId,
      documentTitle: "Contrato Sigma",
      expirationDate: "2026-11-30",
      alertWindowKey: "15-days",
      isExpired: false,
    });
    expect(expRetry.createdCount).toBe(0);
    expect(expRetry.deduplicatedCount).toBe(2);

    const dbRowsForOrg = await db
      .select()
      .from(notifications)
      .where(eq(notifications.organizationId, orgId));
    expect(dbRowsForOrg).toHaveLength(4);

    // Wire API app with sessions for Alice and Bob
    const sessionStore: SessionStorePort = {
      async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
        await db.insert(sessions).values({
          id: input.id,
          organizationId: input.organizationId,
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          revokedAt: null,
        });
        return { ...input, revokedAt: null, createdAt: currentTime };
      },
      async findByTokenHash(tokenHash: string): Promise<StoredSessionRecord | null> {
        const [row] = await db
          .select()
          .from(sessions)
          .where(eq(sessions.tokenHash, tokenHash))
          .limit(1);
        return row ?? null;
      },
      async revokeById(id: string, revokedAt: Date): Promise<void> {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.id, id));
      },
      async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, userId));
      },
    };

    const sessionService = createSessionService({
      store: sessionStore,
      now: () => currentTime,
    });

    const authService = createAuthService({
      passwordService,
      sessionService,
      users: {
        async findCredentialByEmail(email) {
          const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
          if (!row) return null;
          return {
            user: {
              id: row.id,
              organizationId: row.organizationId,
              email: row.email,
              fullName: row.fullName,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            },
            passwordHash: row.passwordHash,
          };
        },
        async findProfileById(id) {
          const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
          if (!row) return null;
          return {
            user: {
              id: row.id,
              organizationId: row.organizationId,
              email: row.email,
              fullName: row.fullName,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            },
            groups: [],
            roles: [],
            permissions: [],
          };
        },
      },
    });

    const app = buildApp({
      authService,
      notificationService,
      secureCookies: false,
    });
    await app.ready();

    try {
      const loginUser = async (email: string) => {
        const csrfRes = await app.inject({
          method: "GET",
          url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
        });
        const initialCsrf = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;
        const loginRes = await app.inject({
          method: "POST",
          url: `${CONTRACTS_API_PREFIX}/auth/login`,
          cookies: { [CSRF_COOKIE_NAME]: initialCsrf },
          headers: { origin: "http://localhost:5173", [CSRF_HEADER_NAME]: initialCsrf },
          payload: { email, password: "SenhaNotif123!" },
        });
        expect(loginRes.statusCode).toBe(200);
        const sessionCookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
        const csrfCookie = loginRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME);
        return {
          sessionCookie: sessionCookie?.value ?? "",
          csrfCookie: csrfCookie?.value ?? initialCsrf,
        };
      };

      const aliceAuth = await loginUser("alice-notif@docuflow.local");
      const bobAuth = await loginUser("bob-notif@docuflow.local");

      // Unauthenticated request rejected
      const unauthRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/notifications`,
      });
      expect(unauthRes.statusCode).toBe(401);

      // Alice sees her 2 notifications (task assigned + expiration)
      const aliceListRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/notifications`,
        cookies: { [SESSION_COOKIE_NAME]: aliceAuth.sessionCookie },
      });
      expect(aliceListRes.statusCode).toBe(200);
      const aliceParsed = notificationListResponseSchema.parse(aliceListRes.json());
      expect(aliceParsed.data.unreadCount).toBe(2);
      expect(aliceParsed.data.items).toHaveLength(2);

      // Filter by kind
      const aliceTaskOnlyRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/notifications?kind=TASK_ASSIGNED`,
        cookies: { [SESSION_COOKIE_NAME]: aliceAuth.sessionCookie },
      });
      expect(aliceTaskOnlyRes.statusCode).toBe(200);
      const aliceTaskParsed = notificationListResponseSchema.parse(aliceTaskOnlyRes.json());
      expect(aliceTaskParsed.data.items).toHaveLength(1);
      expect(aliceTaskParsed.data.items[0]?.kind).toBe("TASK_ASSIGNED");

      const aliceNotifId = aliceParsed.data.items[0]?.id ?? "";

      // Bob cannot mark Alice's notification read (horizontal IDOR -> 403)
      const bobForbiddenRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/notifications/${aliceNotifId}/read`,
        cookies: {
          [SESSION_COOKIE_NAME]: bobAuth.sessionCookie,
          [CSRF_COOKIE_NAME]: bobAuth.csrfCookie,
        },
        headers: {
          origin: "http://localhost:5173",
          [CSRF_HEADER_NAME]: bobAuth.csrfCookie,
        },
      });
      expect(bobForbiddenRes.statusCode).toBe(403);

      // Alice marks ONE notification as read
      const firstReadRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/notifications/${aliceNotifId}/read`,
        cookies: {
          [SESSION_COOKIE_NAME]: aliceAuth.sessionCookie,
          [CSRF_COOKIE_NAME]: aliceAuth.csrfCookie,
        },
        headers: {
          origin: "http://localhost:5173",
          [CSRF_HEADER_NAME]: aliceAuth.csrfCookie,
        },
      });
      expect(firstReadRes.statusCode).toBe(200);
      const readParsed1 = notificationDetailResponseSchema.parse(firstReadRes.json());
      expect(readParsed1.data.readAt).toBe("2026-11-21T15:00:00.000Z");

      // Repeated read is idempotent and keeps original readAt
      currentTime = new Date("2026-11-21T15:05:00.000Z");
      const secondReadRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/notifications/${aliceNotifId}/read`,
        cookies: {
          [SESSION_COOKIE_NAME]: aliceAuth.sessionCookie,
          [CSRF_COOKIE_NAME]: aliceAuth.csrfCookie,
        },
        headers: {
          origin: "http://localhost:5173",
          [CSRF_HEADER_NAME]: aliceAuth.csrfCookie,
        },
      });
      expect(secondReadRes.statusCode).toBe(200);
      const readParsed2 = notificationDetailResponseSchema.parse(secondReadRes.json());
      expect(readParsed2.data.readAt).toBe("2026-11-21T15:00:00.000Z");

      // Unread count decreased from 2 to 1; unreadOnly=true returns only 1 item
      const aliceUnreadRes = await app.inject({
        method: "GET",
        url: `${CONTRACTS_API_PREFIX}/notifications?unreadOnly=true`,
        cookies: { [SESSION_COOKIE_NAME]: aliceAuth.sessionCookie },
      });
      expect(aliceUnreadRes.statusCode).toBe(200);
      const aliceUnreadParsed = notificationListResponseSchema.parse(aliceUnreadRes.json());
      expect(aliceUnreadParsed.data.unreadCount).toBe(1);
      expect(aliceUnreadParsed.data.items).toHaveLength(1);
      expect(aliceUnreadParsed.data.items[0]?.id).not.toBe(aliceNotifId);
    } finally {
      await app.close();
    }
  });
});
