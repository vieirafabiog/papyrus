import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "../src/components/GlobalSearch.js";

const DOC_1_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440004";

function renderGlobalSearch(props?: {
  readonly debounceMs?: number;
  readonly fetchFn?: typeof fetch;
}) {
  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <MemoryRouter initialEntries={["/"]}>
        <GlobalSearch debounceMs={props?.debounceMs ?? 20} fetchFn={props?.fetchFn} />
        <Routes>
          <Route path="/" element={<div>Início</div>} />
          <Route path="/documentos/:id" element={<h1>Detalhe do Documento Destino</h1>} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("GlobalSearch", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("debounces input, cancels previous in-flight requests, and navigates to authorized results", async () => {
    const capturedSignals: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.signal) {
        capturedSignals.push(init.signal);
      }
      if (url.includes("search=Co")) {
        // First request stays pending until aborted
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              {
                id: DOC_1_ID,
                title: "Contrato Fornecedor Alpha",
                categoryId: CAT_ID,
                folderId: null,
                status: "APPROVED",
                currentVersionId: null,
                ownerUserId: OWNER_ID,
                issueDate: "2026-01-10",
                expirationDate: "2026-12-31",
                version: 1,
                createdAt: "2026-01-10T12:00:00Z",
                updatedAt: "2026-01-11T15:30:00Z",
              },
            ],
            pagination: {
              page: 1,
              pageSize: 8,
              totalItems: 1,
              totalPages: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    renderGlobalSearch({ debounceMs: 30, fetchFn: fetchMock });

    const input = screen.getByRole("textbox", { name: "Busca global de documentos" });
    fireEvent.change(input, { target: { value: "Co" } });

    // Trigger first debounced fetch
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Type refined query -> first in-flight request must be aborted
    fireEvent.change(input, { target: { value: "Alpha" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(capturedSignals[0]?.aborted).toBe(true);

    const option = await screen.findByText("Contrato Fornecedor Alpha");
    expect(option).toBeInTheDocument();
    expect(screen.getByText("Aprovado")).toBeInTheDocument();

    fireEvent.click(option);
    expect(
      await screen.findByRole("heading", { name: "Detalhe do Documento Destino" }),
    ).toBeInTheDocument();
  });

  it("shows empty state when no authorized documents match and dismisses with Escape", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          items: [],
          pagination: { page: 1, pageSize: 8, totalItems: 0, totalPages: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    renderGlobalSearch({ debounceMs: 10, fetchFn: fetchMock });

    const input = screen.getByRole("textbox", { name: "Busca global de documentos" });
    fireEvent.change(input, { target: { value: "Inexistente" } });

    expect(await screen.findByText("Nenhum documento encontrado")).toBeInTheDocument();
    expect(
      screen.getByText('Nenhum resultado autorizado corresponde a "Inexistente".'),
    ).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    await waitFor(() => {
      expect(screen.queryByText("Nenhum documento encontrado")).not.toBeInTheDocument();
    });
  });

  it("displays safe error state when search request fails", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(null, { status: 500 });
    });

    renderGlobalSearch({ debounceMs: 10, fetchFn: fetchMock });

    const input = screen.getByRole("textbox", { name: "Busca global de documentos" });
    fireEvent.change(input, { target: { value: "Contrato" } });

    expect(await screen.findByText("Não foi possível concluir a busca (500).")).toBeInTheDocument();
  });
});
