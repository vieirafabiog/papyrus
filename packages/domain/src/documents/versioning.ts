import { DomainError } from "../index.js";
import type { WorkflowInstanceEntity } from "../workflows/workflow.types.js";
import type { DocumentEntity, DocumentVersionEntity } from "./document.types.js";

export interface BuildNextVersionInput {
  readonly id: string;
  readonly documentId: string;
  readonly existingVersions: readonly DocumentVersionEntity[];
  readonly fileObjectId: string;
  readonly uploadedByUserId: string;
  readonly changeNote: string | null;
  readonly createdAt: string;
}

export interface RestoreHistoricalVersionInput {
  readonly newVersionId: string;
  readonly document: DocumentEntity;
  readonly existingVersions: readonly DocumentVersionEntity[];
  readonly targetVersionId: string;
  readonly restoredByUserId: string;
  readonly createdAt: string;
}

export interface RestoredVersionResult {
  readonly restoredVersion: DocumentVersionEntity;
  readonly sourceVersion: DocumentVersionEntity;
}

export function getNextVersionNumber(existingVersions: readonly DocumentVersionEntity[]): number {
  let maxVersion = 0;
  for (const version of existingVersions) {
    if (version.versionNumber > maxVersion) {
      maxVersion = version.versionNumber;
    }
  }
  return maxVersion + 1;
}

export function buildNextDocumentVersion(input: BuildNextVersionInput): DocumentVersionEntity {
  for (const version of input.existingVersions) {
    if (version.documentId !== input.documentId) {
      throw new DomainError(
        "VERSION_DOCUMENT_MISMATCH",
        "Lista de versões contém registro de outro documento.",
      );
    }
    if (version.fileObjectId === input.fileObjectId) {
      throw new DomainError(
        "DUPLICATE_FILE_OBJECT_FOR_VERSION",
        "Nova versão deve apontar para um novo objeto binário.",
      );
    }
  }

  return {
    id: input.id,
    documentId: input.documentId,
    versionNumber: getNextVersionNumber(input.existingVersions),
    fileObjectId: input.fileObjectId,
    uploadedByUserId: input.uploadedByUserId,
    changeNote: input.changeNote,
    createdAt: input.createdAt,
  };
}

export function resolveCurrentVersion(
  document: DocumentEntity,
  versions: readonly DocumentVersionEntity[],
): DocumentVersionEntity | null {
  if (document.currentVersionId === null) {
    return null;
  }

  const found = versions.find(
    (version) => version.id === document.currentVersionId && version.documentId === document.id,
  );
  if (!found) {
    throw new DomainError(
      "CURRENT_VERSION_NOT_FOUND",
      "A versão corrente apontada pelo documento não foi encontrada.",
    );
  }
  return found;
}

export function restoreHistoricalVersion(
  input: RestoreHistoricalVersionInput,
): RestoredVersionResult {
  const sourceVersion = input.existingVersions.find(
    (version) => version.id === input.targetVersionId && version.documentId === input.document.id,
  );

  if (!sourceVersion) {
    throw new DomainError(
      "RESTORE_SOURCE_VERSION_NOT_FOUND",
      "Versão histórica informada para restauração não pertence ao documento.",
    );
  }

  const nextVersionNumber = getNextVersionNumber(input.existingVersions);
  const restoredVersion: DocumentVersionEntity = {
    id: input.newVersionId,
    documentId: input.document.id,
    versionNumber: nextVersionNumber,
    fileObjectId: sourceVersion.fileObjectId,
    uploadedByUserId: input.restoredByUserId,
    changeNote: `Restauração lógica da versão ${sourceVersion.versionNumber}`,
    createdAt: input.createdAt,
  };

  return {
    restoredVersion,
    sourceVersion,
  };
}

export function assertApprovalMatchesVersion(
  workflowInstance: WorkflowInstanceEntity,
  document: DocumentEntity,
  approvedVersionId: string,
): void {
  if (workflowInstance.documentId !== document.id) {
    throw new DomainError(
      "WORKFLOW_DOCUMENT_MISMATCH",
      "A instância de fluxo não pertence ao documento informado.",
    );
  }
  if (workflowInstance.documentVersionId !== approvedVersionId) {
    throw new DomainError(
      "APPROVAL_VERSION_MISMATCH",
      "A aprovação deve registrar exatamente a versão vinculada à instância de fluxo.",
    );
  }
}
