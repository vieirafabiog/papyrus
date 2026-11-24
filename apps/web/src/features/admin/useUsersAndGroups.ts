import {
  type AddGroupMemberRequest,
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  type CreateGroupRequest,
  type CreateUserRequest,
  type GroupSummary,
  type UpdateUserRequest,
  type UserSummary,
  addGroupMemberRequestSchema,
  createGroupRequestSchema,
  createUserRequestSchema,
  groupListResponseSchema,
  groupResponseSchema,
  updateUserRequestSchema,
  userListResponseSchema,
  userResponseSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { type MessageKey, translate } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

const userItemResponseSchema = userResponseSchema;
const groupItemResponseSchema = groupResponseSchema;
const groupMemberListResponseSchema = userListResponseSchema;

export class AdminDirectoryFetchError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AdminDirectoryFetchError";
    this.statusCode = statusCode;
  }
}

export function canManageUsers(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return (
    session.roles.some((role) => role.key === "admin") ||
    session.permissions.some((perm) => perm.action === "MANAGE_USERS" && perm.resource === "USER")
  );
}

export function canManageGroups(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return (
    session.roles.some((role) => role.key === "admin") ||
    session.permissions.some((perm) => perm.action === "MANAGE_USERS" && perm.resource === "GROUP")
  );
}

export const adminUsersQueryKey = () => ["admin", "users"] as const;
export const adminGroupsQueryKey = () => ["admin", "groups"] as const;
export const adminGroupMembersQueryKey = (groupId: string) =>
  ["admin", "groups", groupId, "members"] as const;

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

async function resolveCsrfToken(): Promise<string> {
  const fromCookie = readCookieValue(CSRF_COOKIE_NAME);
  if (fromCookie) {
    return fromCookie;
  }
  const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/csrf-token`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return "";
  }
  const json = (await response.json()) as { data?: { csrfToken?: string } };
  return json.data?.csrfToken ?? "";
}

async function parseErrorResponse(
  response: Response,
  fallbackKey: MessageKey,
): Promise<AdminDirectoryFetchError> {
  const message = await extractUserErrorMessage(response, fallbackKey);
  return new AdminDirectoryFetchError(response.status, message);
}

export async function fetchAdminUsers(): Promise<readonly UserSummary[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/users`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.users.errors.loadFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = userListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AdminDirectoryFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function createAdminUser(payload: CreateUserRequest): Promise<UserSummary> {
  const validated = createUserRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/users`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(validated),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.users.errors.createFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = userItemResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AdminDirectoryFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function updateAdminUser(
  userId: string,
  payload: UpdateUserRequest,
): Promise<UserSummary> {
  const validated = updateUserRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/users/${userId}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(validated),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.users.errors.updateFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = userItemResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AdminDirectoryFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function toggleAdminUserStatus(
  userId: string,
  action: "deactivate" | "reactivate",
): Promise<UserSummary> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/users/${userId}/${action}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.users.errors.toggleFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = userItemResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AdminDirectoryFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function fetchAdminGroups(): Promise<readonly GroupSummary[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/groups`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.groups.errors.loadFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = groupListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AdminDirectoryFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function createAdminGroup(payload: CreateGroupRequest): Promise<GroupSummary> {
  const validated = createGroupRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/groups`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(validated),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.groups.errors.createFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = groupItemResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AdminDirectoryFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function fetchGroupMembers(groupId: string): Promise<readonly UserSummary[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/groups/${groupId}/members`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.groups.errors.loadMembersFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = groupMemberListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new AdminDirectoryFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function addGroupMember(
  groupId: string,
  payload: AddGroupMemberRequest,
): Promise<void> {
  const validated = addGroupMemberRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/groups/${groupId}/members`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(validated),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.groups.errors.addMemberFailed");
  }
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/admin/groups/${groupId}/members/${userId}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
    },
  );
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.groups.errors.removeMemberFailed");
  }
}

export function useAdminUsersQuery(enabled = true) {
  return useQuery<readonly UserSummary[], AdminDirectoryFetchError>({
    queryKey: adminUsersQueryKey(),
    queryFn: fetchAdminUsers,
    enabled,
  });
}

export function useCreateAdminUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAdminUser,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminUsersQueryKey() });
    },
  });
}

export function useUpdateAdminUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { readonly userId: string; readonly payload: UpdateUserRequest }) =>
      updateAdminUser(params.userId, params.payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminUsersQueryKey() });
    },
  });
}

export function useToggleAdminUserStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly userId: string;
      readonly action: "deactivate" | "reactivate";
    }) => toggleAdminUserStatus(params.userId, params.action),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminUsersQueryKey() });
    },
  });
}

export function useAdminGroupsQuery(enabled = true) {
  return useQuery<readonly GroupSummary[], AdminDirectoryFetchError>({
    queryKey: adminGroupsQueryKey(),
    queryFn: fetchAdminGroups,
    enabled,
  });
}

export function useCreateAdminGroupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAdminGroup,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminGroupsQueryKey() });
    },
  });
}

export function useGroupMembersQuery(groupId: string | null, enabled = true) {
  return useQuery<readonly UserSummary[], AdminDirectoryFetchError>({
    queryKey: adminGroupMembersQueryKey(groupId ?? ""),
    queryFn: () => fetchGroupMembers(groupId ?? ""),
    enabled: enabled && groupId !== null,
  });
}

export function useAddGroupMemberMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { readonly groupId: string; readonly userId: string }) =>
      addGroupMember(params.groupId, { userId: params.userId }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: adminGroupMembersQueryKey(variables.groupId),
      });
    },
  });
}

export function useRemoveGroupMemberMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { readonly groupId: string; readonly userId: string }) =>
      removeGroupMember(params.groupId, params.userId),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: adminGroupMembersQueryKey(variables.groupId),
      });
    },
  });
}
