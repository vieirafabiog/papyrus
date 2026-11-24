import { z } from "zod";
import { createApiResponseSchema, isoDateTimeSchema, uuidSchema } from "./common.schema.js";
import { documentStatusSchema } from "./document.schema.js";

export const repositoryReportQuerySchema = z.object({
  expirationWindowDays: z.coerce.number().int().min(1).max(365).default(30),
  categoryId: uuidSchema.optional(),
  status: documentStatusSchema.optional(),
});
export type RepositoryReportQuery = z.infer<typeof repositoryReportQuerySchema>;

export const repositoryReportTotalsSchema = z.object({
  totalDocuments: z.number().int().min(0),
  totalVersions: z.number().int().min(0),
  totalActiveFiles: z.number().int().min(0),
  storageUsedBytes: z.number().int().min(0),
  quarantinedFiles: z.number().int().min(0),
  pendingTasks: z.number().int().min(0),
});
export type RepositoryReportTotals = z.infer<typeof repositoryReportTotalsSchema>;

export const reportExpirationBreakdownSchema = z.object({
  expired: z.number().int().min(0),
  expiringSoon: z.number().int().min(0),
  onTrack: z.number().int().min(0),
  withoutDate: z.number().int().min(0),
  windowDays: z.number().int().min(1).max(365),
});
export type ReportExpirationBreakdown = z.infer<typeof reportExpirationBreakdownSchema>;

export const reportStatusBreakdownItemSchema = z.object({
  status: documentStatusSchema,
  documentCount: z.number().int().min(0),
  storageBytes: z.number().int().min(0),
});
export type ReportStatusBreakdownItem = z.infer<typeof reportStatusBreakdownItemSchema>;

export const reportCategoryBreakdownItemSchema = z.object({
  categoryId: uuidSchema,
  categoryName: z.string().min(1).max(120),
  documentCount: z.number().int().min(0),
  versionCount: z.number().int().min(0),
  storageBytes: z.number().int().min(0),
  expiredCount: z.number().int().min(0),
  expiringSoonCount: z.number().int().min(0),
});
export type ReportCategoryBreakdownItem = z.infer<typeof reportCategoryBreakdownItemSchema>;

export const reportStorageConnectionBreakdownItemSchema = z.object({
  storageConnectionId: uuidSchema,
  storageConnectionName: z.string().min(1).max(120),
  kind: z.string().min(1).max(64),
  fileCount: z.number().int().min(0),
  storageBytes: z.number().int().min(0),
});
export type ReportStorageConnectionBreakdownItem = z.infer<
  typeof reportStorageConnectionBreakdownItemSchema
>;

export const repositoryReportSchema = z.object({
  generatedAt: isoDateTimeSchema,
  timezone: z.string().min(1).max(64),
  totals: repositoryReportTotalsSchema,
  expirations: reportExpirationBreakdownSchema,
  byStatus: z.array(reportStatusBreakdownItemSchema),
  byCategory: z.array(reportCategoryBreakdownItemSchema),
  byStorageConnection: z.array(reportStorageConnectionBreakdownItemSchema),
});
export type RepositoryReport = z.infer<typeof repositoryReportSchema>;

export const repositoryReportResponseSchema = createApiResponseSchema(repositoryReportSchema);
export type RepositoryReportResponse = z.infer<typeof repositoryReportResponseSchema>;
