import { z } from "zod";
import {
  createApiResponseSchema,
  isoDateTimeSchema,
  paginationMetaSchema,
  paginationQuerySchema,
  uuidSchema,
} from "./common.schema.js";

export const notificationChannelSchema = z.enum(["INTERNAL", "EMAIL"]);
export type NotificationChannelContract = z.infer<typeof notificationChannelSchema>;

export const notificationKindSchema = z.enum([
  "TASK_ASSIGNED",
  "WORKFLOW_DECISION",
  "DOCUMENT_EXPIRATION",
]);
export type NotificationKindContract = z.infer<typeof notificationKindSchema>;

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return value;
}, z.boolean());

export const notificationListQuerySchema = paginationQuerySchema.extend({
  unreadOnly: queryBooleanSchema.optional(),
  kind: notificationKindSchema.optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationItemSchema = z.object({
  id: uuidSchema,
  recipientUserId: uuidSchema,
  channel: notificationChannelSchema,
  kind: notificationKindSchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  resourceType: z.string().min(1).max(64).nullable(),
  resourceId: uuidSchema.nullable(),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const notificationListResponseSchema = createApiResponseSchema(
  z.object({
    items: z.array(notificationItemSchema),
    unreadCount: z.number().int().min(0),
    pagination: paginationMetaSchema,
  }),
);
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const notificationDetailResponseSchema = createApiResponseSchema(notificationItemSchema);
export type NotificationDetailResponse = z.infer<typeof notificationDetailResponseSchema>;
