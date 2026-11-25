import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { SAFE_UPLOAD_FORMAT_CATALOG } from "@papyrus/contracts";
import { UiLocaleProvider, papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadLimitsSettingsSection } from "../src/features/admin/UploadLimitsSettingsSection.js";
import { I18nProvider } from "../src/i18n/index.js";

function renderSection(locale: "en-US" | "pt-BR" = "en-US") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <I18nProvider initialLocale={locale}>
      <UiLocaleProvider locale={locale}>
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <QueryClientProvider client={queryClient}>
            <UploadLimitsSettingsSection />
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("UploadLimitsSettingsSection (Step 14.06)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads limits, toggles allowed extensions and max size, and submits PATCH to admin/upload-limits", async () => {
    let capturedPatch: Record<string, unknown> | null = null;
    const initialView = {
      configured: {
        maxFileSizeBytes: 50 * 1024 * 1024,
        allowedExtensions: [".pdf", ".png"],
        enforceDeclaredExtensionMatch: true,
      },
      effective: {
        maxFileSizeBytes: 50 * 1024 * 1024,
        allowedExtensions: [".pdf", ".png"],
        allowedMimeTypes: ["application/pdf", "image/png"],
        enforceDeclaredExtensionMatch: true,
        systemMaxUploadBytes: 50 * 1024 * 1024,
        proxyMaxBodyBytes: 60 * 1024 * 1024,
        effectiveMaxWithProxyBytes: 50 * 1024 * 1024,
      },
      supportedCatalog: [...SAFE_UPLOAD_FORMAT_CATALOG],
      canEdit: true,
      updatedAt: "2026-04-01T10:00:00.000Z",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-limits-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/uploads/limits") && method === "GET") {
        return new Response(JSON.stringify({ data: initialView }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/upload-limits") && method === "PATCH") {
        capturedPatch = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            data: {
              ...initialView,
              configured: {
                ...initialView.configured,
                maxFileSizeBytes: Number(
                  capturedPatch.maxFileSizeBytes ?? initialView.configured.maxFileSizeBytes,
                ),
                allowedExtensions:
                  (capturedPatch.allowedExtensions as string[]) ??
                  initialView.configured.allowedExtensions,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 });
    });

    renderSection();

    expect(await screen.findByText("File upload limits")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Maximum file size (MB)"), {
      target: { value: "10" },
    });
    expect(screen.getByText("PDF document (.pdf)")).toBeInTheDocument();
    expect(screen.getByText("Legacy Word (.doc)")).toBeInTheDocument();
    fireEvent.click(screen.getByText("PNG image (.png)"));
    fireEvent.click(screen.getByText("Microsoft Word (.docx)"));
    fireEvent.click(screen.getByRole("button", { name: "Save upload limits" }));

    await waitFor(() => {
      expect(capturedPatch).toEqual({
        maxFileSizeBytes: 10 * 1024 * 1024,
        allowedExtensions: [".pdf", ".docx"],
        enforceDeclaredExtensionMatch: true,
      });
    });

    expect(await screen.findByText("File upload limits updated.")).toBeInTheDocument();
  });

  it("renders Portuguese format chip labels when locale is pt-BR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            configured: {
              maxFileSizeBytes: 50 * 1024 * 1024,
              allowedExtensions: [".pdf", ".csv"],
              enforceDeclaredExtensionMatch: true,
            },
            effective: {
              maxFileSizeBytes: 50 * 1024 * 1024,
              allowedExtensions: [".pdf", ".csv"],
              allowedMimeTypes: ["application/pdf", "text/csv"],
              enforceDeclaredExtensionMatch: true,
              systemMaxUploadBytes: 50 * 1024 * 1024,
              proxyMaxBodyBytes: 60 * 1024 * 1024,
              effectiveMaxWithProxyBytes: 50 * 1024 * 1024,
            },
            supportedCatalog: [...SAFE_UPLOAD_FORMAT_CATALOG],
            canEdit: true,
            updatedAt: "2026-04-01T10:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderSection("pt-BR");

    expect(await screen.findByText("Limites de envio de arquivos")).toBeInTheDocument();
    expect(screen.getByText("Documento PDF (.pdf)")).toBeInTheDocument();
    expect(screen.getByText("Planilha CSV (.csv)")).toBeInTheDocument();
    expect(screen.getByText("Word legado (.doc)")).toBeInTheDocument();
  });
});
