import {
  type AuthMeResponse,
  authMeResponseSchema,
  CONTRACTS_API_PREFIX,
  createApiResponseSchema,
} from "@docuflow/contracts";
import { useQuery } from "@tanstack/react-query";

const authMeEnvelopeSchema = createApiResponseSchema(authMeResponseSchema);

export const SESSION_QUERY_KEY = ["auth", "me"] as const;

export async function fetchCurrentSession(): Promise<AuthMeResponse | null> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/me`, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Falha ao consultar sessão (${response.status}).`);
  }

  const rawJson: unknown = await response.json();
  const parsed = authMeEnvelopeSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error("Resposta de sessão inválida recebida da API.");
  }

  return parsed.data.data;
}

export function useSessionQuery() {
  return useQuery<AuthMeResponse | null, Error>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchCurrentSession,
    retry: false,
  });
}
