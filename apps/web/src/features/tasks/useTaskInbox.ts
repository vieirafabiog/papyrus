import {
  CONTRACTS_API_PREFIX,
  type TaskInboxItem,
  type TaskInboxListResponse,
  type TaskInboxQuery,
  type WorkflowTaskStatus,
  apiErrorResponseSchema,
  taskInboxListResponseSchema,
} from "@docuflow/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

export type TaskInboxSortField = NonNullable<TaskInboxQuery["sortBy"]>;
export type TaskAssigneeFilterType = NonNullable<TaskInboxQuery["assigneeType"]>;

export interface TaskInboxFiltersState {
  readonly status: WorkflowTaskStatus | "";
  readonly assigneeType: TaskAssigneeFilterType | "";
  readonly overdueOnly: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: TaskInboxSortField;
  readonly sortDirection: "asc" | "desc";
}

export const DEFAULT_TASK_INBOX_FILTERS: TaskInboxFiltersState = {
  status: "",
  assigneeType: "",
  overdueOnly: false,
  page: 1,
  pageSize: 20,
  sortBy: "createdAt",
  sortDirection: "desc",
};

export interface TaskInboxCounts {
  readonly pendingCount: number;
  readonly overduePendingCount: number;
}

export function buildTaskInboxSearchParams(filters: TaskInboxFiltersState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("page", String(filters.page));
  params.set("pageSize", String(filters.pageSize));
  params.set("sortBy", filters.sortBy);
  params.set("sortDirection", filters.sortDirection);

  if (filters.status.length > 0) {
    params.set("status", filters.status);
  }
  if (filters.assigneeType.length > 0) {
    params.set("assigneeType", filters.assigneeType);
  }
  if (filters.overdueOnly) {
    params.set("overdueOnly", "true");
  }

  return params;
}

export function taskInboxListQueryKey(filters: TaskInboxFiltersState) {
  return ["tasks", "inbox", filters] as const;
}

export const TASK_INBOX_COUNTS_QUERY_KEY = ["tasks", "inbox", "counts"] as const;

async function parseTaskInboxErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const raw: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.error.message;
    }
  } catch {
    // Fallback to HTTP status code when body is not JSON.
  }
  return `${fallback} (${response.status}).`;
}

async function fetchTasksEndpoint(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<TaskInboxListResponse> {
  const response = await fetch(`${CONTRACTS_API_PREFIX}/tasks?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(
      await parseTaskInboxErrorMessage(response, "Não foi possível carregar suas tarefas"),
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = taskInboxListResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error("Resposta inválida recebida ao consultar a caixa de tarefas.");
  }

  return parsed.data;
}

/**
 * Fetches one page of authorized workflow tasks filtered, sorted, and counted in PostgreSQL.
 */
export async function fetchTaskInboxPage(
  filters: TaskInboxFiltersState,
  signal?: AbortSignal,
): Promise<TaskInboxListResponse["data"]> {
  const params = buildTaskInboxSearchParams(filters);
  const envelope = await fetchTasksEndpoint(params, signal);
  return envelope.data;
}

/**
 * Fetches authorization-filtered pending and overdue pending counts directly from PostgreSQL.
 */
export async function fetchTaskInboxCounts(signal?: AbortSignal): Promise<TaskInboxCounts> {
  const pendingParams = new URLSearchParams({
    status: "PENDING",
    page: "1",
    pageSize: "1",
  });
  const overdueParams = new URLSearchParams({
    status: "PENDING",
    overdueOnly: "true",
    page: "1",
    pageSize: "1",
  });

  const [pendingResponse, overdueResponse] = await Promise.all([
    fetchTasksEndpoint(pendingParams, signal),
    fetchTasksEndpoint(overdueParams, signal),
  ]);

  return {
    pendingCount: pendingResponse.data.pagination.totalItems,
    overduePendingCount: overdueResponse.data.pagination.totalItems,
  };
}

/**
 * Resolves the document navigation URL scoped strictly to the task and its bound version,
 * returning null when the document is marked as deleted.
 */
export function resolveTaskDocumentTarget(task: TaskInboxItem): string | null {
  if (task.documentStatus === "DELETED") {
    return null;
  }

  const params = new URLSearchParams({
    versionId: task.documentVersionId,
    taskId: task.id,
  });
  return `/documentos/${encodeURIComponent(task.documentId)}?${params.toString()}`;
}

export function useTaskInboxQuery(filters: TaskInboxFiltersState) {
  return useQuery<TaskInboxListResponse["data"], Error>({
    queryKey: taskInboxListQueryKey(filters),
    queryFn: ({ signal }) => fetchTaskInboxPage(filters, signal),
    placeholderData: keepPreviousData,
  });
}

export function useTaskInboxCountsQuery() {
  return useQuery<TaskInboxCounts, Error>({
    queryKey: TASK_INBOX_COUNTS_QUERY_KEY,
    queryFn: ({ signal }) => fetchTaskInboxCounts(signal),
    retry: false,
  });
}
