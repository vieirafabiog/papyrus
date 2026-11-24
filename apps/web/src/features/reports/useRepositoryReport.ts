import {
  CONTRACTS_API_PREFIX,
  type DocumentStatus,
  type RepositoryReport,
  repositoryReportResponseSchema,
} from "@docuflow/contracts";
import { useQuery } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { translate } from "../../i18n/index.js";

export interface RepositoryReportFilters {
  readonly expirationWindowDays: number;
  readonly categoryId: string;
  readonly status: DocumentStatus | "";
}

export const DEFAULT_REPOSITORY_REPORT_FILTERS: RepositoryReportFilters = {
  expirationWindowDays: 30,
  categoryId: "",
  status: "",
};

export function buildRepositoryReportParams(filters: RepositoryReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set("expirationWindowDays", String(filters.expirationWindowDays));
  if (filters.categoryId.trim().length > 0) {
    params.set("categoryId", filters.categoryId.trim());
  }
  if (filters.status.trim().length > 0) {
    params.set("status", filters.status.trim());
  }
  return params;
}

export function buildRepositoryReportCsvUrl(filters: RepositoryReportFilters): string {
  const params = buildRepositoryReportParams(filters);
  return `${CONTRACTS_API_PREFIX}/reports/export.csv?${params.toString()}`;
}

export async function fetchRepositoryReport(
  filters: RepositoryReportFilters,
  signal?: AbortSignal,
): Promise<RepositoryReport> {
  const params = buildRepositoryReportParams(filters);
  const response = await fetch(`${CONTRACTS_API_PREFIX}/reports/overview?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "reports.errors.load"));
  }

  const parsed = repositoryReportResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(translate("reports.errors.invalidResponse"));
  }

  return parsed.data.data;
}

export function useRepositoryReportQuery(filters: RepositoryReportFilters) {
  return useQuery<RepositoryReport, Error>({
    queryKey: ["reports", "overview", filters],
    queryFn: ({ signal }) => fetchRepositoryReport(filters, signal),
    retry: false,
  });
}
