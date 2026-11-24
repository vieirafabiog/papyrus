import {
  CONTRACTS_API_PREFIX,
  type CreateTagInput,
  type TagRecord,
  createTagInputSchema,
  documentTagListResponseSchema,
  tagListResponseSchema,
  tagResponseSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { translate } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "docuflow_csrf";
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

export const TAGS_QUERY_KEY = ["tags"] as const;

export function documentTagsQueryKey(documentId: string) {
  return ["documents", documentId, "tags"] as const;
}

export async function fetchTags(params: {
  readonly search?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
}) {
  const searchParams = new URLSearchParams();
  if (params.search && params.search.trim().length > 0) {
    searchParams.set("search", params.search.trim());
  }
  searchParams.set("page", String(params.page ?? 1));
  searchParams.set("pageSize", String(params.pageSize ?? 50));

  const response = await fetch(`${CONTRACTS_API_PREFIX}/tags?${searchParams.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "tags.errors.listFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = tagListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function createTag(input: CreateTagInput): Promise<TagRecord> {
  const validated = createTagInputSchema.parse(input);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/tags`, {
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
    throw new Error(await extractUserErrorMessage(response, "tags.errors.createFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = tagResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function fetchDocumentTags(documentId: string): Promise<readonly TagRecord[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}/tags`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "tags.errors.loadDocumentTagsFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = documentTagListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function attachDocumentTag(
  documentId: string,
  tagId: string,
): Promise<readonly TagRecord[]> {
  const csrfToken = await resolveCsrfToken();
  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}/tags`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify({ tagId }),
  });

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "tags.errors.attachFailed"));
  }

  const rawJson: unknown = await response.json();
  const parsed = documentTagListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }
  return parsed.data.data;
}

export async function detachDocumentTag(documentId: string, tagId: string): Promise<void> {
  const csrfToken = await resolveCsrfToken();
  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}/tags/${tagId}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(await extractUserErrorMessage(response, "tags.errors.detachFailed"));
  }
}

export function useTagsQuery(search: string, page = 1, pageSize = 20) {
  return useQuery({
    queryKey: [...TAGS_QUERY_KEY, search, page, pageSize],
    queryFn: () => fetchTags({ search, page, pageSize }),
  });
}

export function useCreateTagMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTag,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
    },
  });
}

export function useDocumentTagsQuery(documentId: string) {
  return useQuery({
    queryKey: documentTagsQueryKey(documentId),
    queryFn: () => fetchDocumentTags(documentId),
    enabled: documentId.length > 0,
  });
}

export function useAttachDocumentTagMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tagId: string) => attachDocumentTag(documentId, tagId),
    onSuccess: (updatedTags) => {
      queryClient.setQueryData(documentTagsQueryKey(documentId), updatedTags);
    },
  });
}

export function useDetachDocumentTagMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tagId: string) => detachDocumentTag(documentId, tagId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: documentTagsQueryKey(documentId) });
    },
  });
}
