import {
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  type CategorySummaryRecord,
  type CreateStorageConnectionContract,
  type StorageConnectionTestResultContract,
  type StorageConnectionViewContract,
  type StorageRoutingRuleViewContract,
  type UpdateStorageConnectionContract,
  type UpsertStorageRoutingRuleRequest,
  categoryListResponseSchema,
  createStorageConnectionContractSchema,
  storageConnectionListResponseSchema,
  storageConnectionResponseSchema,
  storageConnectionTestResponseSchema,
  storageRoutingRuleListResponseSchema,
  storageRoutingRuleResponseSchema,
  updateStorageConnectionContractSchema,
  upsertStorageRoutingRuleRequestSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { type MessageKey, translate } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export class StorageSettingsFetchError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "StorageSettingsFetchError";
    this.statusCode = statusCode;
  }
}

export function canManageStorage(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return (
    session.roles.some((role) => role.key === "admin") ||
    session.permissions.some(
      (perm) => perm.action === "MANAGE_STORAGE" && perm.resource === "STORAGE",
    )
  );
}

export const storageConnectionsQueryKey = () => ["admin", "storage", "connections"] as const;
export const storageRoutingRulesQueryKey = () => ["admin", "storage", "routing-rules"] as const;

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
): Promise<StorageSettingsFetchError> {
  const message = await extractUserErrorMessage(response, fallbackKey);
  return new StorageSettingsFetchError(response.status, message);
}

export async function fetchStorageConnections(): Promise<readonly StorageConnectionViewContract[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/storage-connections`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.storage.errors.loadConnectionsFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = storageConnectionListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new StorageSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function fetchStorageRoutingRules(): Promise<
  readonly StorageRoutingRuleViewContract[]
> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/storage-routing-rules`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.storage.errors.loadRulesFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = storageRoutingRuleListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new StorageSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function fetchStorageCategories(): Promise<readonly CategorySummaryRecord[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories?pageSize=100`, {
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

export async function createStorageConnection(
  payload: CreateStorageConnectionContract,
): Promise<StorageConnectionViewContract> {
  const validated = createStorageConnectionContractSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/storage-connections`, {
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
    throw await parseErrorResponse(response, "admin.storage.errors.createFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = storageConnectionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new StorageSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function updateStorageConnection(
  connectionId: string,
  payload: UpdateStorageConnectionContract,
): Promise<StorageConnectionViewContract> {
  const validated = updateStorageConnectionContractSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/${connectionId}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
      body: JSON.stringify(validated),
    },
  );
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.storage.errors.updateFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = storageConnectionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new StorageSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function testStorageConnectionHealth(
  connectionId: string,
): Promise<StorageConnectionTestResultContract> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/${connectionId}/test`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
    },
  );
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.storage.errors.testFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = storageConnectionTestResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new StorageSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function setDefaultStorageConnection(
  connectionId: string,
): Promise<StorageConnectionViewContract> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/${connectionId}/default`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
    },
  );
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.storage.errors.setDefaultFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = storageConnectionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new StorageSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function toggleStorageConnectionStatus(
  connectionId: string,
  action: "activate" | "deactivate",
): Promise<StorageConnectionViewContract> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/admin/storage-connections/${connectionId}/${action}`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
    },
  );
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.storage.errors.toggleStatusFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = storageConnectionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new StorageSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function upsertStorageRoutingRule(
  payload: UpsertStorageRoutingRuleRequest,
): Promise<StorageRoutingRuleViewContract> {
  const validated = upsertStorageRoutingRuleRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/storage-routing-rules`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(validated),
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.storage.errors.saveRuleFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = storageRoutingRuleResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new StorageSettingsFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function clearCategoryRoutingRule(categoryId: string): Promise<void> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/admin/storage-routing-rules/categories/${categoryId}`,
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
    throw await parseErrorResponse(response, "admin.storage.errors.removeRuleFailed");
  }
}

export function useStorageConnectionsQuery(enabled = true) {
  return useQuery<readonly StorageConnectionViewContract[], StorageSettingsFetchError>({
    queryKey: storageConnectionsQueryKey(),
    queryFn: fetchStorageConnections,
    enabled,
  });
}

export function useStorageRoutingRulesQuery(enabled = true) {
  return useQuery<readonly StorageRoutingRuleViewContract[], StorageSettingsFetchError>({
    queryKey: storageRoutingRulesQueryKey(),
    queryFn: fetchStorageRoutingRules,
    enabled,
  });
}

export function useStorageCategoriesQuery(enabled = true) {
  return useQuery<readonly CategorySummaryRecord[], Error>({
    queryKey: ["admin", "storage", "categories"],
    queryFn: fetchStorageCategories,
    enabled,
  });
}

export function useCreateStorageConnectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createStorageConnection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: storageConnectionsQueryKey() });
    },
  });
}

export function useUpdateStorageConnectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly connectionId: string;
      readonly payload: UpdateStorageConnectionContract;
    }) => updateStorageConnection(params.connectionId, params.payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: storageConnectionsQueryKey() });
    },
  });
}

export function useTestStorageConnectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: testStorageConnectionHealth,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: storageConnectionsQueryKey() });
    },
  });
}

export function useSetDefaultStorageConnectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setDefaultStorageConnection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: storageConnectionsQueryKey() });
    },
  });
}

export function useToggleStorageConnectionStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly connectionId: string;
      readonly action: "activate" | "deactivate";
    }) => toggleStorageConnectionStatus(params.connectionId, params.action),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: storageConnectionsQueryKey() });
    },
  });
}

export function useUpsertStorageRoutingRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: upsertStorageRoutingRule,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: storageRoutingRulesQueryKey() });
    },
  });
}

export function useClearCategoryRoutingRuleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: clearCategoryRoutingRule,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: storageRoutingRulesQueryKey() });
    },
  });
}
