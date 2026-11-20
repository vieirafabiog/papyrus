import { createRequire } from "node:module";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import type { pushSchema as PushSchemaFn } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categories,
  documents,
  documentVersions,
  fileObjects,
  organizations,
  storageConnections,
  users,
  workflowDecisions,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowInstances,
  workflowTasks,
} from "../src/index.js";
import * as documentSchema from "../src/schema/documents.js";
import * as governanceSchema from "../src/schema/governance.js";
import * as identitySchema from "../src/schema/identity.js";
import * as storageSchema from "../src/schema/storage.js";
import * as taxonomySchema from "../src/schema/taxonomy.js";
import * as workflowSchema from "../src/schema/workflows.js";

const VALID_SHA256 = "a".repeat(64);

describe("PostgreSQL schema indexes and integrity constraints", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;

  beforeAll(async () => {
    const externalUrl = process.env["DATABASE_URL"];
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = container.getConnectionUri();
    }

    pool = new Pool({ connectionString });
    const db = drizzle(pool);
    const mergedSchema = {
      ...identitySchema,
      ...taxonomySchema,
      ...storageSchema,
      ...documentSchema,
      ...workflowSchema,
      ...governanceSchema,
    };
    const require = createRequire(import.meta.url);
    const { pushSchema } = require("drizzle-kit/api") as { pushSchema: typeof PushSchemaFn };
    const pushed = await pushSchema(mergedSchema, db);
    await pushed.apply();
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("enforces unique object keys, unique document version numbers, check constraints, and restrict deletes", async () => {
    const db = drizzle(pool);

    const [org] = await db
      .insert(organizations)
      .values({ name: "ACME Corp", slug: "acme-corp" })
      .returning();
    expect(org).toBeDefined();
    if (!org) {
      throw new Error("Expected organization to be created");
    }

    const [user] = await db
      .insert(users)
      .values({
        organizationId: org.id,
        email: "admin@acme.invalid",
        fullName: "Admin ACME",
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$salt$hash",
      })
      .returning();
    if (!user) {
      throw new Error("Expected user to be created");
    }

    const [conn] = await db
      .insert(storageConnections)
      .values({
        organizationId: org.id,
        name: "Local Primary",
        kind: "local",
        isDefault: true,
        nonSecretConfig: { rootPath: "/var/lib/docuflow" },
      })
      .returning();
    if (!conn) {
      throw new Error("Expected storage connection to be created");
    }

    const [cat] = await db
      .insert(categories)
      .values({
        organizationId: org.id,
        name: "Contratos",
      })
      .returning();
    if (!cat) {
      throw new Error("Expected category to be created");
    }

    const [file1] = await db
      .insert(fileObjects)
      .values({
        organizationId: org.id,
        storageConnectionId: conn.id,
        objectKey: `org/${org.id}/documents/d1/versions/v1/f1`,
        originalFileName: "contrato.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: VALID_SHA256,
        status: "AVAILABLE",
      })
      .returning();
    if (!file1) {
      throw new Error("Expected file object to be created");
    }

    // Duplicate (storageConnectionId, objectKey) must fail
    await expect(
      db.insert(fileObjects).values({
        organizationId: org.id,
        storageConnectionId: conn.id,
        objectKey: file1.objectKey,
        originalFileName: "outro.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: VALID_SHA256,
        status: "AVAILABLE",
      }),
    ).rejects.toThrow();

    // Invalid SHA-256 checksum must fail check constraint
    await expect(
      db.insert(fileObjects).values({
        organizationId: org.id,
        storageConnectionId: conn.id,
        objectKey: `org/${org.id}/documents/d1/versions/v1/f-bad`,
        originalFileName: "bad.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 100,
        checksumSha256: "not-a-sha256",
        status: "UPLOADING",
      }),
    ).rejects.toThrow();

    // Document with expirationDate < issueDate must fail check constraint
    await expect(
      db.insert(documents).values({
        organizationId: org.id,
        title: "Contrato Inválido",
        categoryId: cat.id,
        ownerUserId: user.id,
        issueDate: "2026-11-20",
        expirationDate: "2026-10-01",
      }),
    ).rejects.toThrow();

    const [doc] = await db
      .insert(documents)
      .values({
        organizationId: org.id,
        title: "Contrato Válido",
        categoryId: cat.id,
        ownerUserId: user.id,
        issueDate: "2026-11-20",
        expirationDate: "2027-11-20",
      })
      .returning();
    if (!doc) {
      throw new Error("Expected document to be created");
    }

    await db.insert(documentVersions).values({
      documentId: doc.id,
      versionNumber: 1,
      fileObjectId: file1.id,
      uploadedByUserId: user.id,
    });

    // Duplicate (documentId, versionNumber) must fail
    await expect(
      db.insert(documentVersions).values({
        documentId: doc.id,
        versionNumber: 1,
        fileObjectId: file1.id,
        uploadedByUserId: user.id,
      }),
    ).rejects.toThrow();

    // Restrict delete: cannot delete storage connection referenced by fileObjects
    await expect(
      db.delete(storageConnections).where(eq(storageConnections.id, conn.id)),
    ).rejects.toThrow();

    // Workflow decision requires comment when rejecting
    const [wfDef] = await db
      .insert(workflowDefinitions)
      .values({ organizationId: org.id, name: "Aprovação Padrão", latestVersionNumber: 1 })
      .returning();
    if (!wfDef) {
      throw new Error("Expected workflow definition");
    }
    const [wfDefVer] = await db
      .insert(workflowDefinitionVersions)
      .values({
        workflowDefinitionId: wfDef.id,
        versionNumber: 1,
        steps: [
          {
            stepOrder: 1,
            name: "Jurídico",
            assigneeType: "USER",
            assigneeTargetId: user.id,
            dueDays: 3,
          },
        ],
      })
      .returning();
    if (!wfDefVer) {
      throw new Error("Expected workflow definition version");
    }
    const [docVer] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, doc.id));
    if (!docVer) {
      throw new Error("Expected document version");
    }
    const [wfInst] = await db
      .insert(workflowInstances)
      .values({
        organizationId: org.id,
        documentId: doc.id,
        documentVersionId: docVer.id,
        workflowDefinitionVersionId: wfDefVer.id,
        startedByUserId: user.id,
      })
      .returning();
    if (!wfInst) {
      throw new Error("Expected workflow instance");
    }
    const [task] = await db
      .insert(workflowTasks)
      .values({
        organizationId: org.id,
        workflowInstanceId: wfInst.id,
        documentId: doc.id,
        documentVersionId: docVer.id,
        stepOrder: 1,
        assigneeType: "USER",
        assigneeTargetId: user.id,
      })
      .returning();
    if (!task) {
      throw new Error("Expected workflow task");
    }

    await expect(
      db.insert(workflowDecisions).values({
        organizationId: org.id,
        taskId: task.id,
        actorUserId: user.id,
        decision: "REJECT",
        comment: null,
      }),
    ).rejects.toThrow();
  });
});
