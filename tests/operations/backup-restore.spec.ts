import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  auditEvents,
  categories,
  categoryFields,
  documentMetadata,
  documentTags,
  documentVersions,
  documents,
  fileObjects,
  folders,
  organizations,
  storageConnections,
  tags,
  users,
} from "@docuflow/database";
import { createStorageSecretVault } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, "../..");
const MIGRATIONS_FOLDER = path.resolve(REPO_ROOT, "packages/database/drizzle");
const BACKUP_DB_SCRIPT = path.resolve(REPO_ROOT, "scripts/backup/backup-database.sh");
const BACKUP_FILES_SCRIPT = path.resolve(REPO_ROOT, "scripts/backup/backup-files.sh");
const RESTORE_FILES_SCRIPT = path.resolve(REPO_ROOT, "scripts/restore/restore-files.sh");
const RESTORE_SYSTEM_SCRIPT = path.resolve(REPO_ROOT, "scripts/restore/restore-system.sh");

interface ScriptExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
}

function runBashScript(
  scriptPath: string,
  envOverrides: Readonly<Record<string, string>>,
  args: readonly string[] = [],
): Promise<ScriptExecutionResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      [scriptPath, ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...envOverrides,
        },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Script ${path.basename(scriptPath)} failed (${String(error.code ?? "unknown")}): ${stderr || stdout || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function extractEnvValue(rawEnv: string, key: string): string | null {
  for (const line of rawEnv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.slice(key.length + 1).replace(/^['"]|['"]$/g, "");
    }
  }
  return null;
}

describe("Backup e restauração coordenada de ambiente completo (Step 16.08)", () => {
  let sourceContainer: StartedPostgreSqlContainer | null = null;
  let targetContainer: StartedPostgreSqlContainer | null = null;
  let sourcePool: Pool | null = null;
  let targetPool: Pool | null = null;
  let tempRootDir: string | null = null;

  afterAll(async () => {
    if (sourcePool) {
      await sourcePool.end();
    }
    if (targetPool) {
      await targetPool.end();
    }
    if (sourceContainer) {
      await sourceContainer.stop();
    }
    if (targetContainer) {
      await targetContainer.stop();
    }
    if (tempRootDir) {
      await rm(tempRootDir, { recursive: true, force: true });
    }
  });

  it("installs temporary environment, creates versioned document + metadata, backs up DB/files, restores to clean environment, and verifies exact parity", async () => {
    tempRootDir = await mkdtemp(path.join(os.tmpdir(), "docuflow-op-backup-restore-"));
    const sourceStorageDir = path.join(tempRootDir, "source-storage");
    const targetStorageDir = path.join(tempRootDir, "target-storage");
    const backupDbDir = path.join(tempRootDir, "backups-postgres");
    const backupFilesDir = path.join(tempRootDir, "backups-files");
    const envDir = path.join(tempRootDir, "secrets");
    await mkdir(sourceStorageDir, { recursive: true });
    await mkdir(targetStorageDir, { recursive: true });
    await mkdir(envDir, { recursive: true });

    const masterKeyHex = randomBytes(32).toString("hex");
    const secretAccessKeyValue = "SecretBackupRoundtripKey!2026";
    const sourceEnvPath = path.join(envDir, "prod-source.env");
    const targetEnvPath = path.join(envDir, "prod-restored.env");

    await writeFile(
      sourceEnvPath,
      [
        "NODE_ENV=production",
        `ENCRYPTION_KEY=${masterKeyHex}`,
        `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(sourceEnvPath, 0o600);

    // 1. Provision temporary source PostgreSQL and migrate schema
    sourceContainer = await new PostgreSqlContainer("postgres:16.8-alpine3.21")
      .withDatabase("docuflow_ops")
      .withUsername("docuflow_ops")
      .withPassword("PgBackupOpsSecret2026!")
      .start();
    sourcePool = new Pool({ connectionString: sourceContainer.getConnectionUri() });
    sourcePool.on("error", () => {});
    const sourceDb = drizzle(sourcePool);
    await migrate(sourceDb, { migrationsFolder: MIGRATIONS_FOLDER });

    // 2. Seed organization, user, taxonomy, encrypted connector config, and versioned document
    const orgId = randomUUID();
    const userId = randomUUID();
    const categoryId = randomUUID();
    const fieldSupplierId = randomUUID();
    const fieldAmountId = randomUUID();
    const fieldConfidentialId = randomUUID();
    const folderId = randomUUID();
    const tagId = randomUUID();
    const connectionId = randomUUID();
    const documentId = randomUUID();
    const version1Id = randomUUID();
    const version2Id = randomUUID();
    const file1Id = randomUUID();
    const file2Id = randomUUID();

    const objectKeyV1 = `org/${orgId}/documents/${documentId}/versions/${version1Id}/${randomUUID()}`;
    const objectKeyV2 = `org/${orgId}/documents/${documentId}/versions/${version2Id}/${randomUUID()}`;

    const pdfV1 = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Title (Contrato Backup v1) >>\nendobj\n%%EOF\n",
      "utf8",
    );
    const pdfV2 = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Title (Contrato Backup v2 Revisado) >>\nendobj\n%%EOF\n",
      "utf8",
    );
    const shaV1 = sha256Hex(pdfV1);
    const shaV2 = sha256Hex(pdfV2);

    const vault = createStorageSecretVault({ masterKey: masterKeyHex });
    const encryptedConnectorSecret = vault.encryptCredentials({
      accessKeyId: "AKIABACKUPTEST",
      secretAccessKey: secretAccessKeyValue,
    });

    await sourceDb.insert(organizations).values({
      id: orgId,
      name: "Empresa Backup Ops",
      slug: `empresa-backup-${orgId.slice(0, 8)}`,
      defaultLanguage: "pt-BR",
      timezone: "America/Sao_Paulo",
    });

    await sourceDb.insert(users).values({
      id: userId,
      organizationId: orgId,
      email: `ops-${orgId.slice(0, 6)}@docuflow.local`,
      fullName: "Operador Backup",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$fakehashforrestoretest",
      status: "ACTIVE",
    });

    await sourceDb.insert(categories).values({
      id: categoryId,
      organizationId: orgId,
      name: "Contratos de Fornecedor",
      description: "Documentos contratuais de operação",
      isActive: true,
    });

    await sourceDb.insert(categoryFields).values([
      {
        id: fieldSupplierId,
        categoryId,
        key: "fornecedor",
        label: "Fornecedor",
        type: "TEXT",
        required: true,
        sortOrder: 1,
      },
      {
        id: fieldAmountId,
        categoryId,
        key: "valor_contrato",
        label: "Valor do Contrato",
        type: "NUMBER",
        required: false,
        sortOrder: 2,
      },
      {
        id: fieldConfidentialId,
        categoryId,
        key: "confidencial",
        label: "Confidencial",
        type: "BOOLEAN",
        required: false,
        sortOrder: 3,
      },
    ]);

    await sourceDb.insert(folders).values({
      id: folderId,
      organizationId: orgId,
      name: "Contratos 2026",
      materializedPath: `/${folderId}`,
      status: "ACTIVE",
      createdBy: userId,
      updatedBy: userId,
    });

    await sourceDb.insert(tags).values({
      id: tagId,
      organizationId: orgId,
      name: "Auditoria Backup",
      normalizedName: "auditoria backup",
    });

    await sourceDb.insert(storageConnections).values({
      id: connectionId,
      organizationId: orgId,
      name: "Local Primário",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: sourceStorageDir },
      encryptedSecretPayload: encryptedConnectorSecret,
      createdBy: userId,
      updatedBy: userId,
    });

    const sourceStorageProvider = createLocalStorageProvider({ rootDirectory: sourceStorageDir });
    await sourceStorageProvider.putObject({
      key: { value: objectKeyV1 },
      body: Readable.from([pdfV1]),
      metadata: {
        contentType: "application/pdf",
        contentLength: pdfV1.byteLength,
        checksumSha256: shaV1,
        customMetadata: { version: "1", integrityScope: "backup-restore" },
      },
    });
    await sourceStorageProvider.putObject({
      key: { value: objectKeyV2 },
      body: Readable.from([pdfV2]),
      metadata: {
        contentType: "application/pdf",
        contentLength: pdfV2.byteLength,
        checksumSha256: shaV2,
        customMetadata: { version: "2", integrityScope: "backup-restore" },
      },
    });

    await sourceDb.insert(fileObjects).values([
      {
        id: file1Id,
        organizationId: orgId,
        storageConnectionId: connectionId,
        objectKey: objectKeyV1,
        originalFileName: "contrato-alpha-v1.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: pdfV1.byteLength,
        checksumSha256: shaV1,
        status: "AVAILABLE",
      },
      {
        id: file2Id,
        organizationId: orgId,
        storageConnectionId: connectionId,
        objectKey: objectKeyV2,
        originalFileName: "contrato-alpha-v2.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: pdfV2.byteLength,
        checksumSha256: shaV2,
        status: "AVAILABLE",
      },
    ]);

    const documentMetaJson = {
      fornecedor: "Alfa Suprimentos Ltda",
      valor_contrato: 48250.75,
      confidencial: true,
    };

    await sourceDb.insert(documents).values({
      id: documentId,
      organizationId: orgId,
      title: "Contrato de Fornecimento Alfa 2026",
      categoryId,
      folderId,
      status: "APPROVED",
      ownerUserId: userId,
      issueDate: "2026-01-15",
      expirationDate: "2027-01-15",
      metadata: documentMetaJson,
      version: 2,
      createdBy: userId,
      updatedBy: userId,
    });

    await sourceDb.insert(documentVersions).values([
      {
        id: version1Id,
        documentId,
        versionNumber: 1,
        fileObjectId: file1Id,
        uploadedByUserId: userId,
        changeNote: "Versão inicial",
      },
      {
        id: version2Id,
        documentId,
        versionNumber: 2,
        fileObjectId: file2Id,
        uploadedByUserId: userId,
        changeNote: "Aditivo assinado",
      },
    ]);

    await sourceDb
      .update(documents)
      .set({ currentVersionId: version2Id })
      .where(eq(documents.id, documentId));

    await sourceDb.insert(documentMetadata).values([
      {
        id: randomUUID(),
        documentId,
        fieldId: fieldSupplierId,
        fieldKey: "fornecedor",
        valueText: "Alfa Suprimentos Ltda",
      },
      {
        id: randomUUID(),
        documentId,
        fieldId: fieldAmountId,
        fieldKey: "valor_contrato",
        valueNumber: 48250.75,
      },
      {
        id: randomUUID(),
        documentId,
        fieldId: fieldConfidentialId,
        fieldKey: "confidencial",
        valueBoolean: true,
      },
    ]);

    await sourceDb.insert(documentTags).values({
      documentId,
      tagId,
    });

    await sourceDb.insert(auditEvents).values([
      {
        id: randomUUID(),
        organizationId: orgId,
        actorUserId: userId,
        action: "DOCUMENT_CREATED",
        resourceType: "DOCUMENT",
        resourceId: documentId,
        result: "SUCCESS",
        requestId: randomUUID(),
        metadata: { title: "Contrato de Fornecimento Alfa 2026" },
      },
      {
        id: randomUUID(),
        organizationId: orgId,
        actorUserId: userId,
        action: "DOCUMENT_VERSION_CREATED",
        resourceType: "DOCUMENT",
        resourceId: documentId,
        result: "SUCCESS",
        requestId: randomUUID(),
        metadata: { versionNumber: 2 },
      },
    ]);

    // 3. Execute coordinated backup scripts (PostgreSQL first, then local storage files)
    const dbBackupRun = await runBashScript(BACKUP_DB_SCRIPT, {
      BACKUP_DIR: backupDbDir,
      BACKUP_MODE: "docker",
      DOCUFLOW_PG_CONTAINER: sourceContainer.getId(),
      PGUSER: sourceContainer.getUsername(),
      PGDATABASE: sourceContainer.getDatabase(),
    });
    expect(dbBackupRun.stdout).toContain("Backup do PostgreSQL concluido com sucesso");
    expect(dbBackupRun.stdout).not.toContain(masterKeyHex);
    expect(dbBackupRun.stdout).not.toContain(sourceContainer.getPassword());

    const dbBackupFiles = await readdir(backupDbDir);
    const dumpFileName = dbBackupFiles.find((name) => name.endsWith(".dump"));
    expect(dumpFileName).toBeDefined();
    if (!dumpFileName) {
      throw new Error("Dump .dump não encontrado após backup.");
    }
    const dumpFilePath = path.join(backupDbDir, dumpFileName);
    const dumpStat = await stat(dumpFilePath);
    expect(dumpStat.mode & 0o777).toBe(0o600);
    expect(dbBackupFiles).toContain(`${dumpFileName}.sha256`);

    const filesBackupRun = await runBashScript(BACKUP_FILES_SCRIPT, {
      BACKUP_DIR: backupFilesDir,
      STORAGE_LOCAL_ROOT: sourceStorageDir,
    });
    expect(filesBackupRun.stdout).toContain("Backup de arquivos locais concluido com sucesso");

    const fileBackupEntries = await readdir(backupFilesDir);
    const archiveFileName = fileBackupEntries.find((name) => name.endsWith(".tar.gz"));
    expect(archiveFileName).toBeDefined();
    if (!archiveFileName) {
      throw new Error("Snapshot .tar.gz não encontrado após backup de arquivos.");
    }
    const archiveFilePath = path.join(backupFilesDir, archiveFileName);
    const archivePrefix = archiveFileName.slice(0, -".tar.gz".length);
    expect(fileBackupEntries).toContain(`${archiveFileName}.sha256`);
    expect(fileBackupEntries).toContain(`${archivePrefix}.manifest.sha256`);

    // 4. Spin up a brand-new EMPTY PostgreSQL container (disaster recovery target)
    targetContainer = await new PostgreSqlContainer("postgres:16.8-alpine3.21")
      .withDatabase("docuflow_ops")
      .withUsername("docuflow_ops")
      .withPassword("PgBackupOpsSecret2026!")
      .start();

    // Refuse restore without explicit CONFIRM_RESTORE=YES
    await expect(
      runBashScript(RESTORE_SYSTEM_SCRIPT, {
        CONFIRM_RESTORE: "NO",
        PROTECTED_ENV_BACKUP: sourceEnvPath,
        TARGET_ENV_FILE: targetEnvPath,
        DB_BACKUP_FILE: dumpFilePath,
        FILES_BACKUP_ARCHIVE: archiveFilePath,
        DOCUFLOW_PG_CONTAINER: targetContainer.getId(),
        PGUSER: targetContainer.getUsername(),
        PGDATABASE: targetContainer.getDatabase(),
        STORAGE_LOCAL_ROOT: targetStorageDir,
        RESTORE_MODE: "docker",
      }),
    ).rejects.toThrow(/CONFIRM_RESTORE=YES/);

    // Execute full coordinated restore against clean PostgreSQL + clean storage directory
    const restoreRun = await runBashScript(RESTORE_SYSTEM_SCRIPT, {
      CONFIRM_RESTORE: "YES",
      PROTECTED_ENV_BACKUP: sourceEnvPath,
      TARGET_ENV_FILE: targetEnvPath,
      DB_BACKUP_FILE: dumpFilePath,
      FILES_BACKUP_ARCHIVE: archiveFilePath,
      DOCUFLOW_PG_CONTAINER: targetContainer.getId(),
      PGUSER: targetContainer.getUsername(),
      PGDATABASE: targetContainer.getDatabase(),
      STORAGE_LOCAL_ROOT: targetStorageDir,
      RESTORE_MODE: "docker",
    });
    expect(restoreRun.stdout).toContain("Restauracao coordenada concluida");
    expect(restoreRun.stdout).not.toContain(masterKeyHex);

    // 5. Verify restored environment secret file, PostgreSQL metadata, and binary files
    const restoredEnvStat = await stat(targetEnvPath);
    expect(restoredEnvStat.mode & 0o777).toBe(0o600);
    const restoredEncryptionKey = extractEnvValue(
      await readFile(targetEnvPath, "utf8"),
      "ENCRYPTION_KEY",
    );
    expect(restoredEncryptionKey).toBe(masterKeyHex);

    targetPool = new Pool({ connectionString: targetContainer.getConnectionUri() });
    targetPool.on("error", () => {});
    const targetDb = drizzle(targetPool);

    const [restoredDoc] = await targetDb
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    const [sourceDoc] = await sourceDb
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    expect(restoredDoc).toEqual(sourceDoc);

    const sourceVersions = await sourceDb
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(asc(documentVersions.versionNumber));
    const restoredVersions = await targetDb
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(asc(documentVersions.versionNumber));
    expect(restoredVersions).toEqual(sourceVersions);

    const sourceMetaRows = await sourceDb
      .select()
      .from(documentMetadata)
      .where(eq(documentMetadata.documentId, documentId))
      .orderBy(asc(documentMetadata.fieldKey));
    const restoredMetaRows = await targetDb
      .select()
      .from(documentMetadata)
      .where(eq(documentMetadata.documentId, documentId))
      .orderBy(asc(documentMetadata.fieldKey));
    expect(restoredMetaRows).toEqual(sourceMetaRows);

    const sourceTagRows = await sourceDb
      .select()
      .from(documentTags)
      .where(eq(documentTags.documentId, documentId));
    const restoredTagRows = await targetDb
      .select()
      .from(documentTags)
      .where(eq(documentTags.documentId, documentId));
    expect(restoredTagRows).toEqual(sourceTagRows);

    const sourceFileRows = await sourceDb
      .select()
      .from(fileObjects)
      .where(eq(fileObjects.organizationId, orgId))
      .orderBy(asc(fileObjects.objectKey));
    const restoredFileRows = await targetDb
      .select()
      .from(fileObjects)
      .where(eq(fileObjects.organizationId, orgId))
      .orderBy(asc(fileObjects.objectKey));
    expect(restoredFileRows).toEqual(sourceFileRows);

    const sourceAuditRows = await sourceDb
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
    const restoredAuditRows = await targetDb
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, orgId))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
    expect(restoredAuditRows).toEqual(sourceAuditRows);

    // Decrypt restored encrypted connector payload using ENCRYPTION_KEY from restored .env
    const [restoredConn] = await targetDb
      .select()
      .from(storageConnections)
      .where(eq(storageConnections.id, connectionId))
      .limit(1);
    expect(restoredConn?.encryptedSecretPayload).toBeTruthy();
    const restoredVault = createStorageSecretVault({
      masterKey: restoredEncryptionKey ?? undefined,
    });
    expect(restoredVault.decryptCredentials(restoredConn?.encryptedSecretPayload ?? "")).toEqual({
      accessKeyId: "AKIABACKUPTEST",
      secretAccessKey: secretAccessKeyValue,
    });

    // Read BOTH restored files through @docuflow/storage-local and compare exact bytes & SHA-256
    const restoredStorageProvider = createLocalStorageProvider({ rootDirectory: targetStorageDir });
    const headV1 = await restoredStorageProvider.headObject({ value: objectKeyV1 });
    const headV2 = await restoredStorageProvider.headObject({ value: objectKeyV2 });
    expect(headV1?.checksumSha256).toBe(shaV1);
    expect(headV1?.contentLength).toBe(pdfV1.byteLength);
    expect(headV1?.customMetadata).toEqual({ version: "1", integrityScope: "backup-restore" });
    expect(headV2?.checksumSha256).toBe(shaV2);
    expect(headV2?.contentLength).toBe(pdfV2.byteLength);

    const downloadedV1 = await restoredStorageProvider.getObject({ value: objectKeyV1 });
    const downloadedV2 = await restoredStorageProvider.getObject({ value: objectKeyV2 });
    const restoredBytesV1 = await readStreamToBuffer(downloadedV1.body);
    const restoredBytesV2 = await readStreamToBuffer(downloadedV2.body);
    expect(Buffer.compare(restoredBytesV1, pdfV1)).toBe(0);
    expect(Buffer.compare(restoredBytesV2, pdfV2)).toBe(0);
    expect(sha256Hex(restoredBytesV1)).toBe(shaV1);
    expect(sha256Hex(restoredBytesV2)).toBe(shaV2);

    // Negative check: tampered backup archive must be rejected cleanly by SHA-256 verification
    const tamperedDir = path.join(tempRootDir, "tampered");
    await mkdir(tamperedDir, { recursive: true });
    const tamperedArchivePath = path.join(tamperedDir, archiveFileName);
    await copyFile(archiveFilePath, tamperedArchivePath);
    await copyFile(
      path.join(backupFilesDir, `${archiveFileName}.sha256`),
      `${tamperedArchivePath}.sha256`,
    );
    await writeFile(tamperedArchivePath, Buffer.from("corrupted-tar-gz-bytes", "utf8"));

    await expect(
      runBashScript(
        RESTORE_FILES_SCRIPT,
        {
          BACKUP_ARCHIVE: tamperedArchivePath,
          STORAGE_LOCAL_ROOT: path.join(tempRootDir, "should-stay-empty"),
        },
        ["--confirm-restore"],
      ),
    ).rejects.toThrow(/SHA-256/);
  });
});
