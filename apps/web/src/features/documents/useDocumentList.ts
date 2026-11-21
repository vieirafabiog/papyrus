import {
  CONTRACTS_API_PREFIX,
  type CategorySummaryRecord,
  type DocumentListResponse,
  type DocumentSearchQuery,
  type DocumentStatus,
  type FolderRecord,
  type UserSummary,
  apiErrorResponseSchema,
  categoryListResponseSchema,
  documentListResponseSchema,
  folderListResponseSchema,
  userSummarySchema,
} from "@docuflow/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSessionQuery } from "../../app/session.js";

export type DocumentListSortField = NonNullable<DocumentSearchQuery["sortBy"]>;

export interface DocumentListFiltersState {
  readonly search: string;
  readonly categoryId: string;
  readonly folderId: string;
  readonly status: DocumentStatus | "";
  readonly ownerUserId: string;
  readonly expirationFrom: string;
  readonly expirationTo: string;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: DocumentListSortField;
  readonly sortDirection: "asc" | "desc";
}

export const DEFAULT_DOCUMENT_LIST_FILTERS: DocumentListFiltersState = {
  search: "",
  categoryId: "",
  folderId: "",
  status: "",
  ownerUserId: "",
  expirationFrom: "",
  expirationTo: "",
  page: 1,
  pageSize: 20,
  sortBy: "updatedAt",
  sortDirection: "desc",
};

export interface OwnerFilterOption {
  readonly id: string;
  readonly label: string;
}

export function isValidExpirationRange(expirationFrom: string, expirationTo: string): boolean {
  if (expirationFrom.length === 0 || expirationTo.length === 0) {
    return true;
  }
  return expirationTo >= expirationFrom;
}

export function buildDocumentSearchParams(filters: DocumentListFiltersState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("page", String(filters.page));
  params.set("pageSize", String(filters.pageSize));
  params.set("sortBy", filters.sortBy);
  params.set("sortDirection", filters.sortDirection);

  const trimmedSearch = filters.search.trim();
  if (trimmedSearch.length > 0) {
    params.set("search", trimmedSearch);
  }
  if (filters.categoryId.length > 0) {
    params.set("categoryId", filters.categoryId);
  }
  if (filters.folderId.length > 0) {
    params.set("folderId", filters.folderId);
  }
  if (filters.status.length > 0) {
    params.set("status", filters.status);
  }
  if (filters.ownerUserId.length > 0) {
    params.set("ownerUserId", filters.ownerUserId);
  }
  if (filters.expirationFrom.length > 0) {
    params.set("expirationFrom", filters.expirationFrom);
  }
  if (filters.expirationTo.length > 0) {
    params.set("expirationTo", filters.expirationTo);
  }

  return params;
}

export function documentSearchQueryKey(filters: DocumentListFiltersState) {
  return ["documents", "search", filters] as const;
}

async function parseSearchErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const raw: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.error.message;
    }
  } catch {
    // Fallback to HTTP status text.
  }
  return `${fallback} (${response.status}).`;
}

export async function fetchDocumentSearchPage(
  filters: DocumentListFiltersState,
  signal?: AbortSignal,
): Promise<DocumentListResponse> {
  const params = buildDocumentSearchParams(filters);
  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/search?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(await parseSearchErrorMessage(response, "Falha ao listar documentos"));
  }

  const rawJson: unknown = await response.json();
  const parsed = documentListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error("Resposta inválida recebida ao consultar a lista de documentos.");
  }

  return parsed.data;
}

export async function fetchActiveCategories(): Promise<readonly CategorySummaryRecord[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/categories?isActive=true&pageSize=100`, {
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

export async function fetchActiveFolders(): Promise<readonly FolderRecord[]> {
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/folders?status=ACTIVE&pageSize=100&sortBy=name&sortDirection=asc`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    return [];
  }
  const rawJson: unknown = await response.json();
  const parsed = folderListResponseSchema.safeParse(rawJson);
  return parsed.success ? parsed.data.data.items : [];
}

export async function fetchOwnerFilterOptions(
  canListUsers: boolean,
  currentUser: UserSummary | null,
): Promise<readonly OwnerFilterOption[]> {
  if (!canListUsers) {
    return currentUser
      ? [{ id: currentUser.id, label: `Sob minha responsabilidade (${currentUser.fullName})` }]
      : [];
  }

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/users`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return currentUser
      ? [{ id: currentUser.id, label: `Sob minha responsabilidade (${currentUser.fullName})` }]
      : [];
  }

  const rawJson: unknown = await response.json();
  const rawItems =
    rawJson && typeof rawJson === "object" && "data" in rawJson
      ? (rawJson as { data?: unknown }).data
      : null;
  if (!Array.isArray(rawItems)) {
    return currentUser
      ? [{ id: currentUser.id, label: `Sob minha responsabilidade (${currentUser.fullName})` }]
      : [];
  }

  const options: OwnerFilterOption[] = [];
  for (const item of rawItems) {
    const parsed = userSummarySchema.safeParse(item);
    if (parsed.success && parsed.data.status === "ACTIVE") {
      options.push({
        id: parsed.data.id,
        label: parsed.data.fullName,
      });
    }
  }
  return options;
}

export function useDocumentListCategoriesQuery() {
  return useQuery({
    queryKey: ["categories", "filter-options"],
    queryFn: fetchActiveCategories,
    retry: false,
  });
}

export function useDocumentListFoldersQuery() {
  return useQuery({
    queryKey: ["folders", "filter-options"],
    queryFn: fetchActiveFolders,
    retry: false,
  });
}

export function useDocumentOwnersQuery() {
  const { data: session } = useSessionQuery();
  const canListUsers = Boolean(
    session &&
      (session.roles.some((role) => role.key === "admin") ||
        session.permissions.some(
          (perm) => perm.action === "MANAGE_USERS" && perm.resource === "USER",
        )),
  );

  return useQuery({
    queryKey: ["users", "owner-filter-options", session?.user.id ?? "", canListUsers],
    queryFn: () => fetchOwnerFilterOptions(canListUsers, session?.user ?? null),
    enabled: session !== undefined,
    retry: false,
  });
}

export function useDocumentListQuery(filters: DocumentListFiltersState) {
  const rangeValid = isValidExpirationRange(filters.expirationFrom, filters.expirationTo);
  return useQuery<DocumentListResponse, Error>({
    queryKey: documentSearchQueryKey(filters),
    queryFn: ({ signal }) => fetchDocumentSearchPage(filters, signal),
    enabled: rangeValid,
    placeholderData: keepPreviousData,
    retry: false,
  });
}
