import { describe, expect, it, vi } from "vitest";
import type { AuditEventInput, AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type {
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
} from "../ports/document-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import type { UploadSessionRepositoryPort } from "../ports/upload-session-repository.port.js";
import {
  type DocumentShareLinkEntity,
  type DocumentShareLinkRepositoryPort,
  type ShareLinkCryptoPort,
  computeShareLinkStatus,
  createDocumentShareService,
} from "./document-share.js";
import type { DocumentEntity, DocumentVersionEntity, FileObjectEntity } from "./document.types.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const VER_ID = "550e8400-e29b-41d4-a716-446655440002";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440003";
const USER_ID = "550e8400-e29b-41d4-a716-446655440010";
const LINK_ID = "550e8400-e29b-41d4-a716-446655440020";

function makeHarness(
  options: {
    readonly docStatus?: DocumentEntity["status"];
    readonly fileStatus?: FileObjectEntity["status"];
    readonly currentTime?: Date;
  } = {},
) {
  const fixedNow = options.currentTime ?? new Date("2026-11-25T12:00:00.000Z");
  let activeNow = fixedNow;

  const doc: DocumentEntity = {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Relatório Confidencial",
    categoryId: "550e8400-e29b-41d4-a716-446655440099",
    folderId: null,
    status: options.docStatus ?? "APPROVED",
    currentVersionId: VER_ID,
    ownerUserId: USER_ID,
    issueDate: null,
    expirationDate: null,
    metadata: {},
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const version: DocumentVersionEntity = {
    id: VER_ID,
    documentId: DOC_ID,
    versionNumber: 1,
    fileObjectId: FILE_ID,
    uploadedByUserId: USER_ID,
    changeNote: null,
    createdAt: "2026-01-01T00:00:00Z",
  };

  const file: FileObjectEntity = {
    id: FILE_ID,
    storageConnectionId: "550e8400-e29b-41d4-a716-446655440050",
    objectKey: `org/${ORG_ID}/documents/${DOC_ID}/versions/${VER_ID}/${FILE_ID}`,
    originalFileName: "relatorio.pdf",
    detectedContentType: "application/pdf",
    sizeBytes: 1024,
    checksumSha256: "a".repeat(64),
    status: options.fileStatus ?? "AVAILABLE",
    createdAt: "2026-01-01T00:00:00Z",
  };

  const links = new Map<string, DocumentShareLinkEntity>();
  const audits: AuditEventInput[] = [];

  const crypto: ShareLinkCryptoPort = {
    generateRawToken: () => "raw-secret-share-token-0123456789abcdef",
    hashToken: (raw) => `hash:${raw}`,
    hashPasscode: async (plain) => `argon2:${plain}`,
    verifyPasscode: async (plain, hash) => hash === `argon2:${plain}`,
    issueUnlockProof: (tokenHash, exp) => `proof|${tokenHash}|${exp}`,
    verifyUnlockProof: (tokenHash, unlock, nowSec) => {
      const parts = unlock.split("|");
      return parts[0] === "proof" && parts[1] === tokenHash && Number(parts[2]) > nowSec;
    },
  };

  const shareLinksRepo: DocumentShareLinkRepositoryPort = {
    async create(input) {
      const entity: DocumentShareLinkEntity = {
        id: input.id,
        organizationId: input.organizationId,
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        tokenHash: input.tokenHash,
        label: input.label,
        allowDownload: input.allowDownload,
        passcodeHash: input.passcodeHash,
        maxUses: input.maxUses,
        useCount: 0,
        expiresAt: input.expiresAt.toISOString(),
        revokedAt: null,
        revokedByUserId: null,
        lastAccessedAt: null,
        createdBy: { id: input.createdByUserId, fullName: "Ana Gestora" },
        createdAt: input.createdAt.toISOString(),
      };
      links.set(entity.id, entity);
      return entity;
    },
    async listByDocument({ organizationId, documentId }) {
      return [...links.values()].filter(
        (l) => l.organizationId === organizationId && l.documentId === documentId,
      );
    },
    async findById(id) {
      return links.get(id) ?? null;
    },
    async findByTokenHash(tokenHash) {
      return [...links.values()].find((l) => l.tokenHash === tokenHash) ?? null;
    },
    async revokeById({ id, revokedByUserId, revokedAt }) {
      const current = links.get(id);
      if (!current) {
        return null;
      }
      const next: DocumentShareLinkEntity = {
        ...current,
        revokedAt: revokedAt.toISOString(),
        revokedByUserId,
      };
      links.set(id, next);
      return next;
    },
    async consumeUseAtomically({ id, now }) {
      const current = links.get(id);
      if (!current || computeShareLinkStatus(current, now) !== "ACTIVE") {
        return null;
      }
      const next: DocumentShareLinkEntity = {
        ...current,
        useCount: current.useCount + 1,
        lastAccessedAt: now.toISOString(),
      };
      links.set(id, next);
      return next;
    },
  };

  const service = createDocumentShareService({
    shareLinks: shareLinksRepo,
    documents: { findById: vi.fn(async () => doc) } as unknown as DocumentRepositoryPort,
    documentVersions: {
      findById: vi.fn(async () => version),
    } as unknown as DocumentVersionRepositoryPort,
    uploads: {
      findFileObjectOrganizationId: vi.fn(async () => ORG_ID),
      findFileObjectById: vi.fn(async () => file),
    } as unknown as UploadSessionRepositoryPort,
    transactions: {
      async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return fn({} as TransactionContext);
      },
    } as TransactionManagerPort,
    audit: {
      append: vi.fn(async (input: AuditEventInput) => {
        audits.push(input);
        return { id: `audit-${audits.length}`, occurredAt: activeNow.toISOString(), ...input };
      }),
      list: vi.fn(),
    } as unknown as AuditRepositoryPort,
    crypto,
    generateId: () => LINK_ID,
    now: () => activeNow,
  });

  return {
    service,
    audits,
    links,
    advanceMinutes: (minutes: number) => {
      activeNow = new Date(activeNow.getTime() + minutes * 60_000);
    },
  };
}

describe("DocumentShareService", () => {
  it("creates hashed token link with passcode, enforces atomic maxUses, blocks disabled download, and never logs secrets", async () => {
    const { service, audits, links } = makeHarness();

    const created = await service.createShareLink({
      organizationId: ORG_ID,
      documentId: DOC_ID,
      actorUserId: USER_ID,
      requestId: "req-1",
      expiresInMinutes: 60,
      maxUses: 1,
      allowDownload: false,
      passcode: "Segredo123!",
      label: "Conselho Fiscal",
    });

    expect(created.shareToken).toBe("raw-secret-share-token-0123456789abcdef");
    const stored = links.get(LINK_ID);
    expect(stored?.tokenHash).toBe("hash:raw-secret-share-token-0123456789abcdef");
    expect(stored?.passcodeHash).toBe("argon2:Segredo123!");
    expect(JSON.stringify(audits[0])).not.toContain(created.shareToken);
    expect(JSON.stringify(audits[0])).not.toContain("Segredo123!");

    // Delivery requires passcode first
    await expect(
      service.consumeForDelivery({
        rawToken: created.shareToken,
        delivery: "PREVIEW",
        requestId: "req-2",
      }),
    ).rejects.toMatchObject({ code: "SHARE_PASSCODE_REQUIRED" });

    // Invalid passcode fails and records DENIED audit
    await expect(
      service.unlockPublicShare({
        rawToken: created.shareToken,
        passcode: "Errada!",
        requestId: "req-3",
      }),
    ).rejects.toMatchObject({ code: "SHARE_PASSCODE_INVALID" });

    const { unlockToken } = await service.unlockPublicShare({
      rawToken: created.shareToken,
      passcode: "Segredo123!",
      requestId: "req-4",
    });

    // Download blocked when allowDownload=false without consuming preview quota
    await expect(
      service.consumeForDelivery({
        rawToken: created.shareToken,
        delivery: "DOWNLOAD",
        unlockToken,
        requestId: "req-5",
      }),
    ).rejects.toMatchObject({ code: "SHARE_DOWNLOAD_FORBIDDEN" });

    // First preview succeeds and exhausts maxUses=1
    const delivered = await service.consumeForDelivery({
      rawToken: created.shareToken,
      delivery: "PREVIEW",
      unlockToken,
      requestId: "req-6",
    });
    expect(delivered.shareLink.useCount).toBe(1);

    // Second preview fails uniformly as unavailable
    await expect(
      service.consumeForDelivery({
        rawToken: created.shareToken,
        delivery: "PREVIEW",
        unlockToken,
        requestId: "req-7",
      }),
    ).rejects.toMatchObject({ code: "SHARE_LINK_UNAVAILABLE" });
  });

  it("blocks quarantined files and expires links after TTL", async () => {
    const quarantined = makeHarness({ fileStatus: "QUARANTINED" });
    await expect(
      quarantined.service.createShareLink({
        organizationId: ORG_ID,
        documentId: DOC_ID,
        actorUserId: USER_ID,
        requestId: "req-q",
        expiresInMinutes: 60,
        allowDownload: true,
      }),
    ).rejects.toMatchObject({ code: "FILE_NOT_AVAILABLE_FOR_SHARE" });

    const expiring = makeHarness();
    const issued = await expiring.service.createShareLink({
      organizationId: ORG_ID,
      documentId: DOC_ID,
      actorUserId: USER_ID,
      requestId: "req-e1",
      expiresInMinutes: 15,
      allowDownload: true,
    });
    expiring.advanceMinutes(16);

    await expect(
      expiring.service.getPublicMetadata({ rawToken: issued.shareToken }),
    ).rejects.toMatchObject({ code: "SHARE_LINK_UNAVAILABLE" });
  });
});
