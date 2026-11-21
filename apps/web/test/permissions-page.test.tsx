import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionsPage } from "../src/features/admin/PermissionsPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_1_ID = "550e8400-e29b-41d4-a716-446655440011";
const GROUP_1_ID = "550e8400-e29b-41d4-a716-446655440021";
const ROLE_ADMIN_ID = "550e8400-e29b-41d4-a716-446655440031";
const ROLE_VIEWER_ID = "550e8400-e29b-41d4-a716-446655440032";
const FOLDER_1_ID = "550e8400-e29b-41d4-a716-446655440041";
const ASSIGN_1_ID = "550e8400-e29b-41d4-a716-446655440051";
const ASSIGN_2_ID = "550e8400-e29b-41d4-a716-446655440052";

function buildSession(isAdmin: boolean) {
  return {
    data: {
      user: {
        id: USER_1_ID,
        organizationId: ORG_ID,
        email: "admin@docuflow.local",
        fullName: "Admin Governança",
        status: "ACTIVE",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
      groups: [],
      roles: [
        {
          id: ROLE_ADMIN_ID,
          key: isAdmin ? "admin" : "viewer",
          name: isAdmin ? "Administrador" : "Consulta",
          description: null,
          isSystem: true,
        },
      ],
      permissions: [],
      sessionExpiresAt: "2026-12-31T10:00:00.000Z",
    },
  };
}

function renderPermissionsPage() {
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
          <PermissionsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("PermissionsPage (Step 14.03)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("blocks unauthorized users from accessing permission governance UI", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify(buildSession(false)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPermissionsPage();

    await waitFor(() => {
      expect(screen.getByText("Acesso restrito")).toBeInTheDocument();
    });
  });

  it("renders readable role matrix without SQL internals, creates explicit DENY exception, and revokes rules", async () => {
    let assignments = [
      {
        id: ASSIGN_1_ID,
        organizationId: ORG_ID,
        userId: null,
        groupId: GROUP_1_ID,
        roleId: ROLE_VIEWER_ID,
        scopeType: "FOLDER",
        scopeTargetId: FOLDER_1_ID,
        effect: "ALLOW",
        createdBy: USER_1_ID,
        createdAt: "2026-01-05T10:00:00.000Z",
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify(buildSession(true)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-perms" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/permissions/roles")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: ROLE_VIEWER_ID,
                key: "viewer",
                name: "Consulta",
                description: "Leitura somente",
                isSystem: true,
                permissions: [
                  {
                    id: "550e8400-e29b-41d4-a716-446655440091",
                    action: "READ",
                    resource: "DOCUMENT",
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (
        url.endsWith("/api/v1/admin/permissions/scopes") &&
        (!init?.method || init.method === "GET")
      ) {
        return new Response(JSON.stringify({ data: assignments }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/permissions/scopes") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          subjectType: "USER" | "GROUP";
          subjectId: string;
          roleId: string;
          scopeType: string;
          scopeTargetId: string | null;
          effect: string;
        };
        const created = {
          id: ASSIGN_2_ID,
          organizationId: ORG_ID,
          userId: body.subjectType === "USER" ? body.subjectId : null,
          groupId: body.subjectType === "GROUP" ? body.subjectId : null,
          roleId: body.roleId,
          scopeType: body.scopeType,
          scopeTargetId: body.scopeTargetId,
          effect: body.effect,
          createdBy: USER_1_ID,
          createdAt: "2026-01-06T10:00:00.000Z",
        };
        assignments = [...assignments, created];
        return new Response(JSON.stringify({ data: created }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.endsWith(`/api/v1/admin/permissions/scopes/${ASSIGN_1_ID}`) &&
        init?.method === "DELETE"
      ) {
        const removed = assignments[0];
        assignments = assignments.filter((a) => a.id !== ASSIGN_1_ID);
        return new Response(JSON.stringify({ data: removed }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/users")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: USER_1_ID,
                organizationId: ORG_ID,
                email: "admin@docuflow.local",
                fullName: "Admin Governança",
                status: "ACTIVE",
                createdAt: "2026-01-01T10:00:00.000Z",
                updatedAt: "2026-01-01T10:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/admin/groups")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: GROUP_1_ID,
                organizationId: ORG_ID,
                name: "Auditores",
                description: null,
                createdAt: "2026-01-01T10:00:00.000Z",
                updatedAt: "2026-01-01T10:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/categories")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [],
              pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/v1/folders")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: FOLDER_1_ID,
                  organizationId: ORG_ID,
                  name: "Financeiro",
                  parentId: null,
                  materializedPath: "/Financeiro",
                  status: "ACTIVE",
                  createdAt: "2026-01-01T10:00:00.000Z",
                  updatedAt: "2026-01-01T10:00:00.000Z",
                },
              ],
              pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    renderPermissionsPage();

    await waitFor(() => {
      expect(screen.getByText("Grupo: Auditores")).toBeInTheDocument();
    });

    // Role matrix & inheritance summary displayed without exposing raw SQL
    expect(screen.getByText("Financeiro (herda subpastas)")).toBeInTheDocument();
    expect(screen.getByText("Consultar")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/user_role_scopes|SELECT|IN \(/i);

    // Add explicit DENY exception
    fireEvent.click(screen.getByRole("button", { name: "Nova regra ou exceção" }));
    const assignDialog = await screen.findByRole("dialog");

    fireEvent.mouseDown(within(assignDialog).getByLabelText("Selecionar usuário"));
    fireEvent.click(await screen.findByRole("option", { name: /Admin Governança/i }));

    fireEvent.mouseDown(within(assignDialog).getByLabelText("Efeito da regra"));
    fireEvent.click(await screen.findByRole("option", { name: /Negar acesso/i }));

    fireEvent.click(within(assignDialog).getByRole("button", { name: "Salvar regra" }));

    await waitFor(() => {
      expect(screen.getByText("Exceção de bloqueio registrada com sucesso.")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Revoke existing assignment
    fireEvent.click(
      await screen.findByRole("button", { name: "Revogar regra de Grupo: Auditores" }),
    );
    const confirmRevoke = await screen.findByRole("button", { name: "Confirmar revogação" });
    fireEvent.click(confirmRevoke);

    await waitFor(() => {
      expect(screen.getByText("Atribuição de permissão revogada com sucesso.")).toBeInTheDocument();
    });
  });
});
