import {
  type AdminSystemStatusReportContract,
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  adminSystemStatusResponseSchema,
  apiErrorResponseSchema,
} from "@docuflow/contracts";
import { useQuery } from "@tanstack/react-query";

export class SystemStatusFetchError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "SystemStatusFetchError";
    this.statusCode = statusCode;
  }
}

export function canViewSystemStatus(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  return (
    session.roles.some((role) => role.key === "admin") ||
    session.permissions.some(
      (perm) =>
        (perm.action === "MANAGE_STORAGE" && perm.resource === "STORAGE") ||
        (perm.action === "VIEW_AUDIT" && perm.resource === "AUDIT"),
    )
  );
}

export const systemStatusQueryKey = () => ["admin", "system-status"] as const;

export async function fetchSystemStatus(): Promise<AdminSystemStatusReportContract> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/system-status`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    try {
      const rawError: unknown = await response.json();
      const parsedError = apiErrorResponseSchema.safeParse(rawError);
      if (parsedError.success) {
        throw new SystemStatusFetchError(response.status, parsedError.data.error.message);
      }
    } catch (error) {
      if (error instanceof SystemStatusFetchError) {
        throw error;
      }
    }
    throw new SystemStatusFetchError(
      response.status,
      `Falha ao consultar o status operacional (HTTP ${response.status}).`,
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = adminSystemStatusResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new SystemStatusFetchError(500, "Resposta inválida recebida do status operacional.");
  }
  return parsed.data.data;
}

export function useSystemStatusQuery(enabled = true) {
  return useQuery<AdminSystemStatusReportContract, SystemStatusFetchError>({
    queryKey: systemStatusQueryKey(),
    queryFn: fetchSystemStatus,
    enabled,
  });
}
