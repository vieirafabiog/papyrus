import {
  CONTRACTS_API_PREFIX,
  type UpdateUploadLimitsRequestContract,
  type UploadLimitsViewContract,
  updateUploadLimitsRequestSchema,
  uploadLimitsResponseSchema,
} from "@papyrus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { type MessageKey, translate } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "papyrus_csrf";
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
  fallbackKey: MessageKey,
): Promise<UploadLimitsFetchError> {
  const message = await extractUserErrorMessage(response, fallbackKey);
  return new UploadLimitsFetchError(response.status, message);
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
    throw await parseErrorResponse(response, "admin.uploadLimits.errors.loadFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = uploadLimitsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new UploadLimitsFetchError(500, translate("common.errors.unexpectedResponse"));
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
    throw await parseErrorResponse(response, "admin.uploadLimits.errors.saveFailed");
  }
  const rawJson: unknown = await response.json();
  const parsed = uploadLimitsResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new UploadLimitsFetchError(500, translate("common.errors.unexpectedResponse"));
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
