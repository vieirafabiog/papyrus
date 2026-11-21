import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationSettingsPage } from "../src/features/admin/OrganizationSettingsPage.js";

function renderOrganizationPage() {
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
          <OrganizationSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("OrganizationSettingsPage (Step 14.01)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads organization preferences and submits valid updates in pt-BR", async () => {
    let sentPatch: Record<string, unknown> | null = null;
    const initialOrg = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "DocuFlow Brasil",
      slug: "docuflow-brasil",
      defaultLanguage: "pt-BR",
      timezone: "America/Sao_Paulo",
      logoObjectKey: null,
      preferences: {
        defaultExpirationWindowDays: 30,
        trashGraceDays: 30,
        dateFormat: "DD/MM/YYYY",
        defaultListPageSize: 20,
        auditDocumentViews: true,
        auditDocumentDownloads: true,
      },
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "org-csrf" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/organization") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ data: { organization: initialOrg, canEdit: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/organization") && init?.method === "PATCH") {
        sentPatch = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            data: {
              organization: {
                ...initialOrg,
                name: String(sentPatch.name ?? initialOrg.name),
              },
              canEdit: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    renderOrganizationPage();

    await waitFor(() => {
      expect(screen.getByDisplayValue("DocuFlow Brasil")).toBeInTheDocument();
    });

    const nameField = screen.getByLabelText(/Nome da organização/i);
    fireEvent.change(nameField, { target: { value: "DocuFlow Corporativo" } });

    const saveBtn = screen.getByRole("button", { name: "Salvar configurações" });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(
        screen.getByText("Dados e preferências da organização salvos com sucesso."),
      ).toBeInTheDocument();
    });

    expect(sentPatch).toMatchObject({
      name: "DocuFlow Corporativo",
      defaultLanguage: "pt-BR",
      timezone: "America/Sao_Paulo",
    });
  });

  it("displays read-only banner and disables saving when canEdit is false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            organization: {
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "Org Leitura",
              slug: "org-leitura",
              defaultLanguage: "pt-BR",
              timezone: "America/Sao_Paulo",
              logoObjectKey: null,
              preferences: {
                defaultExpirationWindowDays: 30,
                trashGraceDays: 30,
                dateFormat: "DD/MM/YYYY",
                defaultListPageSize: 20,
                auditDocumentViews: true,
                auditDocumentDownloads: true,
              },
              createdAt: "2026-01-01T10:00:00.000Z",
              updatedAt: "2026-01-01T10:00:00.000Z",
            },
            canEdit: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderOrganizationPage();

    await waitFor(() => {
      expect(
        screen.getByText(
          "Seu perfil possui acesso somente de leitura às configurações da organização.",
        ),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Salvar configurações" })).toBeDisabled();
  });
});
