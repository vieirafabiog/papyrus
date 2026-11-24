import {
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  type CategoryFieldRecord,
  type CategoryListResponse,
  type CategorySummaryRecord,
  type CreateCategoryFieldInput,
  type CreateCategoryInput,
  type DeleteCategoryFieldInput,
  type SortDirection,
  type UpdateCategoryFieldInput,
  type UpdateCategoryInput,
  apiErrorResponseSchema,
  categoryFieldListResponseSchema,
  categoryFieldResponseSchema,
  categoryListResponseSchema,
  categorySummaryResponseSchema,
  createCategoryFieldInputSchema,
  createCategoryInputSchema,
  deleteCategoryFieldInputSchema,
  updateCategoryFieldInputSchema,
  updateCategoryInputSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage, getLocalizedApiErrorMessage } from "../../i18n/api-errors.js";
import { type MessageKey, translate } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export interface AdminCategoryListParams {
  readonly search: string;
  readonly isActive: "true" | "false" | "";
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: "name" | "isActive" | "createdAt" | "updatedAt";
  readonly sortDirection: SortDirection;
}

export class CategoryAdminFetchError extends Error {
  public readonly statusCode: number;
  public readonly domainCode: string | undefined;

  public constructor(statusCode: number, message: string, domainCode?: string) {
    super(message);
    this.name = "CategoryAdminFetchError";
    this.statusCode = statusCode;
    this.domainCode = domainCode;
  }
}

export function canCreateCategories(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return (
    session.roles.some((role) => role.key === "admin" || role.key === "document_manager") ||
    session.permissions.some((perm) => perm.action === "CREATE" && perm.resource === "CATEGORY")
  );
}

export function canEditCategories(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return (
    session.roles.some((role) => role.key === "admin" || role.key === "document_manager") ||
    session.permissions.some((perm) => perm.action === "UPDATE" && perm.resource === "CATEGORY")
  );
}

export function canDeleteCategories(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return (
    session.roles.some((role) => role.key === "admin" || role.key === "document_manager") ||
    session.permissions.some((perm) => perm.action === "DELETE" && perm.resource === "CATEGORY")
  );
}

export const adminCategoriesListQueryKey = (params: AdminCategoryListParams) =>
  ["admin", "categories", "list", params] as const;

export const categoryFieldsQueryKey = (categoryId: string) =>
  ["admin", "categories", categoryId, "fields"] as const;

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
): Promise<CategoryAdminFetchError> {
  try {
    const rawJson: unknown = await response.clone().json();
    const parsed = apiErrorResponseSchema.safeParse(rawJson);
    if (parsed.success) {
      const details = parsed.data.error.details as { readonly domainCode?: unknown } | undefined;
      const domainCode = typeof details?.domainCode === "string" ? details.domainCode : undefined;
      const localized = getLocalizedApiErrorMessage(
        parsed.data.error.code,
        response.status,
        parsed.data.error.message,
      );
      return new CategoryAdminFetchError(response.status, localized, domainCode);
    }
  } catch {
    // Non-JSON response falls through to extractUserErrorMessage.
  }
  const message = await extractUserErrorMessage(response, fallbackKey);
  return new CategoryAdminFetchError(response.status, message);
}

export async function fetchAdminCategories(
  params: AdminCategoryListParams,
): Promise<CategoryListResponse["data"]> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
    sortBy: params.sortBy,
    sortDirection: params.sortDirection,
  });

  if (params.search.trim().length > 0) {
    query.set("search", params.search.trim());
  }
  if (params.isActive === "true" || params.isActive === "false") {
    query.set("isActive", params.isActive);
  }

  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories?${query.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.categories.errors.loadFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = categoryListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new CategoryAdminFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function fetchCategoryFields(
  categoryId: string,
): Promise<readonly CategoryFieldRecord[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories/${categoryId}/fields`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.categories.errors.loadFieldsFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = categoryFieldListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new CategoryAdminFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function createCategory(payload: CreateCategoryInput): Promise<CategorySummaryRecord> {
  const validated = createCategoryInputSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories`, {
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
    throw await parseErrorResponse(response, "admin.categories.errors.createFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = categorySummaryResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new CategoryAdminFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function updateCategory(
  categoryId: string,
  payload: UpdateCategoryInput,
): Promise<CategorySummaryRecord> {
  const validated = updateCategoryInputSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories/${categoryId}`, {
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
    throw await parseErrorResponse(response, "admin.categories.errors.updateFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = categorySummaryResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new CategoryAdminFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function deactivateCategory(categoryId: string): Promise<CategorySummaryRecord> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories/${categoryId}/deactivate`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
  });
  if (!response.ok) {
    throw await parseErrorResponse(response, "admin.categories.errors.deactivateFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = categorySummaryResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new CategoryAdminFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function addCategoryField(
  categoryId: string,
  payload: CreateCategoryFieldInput,
): Promise<CategoryFieldRecord> {
  const validated = createCategoryFieldInputSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories/${categoryId}/fields`, {
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
    throw await parseErrorResponse(response, "admin.categories.editor.errors.addFieldFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = categoryFieldResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new CategoryAdminFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function updateCategoryField(
  categoryId: string,
  fieldId: string,
  payload: UpdateCategoryFieldInput,
): Promise<CategoryFieldRecord> {
  const validated = updateCategoryFieldInputSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/categories/${categoryId}/fields/${fieldId}`,
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
    throw await parseErrorResponse(response, "admin.categories.editor.errors.updateFieldFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = categoryFieldResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new CategoryAdminFetchError(500, translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function deleteCategoryField(
  categoryId: string,
  fieldId: string,
  payload?: DeleteCategoryFieldInput,
): Promise<void> {
  const validated = deleteCategoryFieldInputSchema.parse(payload ?? {});
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/categories/${categoryId}/fields/${fieldId}`,
    {
      method: "DELETE",
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
    throw await parseErrorResponse(response, "admin.categories.editor.errors.removeFieldFailed");
  }
}

export function useAdminCategoriesQuery(params: AdminCategoryListParams, enabled = true) {
  return useQuery<CategoryListResponse["data"], CategoryAdminFetchError>({
    queryKey: adminCategoriesListQueryKey(params),
    queryFn: () => fetchAdminCategories(params),
    enabled,
  });
}

export function useCategoryFieldsQuery(categoryId: string | null, enabled = true) {
  return useQuery<readonly CategoryFieldRecord[], CategoryAdminFetchError>({
    queryKey: categoryFieldsQueryKey(categoryId ?? "none"),
    queryFn: () => fetchCategoryFields(categoryId ?? ""),
    enabled: enabled && categoryId !== null,
  });
}

export function useCreateCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createCategory,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "categories"] });
    },
  });
}

export function useUpdateCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly categoryId: string;
      readonly payload: UpdateCategoryInput;
    }) => updateCategory(params.categoryId, params.payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "categories"] });
    },
  });
}

export function useDeactivateCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deactivateCategory,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "categories"] });
    },
  });
}

export function useAddCategoryFieldMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly categoryId: string;
      readonly payload: CreateCategoryFieldInput;
    }) => addCategoryField(params.categoryId, params.payload),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: categoryFieldsQueryKey(variables.categoryId),
      });
    },
  });
}

export function useUpdateCategoryFieldMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly categoryId: string;
      readonly fieldId: string;
      readonly payload: UpdateCategoryFieldInput;
    }) => updateCategoryField(params.categoryId, params.fieldId, params.payload),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: categoryFieldsQueryKey(variables.categoryId),
      });
    },
  });
}

export function useDeleteCategoryFieldMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly categoryId: string;
      readonly fieldId: string;
      readonly payload?: DeleteCategoryFieldInput;
    }) => deleteCategoryField(params.categoryId, params.fieldId, params.payload),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: categoryFieldsQueryKey(variables.categoryId),
      });
    },
  });
}
