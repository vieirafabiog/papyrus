import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskReviewPage } from "../src/features/tasks/TaskReviewPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const VER_1_ID = "550e8400-e29b-41d4-a716-446655440011";
const VER_2_ID = "550e8400-e29b-41d4-a716-446655440012";
const VER_3_ID = "550e8400-e29b-41d4-a716-446655440013";
const FILE_2_ID = "550e8400-e29b-41d4-a716-446655440022";
const FILE_3_ID = "550e8400-e29b-41d4-a716-446655440023";
const WF_ID = "550e8400-e29b-41d4-a716-446655440031";
const WF_VER_ID = "550e8400-e29b-41d4-a716-446655440032";
const TASK_ID = "550e8400-e29b-41d4-a716-446655440041";
const DECISION_ID = "550e8400-e29b-41d4-a716-446655440051";
const USER_ID = "550e8400-e29b-41d4-a716-446655440061";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440071";
const FIELD_ID = "550e8400-e29b-41d4-a716-446655440072";
const FOLDER_ID = "550e8400-e29b-41d4-a716-446655440081";
const TAG_ID = "550e8400-e29b-41d4-a716-446655440091";

function renderTaskReviewPage(taskId = TASK_ID) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
          <Routes>
            <Route path="/tasks" element={<h1>Lista de Tarefas</h1>} />
            <Route path="/tasks/:id" element={<TaskReviewPage />} />
            <Route path="/documents/:id" element={<h1>Detalhe do Documento</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function buildTaskPayload(overrides?: Partial<{ status: string; decidedAt: string | null }>) {
  return {
    id: TASK_ID,
    workflowInstanceId: WF_ID,
    documentId: DOC_ID,
    documentVersionId: VER_2_ID,
    stepOrder: 1,
    stepName: "Revisão Jurídica",
    status: overrides?.status ?? "PENDING",
    assignee: { type: "USER", userId: USER_ID },
    dueAt: "2026-11-25T18:00:00Z",
    createdAt: "2026-11-18T10:00:00Z",
    decidedAt: overrides?.decidedAt ?? null,
    documentTitle: "Contrato Fornecedor ACME",
    documentStatus: overrides?.status === "APPROVED" ? "APPROVED" : "IN_REVIEW",
    documentVersionNumber: 2,
    workflowDefinitionName: "Aprovação de Contratos",
    isOverdue: false,
    commentRules: {
      requireOnApprove: false,
      requireOnReject: true,
      requireOnRequestChanges: true,
    },
  };
}

function buildDocumentDetailPayload() {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato Fornecedor ACME",
    categoryId: CAT_ID,
    folderId: FOLDER_ID,
    status: "IN_REVIEW",
    currentVersionId: VER_3_ID,
    ownerUserId: USER_ID,
    issueDate: "2026-11-01",
    expirationDate: "2027-11-01",
    metadata: { fornecedor: "ACME Ltda" },
    version: 3,
    createdAt: "2026-11-01T09:00:00Z",
    updatedAt: "2026-11-20T11:00:00Z",
    category: {
      id: CAT_ID,
      name: "Contratos",
      color: "#0F5C73",
      icon: null,
      fields: [
        {
          id: FIELD_ID,
          key: "fornecedor",
          label: "Fornecedor",
          type: "TEXT",
          required: true,
          sortOrder: 1,
        },
      ],
    },
    folder: {
      id: FOLDER_ID,
      name: "Jurídico",
      materializedPath: `/${FOLDER_ID}`,
    },
    owner: {
      id: USER_ID,
      fullName: "Maria Silva",
      email: "maria@docuflow.local",
    },
    currentVersion: {
      id: VER_3_ID,
      versionNumber: 3,
      fileObjectId: FILE_3_ID,
      uploadedByUserId: USER_ID,
      changeNote: "Versão posterior não vinculada à tarefa",
      createdAt: "2026-11-20T11:00:00Z",
      fileObject: {
        id: FILE_3_ID,
        originalFileName: "contrato_v3.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 204800,
        checksumSha256: "b".repeat(64),
        status: "AVAILABLE",
      },
    },
    tags: [
      {
        id: TAG_ID,
        organizationId: ORG_ID,
        name: "Prioritário",
        normalizedName: "prioritario",
        color: "#0F5C73",
        createdAt: "2026-11-01T09:00:00Z",
      },
    ],
    permissions: {
      canUpdate: false,
      canDelete: false,
      canUpload: false,
      canDownload: true,
    },
  };
}

function buildVersionsPayload() {
  return [
    {
      id: VER_3_ID,
      documentId: DOC_ID,
      versionNumber: 3,
      fileObjectId: FILE_3_ID,
      uploadedByUserId: USER_ID,
      isCurrent: true,
      uploadedByUser: { id: USER_ID, fullName: "Maria Silva", email: "maria@docuflow.local" },
      changeNote: "Versão posterior",
      createdAt: "2026-11-20T11:00:00Z",
      fileObject: {
        id: FILE_3_ID,
        originalFileName: "contrato_v3.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 204800,
        checksumSha256: "b".repeat(64),
        status: "AVAILABLE",
      },
      permissions: { canDownload: true, canRestore: false },
    },
    {
      id: VER_2_ID,
      documentId: DOC_ID,
      versionNumber: 2,
      fileObjectId: FILE_2_ID,
      uploadedByUserId: USER_ID,
      isCurrent: false,
      uploadedByUser: { id: USER_ID, fullName: "Ana Revisora", email: "ana@docuflow.local" },
      changeNote: "Ajustes de cláusula 4",
      createdAt: "2026-11-18T09:30:00Z",
      fileObject: {
        id: FILE_2_ID,
        originalFileName: "contrato_v2_revisao.pdf",
        detectedContentType: "application/pdf",
        sizeBytes: 153600,
        checksumSha256: "a".repeat(64),
        status: "AVAILABLE",
      },
      permissions: { canDownload: true, canRestore: false },
    },
    {
      id: VER_1_ID,
      documentId: DOC_ID,
      versionNumber: 1,
      fileObjectId: FILE_2_ID,
      uploadedByUserId: USER_ID,
      isCurrent: false,
      uploadedByUser: { id: USER_ID, fullName: "Maria Silva", email: "maria@docuflow.local" },
      changeNote: "Versão inicial",
      createdAt: "2026-11-01T09:00:00Z",
      fileObject: null,
      permissions: { canDownload: false, canRestore: false },
    },
  ];
}

describe("TaskReviewPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("displays exact bound version, document metadata, version warning, and task/version history", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/v1/tasks/${TASK_ID}`) {
        return new Response(JSON.stringify({ data: buildTaskPayload() }), { status: 200 });
      }
      if (url === `/api/v1/documents/${DOC_ID}`) {
        return new Response(JSON.stringify({ data: buildDocumentDetailPayload() }), {
          status: 200,
        });
      }
      if (url === `/api/v1/documents/${DOC_ID}/versions`) {
        return new Response(JSON.stringify({ data: buildVersionsPayload() }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    renderTaskReviewPage();

    expect(
      await screen.findByRole("heading", { name: "Aprovação de Contratos — Etapa 1" }),
    ).toBeInTheDocument();

    expect(await screen.findByText("contrato_v2_revisao.pdf")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("Ajustes de cláusula 4")).toBeInTheDocument();
    expect(screen.getByText(/versão vigente mais recente \(v3\)/i)).toBeInTheDocument();

    expect(screen.getByText("ACME Ltda")).toBeInTheDocument();
    expect(screen.getByText("Contratos")).toBeInTheDocument();
    expect(screen.getByText("Jurídico")).toBeInTheDocument();
    expect(screen.getByText("Prioritário")).toBeInTheDocument();

    expect(screen.getByText("Avaliada nesta tarefa")).toBeInTheDocument();
  });

  it("validates required comment before requesting changes or rejecting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/v1/tasks/${TASK_ID}`) {
        return new Response(JSON.stringify({ data: buildTaskPayload() }), { status: 200 });
      }
      if (url === `/api/v1/documents/${DOC_ID}`) {
        return new Response(JSON.stringify({ data: buildDocumentDetailPayload() }), {
          status: 200,
        });
      }
      if (url === `/api/v1/documents/${DOC_ID}/versions`) {
        return new Response(JSON.stringify({ data: buildVersionsPayload() }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    renderTaskReviewPage();

    const rejectButton = await screen.findByRole("button", { name: "Rejeitar" });
    fireEvent.click(rejectButton);

    expect(
      await screen.findByText(
        "Informe um comentário justificando a rejeição ou solicitação de ajustes.",
      ),
    ).toBeInTheDocument();

    const decisionCalls = fetchSpy.mock.calls.filter(([arg]) => {
      const u = typeof arg === "string" ? arg : arg.toString();
      return u.endsWith("/decision");
    });
    expect(decisionCalls).toHaveLength(0);
  });

  it("disables actions during submission and updates task state only after API confirmation", async () => {
    let taskStatusOnServer = "PENDING";
    let taskDecidedAtOnServer: string | null = null;
    let resolveDecisionResponse: ((res: Response) => void) | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === `/api/v1/tasks/${TASK_ID}`) {
        return new Response(
          JSON.stringify({
            data: buildTaskPayload({
              status: taskStatusOnServer,
              decidedAt: taskDecidedAtOnServer,
            }),
          }),
          { status: 200 },
        );
      }
      if (url === `/api/v1/documents/${DOC_ID}`) {
        return new Response(JSON.stringify({ data: buildDocumentDetailPayload() }), {
          status: 200,
        });
      }
      if (url === `/api/v1/documents/${DOC_ID}/versions`) {
        return new Response(JSON.stringify({ data: buildVersionsPayload() }), { status: 200 });
      }
      if (url === "/api/v1/auth/csrf-token") {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-test" } }), { status: 200 });
      }
      if (url === `/api/v1/tasks/${TASK_ID}/decision`) {
        return new Promise<Response>((resolve) => {
          resolveDecisionResponse = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });

    renderTaskReviewPage();

    const approveBtn = await screen.findByRole("button", { name: "Aprovar" });
    const commentBox = screen.getByLabelText("Comentário da revisão");

    fireEvent.change(commentBox, { target: { value: "Cláusulas conferidas e aprovadas." } });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Enviando aprovação..." })).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Solicitar ajustes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rejeitar" })).toBeDisabled();
    expect(commentBox).toBeDisabled();

    // Status must NOT be updated before API confirms!
    expect(screen.getByText("Pendente")).toBeInTheDocument();
    expect(screen.queryByText("Aprovada")).not.toBeInTheDocument();

    taskStatusOnServer = "APPROVED";
    taskDecidedAtOnServer = "2026-11-21T15:00:00Z";

    resolveDecisionResponse?.(
      new Response(
        JSON.stringify({
          data: {
            task: {
              id: TASK_ID,
              workflowInstanceId: WF_ID,
              documentId: DOC_ID,
              documentVersionId: VER_2_ID,
              stepOrder: 1,
              status: "APPROVED",
              assignee: { type: "USER", userId: USER_ID },
              dueAt: "2026-11-25T18:00:00Z",
              createdAt: "2026-11-18T10:00:00Z",
              decidedAt: "2026-11-21T15:00:00Z",
            },
            decision: {
              id: DECISION_ID,
              taskId: TASK_ID,
              actorUserId: USER_ID,
              decision: "APPROVE",
              comment: "Cláusulas conferidas e aprovadas.",
              createdAt: "2026-11-21T15:00:00Z",
            },
            instance: {
              id: WF_ID,
              documentId: DOC_ID,
              documentVersionId: VER_2_ID,
              workflowDefinitionVersionId: WF_VER_ID,
              status: "COMPLETED",
              currentStepOrder: 1,
              startedByUserId: USER_ID,
              startedAt: "2026-11-18T10:00:00Z",
              completedAt: "2026-11-21T15:00:00Z",
            },
            documentStatus: "APPROVED",
            idempotentReplay: false,
          },
        }),
        { status: 200 },
      ),
    );

    expect(await screen.findByText(/Aprovação registrada/i)).toBeInTheDocument();
    expect(screen.getAllByText("Aprovada").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Cláusulas conferidas e aprovadas\./i)).toBeInTheDocument();
  });

  it("displays conflict error without altering pending state when decision API returns 409", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/v1/tasks/${TASK_ID}`) {
        return new Response(JSON.stringify({ data: buildTaskPayload() }), { status: 200 });
      }
      if (url === `/api/v1/documents/${DOC_ID}`) {
        return new Response(JSON.stringify({ data: buildDocumentDetailPayload() }), {
          status: 200,
        });
      }
      if (url === `/api/v1/documents/${DOC_ID}/versions`) {
        return new Response(JSON.stringify({ data: buildVersionsPayload() }), { status: 200 });
      }
      if (url === "/api/v1/auth/csrf-token") {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-test" } }), { status: 200 });
      }
      if (url === `/api/v1/tasks/${TASK_ID}/decision`) {
        return new Response(
          JSON.stringify({
            error: {
              code: "CONFLICT",
              message: "Esta tarefa já recebeu uma decisão concorrente.",
              requestId: ORG_ID,
            },
          }),
          { status: 409 },
        );
      }
      return new Response(null, { status: 404 });
    });

    renderTaskReviewPage();

    const approveBtn = await screen.findByRole("button", { name: "Aprovar" });
    fireEvent.click(approveBtn);

    expect(
      await screen.findByText("Esta tarefa já recebeu uma decisão concorrente."),
    ).toBeInTheDocument();
    expect(screen.getByText("Pendente")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprovar" })).toBeEnabled();
  });
});
