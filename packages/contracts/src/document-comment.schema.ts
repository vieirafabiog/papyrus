import { z } from "zod";
import {
  createApiResponseSchema,
  isoDateTimeSchema,
  paginationMetaSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema.js";

export const MAX_DOCUMENT_COMMENT_LENGTH = 2000;
export const MAX_DOCUMENT_COMMENT_MENTIONS = 20;
export const MAX_MENTION_CANDIDATES_LIMIT = 10;

export const documentCommentAuthorSchema = z.object({
  id: uuidSchema,
  fullName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(255),
});
export type DocumentCommentAuthor = z.infer<typeof documentCommentAuthorSchema>;

export const documentCommentMentionSchema = z.object({
  userId: uuidSchema,
  fullName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(255),
});
export type DocumentCommentMention = z.infer<typeof documentCommentMentionSchema>;

export const documentCommentRecordSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  documentId: uuidSchema,
  author: documentCommentAuthorSchema,
  body: z.string().min(1).max(MAX_DOCUMENT_COMMENT_LENGTH),
  mentions: z.array(documentCommentMentionSchema),
  canDelete: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DocumentCommentRecord = z.infer<typeof documentCommentRecordSchema>;

export const documentCommentListQuerySchema = paginationQuerySchema.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type DocumentCommentListQuery = z.infer<typeof documentCommentListQuerySchema>;

export const documentCommentListResponseSchema = createApiResponseSchema(
  z.object({
    items: z.array(documentCommentRecordSchema),
    pagination: paginationMetaSchema,
  }),
);
export type DocumentCommentListResponse = z.infer<typeof documentCommentListResponseSchema>;

export const createDocumentCommentRequestSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Digite um comentário antes de enviar.")
    .max(
      MAX_DOCUMENT_COMMENT_LENGTH,
      `O comentário deve ter no máximo ${MAX_DOCUMENT_COMMENT_LENGTH} caracteres.`,
    ),
  mentionedUserIds: z.array(uuidSchema).max(MAX_DOCUMENT_COMMENT_MENTIONS).default([]),
});
export type CreateDocumentCommentRequest = z.infer<typeof createDocumentCommentRequestSchema>;

export const documentCommentDetailResponseSchema = createApiResponseSchema(
  documentCommentRecordSchema,
);
export type DocumentCommentDetailResponse = z.infer<typeof documentCommentDetailResponseSchema>;

export const deleteDocumentCommentResponseSchema = createApiResponseSchema(
  z.object({
    deleted: z.literal(true),
    commentId: uuidSchema,
  }),
);
export type DeleteDocumentCommentResponse = z.infer<typeof deleteDocumentCommentResponseSchema>;

export const mentionCandidateQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_MENTION_CANDIDATES_LIMIT).default(8),
});
export type MentionCandidateQuery = z.infer<typeof mentionCandidateQuerySchema>;

export const mentionCandidateSchema = z.object({
  id: uuidSchema,
  fullName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(255),
});
export type MentionCandidate = z.infer<typeof mentionCandidateSchema>;

export const mentionCandidateListResponseSchema = createApiResponseSchema(
  z.object({
    items: z.array(mentionCandidateSchema),
  }),
);
export type MentionCandidateListResponse = z.infer<typeof mentionCandidateListResponseSchema>;
