import "@testing-library/jest-dom/vitest";
import { SAFE_UPLOAD_FORMAT_CATALOG } from "@docuflow/contracts";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadLimitsSettingsSection } from "../src/features/admin/UploadLimitsSettingsSection.js";

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <UploadLimitsSettingsSection />
      </QueryClientProvider>
    </ThemeProvider>,
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

    expect(await screen.findByText("Limites e formatos de upload")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Tamanho máximo por arquivo (MB)"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByText("Imagem PNG (.png)"));
    fireEvent.click(screen.getByText("Microsoft Word (.docx)"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar limites de upload" }));

    await waitFor(() => {
      expect(capturedPatch).toEqual({
        maxFileSizeBytes: 10 * 1024 * 1024,
        allowedExtensions: [".pdf", ".docx"],
        enforceDeclaredExtensionMatch: true,
      });
    });

    expect(
      await screen.findByText(
        "Limites de tamanho e extensões permitidas atualizados para API, proxy e worker.",
      ),
    ).toBeInTheDocument();
  });
});
