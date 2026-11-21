import { z } from "zod";
import { createApiResponseSchema, isoDateTimeSchema, uuidSchema } from "./common.schema.js";

export const operationalDependencyStateSchema = z.enum(["ok", "degraded", "unavailable"]);
export type OperationalDependencyStateContract = z.infer<typeof operationalDependencyStateSchema>;

export const operationalComponentStatusSchema = z.object({
  name: z.string().min(1),
  status: operationalDependencyStateSchema,
  message: z.string(),
  checkedAt: isoDateTimeSchema,
});
export type OperationalComponentStatusContract = z.infer<typeof operationalComponentStatusSchema>;

export const operationalStorageStatusSummarySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  kind: z.string().min(1),
  isDefault: z.boolean(),
  status: z.string().min(1),
  lastHealthCheckAt: isoDateTimeSchema.nullable(),
  lastHealthMessage: z.string().nullable(),
});
export type OperationalStorageStatusSummaryContract = z.infer<
  typeof operationalStorageStatusSummarySchema
>;

export const adminSystemStatusReportSchema = z.object({
  overallStatus: z.enum(["healthy", "degraded"]),
  checkedAt: isoDateTimeSchema,
  components: z.object({
    database: operationalComponentStatusSchema,
    worker: operationalComponentStatusSchema,
  }),
  storageConnections: z.array(operationalStorageStatusSummarySchema),
});
export type AdminSystemStatusReportContract = z.infer<typeof adminSystemStatusReportSchema>;

export const adminSystemStatusResponseSchema = createApiResponseSchema(
  adminSystemStatusReportSchema,
);
export type AdminSystemStatusResponseContract = z.infer<typeof adminSystemStatusResponseSchema>;
