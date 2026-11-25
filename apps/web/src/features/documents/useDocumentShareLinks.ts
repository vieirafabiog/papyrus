import {
  CONTRACTS_API_PREFIX,
  type CreateDocumentShareLinkRequest,
  type CreatedDocumentShareLinkResponse,
  type DocumentShareLinkRecord,
  type PublicShareMetadata,
  createDocumentShareLinkRequestSchema,
  createdDocumentShareLinkResponseSchema,
  documentShareLinkListResponseSchema,
  publicShareMetadataResponseSchema,
  revokeDocumentShareLinkResponseSchema,
  unlockPublicShareRequestSchema,
  unlockPublicShareResponseSchema,
} from "@papyrus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { translate } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "papyrus_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
export const SHARE_UNLOCK_HEADER_NAME = "x-share-unlock";

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

export function documentShareLinksQueryKey(documentId: string) {
  return ["documents", documentId, "share-links"] as const;
}

export async function fetchDocumentShareLinks(
  documentId: string,
  signal?: AbortSignal,
): Promise<readonly DocumentShareLinkRecord[]> {
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/share-links`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "documents.share.errors.loadFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = documentShareLinkListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data.items;
}

export async function createDocumentShareLink(
  documentId: string,
  input: CreateDocumentShareLinkRequest,
): Promise<CreatedDocumentShareLinkResponse["data"]> {
  const validated = createDocumentShareLinkRequestSchema.parse(input);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/share-links`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
      body: JSON.stringify(validated),
    },
  );

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "documents.share.errors.createFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = createdDocumentShareLinkResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function revokeDocumentShareLink(
  documentId: string,
  shareLinkId: string,
): Promise<string> {
  const csrfToken = await resolveCsrfToken();
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/share-links/${encodeURIComponent(shareLinkId)}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
    },
  );

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "documents.share.errors.revokeFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = revokeDocumentShareLinkResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data.shareLinkId;
}

export async function fetchPublicShareMetadata(
  token: string,
  unlockToken?: string | null,
  signal?: AbortSignal,
): Promise<PublicShareMetadata> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/share/${encodeURIComponent(token)}`, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(unlockToken ? { [SHARE_UNLOCK_HEADER_NAME]: unlockToken } : {}),
    },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(
      await extractUserErrorMessage(response, "documents.publicShare.unavailableDescription"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = publicShareMetadataResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function unlockPublicShare(
  token: string,
  passcode: string,
): Promise<{ readonly unlockToken: string; readonly expiresInSeconds: number }> {
  const validated = unlockPublicShareRequestSchema.parse({ passcode });
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/share/${encodeURIComponent(token)}/unlock`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      },
      body: JSON.stringify(validated),
    },
  );

  if (!response.ok) {
    throw new Error(
      await extractUserErrorMessage(response, "documents.publicShare.errors.unlockFailed"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = unlockPublicShareResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export function useDocumentShareLinksQuery(documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: documentShareLinksQueryKey(documentId),
    queryFn: ({ signal }) => fetchDocumentShareLinks(documentId, signal),
    enabled: Boolean(documentId) && enabled,
  });
}

export function useCreateDocumentShareLinkMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    CreatedDocumentShareLinkResponse["data"],
    Error,
    CreateDocumentShareLinkRequest
  >({
    mutationFn: (input) => createDocumentShareLink(documentId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: documentShareLinksQueryKey(documentId) });
    },
  });
}

export function useRevokeDocumentShareLinkMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation<string, Error, string>({
    mutationFn: (shareLinkId) => revokeDocumentShareLink(documentId, shareLinkId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: documentShareLinksQueryKey(documentId) });
    },
  });
}
