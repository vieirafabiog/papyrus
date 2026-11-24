import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportsPage } from "../src/features/reports/ReportsPage.js";

const CAT_ID = "550e8400-e29b-41d4-a716-446655440031";
const CONN_ID = "550e8400-e29b-41d4-a716-446655440041";

function renderReportsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ReportsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("ReportsPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders server-aggregated totals by category, status, expirations, and storage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/categories")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [],
              pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/reports/overview")) {
        return new Response(
          JSON.stringify({
            data: {
              generatedAt: "2026-11-24T12:00:00.000Z",
              timezone: "America/Sao_Paulo",
              totals: {
                totalDocuments: 5,
                totalVersions: 8,
                totalActiveFiles: 8,
                storageUsedBytes: 2_097_152,
                quarantinedFiles: 1,
                pendingTasks: 2,
              },
              expirations: {
                expired: 1,
                expiringSoon: 2,
                onTrack: 1,
                withoutDate: 1,
                windowDays: 30,
              },
              byStatus: [
                { status: "APPROVED", documentCount: 3, storageBytes: 1_572_864 },
                { status: "DRAFT", documentCount: 2, storageBytes: 524_288 },
              ],
              byCategory: [
                {
                  categoryId: CAT_ID,
                  categoryName: "CTRB",
                  documentCount: 5,
                  versionCount: 8,
                  storageBytes: 2_097_152,
                  expiredCount: 1,
                  expiringSoonCount: 2,
                },
              ],
              byStorageConnection: [
                {
                  storageConnectionId: CONN_ID,
                  storageConnectionName: "Armazenamento Local Padrão",
                  kind: "local",
                  fileCount: 8,
                  storageBytes: 2_097_152,
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    renderReportsPage();

    expect(await screen.findByText("CTRB")).toBeInTheDocument();
    expect(screen.getByText("Armazenamento Local Padrão")).toBeInTheDocument();
    expect(screen.getByText("Filesystem local")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Exportar CSV" })).toHaveAttribute(
      "href",
      "/api/v1/reports/export.csv?expirationWindowDays=30",
    );
  });
});
