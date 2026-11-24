import "@testing-library/jest-dom/vitest";
import { UiLocaleProvider, papyrusTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationSettingsPage } from "../src/features/admin/OrganizationSettingsPage.js";
import { I18nProvider } from "../src/i18n/index.js";

function renderOrganizationPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <I18nProvider initialLocale="en-US">
      <UiLocaleProvider locale="en-US">
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <OrganizationSettingsPage />
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("OrganizationSettingsPage (Step 14.01)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads organization preferences and submits valid updates", async () => {
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

    expect(screen.getByText("Organization settings")).toBeInTheDocument();
    expect(screen.getByText(/Organization code: docuflow-brasil/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Time zone")).toBeInTheDocument();
    expect(screen.getByText("General preferences")).toBeInTheDocument();

    const nameField = screen.getByLabelText(/Organization name/i);
    fireEvent.change(nameField, { target: { value: "DocuFlow Corporativo" } });

    const saveBtn = screen.getByRole("button", { name: "Save settings" });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText("Organization settings saved.")).toBeInTheDocument();
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
        screen.getByText("You have read-only access to organization settings."),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });
});
