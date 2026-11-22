import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type CreateSessionRecordInput,
  SYSTEM_ROLE_DEFINITIONS,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@docuflow/auth";
import {
  categories,
  createAuditRepository,
  createAuthorizationRepository,
  createDocumentRepository,
  createDocumentVersionRepository,
  createStorageConnectionRepository,
  createUploadSessionRepository,
  documentVersions,
  documents,
  fileObjects,
  folders,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  storageConnections,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
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

const execFileAsync = promisify(execFile);
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, "../../../..");
const MIGRATIONS_FOLDER = path.resolve(REPO_ROOT, "packages/database/drizzle");
const BACKUP_DB_SCRIPT = path.resolve(REPO_ROOT, "scripts/backup/backup-database.sh");
const BACKUP_FILES_SCRIPT = path.resolve(REPO_ROOT, "scripts/backup/backup-files.sh");
const RESTORE_SYSTEM_SCRIPT = path.resolve(REPO_ROOT, "scripts/restore/restore-system.sh");

describe("Clean environment full restore and document download verification (Step 15.10)", () => {
  let workDir = "";
  let sourceContainer: StartedPostgreSqlContainer | null = null;
  let targetContainer: StartedPostgreSqlContainer | null = null;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), "docuflow-restore-e2e-"));
    sourceContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  }, 120_000);

  afterAll(async () => {
    if (targetContainer) {
      await targetContainer.stop();
    }
    if (sourceContainer) {
      await sourceContainer.stop();
    }
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("restores PostgreSQL, local files, and protected master key config to a clean environment and downloads a restored document", async () => {
    if (!sourceContainer) {
      throw new Error("Source PostgreSQL container did not start");
    }

    const storageRoot = path.join(workDir, "storage");
    const dbBackupDir = path.join(workDir, "backups", "postgres");
    const filesBackupDir = path.join(workDir, "backups", "files");
    const vaultEnvFile = path.join(workDir, "vault", "prod.env");
    const restoredEnvFile = path.join(workDir, "restored", ".env");

    await mkdir(storageRoot, { recursive: true });
    await mkdir(path.dirname(vaultEnvFile), { recursive: true });

    const masterEncryptionKey = randomBytes(32).toString("hex");
    const sessionSecret = randomBytes(32).toString("hex");
    await writeFile(
      vaultEnvFile,
      `NODE_ENV=production\nENCRYPTION_KEY=${masterEncryptionKey}\nSESSION_SECRET=${sessionSecret}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(vaultEnvFile, 0o600);

    // 1. Seed source database + local storage file
    const sourceConnectionUri = sourceContainer.getConnectionUri();
    const sourcePool = new Pool({ connectionString: sourceConnectionUri });
    const orgId = randomUUID();
    const userId = randomUUID();
    const roleId = randomUUID();
    const categoryId = randomUUID();
    const folderId = randomUUID();
    const storageId = randomUUID();
    const documentId = randomUUID();
    const versionId = randomUUID();
    const fileObjectId = randomUUID();
    const userEmail = `restore-reader-${orgId.slice(0, 6)}@docuflow.local`;
    const userPassword = "RestoreCheck!2026";
    const pdfContent = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% DocuFlow Restore Integrity Payload\n%%EOF\n",
      "utf8",
    );
    const pdfSha256 = createHash("sha256").update(pdfContent).digest("hex");
    const objectKey = `org/${orgId}/documents/${documentId}/versions/${versionId}/${fileObjectId}`;

    try {
      const sourceDb = drizzle(sourcePool);
      await migrate(sourceDb, { migrationsFolder: MIGRATIONS_FOLDER });

      const passwordService = createPasswordService({
        memoryCost: 8_192,
        timeCost: 2,
        parallelism: 1,
        minPasswordLength: 10,
      });
      const passwordHash = await passwordService.hashPassword(userPassword);

      await sourceDb.insert(organizations).values({
        id: orgId,
        name: "Org Restore E2E",
        slug: `org-restore-${orgId.slice(0, 8)}`,
      });
      await sourceDb.insert(users).values({
        id: userId,
        organizationId: orgId,
        email: userEmail,
        fullName: "Operador Restore",
        passwordHash,
        status: "ACTIVE",
      });
      await sourceDb.insert(roles).values({
        id: roleId,
        organizationId: orgId,
        key: "viewer",
        name: "Consulta",
        isSystem: true,
      });
      for (const perm of SYSTEM_ROLE_DEFINITIONS.viewer.permissions) {
        const permId = randomUUID();
        await sourceDb
          .insert(permissions)
          .values({ id: permId, action: perm.action, resource: perm.resource });
        await sourceDb.insert(rolePermissions).values({ roleId, permissionId: permId });
      }
      await sourceDb.insert(userRoleScopes).values({
        id: randomUUID(),
        organizationId: orgId,
        userId,
        roleId,
        scopeType: "GLOBAL",
        effect: "ALLOW",
      });
      await sourceDb.insert(categories).values({
        id: categoryId,
        organizationId: orgId,
        name: "Contratos",
        isActive: true,
      });
      await sourceDb.insert(folders).values({
        id: folderId,
        organizationId: orgId,
        parentId: null,
        name: "Contratos",
        materializedPath: `/${folderId}`,
        status: "ACTIVE",
      });
      await sourceDb.insert(storageConnections).values({
        id: storageId,
        organizationId: orgId,
        name: "Local Restore Storage",
        kind: "local",
        status: "ACTIVE",
        isDefault: true,
        nonSecretConfig: { rootDirectory: storageRoot },
      });

      const localProvider = createLocalStorageProvider({ rootDirectory: storageRoot });
      await localProvider.putObject({
        key: { value: objectKey },
        body: Readable.from(pdfContent),
        metadata: {
          contentType: "application/pdf",
          contentLength: pdfContent.length,
          checksumSha256: pdfSha256,
        },
      });

      await sourceDb.insert(fileObjects).values({
        id: fileObjectId,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey,
        originalFileName: "contrato_restaurado.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: pdfContent.length,
        checksumSha256: pdfSha256,
        status: "AVAILABLE",
      });
      await sourceDb.insert(documents).values({
        id: documentId,
        organizationId: orgId,
        title: "Contrato Restaurado",
        categoryId,
        folderId,
        status: "APPROVED",
        ownerUserId: userId,
        createdBy: userId,
        updatedBy: userId,
      });
      await sourceDb.insert(documentVersions).values({
        id: versionId,
        documentId,
        versionNumber: 1,
        fileObjectId,
        uploadedByUserId: userId,
      });
      await sourceDb
        .update(documents)
        .set({ currentVersionId: versionId })
        .where(eq(documents.id, documentId));
    } finally {
      await sourcePool.end();
    }

    // 2. Run coordinated PostgreSQL + local file backups
    await execFileAsync(BACKUP_DB_SCRIPT, [], {
      env: {
        ...process.env,
        DATABASE_URL: sourceConnectionUri,
        BACKUP_DIR: dbBackupDir,
        DOCKER_NETWORK: "host",
      },
    });
    await execFileAsync(BACKUP_FILES_SCRIPT, [], {
      env: {
        ...process.env,
        STORAGE_LOCAL_ROOT: storageRoot,
        BACKUP_DIR: filesBackupDir,
      },
    });

    const sourceContainerName = sourceContainer.getName().replace(/^\//, "");
    const { stdout: dumpFind } = await execFileAsync("sh", [
      "-c",
      `find "${dbBackupDir}" -maxdepth 1 -name 'docuflow-db-*.dump' | head -n 1`,
    ]);
    const { stdout: archiveFind } = await execFileAsync("sh", [
      "-c",
      `find "${filesBackupDir}" -maxdepth 1 -name 'docuflow-files-*.tar.gz' | head -n 1`,
    ]);
    const dumpFilePath = dumpFind.trim();
    const archiveFilePath = archiveFind.trim();
    expect(dumpFilePath.length).toBeGreaterThan(0);
    expect(archiveFilePath.length).toBeGreaterThan(0);
    expect(sourceContainerName.length).toBeGreaterThan(0);

    // 3. Destroy original database and storage files completely, then start clean target DB & empty storage
    await sourceContainer.stop();
    sourceContainer = null;
    await rm(storageRoot, { recursive: true, force: true });
    await mkdir(storageRoot, { recursive: true });

    targetContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
    const targetConnectionUri = targetContainer.getConnectionUri();

    // 4. Execute coordinated restore script against clean database + empty storage + protected .env
    const { stdout: restoreStdout } = await execFileAsync(
      RESTORE_SYSTEM_SCRIPT,
      ["--confirm-restore"],
      {
        env: {
          ...process.env,
          PROTECTED_ENV_BACKUP: vaultEnvFile,
          TARGET_ENV_FILE: restoredEnvFile,
          DATABASE_URL: targetConnectionUri,
          DB_BACKUP_FILE: dumpFilePath,
          FILES_BACKUP_ARCHIVE: archiveFilePath,
          STORAGE_LOCAL_ROOT: storageRoot,
          DOCKER_NETWORK: "host",
        },
      },
    );

    expect(restoreStdout).not.toContain(masterEncryptionKey);
    const restoredEnvStat = await stat(restoredEnvFile);
    expect(restoredEnvStat.mode & 0o777).toBe(0o600);
    const restoredEnvContents = await readFile(restoredEnvFile, "utf8");
    expect(restoredEnvContents).toContain(`ENCRYPTION_KEY=${masterEncryptionKey}`);

    // 5. Boot API against clean restored DB + restored files and download the restored document over HTTP
    const targetPool = new Pool({ connectionString: targetConnectionUri });
    try {
      const targetDb = drizzle(targetPool);
      const storageRegistry = createStorageProviderRegistry();
      storageRegistry.registerFactory("local", async ({ connection }) => {
        const rootDir = connection.nonSecretConfig.rootDirectory;
        if (typeof rootDir !== "string" || rootDir.length === 0) {
          throw new Error("Missing rootDirectory");
        }
        return createLocalStorageProvider({ rootDirectory: rootDir });
      });

      const passwordService = createPasswordService({
        memoryCost: 8_192,
        timeCost: 2,
        parallelism: 1,
        minPasswordLength: 10,
      });
      const sessionService = createSessionService({
        store: {
          async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
            const [row] = await targetDb.insert(sessions).values(input).returning();
            if (!row) {
              throw new Error("Session insert failed");
            }
            return row;
          },
          async findByTokenHash(tokenHash: string) {
            const [row] = await targetDb
              .select()
              .from(sessions)
              .where(eq(sessions.tokenHash, tokenHash))
              .limit(1);
            return row ?? null;
          },
          async revokeById(id: string, revokedAt: Date) {
            await targetDb.update(sessions).set({ revokedAt }).where(eq(sessions.id, id));
          },
          async revokeAllForUser(uid: string, revokedAt: Date) {
            await targetDb.update(sessions).set({ revokedAt }).where(eq(sessions.userId, uid));
          },
        } satisfies SessionStorePort,
      });

      const authService = createAuthService({
        users: {
          async findCredentialByEmail(email) {
            const [row] = await targetDb
              .select()
              .from(users)
              .where(eq(users.email, email))
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
          async findProfileById(uid) {
            const [row] = await targetDb.select().from(users).where(eq(users.id, uid)).limit(1);
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
              groups: [],
              roles: [],
              permissions: [],
            };
          },
        },
        passwordService,
        sessionService,
      });

      const app = buildApp({
        logger: false,
        secureCookies: false,
        authService,
        documentDeps: {
          authzRepository: createAuthorizationRepository(targetDb),
          documentRepository: createDocumentRepository(targetDb),
          auditRepository: createAuditRepository(targetDb),
          documentVersionRepository: createDocumentVersionRepository(targetDb),
          uploadRepository: createUploadSessionRepository(targetDb),
          storageConnections: createStorageConnectionRepository(targetDb),
          storageRegistry,
        },
      });
      await app.ready();

      try {
        const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
        const csrfToken = csrfRes.cookies.find((c) => c.name === CSRF_COOKIE_NAME)?.value ?? "";
        const loginRes = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          cookies: { [CSRF_COOKIE_NAME]: csrfToken },
          headers: { [CSRF_HEADER_NAME]: csrfToken },
          payload: { email: userEmail, password: userPassword },
        });
        expect(loginRes.statusCode).toBe(200);
        const sessionCookie =
          loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value ?? "";
        expect(sessionCookie.length).toBeGreaterThan(0);

        const downloadRes = await app.inject({
          method: "GET",
          url: `/api/v1/documents/${documentId}/download`,
          cookies: { [SESSION_COOKIE_NAME]: sessionCookie },
        });

        expect(downloadRes.statusCode).toBe(200);
        expect(downloadRes.headers["content-disposition"]).toContain("contrato_restaurado.pdf");
        expect(downloadRes.rawPayload.equals(pdfContent)).toBe(true);
        expect(createHash("sha256").update(downloadRes.rawPayload).digest("hex")).toBe(pdfSha256);
      } finally {
        await app.close();
      }
    } finally {
      await targetPool.end();
    }
  }, 180_000);
});
