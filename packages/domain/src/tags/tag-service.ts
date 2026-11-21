import { normalizeCategoryColor } from "../categories/category-service.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { DocumentRepositoryPort, PaginatedResult } from "../ports/document-repository.port.js";
import type { TagRepositoryPort } from "../ports/tag-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { TagEntity, TagListFilter } from "./tag.types.js";

export const MAX_TAG_NAME_LENGTH = 64;

export interface TagServiceDependencies {
  readonly tags: TagRepositoryPort;
  readonly documents: DocumentRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
}

export interface CreateTagCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly name: string;
  readonly color?: string | null | undefined;
}

export interface AttachDocumentTagCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly tagId: string;
}

export interface DetachDocumentTagCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly tagId: string;
}

export interface TagService {
  listTags(filter: TagListFilter): Promise<PaginatedResult<TagEntity>>;
  createTag(command: CreateTagCommand): Promise<TagEntity>;
  listDocumentTags(organizationId: string, documentId: string): Promise<readonly TagEntity[]>;
  attachTagToDocument(command: AttachDocumentTagCommand): Promise<readonly TagEntity[]>;
  detachTagFromDocument(command: DetachDocumentTagCommand): Promise<readonly TagEntity[]>;
}

/**
 * Normalizes a tag display name and its lowercase uniqueness key.
 */
export function normalizeTagName(rawName: string): {
  readonly name: string;
  readonly normalizedName: string;
} {
  const name = rawName.trim();
  if (name.length === 0) {
    throw new DomainError("INVALID_TAG_NAME", "O nome da etiqueta é obrigatório.");
  }
  if (name.length > MAX_TAG_NAME_LENGTH) {
    throw new DomainError(
      "INVALID_TAG_NAME",
      `O nome da etiqueta deve ter no máximo ${MAX_TAG_NAME_LENGTH} caracteres.`,
    );
  }
  return {
    name,
    normalizedName: name.toLowerCase(),
  };
}

/**
 * Creates the domain service responsible for organization tags and document tag associations.
 */
export function createTagService(deps: TagServiceDependencies): TagService {
  return {
    async listTags(filter: TagListFilter): Promise<PaginatedResult<TagEntity>> {
      return deps.tags.list(filter);
    },

    async createTag(command: CreateTagCommand): Promise<TagEntity> {
      const { name, normalizedName } = normalizeTagName(command.name);
      const color = normalizeCategoryColor(command.color);

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.tags.findByNormalizedName(
          command.organizationId,
          normalizedName,
          tx,
        );
        if (existing) {
          throw new DomainError(
            "TAG_ALREADY_EXISTS",
            "Já existe uma etiqueta cadastrada com este nome.",
          );
        }

        const created = await deps.tags.create(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            name,
            normalizedName,
            color,
            createdBy: command.actorUserId,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "TAG_CREATED",
            resourceType: "TAG",
            resourceId: created.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              name: created.name,
            },
          },
          tx,
        );

        return created;
      });
    },

    async listDocumentTags(
      organizationId: string,
      documentId: string,
    ): Promise<readonly TagEntity[]> {
      const document = await deps.documents.findById(documentId);
      if (!document || document.organizationId !== organizationId) {
        throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
      }
      return deps.tags.listDocumentTags(organizationId, documentId);
    },

    async attachTagToDocument(command: AttachDocumentTagCommand): Promise<readonly TagEntity[]> {
      return deps.transactions.runInTransaction(async (tx) => {
        const document = await deps.documents.findById(command.documentId, tx);
        if (!document || document.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        const tag = await deps.tags.findById(command.tagId, tx);
        if (!tag || tag.organizationId !== command.organizationId) {
          throw new DomainError("TAG_NOT_FOUND", "Etiqueta não encontrada.");
        }

        const alreadyAttached = await deps.tags.isAttachedToDocument(document.id, tag.id, tx);
        if (alreadyAttached) {
          throw new DomainError(
            "DOCUMENT_TAG_ALREADY_ATTACHED",
            "Esta etiqueta já está associada ao documento.",
          );
        }

        await deps.tags.attachToDocument(
          {
            id: deps.generateId(),
            documentId: document.id,
            tagId: tag.id,
            createdBy: command.actorUserId,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_TAG_ATTACHED",
            resourceType: "DOCUMENT",
            resourceId: document.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              tagId: tag.id,
              tagName: tag.name,
            },
          },
          tx,
        );

        return deps.tags.listDocumentTags(command.organizationId, document.id, tx);
      });
    },

    async detachTagFromDocument(command: DetachDocumentTagCommand): Promise<readonly TagEntity[]> {
      return deps.transactions.runInTransaction(async (tx) => {
        const document = await deps.documents.findById(command.documentId, tx);
        if (!document || document.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        const tag = await deps.tags.findById(command.tagId, tx);
        if (!tag || tag.organizationId !== command.organizationId) {
          throw new DomainError("TAG_NOT_FOUND", "Etiqueta não encontrada.");
        }

        const removed = await deps.tags.detachFromDocument(document.id, tag.id, tx);
        if (!removed) {
          throw new DomainError(
            "DOCUMENT_TAG_NOT_FOUND",
            "Etiqueta não está associada a este documento.",
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "DOCUMENT_TAG_DETACHED",
            resourceType: "DOCUMENT",
            resourceId: document.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              tagId: tag.id,
              tagName: tag.name,
            },
          },
          tx,
        );

        return deps.tags.listDocumentTags(command.organizationId, document.id, tx);
      });
    },
  };
}
