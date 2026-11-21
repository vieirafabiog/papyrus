import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentWorkflowTimeline } from "../src/features/documents/DocumentWorkflowTimeline.js";

const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const VER_ID = "550e8400-e29b-41d4-a716-446655440011";
const WF_DEF_ID = "550e8400-e29b-41d4-a716-446655440021";
const WF_INST_ID = "550e8400-e29b-41d4-a716-446655440031";
const TASK_1_ID = "550e8400-e29b-41d4-a716-446655440041";
const TASK_2_ID = "550e8400-e29b-41d4-a716-446655440042";
const DECISION_1_ID = "550e8400-e29b-41d4-a716-446655440051";
const REQ_ID = "550e8400-e29b-41d4-a716-446655440099";

function renderTimeline(documentId = DOC_ID) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <DocumentWorkflowTimeline documentId={documentId} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("DocumentWorkflowTimeline", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders read-only workflow steps, assignees, decisions, comments, and timestamps", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: WF_INST_ID,
              documentId: DOC_ID,
              documentVersionId: VER_ID,
              documentVersionNumber: 2,
              workflowDefinitionId: WF_DEF_ID,
              workflowDefinitionName: "Aprovação de Contratos",
              workflowDefinitionVersionNumber: 3,
              status: "ACTIVE",
              currentStepOrder: 2,
              startedByDisplayName: "Carlos Solicitante",
              startedAt: "2026-11-18T10:00:00Z",
              completedAt: null,
              steps: [
                {
                  stepOrder: 1,
                  stepName: "Revisão Jurídica",
                  assigneeType: "GROUP",
                  assigneeDisplayName: "Equipe Jurídica",
                  taskId: TASK_1_ID,
                  taskStatus: "APPROVED",
                  createdAt: "2026-11-18T10:00:00Z",
                  dueAt: "2026-11-20T18:00:00Z",
                  decidedAt: "2026-11-18T15:30:00Z",
                  decision: {
                    id: DECISION_1_ID,
                    decision: "APPROVE",
                    actorDisplayName: "Ana Advogada",
                    comment: "Minuta validada sem ressalvas.",
                    createdAt: "2026-11-18T15:30:00Z",
                  },
                },
                {
                  stepOrder: 2,
                  stepName: "Aprovação Diretoria",
                  assigneeType: "ROLE",
                  assigneeDisplayName: "Diretor Financeiro",
                  taskId: TASK_2_ID,
                  taskStatus: "PENDING",
                  createdAt: "2026-11-18T15:30:00Z",
                  dueAt: "2026-11-24T18:00:00Z",
                  decidedAt: null,
                  decision: null,
                },
                {
                  stepOrder: 3,
                  stepName: "Publicação Final",
                  assigneeType: "USER",
                  assigneeDisplayName: "Mariana Gestora",
                  taskId: null,
                  taskStatus: null,
                  createdAt: null,
                  dueAt: null,
                  decidedAt: null,
                  decision: null,
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderTimeline();

    expect(await screen.findByText("Aprovação de Contratos (v3)")).toBeInTheDocument();
    expect(screen.getByText("Somente leitura")).toBeInTheDocument();
    expect(screen.getByText("Versão avaliada v2")).toBeInTheDocument();
    expect(screen.getByText(/Iniciado por Carlos Solicitante/i)).toBeInTheDocument();

    expect(screen.getByText("Etapa 1: Revisão Jurídica")).toBeInTheDocument();
    expect(screen.getByText("Equipe Jurídica")).toBeInTheDocument();
    expect(screen.getByText(/Aprovado por Ana Advogada/i)).toBeInTheDocument();
    expect(screen.getByText(/Minuta validada sem ressalvas\./i)).toBeInTheDocument();

    expect(screen.getByText("Etapa 2: Aprovação Diretoria")).toBeInTheDocument();
    expect(screen.getByText("Diretor Financeiro")).toBeInTheDocument();
    expect(screen.getByText("Pendente")).toBeInTheDocument();

    expect(screen.getByText("Etapa 3: Publicação Final")).toBeInTheDocument();
    expect(screen.getByText("Mariana Gestora")).toBeInTheDocument();
    expect(screen.getByText("Aguardando etapa anterior")).toBeInTheDocument();

    // Strictly read-only: no mutation or approval buttons should exist in the timeline
    expect(screen.queryByRole("button", { name: "Aprovar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rejeitar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Solicitar ajustes" })).not.toBeInTheDocument();
  });

  it("displays explicit access restriction alert when server returns 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "Usuário sem permissão para consultar histórico de fluxo.",
            requestId: REQ_ID,
          },
        }),
        { status: 403 },
      ),
    );

    renderTimeline();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Acesso restrito ao histórico do fluxo: Usuário sem permissão para consultar histórico de fluxo.",
    );
  });

  it("displays empty state when document has no workflows and ErrorState with retry on server error", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    renderTimeline();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível carregar a linha do tempo do processo (500).",
    );

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(
      await screen.findByRole("heading", { name: "Nenhum fluxo de aprovação registrado" }),
    ).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
