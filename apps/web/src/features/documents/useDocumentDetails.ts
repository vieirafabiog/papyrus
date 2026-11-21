import {
  CONTRACTS_API_PREFIX,
  type DocumentDetail,
  apiErrorResponseSchema,
  documentDetailResponseSchema,
} from "@docuflow/contracts";
import { useQuery } from "@tanstack/react-query";

export class DocumentDetailFetchError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DocumentDetailFetchError";
    this.statusCode = statusCode;
  }
}

export function documentDetailsQueryKey(documentId: string) {
  return ["documents", documentId, "details"] as const;
}

export async function fetchDocumentDetails(documentId: string): Promise<DocumentDetail> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/documents/${documentId}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    let message = `Falha ao carregar os detalhes do documento (${response.status}).`;
    try {
      const rawError: unknown = await response.json();
      const parsedError = apiErrorResponseSchema.safeParse(rawError);
      if (parsedError.success) {
        message = parsedError.data.error.message;
      }
    } catch {
      // Fallback to generic HTTP message.
    }
    throw new DocumentDetailFetchError(response.status, message);
  }

  const rawJson: unknown = await response.json();
  const parsed = documentDetailResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new DocumentDetailFetchError(500, "Resposta inválida recebida ao consultar o documento.");
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
