import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { UiLocaleProvider, createPapyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpirationsPage } from "../src/features/expirations/ExpirationsPage.js";
import { I18nProvider, type UiLocale } from "../src/i18n/index.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const CAT_1_ID = "550e8400-e29b-41d4-a716-446655440011";
const OWNER_1_ID = "550e8400-e29b-41d4-a716-446655440021";
const DOC_1_ID = "550e8400-e29b-41d4-a716-446655440031";
const DOC_2_ID = "550e8400-e29b-41d4-a716-446655440032";

function renderExpirationsPage(locale: UiLocale = "en-US") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <I18nProvider initialLocale={locale}>
      <UiLocaleProvider locale={locale}>
        <ThemeProvider theme={createPapyrusTheme(locale)}>
          <CssBaseline />
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={["/expirations"]}>
              <Routes>
                <Route path="/expirations" element={<ExpirationsPage />} />
                <Route path="/documents/:id" element={<h1>Document Details</h1>} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("ExpirationsPage (Step 13.04)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("displays timezone context, bucket tabs, filters by expired/soon/no-date, and navigates to document", async () => {
    const requestedUrls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({
            data: {
              user: {
                id: OWNER_1_ID,
                organizationId: ORG_ID,
                email: "gestor@papyrus.local",
                fullName: "Gestor Operacional",
                status: "ACTIVE",
                createdAt: "2026-01-01T10:00:00Z",
                updatedAt: "2026-01-01T10:00:00Z",
              },
              groups: [],
              roles: [],
              permissions: [],
              sessionExpiresAt: "2026-12-31T10:00:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/api/v1/categories")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: CAT_1_ID,
                  organizationId: ORG_ID,
                  name: "Contratos",
                  description: null,
                  color: "#00639B",
                  icon: null,
                  isActive: true,
                  createdAt: "2026-01-01T10:00:00Z",
                  updatedAt: "2026-01-01T10:00:00Z",
                },
              ],
              pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/api/v1/admin/users")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }

      return new Response(
        JSON.stringify({
          data: {
            items: [
              {
                id: DOC_1_ID,
                title: "Alvará Municipal",
                categoryId: CAT_1_ID,
                categoryName: "Contratos",
                folderId: null,
                status: "APPROVED",
                currentVersionId: null,
                ownerUserId: OWNER_1_ID,
                ownerName: "Gestor Operacional",
                issueDate: "2025-11-01",
                expirationDate: "2026-11-15",
                version: 1,
                createdAt: "2026-01-01T10:00:00Z",
                updatedAt: "2026-01-01T10:00:00Z",
                expirationState: "EXPIRED",
                daysUntilExpiration: -6,
              },
              {
                id: DOC_2_ID,
                title: "Política Interna",
                categoryId: CAT_1_ID,
                categoryName: "Contratos",
                folderId: null,
                status: "APPROVED",
                currentVersionId: null,
                ownerUserId: OWNER_1_ID,
                ownerName: "Gestor Operacional",
                issueDate: null,
                expirationDate: null,
                version: 1,
                createdAt: "2026-01-01T10:00:00Z",
                updatedAt: "2026-01-01T10:00:00Z",
                expirationState: "NO_DATE",
                daysUntilExpiration: null,
              },
            ],
            pagination: { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 },
            summary: {
              expiredCount: 1,
              expiringSoonCount: 3,
              upToDateCount: 4,
              noExpirationCount: 1,
            },
            timezone: "America/Sao_Paulo",
            referenceDate: "2026-11-21",
            windowDays: 30,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    renderExpirationsPage();

    expect(await screen.findByText("Alvará Municipal")).toBeInTheDocument();
    expect(screen.getByText(/America\/Sao_Paulo/i)).toBeInTheDocument();
    expect(screen.getByText("Expired 6 days ago")).toBeInTheDocument();
    expect(screen.getByText("No date set")).toBeInTheDocument();

    // Switch bucket tab to EXPIRED
    fireEvent.click(screen.getByRole("tab", { name: /Expired \(1\)/i }));
    await waitFor(() => {
      expect(
        requestedUrls.some(
          (url) => url.includes("/api/v1/documents/expirations") && url.includes("bucket=EXPIRED"),
        ),
      ).toBe(true);
    });

    // Switch bucket tab to NO_DATE
    fireEvent.click(screen.getByRole("tab", { name: /No date \(1\)/i }));
    await waitFor(() => {
      expect(
        requestedUrls.some(
          (url) => url.includes("/api/v1/documents/expirations") && url.includes("bucket=NO_DATE"),
        ),
      ).toBe(true);
    });

    // Change alert window to 60 days
    fireEvent.mouseDown(screen.getByLabelText("Alert window"));
    const windowListbox = await screen.findByRole("listbox");
    fireEvent.click(within(windowListbox).getByText("Next 60 days"));
    await waitFor(() => {
      expect(
        requestedUrls.some(
          (url) => url.includes("/api/v1/documents/expirations") && url.includes("windowDays=60"),
        ),
      ).toBe(true);
    });

    // Navigate to document detail
    const openButtons = screen.getAllByRole("button", { name: "Open" });
    const firstOpenButton = openButtons[0];
    expect(firstOpenButton).toBeDefined();
    if (firstOpenButton) {
      fireEvent.click(firstOpenButton);
    }
    expect(await screen.findByRole("heading", { name: "Document Details" })).toBeInTheDocument();
  });
});
