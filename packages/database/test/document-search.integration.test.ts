import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AuthorizedDocumentQueryScope,
  categories,
  categoryFields,
  createDocumentSearchRepository,
  createTagRepository,
  documentMetadata,
  documentVersions,
  documents,
  fileObjects,
  folders,
  organizations,
  storageConnections,
  users,
} from "../src/index.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../drizzle");

const GLOBAL_ALLOW_SCOPE: AuthorizedDocumentQueryScope = {
  hasGlobalDeny: false,
  hasGlobalAllow: true,
  allowedCategoryIds: [],
  allowedFolderIds: [],
  allowedDocumentIds: [],
  deniedCategoryIds: [],
  deniedFolderIds: [],
  deniedDocumentIds: [],
};

describe("Document advanced search repository PostgreSQL integration", () => {
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
    pool.on("error", () => {});
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("filters by name/fileName, category, folder subtree, status, author, owner, dates, tags, typed metadata, sorting and pre-count authz", async () => {
    const db = drizzle(pool);
    const searchRepo = createDocumentSearchRepository(db);
    const tagRepo = createTagRepository(db);

    const orgId = randomUUID();
    const authorAId = randomUUID();
    const authorBId = randomUUID();
    const ownerAId = randomUUID();
    const ownerBId = randomUUID();
    const catContractsId = randomUUID();
    const catInvoicesId = randomUUID();
    const folderRootId = randomUUID();
    const folderChildId = randomUUID();
    const folderDeniedId = randomUUID();
    const storageId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Search Org",
      slug: `search-org-${orgId.slice(0, 8)}`,
    });

    await db.insert(users).values([
      {
        id: authorAId,
        organizationId: orgId,
        email: "author-a@docuflow.local",
        fullName: "Autor A",
        passwordHash: "$argon2id$v=19$m=8192,t=2,p=1$salt$hash",
        status: "ACTIVE",
      },
      {
        id: authorBId,
        organizationId: orgId,
        email: "author-b@docuflow.local",
        fullName: "Autor B",
        passwordHash: "$argon2id$v=19$m=8192,t=2,p=1$salt$hash",
        status: "ACTIVE",
      },
      {
        id: ownerAId,
        organizationId: orgId,
        email: "owner-a@docuflow.local",
        fullName: "Responsável A",
        passwordHash: "$argon2id$v=19$m=8192,t=2,p=1$salt$hash",
        status: "ACTIVE",
      },
      {
        id: ownerBId,
        organizationId: orgId,
        email: "owner-b@docuflow.local",
        fullName: "Responsável B",
        passwordHash: "$argon2id$v=19$m=8192,t=2,p=1$salt$hash",
        status: "ACTIVE",
      },
    ]);

    await db.insert(categories).values([
      { id: catContractsId, organizationId: orgId, name: "Contratos", isActive: true },
      { id: catInvoicesId, organizationId: orgId, name: "Notas Fiscais", isActive: true },
    ]);

    const fieldSupplierId = randomUUID();
    const fieldAmountId = randomUUID();
    const fieldConfidentialId = randomUUID();
    const fieldAreasId = randomUUID();

    await db.insert(categoryFields).values([
      {
        id: fieldSupplierId,
        categoryId: catContractsId,
        key: "fornecedor",
        label: "Fornecedor",
        type: "TEXT",
        required: true,
        sortOrder: 0,
      },
      {
        id: fieldAmountId,
        categoryId: catContractsId,
        key: "valor",
        label: "Valor",
        type: "NUMBER",
        required: false,
        sortOrder: 1,
      },
      {
        id: fieldConfidentialId,
        categoryId: catContractsId,
        key: "sigilo",
        label: "Sigilo",
        type: "BOOLEAN",
        required: false,
        sortOrder: 2,
      },
      {
        id: fieldAreasId,
        categoryId: catContractsId,
        key: "areas",
        label: "Áreas",
        type: "MULTI_SELECT",
        required: false,
        options: ["JURIDICO", "FINANCEIRO", "RH"],
        sortOrder: 3,
      },
    ]);

    await db.insert(folders).values([
      {
        id: folderRootId,
        organizationId: orgId,
        parentId: null,
        name: "Jurídico",
        materializedPath: `/${folderRootId}`,
        status: "ACTIVE",
      },
      {
        id: folderChildId,
        organizationId: orgId,
        parentId: folderRootId,
        name: "2026",
        materializedPath: `/${folderRootId}/${folderChildId}`,
        status: "ACTIVE",
      },
      {
        id: folderDeniedId,
        organizationId: orgId,
        parentId: null,
        name: "Restrito",
        materializedPath: `/${folderDeniedId}`,
        status: "ACTIVE",
      },
    ]);

    await db.insert(storageConnections).values({
      id: storageId,
      organizationId: orgId,
      name: "Local Search",
      kind: "local",
      status: "ACTIVE",
      isDefault: true,
      nonSecretConfig: { rootDirectory: "/tmp/docuflow-search-test" },
    });

    const tagPriority = await tagRepo.create({
      id: randomUUID(),
      organizationId: orgId,
      name: "Prioritário",
      normalizedName: "prioritário",
      color: "#C62828",
    });

    const doc1Id = randomUUID();
    const doc2Id = randomUUID();
    const doc3DeniedId = randomUUID();
    const doc4DeletedId = randomUUID();

    const file1Id = randomUUID();
    const file2Id = randomUUID();
    const ver1Id = randomUUID();
    const ver2Id = randomUUID();

    await db.insert(fileObjects).values([
      {
        id: file1Id,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/f1`,
        originalFileName: "contrato_acme_anexo_especial.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: "a".repeat(64),
        status: "AVAILABLE",
      },
      {
        id: file2Id,
        organizationId: orgId,
        storageConnectionId: storageId,
        objectKey: `org/${orgId}/f2`,
        originalFileName: "nota_beta.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 2048,
        checksumSha256: "b".repeat(64),
        status: "AVAILABLE",
      },
    ]);

    await db.insert(documents).values([
      {
        id: doc1Id,
        organizationId: orgId,
        title: "Acordo Comercial Alpha",
        categoryId: catContractsId,
        folderId: folderChildId,
        status: "APPROVED",
        ownerUserId: ownerAId,
        issueDate: "2026-01-15",
        expirationDate: "2026-06-30",
        metadata: {
          fornecedor: "ACME Tecnologia",
          valor: 25000,
          sigilo: true,
          areas: ["JURIDICO", "FINANCEIRO"],
        },
        createdBy: authorAId,
        updatedBy: authorAId,
        createdAt: new Date("2026-01-15T10:00:00Z"),
        updatedAt: new Date("2026-01-16T10:00:00Z"),
      },
      {
        id: doc2Id,
        organizationId: orgId,
        title: "Fatura Beta",
        categoryId: catInvoicesId,
        folderId: folderRootId,
        status: "DRAFT",
        ownerUserId: ownerBId,
        issueDate: "2026-02-01",
        expirationDate: "2026-12-31",
        metadata: {},
        createdBy: authorBId,
        updatedBy: authorBId,
        createdAt: new Date("2026-02-01T10:00:00Z"),
        updatedAt: new Date("2026-02-02T10:00:00Z"),
      },
      {
        id: doc3DeniedId,
        organizationId: orgId,
        title: "Acordo Comercial Confidencial",
        categoryId: catContractsId,
        folderId: folderDeniedId,
        status: "APPROVED",
        ownerUserId: ownerAId,
        issueDate: "2026-01-20",
        expirationDate: "2026-07-15",
        metadata: {
          fornecedor: "ACME Secreta",
          valor: 99000,
          sigilo: true,
          areas: ["JURIDICO"],
        },
        createdBy: authorAId,
        updatedBy: authorAId,
      },
      {
        id: doc4DeletedId,
        organizationId: orgId,
        title: "Acordo Excluído",
        categoryId: catContractsId,
        folderId: folderChildId,
        status: "DELETED",
        ownerUserId: ownerAId,
        createdBy: authorAId,
        updatedBy: authorAId,
      },
    ]);

    await db.insert(documentVersions).values([
      {
        id: ver1Id,
        documentId: doc1Id,
        versionNumber: 1,
        fileObjectId: file1Id,
        uploadedByUserId: authorAId,
      },
      {
        id: ver2Id,
        documentId: doc2Id,
        versionNumber: 1,
        fileObjectId: file2Id,
        uploadedByUserId: authorBId,
      },
    ]);

    await db.insert(documentMetadata).values([
      {
        documentId: doc1Id,
        fieldId: fieldSupplierId,
        fieldKey: "fornecedor",
        valueText: "ACME Tecnologia",
      },
      {
        documentId: doc1Id,
        fieldId: fieldAmountId,
        fieldKey: "valor",
        valueNumber: 25000,
      },
      {
        documentId: doc1Id,
        fieldId: fieldConfidentialId,
        fieldKey: "sigilo",
        valueBoolean: true,
      },
      {
        documentId: doc1Id,
        fieldId: fieldAreasId,
        fieldKey: "areas",
        valueJson: ["JURIDICO", "FINANCEIRO"],
      },
      {
        documentId: doc3DeniedId,
        fieldId: fieldSupplierId,
        fieldKey: "fornecedor",
        valueText: "ACME Secreta",
      },
    ]);

    await tagRepo.attachToDocument({
      documentId: doc1Id,
      tagId: tagPriority.id,
      createdBy: authorAId,
    });

    // Update currentVersionId so filename search finds doc1 via currentVersion -> fileObject
    const { eq: drizzleEq } = await import("drizzle-orm");
    await db
      .update(documents)
      .set({ currentVersionId: ver1Id })
      .where(drizzleEq(documents.id, doc1Id));
    await db
      .update(documents)
      .set({ currentVersionId: ver2Id })
      .where(drizzleEq(documents.id, doc2Id));

    // 1. Search by originalFileName + exclude DELETED + pre-count authz (deniedFolderId hides doc3DeniedId)
    const restrictedScope: AuthorizedDocumentQueryScope = {
      ...GLOBAL_ALLOW_SCOPE,
      deniedFolderIds: [folderDeniedId],
    };

    const byFileName = await searchRepo.searchAuthorizedDocuments(
      {
        organizationId: orgId,
        search: "anexo_especial",
        page: 1,
        pageSize: 10,
        sortBy: "title",
        sortDirection: "asc",
      },
      restrictedScope,
    );
    expect(byFileName.totalItems).toBe(1);
    expect(byFileName.items.map((i) => i.id)).toEqual([doc1Id]);

    // 2. Folder subtree filter finds child folder doc1Id when querying root folder with includeSubfolders
    const subtreeResult = await searchRepo.searchAuthorizedDocuments(
      {
        organizationId: orgId,
        folderId: folderRootId,
        includeSubfolders: true,
        page: 1,
        pageSize: 10,
        sortBy: "title",
        sortDirection: "asc",
      },
      restrictedScope,
    );
    expect(subtreeResult.items.map((i) => i.id)).toEqual([doc1Id, doc2Id]);

    // 3. Combined author, owner, issue/expiration/created dates, tag, and typed metadata filters
    const combined = await searchRepo.searchAuthorizedDocuments(
      {
        organizationId: orgId,
        categoryId: catContractsId,
        status: "APPROVED",
        authorUserId: authorAId,
        ownerUserId: ownerAId,
        issueDateFrom: "2026-01-01",
        issueDateTo: "2026-01-31",
        expirationFrom: "2026-06-01",
        expirationTo: "2026-07-01",
        createdFrom: "2026-01-15",
        createdTo: "2026-01-15",
        tagIds: [tagPriority.id],
        metadataFilters: [
          { fieldKey: "fornecedor", type: "TEXT", value: "acme", matchMode: "contains" },
          { fieldKey: "valor", type: "NUMBER", min: 20000, max: 30000 },
          { fieldKey: "sigilo", type: "BOOLEAN", value: true },
          { fieldKey: "areas", type: "MULTI_SELECT", values: ["JURIDICO"] },
        ],
        page: 1,
        pageSize: 10,
        sortBy: "updatedAt",
        sortDirection: "desc",
      },
      restrictedScope,
    );
    expect(combined.totalItems).toBe(1);
    expect(combined.items[0]?.id).toBe(doc1Id);

    // 4. Denied folder exclusion also prevents leakage in totalItems count
    const titleMatch = await searchRepo.searchAuthorizedDocuments(
      {
        organizationId: orgId,
        search: "Acordo",
        page: 1,
        pageSize: 10,
        sortBy: "title",
        sortDirection: "asc",
      },
      restrictedScope,
    );
    expect(titleMatch.totalItems).toBe(1);
    expect(titleMatch.items.map((i) => i.id)).toEqual([doc1Id]);

    // 5. Explicit DELETED status filter returns empty in standard search
    const deletedRes = await searchRepo.searchAuthorizedDocuments(
      {
        organizationId: orgId,
        status: "DELETED",
        page: 1,
        pageSize: 10,
        sortBy: "updatedAt",
        sortDirection: "desc",
      },
      GLOBAL_ALLOW_SCOPE,
    );
    expect(deletedRes.totalItems).toBe(0);
    expect(deletedRes.items).toEqual([]);
  }, 60_000);
});
