import {
  CONTRACTS_API_PREFIX,
  type DocumentExpirationItem,
  type DocumentExpirationsListData,
  type DocumentExpirationsQuery,
  type ExpirationBucket,
  documentExpirationsResponseSchema,
} from "@papyrus/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { translate } from "../../i18n/index.js";

export type ExpirationsSortField = NonNullable<DocumentExpirationsQuery["sortBy"]>;

export interface ExpirationsFiltersState {
  readonly bucket: ExpirationBucket;
  readonly windowDays: number;
  readonly categoryId: string;
  readonly ownerUserId: string;
  readonly search: string;
  readonly includeArchived: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: ExpirationsSortField;
  readonly sortDirection: "asc" | "desc";
}

export const DEFAULT_EXPIRATIONS_FILTERS: ExpirationsFiltersState = {
  bucket: "ALL",
  windowDays: 30,
  categoryId: "",
  ownerUserId: "",
  search: "",
  includeArchived: false,
  page: 1,
  pageSize: 20,
  sortBy: "expirationDate",
  sortDirection: "asc",
};

export function buildExpirationsSearchParams(filters: ExpirationsFiltersState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("bucket", filters.bucket);
  params.set("windowDays", String(filters.windowDays));
  params.set("page", String(filters.page));
  params.set("pageSize", String(filters.pageSize));
  params.set("sortBy", filters.sortBy);
  params.set("sortDirection", filters.sortDirection);

  if (filters.categoryId.length > 0) {
    params.set("categoryId", filters.categoryId);
  }
  if (filters.ownerUserId.length > 0) {
    params.set("ownerUserId", filters.ownerUserId);
  }
  const trimmedSearch = filters.search.trim();
  if (trimmedSearch.length > 0) {
    params.set("search", trimmedSearch);
  }
  if (filters.includeArchived) {
    params.set("includeArchived", "true");
  }

  return params;
}

export async function fetchDocumentExpirations(
  filters: ExpirationsFiltersState,
  signal?: AbortSignal,
): Promise<DocumentExpirationsListData> {
  const params = buildExpirationsSearchParams(filters);
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/expirations?${params.toString()}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "expirations.errors.load"));
  }

  const rawJson: unknown = await response.json();
  const parsed = documentExpirationsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("expirations.errors.invalidResponse"));
  }

  return parsed.data.data;
}

export function useDocumentExpirationsQuery(filters: ExpirationsFiltersState) {
  return useQuery<DocumentExpirationsListData, Error>({
    queryKey: ["documents", "expirations", filters] as const,
    queryFn: ({ signal }) => fetchDocumentExpirations(filters, signal),
    placeholderData: keepPreviousData,
  });
}

export type { DocumentExpirationItem };
