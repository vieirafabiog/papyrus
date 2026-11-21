import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemStatusPage } from "../src/features/admin/SystemStatusPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const CONN_LOCAL_ID = "550e8400-e29b-41d4-a716-446655440101";
const CONN_S3_ID = "550e8400-e29b-41d4-a716-446655440102";

function buildSession(roleKey: "admin" | "collaborator") {
  return {
    user: {
      id: "550e8400-e29b-41d4-a716-446655440010",
      organizationId: ORG_ID,
      email: `${roleKey}@docuflow.local`,
      fullName: roleKey === "admin" ? "Administradora" : "Colaborador",
      status: "ACTIVE",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    },
    groups: [],
    roles: [
      {
        id: "550e8400-e29b-41d4-a716-446655440099",
        key: roleKey,
        name: roleKey === "admin" ? "Administrador" : "Colaborador",
        description: null,
        isSystem: true,
      },
    ],
    permissions: [],
    sessionExpiresAt: "2026-12-31T10:00:00.000Z",
  };
}

function renderSystemStatusPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SystemStatusPage />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("SystemStatusPage (Step 14.08)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("restricts operational status view for unauthorized users", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession("collaborator") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403 });
    });

    renderSystemStatusPage();

    expect(await screen.findByText("Acesso restrito")).toBeInTheDocument();
  });

  it("displays database, worker, and storage health with last verification timestamp and refreshes on action", async () => {
    let statusCalls = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession("admin") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/admin/system-status")) {
        statusCalls += 1;
        const isFirstCall = statusCalls === 1;
        return new Response(
          JSON.stringify({
            data: {
              overallStatus: isFirstCall ? "degraded" : "healthy",
              checkedAt: isFirstCall ? "2026-11-21T20:00:00.000Z" : "2026-11-21T20:05:00.000Z",
              components: {
                database: {
                  name: "Banco de dados PostgreSQL",
                  status: "ok",
                  message: "Conexão ativa com o PostgreSQL.",
                  checkedAt: "2026-11-21T20:00:00.000Z",
                },
                worker: {
                  name: "Worker de processamento",
                  status: isFirstCall ? "degraded" : "ok",
                  message: isFirstCall
                    ? "Heartbeat do worker atrasado."
                    : "Worker respondendo normalmente.",
                  checkedAt: isFirstCall ? "2026-11-21T20:00:00.000Z" : "2026-11-21T20:05:00.000Z",
                },
              },
              storageConnections: [
                {
                  id: CONN_LOCAL_ID,
                  name: "Cofre Local",
                  kind: "local",
                  isDefault: true,
                  status: "ACTIVE",
                  lastHealthCheckAt: "2026-11-21T19:50:00.000Z",
                  lastHealthMessage: "Diretório disponível.",
                },
                {
                  id: CONN_S3_ID,
                  name: "Bucket Secundário",
                  kind: "s3",
                  isDefault: false,
                  status: isFirstCall ? "ERROR" : "ACTIVE",
                  lastHealthCheckAt: "2026-11-21T19:45:00.000Z",
                  lastHealthMessage: isFirstCall
                    ? "Tempo limite ao verificar bucket."
                    : "Bucket acessível.",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 });
    });

    renderSystemStatusPage();

    expect(await screen.findByText("Status operacional")).toBeInTheDocument();
    expect(screen.getByText("Banco de dados PostgreSQL")).toBeInTheDocument();
    expect(screen.getByText("Worker de processamento")).toBeInTheDocument();
    expect(screen.getByText("Heartbeat do worker atrasado.")).toBeInTheDocument();
    expect(screen.getByText("Cofre Local")).toBeInTheDocument();
    expect(screen.getByText("Bucket Secundário")).toBeInTheDocument();
    expect(screen.getByText(/Atenção operacional/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Atualizar verificação" }));

    await waitFor(() => {
      expect(statusCalls).toBe(2);
    });
    expect(await screen.findByText(/Instalação operacional/)).toBeInTheDocument();
    expect(screen.getByText("Worker respondendo normalmente.")).toBeInTheDocument();
    expect(screen.getByText("Bucket acessível.")).toBeInTheDocument();
  });
});
