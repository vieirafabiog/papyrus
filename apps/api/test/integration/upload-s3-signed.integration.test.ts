import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@papyrus/auth";
import {
  CONTRACTS_API_PREFIX,
  signedUploadTargetResponseSchema,
  uploadSessionRecordSchema,
} from "@papyrus/contracts";
import {
  auditEvents,
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
  createTransactionManager,
  createUploadSessionRepository,
  documentVersions,
  fileObjects,
  organizations,
  roles,
  sessions,
  storageConnections,
  storageRoutingRules,
  uploadSessions,
  userRoleScopes,
  users,
} from "@papyrus/database";
import {
  createStorageConnectionAdminService,
  createStorageRouterService,
  createUploadSessionService,
} from "@papyrus/domain";
import { createStorageSecretVault } from "@papyrus/storage-core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createAuthService } from "../../src/modules/auth/auth.service.js";
import { createStorageHealthTester } from "../../src/modules/storage/storage-health.adapter.js";
import { createApiStorageProviderRegistry } from "../../src/modules/storage/storage-provider.registry.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

const MINIO_IMAGE = "cgr.dev/chainguard/minio:latest";
const MINIO_ACCESS_KEY = "AKIAMINIOUPLOAD2026";
const MINIO_SECRET_KEY = "MinioSignedUploadSecret2026!";
const MINIO_BUCKET = "papyrus-signed-uploads";

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
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

describe("API S3 signed direct upload integration", () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let minioContainer: StartedTestContainer | null = null;
  let pool: Pool;
  let minioEndpoint = "";
  const tempDirs: string[] = [];

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
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
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

  it("issues signed S3 PUT targets only for authorized upload sessions and requires API finalization", async () => {
    const db = drizzle(pool);
    const localTempRoot = await mkdtemp(path.join(os.tmpdir(), "papyrus-api-s3-local-conn-"));
    tempDirs.push(localTempRoot);

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });

    const sessionService = createSessionService({
      store: {
        async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
          const [row] = await db.insert(sessions).values(input).returning();
          if (!row) throw new Error("Session insert failed");
          return row;
        },
        async findByTokenHash(tokenHash: string) {
          const [row] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.tokenHash, tokenHash))
            .limit(1);
          return row ?? null;
        },
        async revokeById(id: string, revokedAt: Date) {
          await db.update(sessions).set({ revokedAt }).where(eq(sessions.id, id));
        },
        async revokeAllForUser(userId: string, revokedAt: Date) {
          await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, userId));
        },
      } satisfies SessionStorePort,
    });

    const orgId = randomUUID();
    const adminId = randomUUID();
    const uploaderId = randomUUID();
    const otherColabId = randomUUID();
    const roleAdminId = randomUUID();
    const roleColabId = randomUUID();
    const categoryS3Id = randomUUID();
    const categoryLocalId = randomUUID();
    const localConnId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Org Signed S3",
      slug: "org-signed-s3",
    });

    const password = "SignedUploadPass2026!";
    const passwordHash = await passwordService.hashPassword(password);
    await db.insert(users).values([
      {
        id: adminId,
        organizationId: orgId,
        email: "admin@signeds3.invalid",
        fullName: "Admin Storage S3",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: uploaderId,
        organizationId: orgId,
        email: "uploader@signeds3.invalid",
        fullName: "Uploader S3",
        passwordHash,
        status: "ACTIVE",
      },
      {
        id: otherColabId,
        organizationId: orgId,
        email: "other@signeds3.invalid",
        fullName: "Outro Colaborador",
        passwordHash,
        status: "ACTIVE",
      },
    ]);

    await db.insert(roles).values([
      {
        id: roleAdminId,
        organizationId: orgId,
        key: "admin",
        name: "Administrador",
        isSystem: true,
      },
      {
        id: roleColabId,
        organizationId: orgId,
        key: "collaborator",
        name: "Colaborador",
        isSystem: true,
      },
    ]);

    await db.insert(categories).values([
      {
        id: categoryS3Id,
        organizationId: orgId,
        name: "Contratos S3",
      },
      {
        id: categoryLocalId,
        organizationId: orgId,
        name: "Rascunhos Locais",
      },
    ]);

    await db.insert(userRoleScopes).values([
      {
        organizationId: orgId,
        userId: adminId,
        roleId: roleAdminId,
        scopeType: "GLOBAL",
        scopeTargetId: null,
        effect: "ALLOW",
      },
      {
        organizationId: orgId,
        userId: uploaderId,
        roleId: roleColabId,
        scopeType: "CATEGORY",
        scopeTargetId: categoryS3Id,
        effect: "ALLOW",
      },
      {
        organizationId: orgId,
        userId: uploaderId,
        roleId: roleColabId,
        scopeType: "CATEGORY",
        scopeTargetId: categoryLocalId,
        effect: "ALLOW",
      },
      {
        organizationId: orgId,
        userId: otherColabId,
        roleId: roleColabId,
        scopeType: "GLOBAL",
        scopeTargetId: null,
        effect: "ALLOW",
      },
    ]);

    await db.insert(storageConnections).values({
      id: localConnId,
      organizationId: orgId,
      name: "Local Fallback Store",
      kind: "local",
      isDefault: true,
      status: "ACTIVE",
      nonSecretConfig: { rootDirectory: localTempRoot },
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
            .where(and(eq(userRoleScopes.userId, id), eq(userRoleScopes.effect, "ALLOW")));
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
    const secretVault = createStorageSecretVault({ masterKey });
    const connectionsRepo = createStorageConnectionRepository(db);
    const transactions = createTransactionManager(db);
    const auditRepo = createAuditRepository(db);
    const uploadRepo = createUploadSessionRepository(db);

    let clockMs = Date.now();
    const s3SecurityPolicy = { allowPrivateEndpoints: true } as const;

    const storageAdminService = createStorageConnectionAdminService({
      connections: connectionsRepo,
      transactions,
      audit: auditRepo,
      healthTester: createStorageHealthTester({
        secretVault,
        s3SecurityPolicy,
        healthVerifyReadWrite: false,
      }),
      secretEncryptor: {
        encrypt: (credentials) => secretVault.encryptCredentials(credentials),
      },
      generateId: () => randomUUID(),
    });

    const storageRegistry = createApiStorageProviderRegistry({
      secretVault,
      s3SecurityPolicy,
      enableS3SignedTargets: true,
      s3SignedTargetsOptions: {
        maxUploadBytes: 1_048_576,
        now: () => new Date(clockMs),
      },
    });

    const uploadSessionService = createUploadSessionService({
      uploads: uploadRepo,
      documents: createDocumentRepository(db),
      storageRouter: createStorageRouterService({
        connections: connectionsRepo,
        routingRules: createStorageRoutingRuleRepository(db),
      }),
      transactions,
      audit: auditRepo,
      generateId: () => randomUUID(),
      maxUploadBytes: 1_048_576,
      now: () => new Date(clockMs),
    });

    const app = buildApp({
      authService,
      storageAdminService,
      s3SecurityPolicy,
      uploadDeps: {
        authzRepository: createAuthorizationRepository(db),
        documentRepository: createDocumentRepository(db),
        uploadRepository: uploadRepo,
        uploadSessionService,
        storageUploadDeps: {
          connections: connectionsRepo,
          storageRegistry,
          transactions,
          auditRepository: auditRepo,
          maxUploadBytes: 1_048_576,
          now: () => new Date(clockMs),
        },
      },
      security: {
        allowedOrigins: ["http://localhost:5173"],
        enforceCsrf: true,
      },
    });

    const csrfRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/auth/csrf-token`,
    });
    expect(csrfRes.statusCode).toBe(200);
    const sharedCsrfToken = (csrfRes.json() as { data: { csrfToken: string } }).data.csrfToken;

    const loginAs = async (email: string) => {
      const loginRes = await app.inject({
        method: "POST",
        url: `${CONTRACTS_API_PREFIX}/auth/login`,
        cookies: { [CSRF_COOKIE_NAME]: sharedCsrfToken },
        headers: {
          origin: "http://localhost:5173",
          [CSRF_HEADER_NAME]: sharedCsrfToken,
        },
        payload: { email, password },
      });
      expect(loginRes.statusCode).toBe(200);
      const sessionCookie = loginRes.cookies.find((c) => c.name === "papyrus_session");
      if (!sessionCookie) {
        throw new Error("Missing session cookie");
      }
      return {
        cookieHeader: `papyrus_session=${sessionCookie.value}; ${CSRF_COOKIE_NAME}=${sharedCsrfToken}`,
        csrfToken: sharedCsrfToken,
      };
    };

    const adminSession = await loginAs("admin@signeds3.invalid");
    const uploaderSession = await loginAs("uploader@signeds3.invalid");
    const otherColabSession = await loginAs("other@signeds3.invalid");

    // 1. Register encrypted MinIO S3 storage connection via admin API and route Contratos S3 to it
    const createS3ConnRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/admin/storage-connections`,
      headers: {
        origin: "http://localhost:5173",
        cookie: adminSession.cookieHeader,
        [CSRF_HEADER_NAME]: adminSession.csrfToken,
      },
      payload: {
        name: "MinIO Contratos S3",
        kind: "s3",
        isDefault: false,
        endpoint: minioEndpoint,
        region: "us-east-1",
        bucket: MINIO_BUCKET,
        forcePathStyle: true,
        keyPrefix: "signed-upload-prefix",
        tls: {
          allowInsecureHttp: true,
          rejectUnauthorized: false,
        },
        credentials: {
          accessKeyId: MINIO_ACCESS_KEY,
          secretAccessKey: MINIO_SECRET_KEY,
        },
      },
    });
    expect(createS3ConnRes.statusCode).toBe(201);
    const s3ConnId = (createS3ConnRes.json() as { data: { id: string } }).data.id;

    await db.insert(storageRoutingRules).values({
      organizationId: orgId,
      categoryId: categoryS3Id,
      storageConnectionId: s3ConnId,
      createdBy: adminId,
      updatedBy: adminId,
    });

    // 2. Collaborator creates an upload session routed to S3
    const pdfPayload = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Title (Signed S3 Contract) >>\nendobj\n%%EOF\n",
      "utf8",
    );
    const payloadChecksum = sha256Hex(pdfPayload);

    const createS3UploadSessionRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      headers: {
        origin: "http://localhost:5173",
        cookie: uploaderSession.cookieHeader,
        [CSRF_HEADER_NAME]: uploaderSession.csrfToken,
      },
      payload: {
        categoryId: categoryS3Id,
        originalFileName: "contrato-assinado.pdf",
        declaredSizeBytes: pdfPayload.length,
        declaredContentType: "application/pdf",
        declaredChecksumSha256: payloadChecksum,
        idempotencyKey: "s3-signed-session-1",
        expiresInSeconds: 600,
      },
    });
    expect(createS3UploadSessionRes.statusCode).toBe(201);
    const s3Session = uploadSessionRecordSchema.parse(
      (createS3UploadSessionRes.json() as { data: unknown }).data,
    );
    expect(s3Session.storageConnectionId).toBe(s3ConnId);

    // 3. Unauthenticated caller cannot obtain a signed upload target
    const unauthTargetRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${s3Session.id}/signed-target`,
      cookies: { [CSRF_COOKIE_NAME]: sharedCsrfToken },
      headers: {
        origin: "http://localhost:5173",
        [CSRF_HEADER_NAME]: sharedCsrfToken,
      },
    });
    expect(unauthTargetRes.statusCode).toBe(401);

    // 4. IDOR attempt by another collaborator returns 403
    const idorTargetRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${s3Session.id}/signed-target`,
      headers: {
        origin: "http://localhost:5173",
        cookie: otherColabSession.cookieHeader,
        [CSRF_HEADER_NAME]: otherColabSession.csrfToken,
      },
    });
    expect(idorTargetRes.statusCode).toBe(403);

    // 5. Payload tampering attempt (client trying to inject objectKey or contentLength) fails 400
    const tamperedPayloadRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${s3Session.id}/signed-target`,
      headers: {
        origin: "http://localhost:5173",
        cookie: uploaderSession.cookieHeader,
        [CSRF_HEADER_NAME]: uploaderSession.csrfToken,
      },
      payload: {
        expiresInSeconds: 180,
        objectKey: "org/evil/override",
        contentLength: 1,
      },
    });
    expect(tamperedPayloadRes.statusCode).toBe(400);

    // 6. Calling local API streaming endpoint on an S3-routed session returns 409 CONFLICT
    const wrongStreamEndpointRes = await app.inject({
      method: "PUT",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${s3Session.id}/content`,
      headers: {
        origin: "http://localhost:5173",
        cookie: uploaderSession.cookieHeader,
        [CSRF_HEADER_NAME]: uploaderSession.csrfToken,
        "content-type": "application/pdf",
      },
      payload: pdfPayload,
    });
    expect(wrongStreamEndpointRes.statusCode).toBe(409);

    // 7. Calling signed-target on a local-storage session returns 409 CONFLICT
    const localSessionRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions`,
      headers: {
        origin: "http://localhost:5173",
        cookie: uploaderSession.cookieHeader,
        [CSRF_HEADER_NAME]: uploaderSession.csrfToken,
      },
      payload: {
        categoryId: categoryLocalId,
        originalFileName: "local.pdf",
        declaredSizeBytes: 128,
        declaredContentType: "application/pdf",
        idempotencyKey: "local-session-cannot-sign",
      },
    });
    expect(localSessionRes.statusCode).toBe(201);
    const localSession = uploadSessionRecordSchema.parse(
      (localSessionRes.json() as { data: unknown }).data,
    );

    const localSignedRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${localSession.id}/signed-target`,
      headers: {
        origin: "http://localhost:5173",
        cookie: uploaderSession.cookieHeader,
        [CSRF_HEADER_NAME]: uploaderSession.csrfToken,
      },
      payload: { expiresInSeconds: 120 },
    });
    expect(localSignedRes.statusCode).toBe(409);

    // 8. Authorized owner obtains short-lived signed PUT target for S3
    const issueTargetRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${s3Session.id}/signed-target`,
      headers: {
        origin: "http://localhost:5173",
        cookie: uploaderSession.cookieHeader,
        [CSRF_HEADER_NAME]: uploaderSession.csrfToken,
      },
      payload: { expiresInSeconds: 180 },
    });
    expect(issueTargetRes.statusCode).toBe(200);
    expect(issueTargetRes.headers["cache-control"]).toBe("private, no-store");

    const signedResponse = signedUploadTargetResponseSchema.parse(
      (issueTargetRes.json() as { data: unknown }).data,
    );
    expect(signedResponse.uploadMode).toBe("SIGNED_UPLOAD");
    expect(signedResponse.finalizationRequired).toBe(true);
    expect(signedResponse.status).toBe("PENDING");
    expect(signedResponse.fileObjectStatus).toBe("UPLOADING");
    expect(signedResponse.target.method).toBe("PUT");
    expect(signedResponse.target.headers).toEqual({
      "content-type": "application/pdf",
      "content-length": String(pdfPayload.length),
    });
    expect(signedResponse.target.url).not.toContain(MINIO_SECRET_KEY);

    const targetUrl = new URL(signedResponse.target.url);
    expect(targetUrl.pathname).toBe(`/${MINIO_BUCKET}/signed-upload-prefix/${s3Session.objectKey}`);
    expect(targetUrl.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(targetUrl.searchParams.get("X-Amz-Expires")).toBe("180");

    // Verify audit event logged without signed URL or secret keys
    const [issuedAuditRow] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, s3Session.id),
          eq(auditEvents.action, "UPLOAD_SIGNED_TARGET_ISSUED"),
        ),
      );
    expect(issuedAuditRow).toBeDefined();
    const auditSerialized = JSON.stringify(issuedAuditRow);
    expect(auditSerialized).not.toContain("X-Amz-Signature");
    expect(auditSerialized).not.toContain(MINIO_SECRET_KEY);

    // 9. MinIO rejects direct signed upload with mismatched content-type header
    const tamperedPutRes = await fetch(signedResponse.target.url, {
      method: signedResponse.target.method,
      headers: {
        ...signedResponse.target.headers,
        "content-type": "text/html",
      },
      body: pdfPayload,
    });
    expect(tamperedPutRes.ok).toBe(false);

    // 10. Direct PUT directly against MinIO succeeds using issued headers & target URL
    const directPutRes = await fetch(signedResponse.target.url, {
      method: signedResponse.target.method,
      headers: signedResponse.target.headers,
      body: pdfPayload,
    });
    expect(directPutRes.ok).toBe(true);

    // Confirm binary was actually stored in MinIO under the server-generated opaque key
    const s3ConnRow = await connectionsRepo.findById(s3ConnId);
    if (!s3ConnRow) {
      throw new Error("Expected S3 connection row");
    }
    const resolvedProvider = await storageRegistry.resolveProvider(s3ConnRow);
    const headResult = await resolvedProvider.headObject({ value: s3Session.objectKey });
    expect(headResult).not.toBeNull();
    expect(headResult?.contentLength).toBe(pdfPayload.length);
    expect(headResult?.contentType).toBe("application/pdf");

    // 11. Critical security guarantee: direct S3 upload MUST require explicit API finalization.
    // Even though bytes exist in MinIO, session stays PENDING, object stays UPLOADING, and zero versions exist!
    const [dbSessionAfterPut] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, s3Session.id));
    expect(dbSessionAfterPut?.status).toBe("PENDING");
    expect(dbSessionAfterPut?.finalizedAt).toBeNull();

    const [dbFileAfterPut] = await db
      .select()
      .from(fileObjects)
      .where(eq(fileObjects.id, s3Session.fileObjectId));
    expect(dbFileAfterPut?.status).toBe("UPLOADING");

    const [versionCount] = await db.select({ total: count() }).from(documentVersions);
    expect(Number(versionCount?.total ?? 0)).toBe(0);

    const inspectSessionRes = await app.inject({
      method: "GET",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${s3Session.id}`,
      headers: {
        cookie: uploaderSession.cookieHeader,
      },
    });
    expect(inspectSessionRes.statusCode).toBe(200);
    const inspectedSession = uploadSessionRecordSchema.parse(
      (inspectSessionRes.json() as { data: unknown }).data,
    );
    expect(inspectedSession.status).toBe("PENDING");
    expect(inspectedSession.finalizedAt).toBeNull();

    // 12. Revoking uploader's UPLOAD grant (via explicit DENY) blocks subsequent signed-target issuance
    await db.insert(userRoleScopes).values({
      organizationId: orgId,
      userId: uploaderId,
      roleId: roleColabId,
      scopeType: "GLOBAL",
      scopeTargetId: null,
      effect: "DENY",
    });

    const revokedSignedRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${s3Session.id}/signed-target`,
      headers: {
        origin: "http://localhost:5173",
        cookie: uploaderSession.cookieHeader,
        [CSRF_HEADER_NAME]: uploaderSession.csrfToken,
      },
    });
    expect(revokedSignedRes.statusCode).toBe(403);

    // Restore allow for expiration test using remaining < 10s window -> 409 CONFLICT
    await db.delete(userRoleScopes).where(eq(userRoleScopes.effect, "DENY"));
    clockMs = new Date(s3Session.expiresAt).getTime() - 5_000;
    const tooCloseToExpiryRes = await app.inject({
      method: "POST",
      url: `${CONTRACTS_API_PREFIX}/uploads/sessions/${s3Session.id}/signed-target`,
      headers: {
        origin: "http://localhost:5173",
        cookie: uploaderSession.cookieHeader,
        [CSRF_HEADER_NAME]: uploaderSession.csrfToken,
      },
    });
    expect(tooCloseToExpiryRes.statusCode).toBe(409);

    await app.close();
  }, 120_000);
});
