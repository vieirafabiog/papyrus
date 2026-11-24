import {
  CONTRACTS_API_PREFIX,
  type DashboardSummary,
  createApiResponseSchema,
  dashboardSummarySchema,
} from "@docuflow/contracts";
import { useQuery } from "@tanstack/react-query";

const dashboardSummaryEnvelopeSchema = createApiResponseSchema(dashboardSummarySchema);

export const DASHBOARD_SUMMARY_QUERY_KEY = ["dashboard", "summary"] as const;

export async function fetchDashboardSummary(): Promise<DashboardSummary | null> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/dashboard/summary`, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 404 || response.status === 501) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Não foi possível carregar o resumo operacional do acervo.");
  }

  const rawJson: unknown = await response.json();
  const parsed = dashboardSummaryEnvelopeSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error("Resposta inválida ao consultar o resumo do painel.");
  }

  return parsed.data.data;
}

export function useDashboardSummary() {
  return useQuery<DashboardSummary | null, Error>({
    queryKey: DASHBOARD_SUMMARY_QUERY_KEY,
    queryFn: fetchDashboardSummary,
    retry: false,
  });
}
