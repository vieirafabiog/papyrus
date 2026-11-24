import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { UiLocaleProvider, createPapyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportsPage } from "../src/features/reports/ReportsPage.js";
import { I18nProvider, type UiLocale } from "../src/i18n/index.js";

const CAT_ID = "550e8400-e29b-41d4-a716-446655440031";
const CONN_ID = "550e8400-e29b-41d4-a716-446655440041";
const CONN_S3_ID = "550e8400-e29b-41d4-a716-446655440042";

function renderReportsPage(locale: UiLocale = "en-US") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider initialLocale={locale}>
      <UiLocaleProvider locale={locale}>
        <ThemeProvider theme={createPapyrusTheme(locale)}>
          <CssBaseline />
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <ReportsPage />
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
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
                  fileCount: 5,
                  storageBytes: 1_048_576,
                },
                {
                  storageConnectionId: CONN_S3_ID,
                  storageConnectionName: "Bucket Corporativo",
                  kind: "s3",
                  fileCount: 3,
                  storageBytes: 1_048_576,
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
    expect(screen.getByText("Assigned to you")).toBeInTheDocument();
    expect(screen.getByText("Armazenamento Local Padrão")).toBeInTheDocument();
    expect(screen.getByText("Local storage")).toBeInTheDocument();
    expect(screen.getByText("Bucket Corporativo")).toBeInTheDocument();
    expect(screen.getByText("Cloud storage (S3-compatible)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute(
      "href",
      "/api/v1/reports/export.csv?expirationWindowDays=30",
    );
  });

  it("renders pt-BR copy cleanly without technical jargon", async () => {
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
        return new Promise<Response>(() => {
          // Keep loading state visible to verify loading message.
        });
      }
      return new Response(null, { status: 404 });
    });

    renderReportsPage("pt-BR");

    expect(screen.getByRole("heading", { name: "Relatórios" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Totais de documentos por categoria, status, vencimentos e uso de armazenamento.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Carregando relatórios...")).toBeInTheDocument();
  });
});
