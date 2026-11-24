import "@testing-library/jest-dom/vitest";
import { UiLocaleProvider, papyrusTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../src/features/dashboard/DashboardPage.js";
import { I18nProvider, resetUiLocaleForTests } from "../src/i18n/index.js";

function renderDashboard() {
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
            <MemoryRouter initialEntries={["/"]}>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/documents" element={<h1>Documents list</h1>} />
                <Route path="/documents/:id" element={<h1>Document details</h1>} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("DashboardPage", () => {
  afterEach(() => {
    cleanup();
    resetUiLocaleForTests();
    vi.restoreAllMocks();
  });

  it("renders informative empty state when summary endpoint is not yet available (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));

    renderDashboard();

    expect(
      await screen.findByRole("heading", { name: "No summary available right now" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Go to documents" }));
    expect(await screen.findByRole("heading", { name: "Documents list" })).toBeInTheDocument();
  });

  it("renders real summary KPIs, storage usage and localized recent activity when API responds 200", async () => {
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            totalDocuments: 42,
            pendingTasks: 3,
            expiringSoonDocuments: 5,
            quarantinedFiles: 1,
            storageUsedBytes: 1_572_864,
            storageFileCount: 12,
            recentActivity: [
              {
                id: validUuid,
                action: "DOCUMENT_CREATED",
                resourceType: "DOCUMENT",
                resourceId: validUuid,
                occurredAt: "2026-11-20T12:00:00Z",
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderDashboard();

    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("1.50 MB")).toBeInTheDocument();
    expect(screen.getByText("12 active files")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Document created — Document"));
    expect(await screen.findByRole("heading", { name: "Document details" })).toBeInTheDocument();
  });

  it("renders ErrorState with working retry when summary request fails", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    renderDashboard();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to load the library summary. Please try again.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByRole("heading", { name: "No summary available right now" }),
    ).toBeInTheDocument();
  });
});
