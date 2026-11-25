import {
  CONTRACTS_API_PREFIX,
  type CreateDocumentCommentRequest,
  type DocumentCommentListResponse,
  type DocumentCommentRecord,
  type MentionCandidate,
  createDocumentCommentRequestSchema,
  deleteDocumentCommentResponseSchema,
  documentCommentDetailResponseSchema,
  documentCommentListResponseSchema,
  mentionCandidateListResponseSchema,
} from "@papyrus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export function documentCommentsQueryKey(documentId: string, page?: number) {
  return page === undefined
    ? (["documents", documentId, "comments"] as const)
    : (["documents", documentId, "comments", { page }] as const);
}

export function mentionCandidatesQueryKey(documentId: string, query: string) {
  return ["documents", documentId, "mention-candidates", query] as const;
}

export async function fetchDocumentComments(
  documentId: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<DocumentCommentListResponse["data"]> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/comments?${params.toString()}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );

  if (!response.ok) {
    throw new Error(
      await extractUserErrorMessage(response, "documents.comments.errors.loadFailed"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = documentCommentListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function fetchMentionCandidates(
  documentId: string,
  query: string,
  signal?: AbortSignal,
): Promise<readonly MentionCandidate[]> {
  const params = new URLSearchParams({ limit: "8" });
  const trimmed = query.trim();
  if (trimmed.length > 0) {
    params.set("q", trimmed);
  }

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/mention-candidates?${params.toString()}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );

  if (!response.ok) {
    throw new Error(
      await extractUserErrorMessage(response, "documents.comments.errors.mentionsLoadFailed"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = mentionCandidateListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data.items;
}

export async function createDocumentComment(
  documentId: string,
  input: CreateDocumentCommentRequest,
): Promise<DocumentCommentRecord> {
  const validated = createDocumentCommentRequestSchema.parse(input);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/comments`,
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
      await extractUserErrorMessage(response, "documents.comments.errors.createFailed"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = documentCommentDetailResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data;
}

export async function deleteDocumentComment(
  documentId: string,
  commentId: string,
): Promise<string> {
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(commentId)}`,
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
    throw new Error(
      await extractUserErrorMessage(response, "documents.comments.errors.deleteFailed"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = deleteDocumentCommentResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(translate("common.errors.unexpectedResponse"));
  }

  return parsed.data.data.commentId;
}

export function useDocumentCommentsQuery(documentId: string, page: number, pageSize = 20) {
  return useQuery({
    queryKey: documentCommentsQueryKey(documentId, page),
    queryFn: ({ signal }) => fetchDocumentComments(documentId, page, pageSize, signal),
    enabled: Boolean(documentId),
  });
}

export function useMentionCandidatesQuery(documentId: string, query: string, enabled: boolean) {
  return useQuery({
    queryKey: mentionCandidatesQueryKey(documentId, query),
    queryFn: ({ signal }) => fetchMentionCandidates(documentId, query, signal),
    enabled: Boolean(documentId) && enabled,
    staleTime: 30_000,
  });
}

export function useCreateDocumentCommentMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation<DocumentCommentRecord, Error, CreateDocumentCommentRequest>({
    mutationFn: (input) => createDocumentComment(documentId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: documentCommentsQueryKey(documentId) });
    },
  });
}

export function useDeleteDocumentCommentMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation<string, Error, string>({
    mutationFn: (commentId) => deleteDocumentComment(documentId, commentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: documentCommentsQueryKey(documentId) });
    },
  });
}
