import {
  type AssignPermissionScopeRequest,
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  type CategorySummaryRecord,
  type FolderRecord,
  type PermissionScopeAssignmentItem,
  type RoleWithPermissions,
  apiErrorResponseSchema,
  assignPermissionScopeRequestSchema,
  categoryListResponseSchema,
  folderListResponseSchema,
  permissionScopeAssignmentListResponseSchema,
  permissionScopeAssignmentResponseSchema,
  roleCatalogListResponseSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export class PermissionsAdminFetchError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "PermissionsAdminFetchError";
    this.statusCode = statusCode;
  }
}

export function canAdministerPermissions(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return (
    session.roles.some((role) => role.key === "admin") ||
    session.permissions.some((perm) => perm.action === "MANAGE_PERMISSIONS")
  );
}

export const permissionRolesQueryKey = () => ["admin", "permissions", "roles"] as const;
export const permissionAssignmentsQueryKey = () => ["admin", "permissions", "scopes"] as const;

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
  fallbackMessage: string,
): Promise<PermissionsAdminFetchError> {
  try {
    const rawJson: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(rawJson);
    if (parsed.success) {
      return new PermissionsAdminFetchError(response.status, parsed.data.error.message);
    }
  } catch {
    // Non-JSON response fallback
  }
  return new PermissionsAdminFetchError(
    response.status,
    `${fallbackMessage} (HTTP ${response.status}).`,
  );
}

export async function fetchPermissionRoles(): Promise<readonly RoleWithPermissions[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/permissions/roles`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao carregar catálogo de papéis");
  }
  const rawJson: unknown = await response.json();
  const parsed = roleCatalogListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new PermissionsAdminFetchError(500, "Resposta inválida recebida do catálogo de papéis.");
  }
  return parsed.data.data;
}

export async function fetchPermissionAssignments(): Promise<
  readonly PermissionScopeAssignmentItem[]
> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/permissions/scopes`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao carregar atribuições de permissão");
  }
  const rawJson: unknown = await response.json();
  const parsed = permissionScopeAssignmentListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new PermissionsAdminFetchError(
      500,
      "Resposta inválida recebida ao listar atribuições de escopo.",
    );
  }
  return parsed.data.data;
}

export async function fetchScopeCategories(): Promise<readonly CategorySummaryRecord[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories?activeOnly=false`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return [];
  }
  const rawJson: unknown = await response.json();
  const parsed = categoryListResponseSchema.safeParse(rawJson);
  return parsed.success ? parsed.data.data.items : [];
}

export async function fetchScopeFolders(): Promise<readonly FolderRecord[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/folders?pageSize=100`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return [];
  }
  const rawJson: unknown = await response.json();
  const parsed = folderListResponseSchema.safeParse(rawJson);
  return parsed.success ? parsed.data.data.items : [];
}

export async function assignPermissionScope(
  payload: AssignPermissionScopeRequest,
): Promise<PermissionScopeAssignmentItem> {
  const validated = assignPermissionScopeRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/permissions/scopes`, {
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
    throw await parseErrorResponse(response, "Falha ao atribuir regra de permissão");
  }
  const rawJson: unknown = await response.json();
  const parsed = permissionScopeAssignmentResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new PermissionsAdminFetchError(
      500,
      "Resposta inválida recebida ao salvar regra de permissão.",
    );
  }
  return parsed.data.data;
}

export async function revokePermissionScope(
  assignmentId: string,
): Promise<PermissionScopeAssignmentItem> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/permissions/scopes/${assignmentId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao revogar regra de permissão");
  }
  const rawJson: unknown = await response.json();
  const parsed = permissionScopeAssignmentResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new PermissionsAdminFetchError(
      500,
      "Resposta inválida recebida ao revogar regra de permissão.",
    );
  }
  return parsed.data.data;
}

export function usePermissionRolesQuery(enabled = true) {
  return useQuery<readonly RoleWithPermissions[], PermissionsAdminFetchError>({
    queryKey: permissionRolesQueryKey(),
    queryFn: fetchPermissionRoles,
    enabled,
  });
}

export function usePermissionAssignmentsQuery(enabled = true) {
  return useQuery<readonly PermissionScopeAssignmentItem[], PermissionsAdminFetchError>({
    queryKey: permissionAssignmentsQueryKey(),
    queryFn: fetchPermissionAssignments,
    enabled,
  });
}

export function useScopeCategoriesQuery(enabled = true) {
  return useQuery<readonly CategorySummaryRecord[], Error>({
    queryKey: ["admin", "permissions", "categories"],
    queryFn: fetchScopeCategories,
    enabled,
  });
}

export function useScopeFoldersQuery(enabled = true) {
  return useQuery<readonly FolderRecord[], Error>({
    queryKey: ["admin", "permissions", "folders"],
    queryFn: fetchScopeFolders,
    enabled,
  });
}

export function useAssignPermissionScopeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: assignPermissionScope,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: permissionAssignmentsQueryKey() });
    },
  });
}

export function useRevokePermissionScopeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokePermissionScope,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: permissionAssignmentsQueryKey() });
    },
  });
}
