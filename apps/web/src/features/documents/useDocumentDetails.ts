import {
  type ArchiveDocumentRequest,
  CONTRACTS_API_PREFIX,
  type CreateDocumentVersionResponse,
  type DocumentDetail,
  type DocumentVersionHistoryItem,
  type FolderRecord,
  type MoveDocumentRequest,
  type RestoreDocumentVersionRequest,
  type RestoreTrashedDocumentRequest,
  type TrashDocumentListItem,
  type TrashDocumentsListResponse,
  type TrashDocumentsQuery,
  type UpdateDocumentRequest,
  apiErrorResponseSchema,
  archiveDocumentRequestSchema,
  createApiResponseSchema,
  createDocumentVersionResponseSchema,
  documentDetailResponseSchema,
  documentRecordSchema,
  documentVersionHistoryListResponseSchema,
  folderListResponseSchema,
  moveDocumentRequestSchema,
  restoreDocumentVersionRequestSchema,
  restoreTrashedDocumentRequestSchema,
  trashDocumentsListResponseSchema,
  updateDocumentRequestSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

const updatedDocumentEnvelopeSchema = createApiResponseSchema(documentRecordSchema);

export class DocumentDetailFetchError extends Error {
  public readonly statusCode: number;
  public readonly fieldErrors: Readonly<Record<string, string>>;

  public constructor(
    statusCode: number,
    message: string,
    fieldErrors: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "DocumentDetailFetchError";
    this.statusCode = statusCode;
    this.fieldErrors = fieldErrors;
  }
}

export function documentDetailsQueryKey(documentId: string) {
  return ["documents", documentId, "details"] as const;
}

export function documentVersionsQueryKey(documentId: string) {
  return ["documents", documentId, "versions"] as const;
}

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

function extractFieldErrors(details: Record<string, unknown> | undefined): Record<string, string> {
  if (!details) {
    return {};
  }
  const rawFieldErrors = details.fieldErrors;
  if (!rawFieldErrors || typeof rawFieldErrors !== "object") {
    return {};
  }
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawFieldErrors)) {
    if (typeof value === "string" && value.trim().length > 0) {
      mapped[key] = value;
    }
  }
  return mapped;
}

async function parseErrorResponse(
  response: Response,
  fallbackMessage: string,
): Promise<DocumentDetailFetchError> {
  let message = `${fallbackMessage} (${response.status}).`;
  let fieldErrors: Record<string, string> = {};
  try {
    const rawError: unknown = await response.json();
    const parsedError = apiErrorResponseSchema.safeParse(rawError);
    if (parsedError.success) {
      message = parsedError.data.error.message;
      fieldErrors = extractFieldErrors(parsedError.data.error.details);
    }
  } catch {
    // Fallback to generic HTTP message.
  }
  return new DocumentDetailFetchError(response.status, message, fieldErrors);
}

export async function fetchDocumentDetails(documentId: string): Promise<DocumentDetail> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao carregar os detalhes do documento");
  }

  const rawJson: unknown = await response.json();
  const parsed = documentDetailResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(500, "Resposta inválida recebida ao consultar o documento.");
  }

  return parsed.data.data;
}

export async function updateDocumentMetadata(documentId: string, payload: UpdateDocumentRequest) {
  const validated = updateDocumentRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}`, {
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
    throw await parseErrorResponse(response, "Falha ao salvar metadados do documento");
  }

  const rawJson: unknown = await response.json();
  const parsed = updatedDocumentEnvelopeSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(500, "Resposta inválida recebida ao atualizar metadados.");
  }

  return parsed.data.data;
}

export function useDocumentDetailsQuery(documentId: string) {
  return useQuery<DocumentDetail, DocumentDetailFetchError>({
    queryKey: documentDetailsQueryKey(documentId),
    queryFn: () => fetchDocumentDetails(documentId),
    enabled: documentId.trim().length > 0,
    retry: false,
  });
}

export function useUpdateDocumentMetadataMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateDocumentRequest) => updateDocumentMetadata(documentId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(documentId) });
    },
  });
}

export async function fetchDocumentVersions(
  documentId: string,
): Promise<readonly DocumentVersionHistoryItem[]> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}/versions`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao carregar o histórico de versões");
  }

  const rawJson: unknown = await response.json();
  const parsed = documentVersionHistoryListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(
      500,
      "Resposta inválida recebida ao consultar o histórico de versões.",
    );
  }

  return parsed.data.data;
}

export async function restoreDocumentVersion(
  documentId: string,
  versionId: string,
  payload: RestoreDocumentVersionRequest,
): Promise<CreateDocumentVersionResponse> {
  const validated = restoreDocumentVersionRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${documentId}/versions/${versionId}/restore`,
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
    throw await parseErrorResponse(response, "Falha ao restaurar a versão selecionada");
  }

  const rawJson: unknown = await response.json();
  const parsed = createDocumentVersionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(
      500,
      "Resposta inválida recebida ao restaurar a versão documental.",
    );
  }

  return parsed.data;
}

export function useDocumentVersionsQuery(documentId: string) {
  return useQuery<readonly DocumentVersionHistoryItem[], DocumentDetailFetchError>({
    queryKey: documentVersionsQueryKey(documentId),
    queryFn: () => fetchDocumentVersions(documentId),
    enabled: documentId.trim().length > 0,
    retry: false,
  });
}

export function useRestoreDocumentVersionMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    CreateDocumentVersionResponse,
    DocumentDetailFetchError,
    { readonly versionId: string; readonly expectedVersion: number; readonly changeNote?: string }
  >({
    mutationFn: ({ versionId, expectedVersion, changeNote }) =>
      restoreDocumentVersion(documentId, versionId, {
        expectedVersion,
        ...(changeNote && changeNote.trim().length > 0 ? { changeNote: changeNote.trim() } : {}),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: documentVersionsQueryKey(documentId) }),
        queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(documentId) }),
      ]);
    },
  });
}

export async function requestVersionDownloadTarget(
  documentId: string,
  versionId: string,
): Promise<{ readonly url?: string | undefined }> {
  const csrfToken = await resolveCsrfToken();
  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}/download-target`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify({ versionId }),
  });

  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao solicitar o download da versão");
  }

  const rawJson: unknown = await response.json();
  if (rawJson && typeof rawJson === "object" && "data" in rawJson) {
    const data = (rawJson as { data?: unknown }).data;
    if (data && typeof data === "object") {
      if ("url" in data && typeof (data as { url?: unknown }).url === "string") {
        return { url: (data as { url: string }).url };
      }
      if ("target" in data) {
        const target = (data as { target?: unknown }).target;
        if (target && typeof target === "object" && "url" in target) {
          const url = (target as { url?: unknown }).url;
          if (typeof url === "string") {
            return { url };
          }
        }
      }
    }
  }
  return {};
}

export async function fetchAvailableFolders(): Promise<readonly FolderRecord[]> {
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/folders?status=ACTIVE&pageSize=100&sortBy=name&sortDirection=asc`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );

  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao carregar pastas disponíveis");
  }

  const rawJson: unknown = await response.json();
  const parsed = folderListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(500, "Resposta inválida recebida ao listar pastas.");
  }

  return parsed.data.data.items;
}

export function useAvailableFoldersQuery(enabled: boolean) {
  return useQuery<readonly FolderRecord[], DocumentDetailFetchError>({
    queryKey: ["folders", "active-options"],
    queryFn: fetchAvailableFolders,
    enabled,
    retry: false,
  });
}

export async function moveDocument(documentId: string, payload: MoveDocumentRequest) {
  const validated = moveDocumentRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}/move`, {
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
    throw await parseErrorResponse(response, "Falha ao mover o documento");
  }

  const rawJson: unknown = await response.json();
  const parsed = updatedDocumentEnvelopeSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(500, "Resposta inválida recebida ao mover documento.");
  }

  return parsed.data.data;
}

export async function archiveDocument(documentId: string, payload: ArchiveDocumentRequest) {
  const validated = archiveDocumentRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}/archive`, {
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
    throw await parseErrorResponse(response, "Falha ao arquivar o documento");
  }

  const rawJson: unknown = await response.json();
  const parsed = updatedDocumentEnvelopeSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(500, "Resposta inválida recebida ao arquivar documento.");
  }

  return parsed.data.data;
}

export function useMoveDocumentMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: MoveDocumentRequest) => moveDocument(documentId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(documentId) });
    },
  });
}

export function useArchiveDocumentMutation(documentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ArchiveDocumentRequest) => archiveDocument(documentId, payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(documentId) }),
        queryClient.invalidateQueries({ queryKey: documentVersionsQueryKey(documentId) }),
      ]);
    },
  });
}

export function trashDocumentsQueryKey(filters?: Partial<TrashDocumentsQuery>) {
  return ["documents", "trash", filters ?? {}] as const;
}

export async function fetchTrashDocuments(
  filters: Partial<TrashDocumentsQuery> = {},
): Promise<TrashDocumentsListResponse> {
  const params = new URLSearchParams();
  if (filters.page !== undefined) {
    params.set("page", String(filters.page));
  }
  if (filters.pageSize !== undefined) {
    params.set("pageSize", String(filters.pageSize));
  }
  if (filters.search && filters.search.trim().length > 0) {
    params.set("search", filters.search.trim());
  }
  if (filters.categoryId) {
    params.set("categoryId", filters.categoryId);
  }
  if (filters.folderId) {
    params.set("folderId", filters.folderId);
  }
  if (filters.sortBy) {
    params.set("sortBy", filters.sortBy);
  }
  if (filters.sortDirection) {
    params.set("sortDirection", filters.sortDirection);
  }

  const queryString = params.toString();
  const url = `${CONTRACTS_API_PREFIX}/documents/trash${queryString.length > 0 ? `?${queryString}` : ""}`;
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw await parseErrorResponse(response, "Falha ao carregar documentos na lixeira");
  }

  const rawJson: unknown = await response.json();
  const parsed = trashDocumentsListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(500, "Resposta inválida recebida da lixeira documental.");
  }

  return parsed.data;
}

export function useTrashDocumentsQuery(filters: Partial<TrashDocumentsQuery>) {
  return useQuery<TrashDocumentsListResponse, DocumentDetailFetchError>({
    queryKey: trashDocumentsQueryKey(filters),
    queryFn: () => fetchTrashDocuments(filters),
  });
}

export async function restoreTrashedDocument(
  documentId: string,
  payload: RestoreTrashedDocumentRequest,
) {
  const validated = restoreTrashedDocumentRequestSchema.parse(payload);
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}/restore`, {
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
    throw await parseErrorResponse(response, "Falha ao restaurar documento da lixeira");
  }

  const rawJson: unknown = await response.json();
  const parsed = updatedDocumentEnvelopeSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(500, "Resposta inválida recebida ao restaurar documento.");
  }

  return parsed.data.data;
}

export function useRestoreTrashedDocumentMutation(documentId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      readonly documentId: string;
      readonly payload: RestoreTrashedDocumentRequest;
    }) => restoreTrashedDocument(params.documentId, params.payload),
    onSuccess: async (_data, variables) => {
      const targetId = documentId ?? variables.documentId;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["documents", "trash"] }),
        queryClient.invalidateQueries({ queryKey: ["documents", "search"] }),
        queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(targetId) }),
        queryClient.invalidateQueries({ queryKey: documentVersionsQueryKey(targetId) }),
      ]);
    },
  });
}

export type { TrashDocumentListItem };
