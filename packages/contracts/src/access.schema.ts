import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./common.schema.js";

export const accessActionSchema = z.enum([
  "READ",
  "CREATE",
  "UPDATE",
  "DELETE",
  "UPLOAD",
  "DOWNLOAD",
  "APPROVE",
  "REJECT",
  "MANAGE_PERMISSIONS",
  "MANAGE_STORAGE",
  "MANAGE_USERS",
  "VIEW_AUDIT",
]);
export type AccessAction = z.infer<typeof accessActionSchema>;

export const accessResourceSchema = z.enum([
  "DOCUMENT",
  "FOLDER",
  "CATEGORY",
  "WORKFLOW",
  "USER",
  "GROUP",
  "ROLE",
  "STORAGE",
  "AUDIT",
  "ORGANIZATION",
]);
export type AccessResource = z.infer<typeof accessResourceSchema>;

export const accessScopeTypeSchema = z.enum(["GLOBAL", "CATEGORY", "FOLDER", "DOCUMENT"]);
export type AccessScopeType = z.infer<typeof accessScopeTypeSchema>;

export const accessEffectSchema = z.enum(["ALLOW", "DENY"]);
export type AccessEffect = z.infer<typeof accessEffectSchema>;

export const userStatusSchema = z.enum(["ACTIVE", "INACTIVE", "LOCKED"]);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const accessScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("GLOBAL") }),
  z.object({ type: z.literal("CATEGORY"), categoryId: uuidSchema }),
  z.object({ type: z.literal("FOLDER"), folderId: uuidSchema }),
  z.object({ type: z.literal("DOCUMENT"), documentId: uuidSchema }),
]);
export type AccessScope = z.infer<typeof accessScopeSchema>;

export const permissionSchema = z.object({
  id: uuidSchema,
  action: accessActionSchema,
  resource: accessResourceSchema,
});
export type PermissionRecord = z.infer<typeof permissionSchema>;

export const roleSummarySchema = z.object({
  id: uuidSchema,
  key: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  isSystem: z.boolean(),
});
export type RoleSummary = z.infer<typeof roleSummarySchema>;

export const groupSummarySchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type GroupSummary = z.infer<typeof groupSummarySchema>;

export const userSummarySchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  email: z.string().trim().email().toLowerCase(),
  fullName: z.string().trim().min(1).max(160),
  status: userStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const roleScopeAssignmentSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  roleId: uuidSchema,
  scope: accessScopeSchema,
  effect: accessEffectSchema,
  createdAt: isoDateTimeSchema,
});
export type RoleScopeAssignmentRecord = z.infer<typeof roleScopeAssignmentSchema>;

export const loginRequestSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authMeResponseSchema = z.object({
  user: userSummarySchema,
  groups: z.array(groupSummarySchema),
  roles: z.array(roleSummarySchema),
  permissions: z.array(permissionSchema),
  sessionExpiresAt: isoDateTimeSchema,
});
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;

export const createUserRequestSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  fullName: z.string().trim().min(2).max(160),
  password: z.string().min(10).max(256),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const createGroupRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
});
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

export const addGroupMemberRequestSchema = z.object({
  userId: uuidSchema,
});
export type AddGroupMemberRequest = z.infer<typeof addGroupMemberRequestSchema>;
