import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskInboxPage } from "../src/features/tasks/TaskInboxPage.js";

const DOC_1_ID = "550e8400-e29b-41d4-a716-446655440001";
const DOC_2_ID = "550e8400-e29b-41d4-a716-446655440002";
const VER_1_ID = "550e8400-e29b-41d4-a716-446655440011";
const VER_2_ID = "550e8400-e29b-41d4-a716-446655440012";
const WF_1_ID = "550e8400-e29b-41d4-a716-446655440021";
const TASK_1_ID = "550e8400-e29b-41d4-a716-446655440031";
const TASK_2_ID = "550e8400-e29b-41d4-a716-446655440032";
const USER_1_ID = "550e8400-e29b-41d4-a716-446655440041";
const GROUP_1_ID = "550e8400-e29b-41d4-a716-446655440051";

function DocumentRouteProbe() {
  const location = useLocation();
  return (
    <div>
      <h1>Detalhe do Documento</h1>
      <p data-testid="doc-location">{`${location.pathname}${location.search}`}</p>
    </div>
  );
}

function renderTaskInboxPage(initialPath = "/tarefas") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/tarefas" element={<TaskInboxPage />} />
            <Route path="/documentos/:id" element={<DocumentRouteProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const SAMPLE_TASKS = [
  {
    id: TASK_1_ID,
    workflowInstanceId: WF_1_ID,
    documentId: DOC_1_ID,
    documentVersionId: VER_1_ID,
    stepOrder: 1,
    status: "PENDING",
    assignee: { type: "USER", userId: USER_1_ID },
    dueAt: "2026-11-20T12:00:00Z",
    createdAt: "2026-11-18T10:00:00Z",
    decidedAt: null,
    stepName: "Revisão Jurídica",
    documentTitle: "Contrato Fornecedor ACME",
    documentStatus: "IN_REVIEW",
    documentVersionNumber: 2,
    workflowDefinitionName: "Aprovação de Contratos",
    isOverdue: true,
    commentRules: {
      requireOnApprove: false,
      requireOnReject: true,
      requireOnRequestChanges: true,
    },
  },
  {
    id: TASK_2_ID,
    workflowInstanceId: WF_1_ID,
    documentId: DOC_2_ID,
    documentVersionId: VER_2_ID,
    stepOrder: 2,
    status: "APPROVED",
    assignee: { type: "GROUP", groupId: GROUP_1_ID },
    dueAt: null,
    createdAt: "2026-11-19T14:00:00Z",
    decidedAt: "2026-11-20T09:00:00Z",
    stepName: "Validação Financeira",
    documentTitle: "Laudo Arquivado Removido",
    documentStatus: "DELETED",
    documentVersionNumber: 1,
    workflowDefinitionName: "Fluxo Financeiro",
    isOverdue: false,
    commentRules: {
      requireOnApprove: false,
      requireOnReject: true,
      requireOnRequestChanges: true,
    },
  },
] as const;

function mockTaskInboxFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsedUrl = new URL(url, "http://localhost");

    if (parsedUrl.pathname !== "/api/v1/tasks") {
      return new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "Acesso fora do escopo da tarefa.",
            requestId: "test-req",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const status = parsedUrl.searchParams.get("status");
    const assigneeType = parsedUrl.searchParams.get("assigneeType");
    const overdueOnly = parsedUrl.searchParams.get("overdueOnly") === "true";
    const page = Number(parsedUrl.searchParams.get("page") ?? "1");
    const pageSize = Number(parsedUrl.searchParams.get("pageSize") ?? "20");

    const filtered = SAMPLE_TASKS.filter((task) => {
      if (status && task.status !== status) {
        return false;
      }
      if (assigneeType && task.assignee.type !== assigneeType) {
        return false;
      }
      if (overdueOnly && !task.isOverdue) {
        return false;
      }
      return true;
    });

    const start = (page - 1) * pageSize;
    const pagedItems = filtered.slice(start, start + pageSize);

    return new Response(
      JSON.stringify({
        data: {
          items: pagedItems,
          pagination: {
            page,
            pageSize,
            totalItems: filtered.length,
            totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

describe("TaskInboxPage (Minhas tarefas)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders tasks, server counts, and queries only the scoped tasks endpoint", async () => {
    const fetchSpy = mockTaskInboxFetch();

    renderTaskInboxPage();

    expect(await screen.findByText("Contrato Fornecedor ACME")).toBeInTheDocument();
    expect(screen.getByText("Aprovação de Contratos")).toBeInTheDocument();
    expect(screen.getByText("Etapa 1: Revisão Jurídica")).toBeInTheDocument();
    expect(screen.getByText("Versão v2 · Em revisão")).toBeInTheDocument();

    expect(screen.getByText("Pendentes: 1")).toBeInTheDocument();
    expect(screen.getByText("Em atraso: 1")).toBeInTheDocument();
    expect(screen.getByText("Total no filtro atual: 2 tarefas")).toBeInTheDocument();

    for (const [callArg] of fetchSpy.mock.calls) {
      const requestedUrl = typeof callArg === "string" ? callArg : callArg.toString();
      expect(requestedUrl).toMatch(/^\/api\/v1\/tasks\?/);
    }
  });

  it("applies server-side status, assignee type, and overdue filters via API query parameters", async () => {
    const fetchSpy = mockTaskInboxFetch();

    renderTaskInboxPage();

    expect(await screen.findByText("Contrato Fornecedor ACME")).toBeInTheDocument();
    expect(screen.getByText("Laudo Arquivado Removido")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText("Status"));
    const statusListbox = within(screen.getByRole("listbox"));
    fireEvent.click(statusListbox.getByRole("option", { name: "Pendente" }));

    await waitFor(() => {
      expect(screen.queryByText("Laudo Arquivado Removido")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Total no filtro atual: 1 tarefa")).toBeInTheDocument();

    const calledUrlsAfterStatus = fetchSpy.mock.calls.map(([arg]) =>
      typeof arg === "string" ? arg : arg.toString(),
    );
    expect(
      calledUrlsAfterStatus.some((u) => u.includes("status=PENDING") && u.includes("pageSize=20")),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));

    expect(await screen.findByText("Laudo Arquivado Removido")).toBeInTheDocument();
    expect(screen.getByText("Total no filtro atual: 2 tarefas")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText("Atribuição"));
    const assigneeListbox = within(screen.getByRole("listbox"));
    fireEvent.click(assigneeListbox.getByRole("option", { name: "Grupo" }));

    await waitFor(() => {
      expect(screen.queryByText("Contrato Fornecedor ACME")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Laudo Arquivado Removido")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Somente em atraso" }));

    expect(
      await screen.findByRole("heading", { name: "Nenhuma tarefa encontrada" }),
    ).toBeInTheDocument();
  });

  it("opens related document with strict task/version scope and blocks navigation for deleted documents", async () => {
    mockTaskInboxFetch();

    renderTaskInboxPage();

    expect(await screen.findByText("Contrato Fornecedor ACME")).toBeInTheDocument();

    const deletedAction = screen.getByRole("button", { name: "Documento indisponível" });
    expect(deletedAction).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Abrir documento Contrato Fornecedor ACME (versão v2)",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Detalhe do Documento" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("doc-location")).toHaveTextContent(
      `/documentos/${DOC_1_ID}?versionId=${VER_1_ID}&taskId=${TASK_1_ID}`,
    );
  });

  it("displays an actionable ErrorState when the tasks API request fails and supports retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 500 }));

    renderTaskInboxPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível carregar suas tarefas (500).",
    );

    fetchSpy.mockRestore();
    const okSpy = mockTaskInboxFetch();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByText("Contrato Fornecedor ACME")).toBeInTheDocument();
    expect(okSpy).toHaveBeenCalled();
  });
});
