import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./common.schema.js";

export const dashboardRecentActivitySchema = z.object({
  id: uuidSchema,
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: uuidSchema.nullable(),
  occurredAt: isoDateTimeSchema,
});
export type DashboardRecentActivity = z.infer<typeof dashboardRecentActivitySchema>;

export const dashboardSummarySchema = z.object({
  totalDocuments: z.number().int().min(0),
  pendingTasks: z.number().int().min(0),
  expiringSoonDocuments: z.number().int().min(0),
  quarantinedFiles: z.number().int().min(0),
  storageUsedBytes: z.number().int().min(0).default(0),
  storageFileCount: z.number().int().min(0).default(0),
  recentActivity: z.array(dashboardRecentActivitySchema),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
