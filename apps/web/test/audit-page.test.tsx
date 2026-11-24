import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditPage } from "../src/features/audit/AuditPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ADMIN_ID = "550e8400-e29b-41d4-a716-446655440001";
const USER_GESTOR_ID = "550e8400-e29b-41d4-a716-446655440002";
const DOC_1_ID = "550e8400-e29b-41d4-a716-446655440010";
const EVT_1_ID = "550e8400-e29b-41d4-a716-446655440020";
const REQ_1_ID = "550e8400-e29b-41d4-a716-446655440030";

function renderAuditPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/audit"]}>
          <Routes>
            <Route path="/admin/audit" element={<AuditPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function buildSessionPayload(hasAuditPermission: boolean) {
  return {
    data: {
      user: {
        id: USER_ADMIN_ID,
        organizationId: ORG_ID,
        email: hasAuditPermission ? "auditor@docuflow.local" : "consulta@docuflow.local",
        fullName: hasAuditPermission ? "Auditor Autorizado" : "Usuário Sem Auditoria",
        status: "ACTIVE",
        createdAt: "2026-11-20T10:00:00Z",
        updatedAt: "2026-11-20T10:00:00Z",
      },
      groups: [],
      roles: [],
      permissions: hasAuditPermission
        ? [{ id: "550e8400-e29b-41d4-a716-446655440099", action: "VIEW_AUDIT", resource: "AUDIT" }]
        : [{ id: "550e8400-e29b-41d4-a716-446655440098", action: "READ", resource: "DOCUMENT" }],
      sessionExpiresAt: "2026-11-22T10:00:00Z",
    },
  };
}

describe("AuditPage (Step 13.03)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("filters events by user, action, resource, and period, shows detail dialog, and exports for authorized users", async () => {
    const requestedUrls: string[] = [];

    const createObjectUrlSpy = vi.fn(() => "blob:mock-audit-export");
    const revokeObjectUrlSpy = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrlSpy,
      revokeObjectURL: revokeObjectUrlSpy,
    });
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.endsWith("/api/v1/auth/me")) {
        return new Response(JSON.stringify(buildSessionPayload(true)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/v1/admin/audit-events/facets")) {
        return new Response(
          JSON.stringify({
            data: {
              actors: [
                {
                  id: USER_ADMIN_ID,
                  fullName: "Auditor Autorizado",
                  email: "auditor@docuflow.local",
                },
                {
                  id: USER_GESTOR_ID,
                  fullName: "Gestor Documental",
                  email: "gestor@docuflow.local",
                },
              ],
              actions: ["DOCUMENT_CREATED", "DOCUMENT_DOWNLOADED"],
              resourceTypes: ["DOCUMENT", "ROLE_SCOPE"],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/api/v1/admin/audit-events/export")) {
        return new Response("id,action\r\nevt,DOCUMENT_DOWNLOADED\r\n", {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="auditoria-docuflow-2026-11-21.csv"',
          },
        });
      }

      return new Response(
        JSON.stringify({
          data: {
            items: [
              {
                id: EVT_1_ID,
                organizationId: ORG_ID,
                occurredAt: "2026-11-21T14:30:00Z",
                actorUserId: USER_GESTOR_ID,
                actorName: "Gestor Documental",
                actorEmail: "gestor@docuflow.local",
                action: "DOCUMENT_DOWNLOADED",
                resourceType: "DOCUMENT",
                resourceId: DOC_1_ID,
                result: "SUCCESS",
                requestId: REQ_1_ID,
                ipAddress: "127.0.0.1",
                metadata: { delivery: "STREAM" },
              },
            ],
            pagination: {
              page: 1,
              pageSize: 20,
              totalItems: 1,
              totalPages: 1,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    renderAuditPage();

    expect(await screen.findByText("Gestor Documental")).toBeInTheDocument();
    expect(screen.getByText("Download realizado")).toBeInTheDocument();

    // Filter by user
    fireEvent.mouseDown(screen.getByLabelText("Usuário"));
    const userListbox = await screen.findByRole("listbox");
    fireEvent.click(within(userListbox).getByText("Gestor Documental (gestor@docuflow.local)"));

    // Filter by action
    fireEvent.mouseDown(screen.getByLabelText("Ação"));
    const actionListbox = await screen.findByRole("listbox");
    fireEvent.click(within(actionListbox).getByText("Download realizado"));

    // Filter by resource
    fireEvent.mouseDown(screen.getByLabelText("Recurso"));
    const resourceListbox = await screen.findByRole("listbox");
    fireEvent.click(within(resourceListbox).getByText("Documento"));

    // Filter by period
    fireEvent.change(screen.getByLabelText("Data inicial"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Data final"), { target: { value: "2026-11-21" } });

    await waitFor(() => {
      expect(
        requestedUrls.some(
          (url) =>
            url.includes(`actorUserId=${USER_GESTOR_ID}`) &&
            url.includes("action=DOCUMENT_DOWNLOADED") &&
            url.includes("resourceType=DOCUMENT") &&
            url.includes("from=2026-11-01") &&
            url.includes("to=2026-11-21"),
        ),
      ).toBe(true);
    });

    // Open details modal
    fireEvent.click(screen.getByRole("button", { name: "Detalhes" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Detalhes do evento de auditoria")).toBeInTheDocument();
    expect(within(dialog).getByText(REQ_1_ID)).toBeInTheDocument();
    expect(within(dialog).getByText("STREAM")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Trigger authorized CSV export with filters preserved
    fireEvent.click(screen.getByRole("button", { name: "Exportar CSV" }));
    await waitFor(() => {
      expect(
        requestedUrls.some(
          (url) =>
            url.includes("/api/v1/admin/audit-events/export") &&
            url.includes("format=csv") &&
            url.includes(`actorUserId=${USER_GESTOR_ID}`),
        ),
      ).toBe(true);
    });
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Exportação concluída/i)).toBeInTheDocument();
  });

  it("blocks access and hides export controls when the user lacks VIEW_AUDIT permission", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(buildSessionPayload(false)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderAuditPage();

    expect(
      await screen.findByText("Acesso não autorizado à trilha de auditoria"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exportar CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exportar JSON" })).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
