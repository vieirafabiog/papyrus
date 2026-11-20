export class DomainError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export {
  DOCUMENT_STATUSES,
  type DocumentEntity,
  type DocumentMetadataMap,
  type DocumentMetadataValue,
  type DocumentStatus,
  type DocumentVersionEntity,
  FILE_OBJECT_STATUSES,
  type FileObjectEntity,
  type FileObjectStatus,
} from "./documents/document.types.js";
