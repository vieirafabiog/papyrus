import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrashDocumentsPage } from "../src/features/documents/TrashDocumentsPage.js";

const CAT_ID = "550e8400-e29b-41d4-a716-446655440011";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440021";
const DOC_RESTORABLE_ID = "550e8400-e29b-41d4-a716-446655440031";
const DOC_EXPIRED_ID = "550e8400-e29b-41d4-a716-446655440032";

function renderTrashPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/trash"]}>
          <Routes>
            <Route path="/trash" element={<TrashDocumentsPage />} />
            <Route path="/documents" element={<h1>Lista de Documentos</h1>} />
            <Route path="/documents/:id" element={<h1>Detalhe do Documento</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("TrashDocumentsPage (Step 13.07)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders trash items with grace status, disables expired restore, and restores within window", async () => {
    let restoredCalledWith: {
      targetStatus: string;
      expectedVersion: number;
      reason?: string;
    } | null = null;
    let listItems = [
      {
        id: DOC_RESTORABLE_ID,
        title: "Manual Operacional",
        categoryId: CAT_ID,
        categoryName: "Procedimentos",
        folderId: null,
        status: "DELETED",
        currentVersionId: "550e8400-e29b-41d4-a716-446655440041",
        ownerUserId: OWNER_ID,
        ownerName: "Gestor",
        issueDate: null,
        expirationDate: null,
        version: 2,
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-02-01T10:00:00.000Z",
        deletedAt: "2026-02-01T10:00:00.000Z",
        trashGraceDays: 30,
        restoreDeadlineAt: "2026-03-03T10:00:00.000Z",
        canRestore: true,
      },
      {
        id: DOC_EXPIRED_ID,
        title: "Relatório Expirado",
        categoryId: CAT_ID,
        categoryName: "Procedimentos",
        folderId: null,
        status: "DELETED",
        currentVersionId: null,
        ownerUserId: OWNER_ID,
        ownerName: "Gestor",
        issueDate: null,
        expirationDate: null,
        version: 3,
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-05T10:00:00.000Z",
        deletedAt: "2026-01-05T10:00:00.000Z",
        trashGraceDays: 7,
        restoreDeadlineAt: "2026-01-12T10:00:00.000Z",
        canRestore: false,
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "test-csrf" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/v1/documents/trash")) {
        return new Response(
          JSON.stringify({
            items: listItems,
            pagination: {
              page: 1,
              pageSize: 20,
              totalItems: listItems.length,
              totalPages: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes(`/api/v1/documents/${DOC_RESTORABLE_ID}/restore`)) {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        restoredCalledWith = JSON.parse(rawBody) as {
          targetStatus: string;
          expectedVersion: number;
          reason?: string;
        };
        listItems = listItems.filter((item) => item.id !== DOC_RESTORABLE_ID);
        return new Response(
          JSON.stringify({
            data: {
              id: DOC_RESTORABLE_ID,
              organizationId: "550e8400-e29b-41d4-a716-446655440000",
              title: "Manual Operacional",
              categoryId: CAT_ID,
              folderId: null,
              status: restoredCalledWith.targetStatus,
              currentVersionId: "550e8400-e29b-41d4-a716-446655440041",
              ownerUserId: OWNER_ID,
              issueDate: null,
              expirationDate: null,
              metadata: {},
              version: 3,
              createdAt: "2026-01-01T10:00:00.000Z",
              updatedAt: "2026-02-10T10:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch URL in TrashDocumentsPage test: ${url}`);
    });

    renderTrashPage();

    await waitFor(() => {
      expect(screen.getByText("Manual Operacional")).toBeInTheDocument();
    });

    expect(screen.getByText("Relatório Expirado")).toBeInTheDocument();
    expect(screen.getByText("Disponível")).toBeInTheDocument();
    expect(screen.getByText("Prazo expirado")).toBeInTheDocument();

    const expiredRestoreBtn = screen.getByRole("button", {
      name: "Restaurar Relatório Expirado",
    });
    expect(expiredRestoreBtn).toBeDisabled();

    const activeRestoreBtn = screen.getByRole("button", {
      name: "Restaurar Manual Operacional",
    });
    expect(activeRestoreBtn).not.toBeDisabled();
    fireEvent.click(activeRestoreBtn);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const reasonInput = screen.getByLabelText("Motivo da restauração (opcional)");
    fireEvent.change(reasonInput, { target: { value: "Recuperação operacional" } });

    const confirmBtn = screen.getByRole("button", { name: "Confirmar restauração" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(
        screen.getByText(
          'Documento "Manual Operacional" restaurado com sucesso como Rascunho, mantendo versões e permissões.',
        ),
      ).toBeInTheDocument();
    });

    expect(restoredCalledWith).toEqual({
      expectedVersion: 2,
      targetStatus: "DRAFT",
      reason: "Recuperação operacional",
    });
  });
});
