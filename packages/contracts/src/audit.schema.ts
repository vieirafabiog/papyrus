import { z } from "zod";
import {
  createApiResponseSchema,
  createPaginatedResponseSchema,
  isoDateSchema,
  isoDateTimeSchema,
  paginationQuerySchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common.schema.js";

export const auditResultSchema = z.enum(["SUCCESS", "DENIED", "FAILURE"]);
export type AuditResult = z.infer<typeof auditResultSchema>;

export const auditMetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type AuditMetadataValue = z.infer<typeof auditMetadataValueSchema>;

export const auditEventRecordSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  occurredAt: isoDateTimeSchema,
  actorUserId: uuidSchema.nullable(),
  actorName: z.string().nullable().optional(),
  actorEmail: z.string().nullable().optional(),
  action: z.string().min(1).max(120),
  resourceType: z.string().min(1).max(64),
  resourceId: uuidSchema.nullable(),
  result: auditResultSchema,
  requestId: uuidSchema,
  ipAddress: z.string().nullable().optional(),
  metadata: z.record(auditMetadataValueSchema).default({}),
});
export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;

export const auditListSortFieldSchema = z.enum(["occurredAt", "action", "resourceType", "result"]);
export type AuditListSortField = z.infer<typeof auditListSortFieldSchema>;

const auditDateBoundarySchema = z.union([isoDateSchema, isoDateTimeSchema]);

export const auditEventsFilterFieldsSchema = z.object({
  actorUserId: uuidSchema.optional(),
  action: z.string().trim().min(1).max(120).optional(),
  resourceType: z.string().trim().min(1).max(64).optional(),
  resourceId: uuidSchema.optional(),
  result: auditResultSchema.optional(),
  from: auditDateBoundarySchema.optional(),
  to: auditDateBoundarySchema.optional(),
});
export type AuditEventsFilterFields = z.infer<typeof auditEventsFilterFieldsSchema>;

export const auditEventsQuerySchema = paginationQuerySchema
  .merge(auditEventsFilterFieldsSchema)
  .extend({
    sortBy: auditListSortFieldSchema.default("occurredAt"),
    sortDirection: sortDirectionSchema.default("desc"),
  });
export type AuditEventsQuery = z.infer<typeof auditEventsQuerySchema>;

export const auditExportFormatSchema = z.enum(["csv", "json"]);
export type AuditExportFormat = z.infer<typeof auditExportFormatSchema>;

export const auditEventsExportQuerySchema = auditEventsFilterFieldsSchema.extend({
  format: auditExportFormatSchema.default("csv"),
  sortBy: auditListSortFieldSchema.default("occurredAt"),
  sortDirection: sortDirectionSchema.default("desc"),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});
export type AuditEventsExportQuery = z.infer<typeof auditEventsExportQuerySchema>;

export const auditEventsListResponseSchema = createApiResponseSchema(
  createPaginatedResponseSchema(auditEventRecordSchema),
);
export type AuditEventsListResponse = z.infer<typeof auditEventsListResponseSchema>;

export const auditActorOptionSchema = z.object({
  id: uuidSchema,
  fullName: z.string().min(1),
  email: z.string().min(1),
});
export type AuditActorOption = z.infer<typeof auditActorOptionSchema>;

export const auditFacetsSchema = z.object({
  actors: z.array(auditActorOptionSchema),
  actions: z.array(z.string().min(1)),
  resourceTypes: z.array(z.string().min(1)),
});
export type AuditFacets = z.infer<typeof auditFacetsSchema>;

export const auditFacetsResponseSchema = createApiResponseSchema(auditFacetsSchema);
export type AuditFacetsResponse = z.infer<typeof auditFacetsResponseSchema>;
