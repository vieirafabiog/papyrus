import {
  CONTRACTS_API_PREFIX,
  type CreateWorkflowDefinitionRequest,
  type PublishWorkflowDefinitionVersionRequest,
  type WorkflowAssigneeCatalog,
  type WorkflowDefinitionEntityRecord,
  type WorkflowDefinitionMutationResult,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionWithVersionsRecord,
  apiErrorResponseSchema,
  workflowAssigneeCatalogResponseSchema,
  workflowDefinitionDetailResponseSchema,
  workflowDefinitionListResponseSchema,
  workflowDefinitionMutationResponseSchema,
  workflowDefinitionStatusResponseSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
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

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const raw: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.error.message;
    }
  } catch {
    // Fallback para mensagem padrão.
  }
  return `${fallback} (${response.status}).`;
}

export async function fetchWorkflowDefinitionsList(
  includeInactive: boolean,
): Promise<readonly WorkflowDefinitionSummary[]> {
  const query = includeInactive ? "?includeInactive=true" : "";
  const response = await fetch(`${CONTRACTS_API_PREFIX}/workflows/definitions${query}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Falha ao listar definições de fluxo"));
  }
  const parsed = workflowDefinitionListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Resposta inválida recebida ao listar definições de fluxo.");
  }
  return parsed.data.data;
}

export async function fetchWorkflowDefinitionDetail(
  definitionId: string,
): Promise<WorkflowDefinitionWithVersionsRecord> {
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/workflows/definitions/${encodeURIComponent(definitionId)}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Falha ao carregar detalhes do fluxo"));
  }
  const parsed = workflowDefinitionDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Resposta inválida recebida ao consultar detalhes do fluxo.");
  }
  return parsed.data.data;
}

export async function fetchWorkflowAssigneeCatalog(): Promise<WorkflowAssigneeCatalog> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/workflows/assignees`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Falha ao carregar aprovadores disponíveis"));
  }
  const parsed = workflowAssigneeCatalogResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Resposta inválida recebida ao consultar aprovadores.");
  }
  return parsed.data.data;
}

export function useWorkflowDefinitionsQuery(includeInactive: boolean) {
  return useQuery<readonly WorkflowDefinitionSummary[], Error>({
    queryKey: ["workflows", "definitions", { includeInactive }],
    queryFn: () => fetchWorkflowDefinitionsList(includeInactive),
    retry: false,
  });
}

export function useWorkflowDefinitionDetailQuery(definitionId: string | null) {
  return useQuery<WorkflowDefinitionWithVersionsRecord, Error>({
    queryKey: ["workflows", "definitions", "detail", definitionId],
    queryFn: () => {
      if (!definitionId) {
        throw new Error("Identificador do fluxo não informado.");
      }
      return fetchWorkflowDefinitionDetail(definitionId);
    },
    enabled: Boolean(definitionId),
    retry: false,
  });
}

export function useWorkflowAssigneeCatalogQuery(enabled: boolean) {
  return useQuery<WorkflowAssigneeCatalog, Error>({
    queryKey: ["workflows", "assignees"],
    queryFn: fetchWorkflowAssigneeCatalog,
    enabled,
    retry: false,
  });
}

export function useCreateWorkflowDefinitionMutation() {
  const queryClient = useQueryClient();
  return useMutation<WorkflowDefinitionMutationResult, Error, CreateWorkflowDefinitionRequest>({
    mutationFn: async (input) => {
      const csrfToken = await resolveCsrfToken();
      const response = await fetch(`${CONTRACTS_API_PREFIX}/workflows/definitions`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(await parseErrorMessage(response, "Não foi possível criar o fluxo"));
      }
      const parsed = workflowDefinitionMutationResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("Resposta inválida recebida ao criar definição de fluxo.");
      }
      return parsed.data.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workflows", "definitions"] });
    },
  });
}

export function usePublishWorkflowVersionMutation() {
  const queryClient = useQueryClient();
  return useMutation<
    WorkflowDefinitionMutationResult,
    Error,
    { readonly definitionId: string; readonly payload: PublishWorkflowDefinitionVersionRequest }
  >({
    mutationFn: async ({ definitionId, payload }) => {
      const csrfToken = await resolveCsrfToken();
      const response = await fetch(
        `${CONTRACTS_API_PREFIX}/workflows/definitions/${encodeURIComponent(definitionId)}/versions`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
          },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        throw new Error(
          await parseErrorMessage(response, "Não foi possível publicar nova versão do fluxo"),
        );
      }
      const parsed = workflowDefinitionMutationResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("Resposta inválida recebida ao publicar nova versão do fluxo.");
      }
      return parsed.data.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workflows", "definitions"] });
    },
  });
}

export function useToggleWorkflowStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation<
    WorkflowDefinitionEntityRecord,
    Error,
    { readonly definitionId: string; readonly isActive: boolean }
  >({
    mutationFn: async ({ definitionId, isActive }) => {
      const csrfToken = await resolveCsrfToken();
      const response = await fetch(
        `${CONTRACTS_API_PREFIX}/workflows/definitions/${encodeURIComponent(definitionId)}/status`,
        {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
          },
          body: JSON.stringify({ isActive }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await parseErrorMessage(response, "Não foi possível alterar o status do fluxo"),
        );
      }
      const parsed = workflowDefinitionStatusResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("Resposta inválida recebida ao alterar status do fluxo.");
      }
      return parsed.data.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workflows", "definitions"] });
    },
  });
}
