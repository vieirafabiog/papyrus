import {
  type AuditEventRecord,
  type AuditEventsListResponse,
  type AuditExportFormat,
  type AuditFacets,
  type AuditListSortField,
  type AuditResult,
  CONTRACTS_API_PREFIX,
  auditEventsListResponseSchema,
  auditFacetsResponseSchema,
} from "@docuflow/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { translate } from "../../i18n/index.js";

export interface AuditFiltersState {
  readonly actorUserId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly result: AuditResult | "";
  readonly from: string;
  readonly to: string;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: AuditListSortField;
  readonly sortDirection: "asc" | "desc";
}

export const DEFAULT_AUDIT_FILTERS: AuditFiltersState = {
  actorUserId: "",
  action: "",
  resourceType: "",
  result: "",
  from: "",
  to: "",
  page: 1,
  pageSize: 20,
  sortBy: "occurredAt",
  sortDirection: "desc",
};

export function hasInvalidAuditPeriod(filters: Pick<AuditFiltersState, "from" | "to">): boolean {
  return filters.from.length > 0 && filters.to.length > 0 && filters.from > filters.to;
}

function appendAuditFilterParams(params: URLSearchParams, filters: AuditFiltersState): void {
  if (filters.actorUserId.length > 0) {
    params.set("actorUserId", filters.actorUserId);
  }
  if (filters.action.length > 0) {
    params.set("action", filters.action);
  }
  if (filters.resourceType.length > 0) {
    params.set("resourceType", filters.resourceType);
  }
  if (filters.result.length > 0) {
    params.set("result", filters.result);
  }
  if (filters.from.length > 0) {
    params.set("from", filters.from);
  }
  if (filters.to.length > 0) {
    params.set("to", filters.to);
  }
}

export function buildAuditEventsSearchParams(filters: AuditFiltersState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("page", String(filters.page));
  params.set("pageSize", String(filters.pageSize));
  params.set("sortBy", filters.sortBy);
  params.set("sortDirection", filters.sortDirection);
  appendAuditFilterParams(params, filters);
  return params;
}

export function buildAuditExportSearchParams(
  filters: AuditFiltersState,
  format: AuditExportFormat,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("format", format);
  params.set("sortBy", filters.sortBy);
  params.set("sortDirection", filters.sortDirection);
  appendAuditFilterParams(params, filters);
  return params;
}

export async function fetchAuditEventsPage(
  filters: AuditFiltersState,
  signal?: AbortSignal,
): Promise<AuditEventsListResponse["data"]> {
  const params = buildAuditEventsSearchParams(filters);
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/audit-events?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "audit.errors.loadFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = auditEventsListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function fetchAuditFacets(signal?: AbortSignal): Promise<AuditFacets> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/audit-events/facets`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "audit.errors.loadFacetsFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = auditFacetsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

function parseContentDispositionFileName(headerValue: string | null, fallback: string): string {
  if (!headerValue) {
    return fallback;
  }
  const match = /filename="([^"]+)"/i.exec(headerValue);
  return match?.[1] ? match[1] : fallback;
}

/**
 * Downloads an authorized audit export (`csv` or `json`) using the current filters
 * while enforcing server-side `VIEW_AUDIT` permission checks.
 */
export async function downloadAuthorizedAuditExport(
  filters: AuditFiltersState,
  format: AuditExportFormat,
): Promise<string> {
  const params = buildAuditExportSearchParams(filters, format);
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/admin/audit-events/export?${params.toString()}`,
    {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: format === "json" ? "application/json" : "text/csv",
      },
    },
  );

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "audit.errors.exportFailed"));
  }

  const blob = await response.blob();
  const fallbackName = `${translate("audit.exportDefaultFilename")}.${format}`;
  const fileName = parseContentDispositionFileName(
    response.headers.get("content-disposition"),
    fallbackName,
  );

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  return fileName;
}

export function useAuditEventsQuery(filters: AuditFiltersState, enabled: boolean) {
  return useQuery<AuditEventsListResponse["data"], Error>({
    queryKey: ["admin", "audit-events", filters] as const,
    queryFn: ({ signal }) => fetchAuditEventsPage(filters, signal),
    enabled: enabled && !hasInvalidAuditPeriod(filters),
    placeholderData: keepPreviousData,
  });
}

export function useAuditFacetsQuery(enabled: boolean) {
  return useQuery<AuditFacets, Error>({
    queryKey: ["admin", "audit-events", "facets"] as const,
    queryFn: ({ signal }) => fetchAuditFacets(signal),
    enabled,
  });
}

export type { AuditEventRecord };
