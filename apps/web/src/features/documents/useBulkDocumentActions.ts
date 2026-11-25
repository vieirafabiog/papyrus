import {
  type BulkDocumentActionRequest,
  type BulkDocumentActionSummary,
  CONTRACTS_API_PREFIX,
  bulkDocumentActionRequestSchema,
  bulkDocumentActionResponseSchema,
  bulkDocumentDownloadRequestSchema,
} from "@papyrus/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { translate } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "papyrus_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

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

export async function executeBulkDocumentAction(
  payload: BulkDocumentActionRequest,
): Promise<BulkDocumentActionSummary> {
  const validated = bulkDocumentActionRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/bulk-actions`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(validated),
  });

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "documents.bulk.errors.actionFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = bulkDocumentActionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function downloadDocumentsZip(documentIds: readonly string[]): Promise<void> {
  const validated = bulkDocumentDownloadRequestSchema.parse({ documentIds: [...documentIds] });
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/bulk-download`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/zip, application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(validated),
  });

  if (!response.ok) {
    throw new Error(
      await extractUserErrorMessage(response, "documents.bulk.errors.downloadFailed"),
    );
  }

  const blob = await response.blob();
  if (typeof URL.createObjectURL !== "function") {
    throw new Error(translate("documents.preview.browserUnsupported"));
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "papyrus-documents.zip";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    if (typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

export function useBulkDocumentActionMutation() {
  const queryClient = useQueryClient();
  return useMutation<BulkDocumentActionSummary, Error, BulkDocumentActionRequest>({
    mutationFn: executeBulkDocumentAction,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["documents", "search"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["documents", "trash"] }),
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
      ]);
    },
  });
}
