import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
  storageConnectionTestResultSchema,
  storageConnectionViewSchema,
} from "@docuflow/contracts";
import {
  createAuditRepository,
  createStorageConnectionRepository,
  createTransactionManager,
  roles,
  sessions,
  storageConnections,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createStorageConnectionAdminService } from "@docuflow/domain";
import { createStorageSecretVault } from "@docuflow/storage-core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { createDrizzleSetupRepository } from "../../src/modules/setup/setup.repository.js";
import { createSetupService } from "../../src/modules/setup/setup.service.js";
import { createStorageHealthTester } from "../../src/modules/storage/storage-health.adapter.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

const MINIO_IMAGE = "cgr.dev/chainguard/minio:latest";
const MINIO_ACCESS_KEY = "AKIAMINIOADMIN2026";
const MINIO_SECRET_KEY = "MinioSuperSecretKeyValue2026!";
const MINIO_BUCKET = "docuflow-api-s3-bucket";

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function createMinioBucket(
  endpoint: string,
  bucket: string,
  accessKey: string,
  secretKey: string,
): Promise<void> {
  const url = new URL(`/${bucket}`, endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "us-east-1";
  const payloadHash = sha256Hex("");
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `PUT\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authorization,
    },
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to create MinIO bucket: HTTP ${res.status}`);
  }
}

describe("S3 storage administrative routes integration", () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let minioContainer: StartedTestContainer | null = null;
  let pool: Pool;
  let minioEndpoint = "";

  beforeAll(async () => {
    const externalUrl = process.env.DATABASE_URL;
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = pgContainer.getConnectionUri();
    }

    const externalMinio = process.env.MINIO_ENDPOINT?.trim();
    if (externalMinio) {
      minioEndpoint = externalMinio;
    } else {
      minioContainer = await new GenericContainer(MINIO_IMAGE)
        .withEnvironment({
          MINIO_ROOT_USER: MINIO_ACCESS_KEY,
          MINIO_ROOT_PASSWORD: MINIO_SECRET_KEY,
        })
        .withCommand(["server", "/data", "--address", ":9000"])
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000).forStatusCode(200))
        .start();
      minioEndpoint = `http://${minioContainer.getHost()}:${minioContainer.getMappedPort(9000)}`;
    }

    await createMinioBucket(minioEndpoint, MINIO_BUCKET, MINIO_ACCESS_KEY, MINIO_SECRET_KEY);

    pool = new Pool({ connectionString });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (minioContainer) {
      await minioContainer.stop();
    }
    if (pgContainer) {
      await pgContainer.stop();
    }
  });

  it("registers, edits, health-checks S3 connections against MinIO while masking all secrets in HTTP responses and DB", async () => {
    const db = drizzle(pool);
    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });

    const sessionStore: SessionStorePort = {
      async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
        const [row] = await db.insert(sessions).values(input).returning();
        if (!row) {
          throw new Error("Session insert failed");
        }
        return row;
      },
      async findByTokenHash(tokenHash: string): Promise<StoredSessionRecord | null> {
        const [row] = await db
          .select()
          .from(sessions)
          .where(eq(sessions.tokenHash, tokenHash))
          .limit(1);
        return row ?? null;
      },
      async revokeById(sessionId: string, revokedAt: Date): Promise<void> {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.id, sessionId));
      },
      async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
        await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, userId));
      },
    };

    const sessionService = createSessionService({ store: sessionStore });
    const setupService = createSetupService({
      repository: createDrizzleSetupRepository(db),
      passwordService,
    });

    const authService = createAuthService({
      passwordService,
      sessionService,
      users: {
        async findCredentialByEmail(normalizedEmail: string) {
          const [row] = await db
            .select()
            .from(users)
            .where(eq(users.email, normalizedEmail))
            .limit(1);
          if (!row) {
            return null;
          }
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
        async findProfileById(userId: string) {
          const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
          if (!row) {
            return null;
          }
          const assignedRoles = await db
            .select({
              id: roles.id,
              key: roles.key,
              name: roles.name,
              description: roles.description,
              isSystem: roles.isSystem,
            })
            .from(userRoleScopes)
            .innerJoin(roles, eq(roles.id, userRoleScopes.roleId))
            .where(and(eq(userRoleScopes.userId, userId), eq(userRoleScopes.effect, "ALLOW")));
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
            roles: assignedRoles,
            permissions: [],
          };
        },
      },
    });

    const masterKey = randomBytes(32);
    const vault = createStorageSecretVault({ masterKey });
    const s3SecurityPolicy = { allowPrivateEndpoints: true };

    const storageAdminService = createStorageConnectionAdminService({
      connections: createStorageConnectionRepository(db),
      transactions: createTransactionManager(db),
      audit: createAuditRepository(db),
      secretEncryptor: {
        encrypt(credentials) {
          return vault.encryptCredentials(credentials);
        },
      },
      healthTester: createStorageHealthTester({
        secretVault: vault,
        s3SecurityPolicy,
        healthVerifyReadWrite: true,
      }),
      generateId: () => randomUUID(),
    });

    const app = buildApp({
      logger: false,
      secureCookies: false,
      setupService,
      authService,
      storageAdminService,
      s3SecurityPolicy,
    });

    const adminPass = "AdminS3ApiPassword2026!";
    await setupService.bootstrapFirstAdmin(
      {
        organizationName: "Empresa S3 API",
        organizationSlug: "empresa-s3-api",
        email: "admin@s3api.invalid",
        fullName: "Admin S3 API",
        password: adminPass,
      },
      randomUUID(),
    );

    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    const csrfToken = csrfRes.json().data.csrfToken as string;

    const loginRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/auth/login`,
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: { email: "admin@s3api.invalid", password: adminPass },
    });
    expect(loginRes.statusCode).toBe(200);
    const adminCookie = loginRes.cookies.find((c) => c.name === "docuflow_session")?.value ?? "";

    // 1. SSRF / cloud metadata endpoint is rejected with 400
    const ssrfRejectRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        kind: "s3",
        name: "S3 SSRF Metadata",
        endpoint: "http://169.254.169.254",
        region: "us-east-1",
        bucket: MINIO_BUCKET,
        forcePathStyle: true,
        tls: { allowInsecureHttp: true },
        credentials: {
          accessKeyId: MINIO_ACCESS_KEY,
          secretAccessKey: MINIO_SECRET_KEY,
        },
      },
    });
    expect(ssrfRejectRes.statusCode).toBe(400);

    // 2. Register S3 connection (with wrong secret first to confirm edit & health check)
    const createS3Res = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        kind: "s3",
        name: "MinIO Principal",
        endpoint: minioEndpoint,
        region: "us-east-1",
        bucket: MINIO_BUCKET,
        forcePathStyle: true,
        keyPrefix: "corp-docs",
        tls: { allowInsecureHttp: true, rejectUnauthorized: false },
        timeouts: { connectionTimeoutMs: 2_000, requestTimeoutMs: 10_000 },
        credentials: {
          accessKeyId: MINIO_ACCESS_KEY,
          secretAccessKey: "InitialWrongSecret2026!",
        },
        isDefault: true,
      },
    });
    expect(createS3Res.statusCode).toBe(201);
    expect(createS3Res.body).not.toContain(MINIO_ACCESS_KEY);
    expect(createS3Res.body).not.toContain("InitialWrongSecret2026!");
    expect(createS3Res.body).not.toContain("dfvault:v1");
    expect(storageConnectionViewSchema.safeParse(createS3Res.json().data).success).toBe(true);
    expect(createS3Res.json().data.hasCredentials).toBe(true);

    const connId = createS3Res.json().data.id as string;

    // Database stores encrypted envelope, never plaintext credentials
    const [dbRow] = await db
      .select()
      .from(storageConnections)
      .where(eq(storageConnections.id, connId))
      .limit(1);
    expect(dbRow?.encryptedSecretPayload?.startsWith("dfvault:v1:")).toBe(true);
    expect(dbRow?.encryptedSecretPayload).not.toContain(MINIO_ACCESS_KEY);
    expect(dbRow?.encryptedSecretPayload).not.toContain("InitialWrongSecret2026!");
    expect(JSON.stringify(dbRow?.nonSecretConfig)).not.toContain(MINIO_ACCESS_KEY);

    // 3. Initial health check fails due to wrong secret, without exposing secret in message
    const failedTestRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections/${connId}/test`,
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(failedTestRes.statusCode).toBe(200);
    expect(failedTestRes.json().data.health.healthy).toBe(false);
    expect(failedTestRes.json().data.connection.status).toBe("ERROR");
    expect(failedTestRes.body).not.toContain("InitialWrongSecret2026!");

    // 4. Edit connection to rotate to valid MinIO credentials & update name
    const patchRes = await app.inject({
      method: "PATCH",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections/${connId}`,
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        name: "MinIO Produção",
        credentials: {
          accessKeyId: MINIO_ACCESS_KEY,
          secretAccessKey: MINIO_SECRET_KEY,
        },
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.name).toBe("MinIO Produção");
    expect(patchRes.body).not.toContain(MINIO_ACCESS_KEY);
    expect(patchRes.body).not.toContain(MINIO_SECRET_KEY);

    // 5. Health check against live MinIO now succeeds and response conforms strictly to contract
    const healthyTestRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections/${connId}/test`,
      cookies: { docuflow_session: adminCookie, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(healthyTestRes.statusCode).toBe(200);
    expect(storageConnectionTestResultSchema.safeParse(healthyTestRes.json().data).success).toBe(
      true,
    );
    expect(healthyTestRes.json().data.health.healthy).toBe(true);
    expect(healthyTestRes.json().data.connection.status).toBe("ACTIVE");
    expect(healthyTestRes.body).not.toContain(MINIO_ACCESS_KEY);
    expect(healthyTestRes.body).not.toContain(MINIO_SECRET_KEY);

    // 6. Listing exposes no secret material
    const listRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
      cookies: { docuflow_session: adminCookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).not.toContain(MINIO_ACCESS_KEY);
    expect(listRes.body).not.toContain(MINIO_SECRET_KEY);
    expect(listRes.body).not.toContain("dfvault:v1");

    await app.close();
  });
});
