import { DomainError } from "../index.js";
import type { DocumentStatus, FileObjectStatus } from "./document.types.js";

export const ALLOWED_DOCUMENT_TRANSITIONS: Readonly<
  Record<DocumentStatus, readonly DocumentStatus[]>
> = {
  DRAFT: ["IN_REVIEW", "ARCHIVED", "DELETED"],
  IN_REVIEW: ["APPROVED", "REJECTED", "DRAFT", "DELETED"],
  APPROVED: ["IN_REVIEW", "ARCHIVED", "EXPIRED", "DELETED"],
  REJECTED: ["DRAFT", "IN_REVIEW", "ARCHIVED", "DELETED"],
  ARCHIVED: ["DRAFT", "DELETED"],
  EXPIRED: ["IN_REVIEW", "ARCHIVED", "DELETED"],
  DELETED: ["DRAFT", "ARCHIVED"],
};

export function canTransitionDocumentStatus(from: DocumentStatus, to: DocumentStatus): boolean {
  if (from === to) {
    return false;
  }
  return ALLOWED_DOCUMENT_TRANSITIONS[from].includes(to);
}

export function assertDocumentStatusTransition(from: DocumentStatus, to: DocumentStatus): void {
  if (!canTransitionDocumentStatus(from, to)) {
    throw new DomainError(
      "INVALID_DOCUMENT_TRANSITION",
      `Transição de estado documental não permitida: ${from} -> ${to}.`,
    );
  }
}

export function isFileObjectDownloadable(status: FileObjectStatus): boolean {
  return status === "AVAILABLE";
}

export function canSubmitDocumentForReview(
  documentStatus: DocumentStatus,
  fileObjectStatus: FileObjectStatus | null,
): boolean {
  return (
    canTransitionDocumentStatus(documentStatus, "IN_REVIEW") && fileObjectStatus === "AVAILABLE"
  );
}
