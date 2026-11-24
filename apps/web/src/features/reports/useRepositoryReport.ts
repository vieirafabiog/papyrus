import {
  CONTRACTS_API_PREFIX,
  type DocumentStatus,
  type RepositoryReport,
  apiErrorResponseSchema,
  repositoryReportResponseSchema,
} from "@docuflow/contracts";
import { useQuery } from "@tanstack/react-query";

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
    let message = `Não foi possível gerar o relatório do acervo (${response.status}).`;
    try {
      const parsedError = apiErrorResponseSchema.safeParse(await response.json());
      if (parsedError.success) {
        message = parsedError.data.error.message;
      }
    } catch {
      // Fallback para mensagem padrão.
    }
    throw new Error(message);
  }

  const parsed = repositoryReportResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Resposta inválida recebida ao consultar o relatório do acervo.");
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
