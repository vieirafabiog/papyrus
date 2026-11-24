import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowsPage } from "../src/features/workflows/WorkflowsPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440001";
const USER_ID = "550e8400-e29b-41d4-a716-446655440002";
const DEF_ID = "550e8400-e29b-41d4-a716-446655440010";
const VER_ID = "550e8400-e29b-41d4-a716-446655440011";
const ROLE_ID = "550e8400-e29b-41d4-a716-446655440020";

function renderWorkflowsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <WorkflowsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("WorkflowsPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists workflow definitions and creates a new versioned sequential workflow", async () => {
    let createdPayload: Record<string, unknown> | null = null;
    const definitions: Array<Record<string, unknown>> = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({
            data: {
              user: {
                id: USER_ID,
                organizationId: ORG_ID,
                email: "admin@docuflow.local",
                fullName: "Administrador",
                status: "ACTIVE",
                createdAt: "2026-11-24T10:00:00.000Z",
                updatedAt: "2026-11-24T10:00:00.000Z",
              },
              groups: [],
              roles: [
                {
                  id: ROLE_ID,
                  key: "admin",
                  name: "Administrador",
                  description: null,
                  isSystem: true,
                },
              ],
              permissions: [],
              sessionExpiresAt: "2026-11-25T10:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-wf" } }), { status: 200 });
      }
      if (url.endsWith("/workflows/assignees")) {
        return new Response(
          JSON.stringify({
            data: {
              users: [{ id: USER_ID, fullName: "Administrador", email: "admin@docuflow.local" }],
              groups: [],
              roles: [{ id: ROLE_ID, key: "admin", name: "Administrador" }],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/workflows/definitions") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ data: definitions }), { status: 200 });
      }
      if (url.endsWith("/workflows/definitions") && init?.method === "POST") {
        createdPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        const createdDef = {
          id: DEF_ID,
          organizationId: ORG_ID,
          name: createdPayload.name,
          description: createdPayload.description ?? null,
          isActive: true,
          latestVersionNumber: 1,
          createdAt: "2026-11-24T10:00:00.000Z",
          updatedAt: "2026-11-24T10:00:00.000Z",
        };
        definitions.push(createdDef);
        return new Response(
          JSON.stringify({
            data: {
              definition: createdDef,
              version: {
                id: VER_ID,
                workflowDefinitionId: DEF_ID,
                versionNumber: 1,
                steps: [
                  {
                    stepOrder: 1,
                    name: "Revisão Jurídica",
                    assignee: { type: "USER", userId: USER_ID },
                    dueDays: 3,
                  },
                ],
                createdAt: "2026-11-24T10:00:00.000Z",
              },
            },
          }),
          { status: 201 },
        );
      }
      return new Response(null, { status: 404 });
    });

    renderWorkflowsPage();

    expect(await screen.findByText("Nenhum fluxo de aprovação cadastrado")).toBeInTheDocument();

    const newButtons = screen.getAllByRole("button", { name: "Novo fluxo" });
    const primaryNewButton = newButtons[0];
    expect(primaryNewButton).toBeDefined();
    if (primaryNewButton) {
      fireEvent.click(primaryNewButton);
    }

    fireEvent.change(await screen.findByLabelText(/Nome do fluxo/), {
      target: { value: "Aprovação de Contratos" },
    });
    fireEvent.change(screen.getByLabelText(/Nome da etapa 1/), {
      target: { value: "Revisão Jurídica" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Criar definição" }));

    await waitFor(() => {
      expect(createdPayload).not.toBeNull();
    });
    expect(createdPayload?.name).toBe("Aprovação de Contratos");
    expect(await screen.findByText("Aprovação de Contratos")).toBeInTheDocument();
  });
});
