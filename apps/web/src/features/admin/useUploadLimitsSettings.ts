import {
  CONTRACTS_API_PREFIX,
  type UpdateUploadLimitsRequestContract,
  type UploadLimitsViewContract,
  apiErrorResponseSchema,
  updateUploadLimitsRequestSchema,
  uploadLimitsResponseSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export class UploadLimitsFetchError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "UploadLimitsFetchError";
    this.statusCode = statusCode;
  }
}

export const uploadLimitsQueryKey = () => ["uploads", "limits"] as const;

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
  fallbackMessage: string,
): Promise<UploadLimitsFetchError> {
  try {
    const rawJson: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(rawJson);
    if (parsed.success) {
      return new UploadLimitsFetchError(response.status, parsed.data.error.message);
    }
  } catch {
    // Non-JSON error body
  }
  return new UploadLimitsFetchError(
    response.status,
    `${fallbackMessage} (HTTP ${response.status}).`,
  );
}

export async function fetchUploadLimits(): Promise<UploadLimitsViewContract | null> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/uploads/limits`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao carregar limites de upload");
  }
  const rawJson: unknown = await response.json();
  const parsed = uploadLimitsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new UploadLimitsFetchError(500, "Resposta inválida recebida dos limites de upload.");
  }
  return parsed.data.data;
}

export async function updateUploadLimits(
  payload: UpdateUploadLimitsRequestContract,
): Promise<UploadLimitsViewContract> {
  const validated = updateUploadLimitsRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/admin/upload-limits`, {
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
    throw await parseErrorResponse(response, "Falha ao atualizar limites de upload");
  }
  const rawJson: unknown = await response.json();
  const parsed = uploadLimitsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new UploadLimitsFetchError(500, "Resposta inválida ao atualizar limites de upload.");
  }
  return parsed.data.data;
}

export function useUploadLimitsQuery(enabled = true) {
  return useQuery<UploadLimitsViewContract | null, UploadLimitsFetchError>({
    queryKey: uploadLimitsQueryKey(),
    queryFn: fetchUploadLimits,
    enabled,
    retry: false,
  });
}

export function useUpdateUploadLimitsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateUploadLimits,
    onSuccess: (updated) => {
      queryClient.setQueryData(uploadLimitsQueryKey(), updated);
    },
  });
}
