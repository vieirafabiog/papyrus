export { extractTextFromBuffer, extractTextFromStream } from "./extractor.js";
export {
  createExtractedTextIndexRepository,
  extractAndIndexDocumentVersionText,
  type ExtractedTextIndexRepository,
  type ExtractedTextIndexSaveResult,
  type ExtractedTextSearchHit,
  type ExtractedTextSearchResult,
  type PostgresSqlExecutor,
  type SaveExtractedTextInput,
  type SearchExtractedTextQuery,
} from "./postgres-index.js";
export {
  evaluateAndNormalizeExtractedText,
  type TextQualityEvaluationResult,
} from "./quality.js";
export {
  createTextExtractionPolicy,
  DEFAULT_TEXT_EXTRACTION_MIME_TYPES,
  DEFAULT_TEXT_EXTRACTION_POLICY,
  type PostgresFtsConfig,
  type SupportedTextExtractionMime,
  type TextExtractionOutcome,
  type TextExtractionPolicy,
  type TextExtractorKind,
} from "./types.js";
