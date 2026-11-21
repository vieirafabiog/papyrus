import {
  CONTRACTS_API_PREFIX,
  type DocumentDetail,
  type UpdateDocumentRequest,
  apiErrorResponseSchema,
  createApiResponseSchema,
  documentDetailResponseSchema,
  documentRecordSchema,
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
