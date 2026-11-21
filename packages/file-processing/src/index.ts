export const FILE_PROCESSING_VERSION = 1 as const;

export {
  calculateStreamSha256,
  type ChecksumErrorCode,
  ChecksumValidationError,
  createSha256HashingTransform,
  isChecksumEqualConstantTime,
  normalizeSha256Hex,
  PLACEHOLDER_SHA256_HEX,
  type Sha256HashingTransformOptions,
  type StreamChecksumOptions,
  type StreamChecksumResult,
  type StreamChecksumVerificationResult,
  type VerifyStreamSha256Options,
  verifyStreamSha256,
} from "./checksum.js";

export {
  type ContentDetectionPolicy,
  type ContentRejectionCode,
  type ContentRejectionRecord,
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_HEADER_SAMPLE_BYTES,
  type DetectedContentSignature,
  detectMimeFromBytes,
  type FileContentInspectionAccepted,
  type FileContentInspectionInput,
  type FileContentInspectionRejected,
  type FileContentInspectionResult,
  inspectFileContent,
  inspectFileContentFromStream,
  normalizeDeclaredMimeType,
  SAFE_REJECTION_MAX_LENGTH,
  type SafeRejectionRecorderPort,
} from "./content-detection.js";
