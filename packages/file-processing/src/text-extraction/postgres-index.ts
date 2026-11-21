import type { Readable } from "node:stream";
import { extractTextFromBuffer, extractTextFromStream } from "./extractor.js";
import type {
  PostgresFtsConfig,
  TextExtractionOutcome,
  TextExtractionPolicy,
  TextExtractorKind,
} from "./types.js";

export interface PostgresSqlExecutor {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
}

export interface SaveExtractedTextInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly fileObjectId: string;
  readonly extractorKind: TextExtractorKind;
  readonly extractedText: string;
  readonly charCount: number;
  readonly truncated: boolean;
}

export interface SearchExtractedTextQuery {
  readonly organizationId: string;
  readonly query: string;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ExtractedTextSearchHit {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly rank: number;
  readonly snippet: string;
}

export type ExtractedTextIndexSaveResult =
  | { readonly indexed: false; readonly reason: "DISABLED" }
  | { readonly indexed: true; readonly documentVersionId: string; readonly charCount: number };

export type ExtractedTextSearchResult =
  | { readonly enabled: false; readonly matches: readonly ExtractedTextSearchHit[] }
  | { readonly enabled: true; readonly matches: readonly ExtractedTextSearchHit[] };

export interface ExtractedTextIndexRepository {
  isEnabled(): boolean;
  saveAndIndex(input: SaveExtractedTextInput): Promise<ExtractedTextIndexSaveResult>;
  deleteByDocumentId(organizationId: string, documentId: string): Promise<void>;
  search(input: SearchExtractedTextQuery): Promise<ExtractedTextSearchResult>;
}

const VALID_FTS_CONFIGS: ReadonlySet<PostgresFtsConfig> = new Set([
  "portuguese",
  "simple",
  "english",
]);

function resolveFtsConfig(config: PostgresFtsConfig): PostgresFtsConfig {
  return VALID_FTS_CONFIGS.has(config) ? config : "simple";
}

/**
 * Manages persistence and PostgreSQL full-text indexing of extracted document
 * text inside the dedicated `document_extracted_texts` table (separate from binaries).
 * All writes and searches become safe no-ops when `policy.enabled` is false.
 */
export function createExtractedTextIndexRepository(deps: {
  readonly executor: PostgresSqlExecutor;
  readonly policy: TextExtractionPolicy;
}): ExtractedTextIndexRepository {
  const { executor, policy } = deps;
  const ftsConfig = resolveFtsConfig(policy.postgresFtsConfig);

  return {
    isEnabled(): boolean {
      return policy.enabled;
    },

    async saveAndIndex(input: SaveExtractedTextInput): Promise<ExtractedTextIndexSaveResult> {
      if (!policy.enabled) {
        return { indexed: false, reason: "DISABLED" };
      }

      const upsertSql = `
        INSERT INTO document_extracted_texts (
          organization_id,
          document_id,
          document_version_id,
          file_object_id,
          extractor_kind,
          language_config,
          char_count,
          truncated,
          extracted_text,
          search_vector,
          indexed_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::varchar,
          $6::varchar,
          $7::integer,
          $8::boolean,
          $9::text,
          to_tsvector($6::regconfig, $9::text),
          now()
        )
        ON CONFLICT (document_version_id)
        DO UPDATE SET
          file_object_id = EXCLUDED.file_object_id,
          extractor_kind = EXCLUDED.extractor_kind,
          language_config = EXCLUDED.language_config,
          char_count = EXCLUDED.char_count,
          truncated = EXCLUDED.truncated,
          extracted_text = EXCLUDED.extracted_text,
          search_vector = EXCLUDED.search_vector,
          indexed_at = now()
        RETURNING document_version_id AS "documentVersionId"
      `;

      await executor.query(upsertSql, [
        input.organizationId,
        input.documentId,
        input.documentVersionId,
        input.fileObjectId,
        input.extractorKind,
        ftsConfig,
        input.charCount,
        input.truncated,
        input.extractedText,
      ]);

      return {
        indexed: true,
        documentVersionId: input.documentVersionId,
        charCount: input.charCount,
      };
    },

    async deleteByDocumentId(organizationId: string, documentId: string): Promise<void> {
      await executor.query(
        "DELETE FROM document_extracted_texts WHERE organization_id = $1::uuid AND document_id = $2::uuid",
        [organizationId, documentId],
      );
    },

    async search(input: SearchExtractedTextQuery): Promise<ExtractedTextSearchResult> {
      if (!policy.enabled) {
        return { enabled: false, matches: [] };
      }

      const trimmedQuery = input.query.trim();
      if (trimmedQuery.length === 0) {
        return { enabled: true, matches: [] };
      }

      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const offset = Math.max(input.offset ?? 0, 0);

      const searchSql = `
        WITH q AS (
          SELECT websearch_to_tsquery($2::regconfig, $3::text) AS tsq
        )
        SELECT
          det.document_id AS "documentId",
          det.document_version_id AS "documentVersionId",
          ts_rank_cd(det.search_vector, q.tsq)::double precision AS "rank",
          ts_headline(
            $2::regconfig,
            det.extracted_text,
            q.tsq,
            'MaxWords=24, MinWords=8, ShortWord=3, HighlightAll=false'
          ) AS "snippet"
        FROM document_extracted_texts det
        CROSS JOIN q
        WHERE det.organization_id = $1::uuid
          AND det.search_vector @@ q.tsq
        ORDER BY "rank" DESC, det.indexed_at DESC, det.document_version_id ASC
        LIMIT $4::integer
        OFFSET $5::integer
      `;

      const result = await executor.query<{
        documentId: string;
        documentVersionId: string;
        rank: number;
        snippet: string;
      }>(searchSql, [input.organizationId, ftsConfig, trimmedQuery, limit, offset]);

      return {
        enabled: true,
        matches: result.rows.map((row) => ({
          documentId: String(row.documentId),
          documentVersionId: String(row.documentVersionId),
          rank: Number(row.rank ?? 0),
          snippet: String(row.snippet ?? ""),
        })),
      };
    },
  };
}

/**
 * Orchestrates optional text extraction and separate PostgreSQL FTS indexing for
 * an approved document version without altering or touching the underlying binary.
 */
export async function extractAndIndexDocumentVersionText(params: {
  readonly source:
    | { readonly kind: "buffer"; readonly content: Buffer; readonly mimeType: string }
    | {
        readonly kind: "stream";
        readonly stream: Readable;
        readonly mimeType: string;
        readonly declaredSizeBytes?: number | undefined;
      };
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly fileObjectId: string;
  readonly policy: TextExtractionPolicy;
  readonly indexRepository: ExtractedTextIndexRepository;
}): Promise<{
  readonly extraction: TextExtractionOutcome;
  readonly indexing: ExtractedTextIndexSaveResult;
}> {
  if (!params.policy.enabled || !params.indexRepository.isEnabled()) {
    return {
      extraction: { status: "DISABLED" },
      indexing: { indexed: false, reason: "DISABLED" },
    };
  }

  const extraction =
    params.source.kind === "buffer"
      ? await extractTextFromBuffer(
          { content: params.source.content, mimeType: params.source.mimeType },
          params.policy,
        )
      : await extractTextFromStream(
          {
            stream: params.source.stream,
            mimeType: params.source.mimeType,
            declaredSizeBytes: params.source.declaredSizeBytes,
          },
          params.policy,
        );

  if (extraction.status !== "EXTRACTED") {
    return {
      extraction,
      indexing: { indexed: false, reason: "DISABLED" },
    };
  }

  const indexing = await params.indexRepository.saveAndIndex({
    organizationId: params.organizationId,
    documentId: params.documentId,
    documentVersionId: params.documentVersionId,
    fileObjectId: params.fileObjectId,
    extractorKind: extraction.extractorKind,
    extractedText: extraction.text,
    charCount: extraction.charCount,
    truncated: extraction.truncated,
  });

  return { extraction, indexing };
}
