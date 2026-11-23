import {
  CONTRACTS_API_PREFIX,
  type DocumentDetail,
  type DocumentVersionHistoryItem,
  type SubmitTaskDecisionInput,
  type SubmitTaskDecisionResult,
  type TaskInboxItem,
  apiErrorResponseSchema,
  documentVersionHistoryListResponseSchema,
  submitTaskDecisionInputSchema,
  submitTaskDecisionResponseSchema,
  taskDetailResponseSchema,
} from "@docuflow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentWorkflowTimelineQueryKey } from "../documents/DocumentWorkflowTimeline.js";
import {
  documentDetailsQueryKey,
  documentVersionsQueryKey,
  fetchDocumentDetails,
} from "../documents/useDocumentDetails.js";
import { TASK_INBOX_COUNTS_QUERY_KEY } from "./useTaskInbox.js";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

export class TaskReviewRequestError extends Error {
  public readonly statusCode: number;
  public readonly code?: string | undefined;

  public constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = "TaskReviewRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function taskDetailQueryKey(taskId: string) {
  return ["tasks", "detail", taskId] as const;
}

export function taskDocumentVersionsQueryKey(documentId: string) {
  return ["tasks", "documentVersions", documentId] as const;
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

async function parseTaskReviewError(
  response: Response,
  fallbackMessage: string,
): Promise<TaskReviewRequestError> {
  let message = `${fallbackMessage} (${response.status}).`;
  let code: string | undefined;
  try {
    const rawError: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(rawError);
    if (parsed.success) {
      message = parsed.data.error.message;
      code = parsed.data.error.code;
    }
  } catch {
    // Fallback to HTTP status code message.
  }
  return new TaskReviewRequestError(response.status, message, code);
}

/**
 * Fetches authorized task detail from `GET /api/v1/tasks/:id`.
 */
export async function fetchTaskDetail(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskInboxItem> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw await parseTaskReviewError(response, "Não foi possível carregar os detalhes da tarefa");
  }

  const rawJson: unknown = await response.json();
  const parsed = taskDetailResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new TaskReviewRequestError(500, "Resposta inválida recebida ao consultar a tarefa.");
  }

  return parsed.data.data;
}

/**
 * Fetches document version history to locate the immutable version bound to the workflow task.
 */
export async function fetchTaskDocumentVersions(
  documentId: string,
  signal?: AbortSignal,
): Promise<readonly DocumentVersionHistoryItem[]> {
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/versions`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );

  if (!response.ok) {
    throw await parseTaskReviewError(response, "Falha ao consultar o histórico de versões");
  }

  const rawJson: unknown = await response.json();
  const parsed = documentVersionHistoryListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new TaskReviewRequestError(500, "Resposta inválida ao consultar versões do documento.");
  }

  return parsed.data.data;
}

export interface SubmitTaskDecisionCommand {
  readonly decision: SubmitTaskDecisionInput["decision"];
  readonly comment?: string | null | undefined;
  readonly idempotencyKey?: string | undefined;
}

/**
 * Submits a workflow task decision to `POST /api/v1/tasks/:id/decision`.
 * Caller UI must wait for the resolved confirmation before changing state.
 */
export async function submitTaskDecision(
  taskId: string,
  command: SubmitTaskDecisionCommand,
): Promise<SubmitTaskDecisionResult> {
  const validated = submitTaskDecisionInputSchema.parse({
    decision: command.decision,
    comment: command.comment ?? null,
  });
  const csrfToken = await resolveCsrfToken();

  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/tasks/${encodeURIComponent(taskId)}/decision`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
        ...(command.idempotencyKey ? { "Idempotency-Key": command.idempotencyKey } : {}),
      },
      body: JSON.stringify(validated),
    },
  );

  if (!response.ok) {
    throw await parseTaskReviewError(response, "Não foi possível registrar a decisão da tarefa");
  }

  const rawJson: unknown = await response.json();
  const parsed = submitTaskDecisionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new TaskReviewRequestError(
      500,
      "Resposta inválida recebida ao confirmar a decisão da tarefa.",
    );
  }

  return parsed.data.data;
}

export function useTaskDetailQuery(taskId: string) {
  return useQuery<TaskInboxItem, TaskReviewRequestError>({
    queryKey: taskDetailQueryKey(taskId),
    queryFn: ({ signal }) => fetchTaskDetail(taskId, signal),
    enabled: taskId.trim().length > 0,
    retry: false,
  });
}

export function useTaskDocumentDetailsQuery(documentId: string | undefined) {
  return useQuery<DocumentDetail, Error>({
    queryKey: documentDetailsQueryKey(documentId ?? ""),
    queryFn: () => fetchDocumentDetails(documentId ?? ""),
    enabled: Boolean(documentId && documentId.trim().length > 0),
    retry: false,
  });
}

export function useTaskDocumentVersionsQuery(documentId: string | undefined) {
  return useQuery<readonly DocumentVersionHistoryItem[], TaskReviewRequestError>({
    queryKey: taskDocumentVersionsQueryKey(documentId ?? ""),
    queryFn: ({ signal }) => fetchTaskDocumentVersions(documentId ?? "", signal),
    enabled: Boolean(documentId && documentId.trim().length > 0),
    retry: false,
  });
}

export function useSubmitTaskDecisionMutation(taskId: string, documentId?: string) {
  const queryClient = useQueryClient();

  return useMutation<SubmitTaskDecisionResult, TaskReviewRequestError, SubmitTaskDecisionCommand>({
    mutationFn: (command) => submitTaskDecision(taskId, command),
    onSuccess: (confirmedResult) => {
      queryClient.setQueryData<TaskInboxItem>(taskDetailQueryKey(taskId), (previous) => {
        if (!previous) {
          return previous;
        }
        return {
          ...previous,
          status: confirmedResult.task.status,
          decidedAt: confirmedResult.task.decidedAt,
          documentStatus: confirmedResult.documentStatus,
          isOverdue: false,
        };
      });

      void queryClient.invalidateQueries({ queryKey: taskDetailQueryKey(taskId) });
      void queryClient.invalidateQueries({ queryKey: ["tasks", "inbox"] });
      void queryClient.invalidateQueries({ queryKey: TASK_INBOX_COUNTS_QUERY_KEY });

      if (documentId) {
        void queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(documentId) });
        void queryClient.invalidateQueries({ queryKey: documentVersionsQueryKey(documentId) });
        void queryClient.invalidateQueries({ queryKey: taskDocumentVersionsQueryKey(documentId) });
        void queryClient.invalidateQueries({
          queryKey: documentWorkflowTimelineQueryKey(documentId),
        });
      }
    },
  });
}
