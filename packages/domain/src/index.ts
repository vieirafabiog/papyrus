export class DomainError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export {
  ACCESS_ACTIONS,
  ACCESS_EFFECTS,
  ACCESS_RESOURCES,
  ACCESS_SCOPE_TYPES,
  type AccessAction,
  type AccessEffect,
  type AccessResource,
  type AccessScope,
  type AccessScopeType,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AuthorizationSubject,
  type GroupEntity,
  type PermissionEntity,
  type RoleEntity,
  type RoleScopeAssignment,
  type SessionSummary,
  USER_STATUSES,
  type UserEntity,
  type UserStatus,
} from "./access/access.types.js";

export {
  type CategoryFieldDefinition,
  type CategoryFieldType,
  type MetadataValidationIssue,
  type MetadataValidationResult,
  validateDocumentMetadata,
} from "./categories/metadata-validation.js";

export {
  ALLOWED_DOCUMENT_TRANSITIONS,
  assertDocumentStatusTransition,
  canSubmitDocumentForReview,
  canTransitionDocumentStatus,
  isFileObjectDownloadable,
} from "./documents/document-state.js";

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
