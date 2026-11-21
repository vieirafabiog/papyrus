import "@testing-library/jest-dom/vitest";
import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadDialog, type UploadDialogProps } from "../src/features/documents/UploadDialog.js";
import type {
  BinaryUploadRequest,
  BinaryUploadResponse,
} from "../src/features/documents/useUploadDocuments.js";

const SAMPLE_UUID_1 = "550e8400-e29b-41d4-a716-446655440001";
const SAMPLE_UUID_2 = "550e8400-e29b-41d4-a716-446655440002";
const SAMPLE_UUID_3 = "550e8400-e29b-41d4-a716-446655440003";

function renderDialog(props: Partial<UploadDialogProps> = {}) {
  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <UploadDialog
        open
        onClose={() => {}}
        categories={[{ id: SAMPLE_UUID_1, name: "Contratos" }]}
        folders={[{ id: SAMPLE_UUID_2, name: "Jurídico" }]}
        {...props}
      />
    </ThemeProvider>,
  );
}

describe("UploadDialog and useUploadDocuments", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("validates category metadata and client-side file pre-checks (empty/oversized) before uploading", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    renderDialog({ maxFileBytes: 1024, fetchFn: fetchSpy });

    const input = screen.getByLabelText("Selecionar arquivos para envio") as HTMLInputElement;
    const emptyFile = new File([], "vazio.pdf", { type: "application/pdf" });
    const hugeFile = new File([new Uint8Array(2048)], "grande.pdf", { type: "application/pdf" });
    const validFile = new File(["%PDF-1.7\n"], "valido.pdf", { type: "application/pdf" });

    fireEvent.change(input, { target: { files: [emptyFile, hugeFile, validFile] } });

    expect(
      await screen.findByText("Arquivo vazio não é permitido para envio."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Arquivo excede o limite máximo permitido/)).toBeInTheDocument();
    expect(screen.getByText("valido.pdf")).toBeInTheDocument();

    // Attempt submit without selecting required category
    fireEvent.click(screen.getByRole("button", { name: "Iniciar envio (1)" }));
    expect(
      await screen.findByText("Selecione uma categoria documental antes de enviar."),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uploads multiple files with real-time progress, handles partial batch failures, and retries individual items", async () => {
    let sessionCounter = 0;
    let shouldFailSecondFile = true;

    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-123" } }), { status: 200 });
      }
      if (url.endsWith("/uploads/sessions")) {
        sessionCounter += 1;
        const sessionId = `550e8400-e29b-41d4-a716-44665544001${sessionCounter}`;
        return new Response(
          JSON.stringify({
            data: {
              id: sessionId,
              organizationId: SAMPLE_UUID_1,
              userId: SAMPLE_UUID_2,
              storageConnectionId: SAMPLE_UUID_3,
              fileObjectId: SAMPLE_UUID_3,
              objectKey: `org/1/documents/d/versions/v/${sessionId}`,
              declaredSizeBytes: 12,
              declaredContentType: "application/pdf",
              idempotencyKey: `idem-${sessionCounter}`,
              status: "PENDING",
              expiresAt: "2026-11-21T14:00:00.000Z",
              finalizedAt: null,
              createdAt: "2026-11-21T12:00:00.000Z",
              updatedAt: "2026-11-21T12:00:00.000Z",
            },
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/signed-target")) {
        return new Response(
          JSON.stringify({
            data: {
              sessionId: SAMPLE_UUID_1,
              fileObjectId: SAMPLE_UUID_3,
              storageConnectionId: SAMPLE_UUID_3,
              uploadMode: "SIGNED_UPLOAD",
              finalizationRequired: true,
              status: "PENDING",
              fileObjectStatus: "UPLOADING",
              target: {
                url: "https://minio.local/bucket/obj",
                method: "PUT",
                headers: { "content-type": "application/pdf", "content-length": "12" },
                expiresAt: "2026-11-21T12:15:00.000Z",
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/finalize")) {
        return new Response(
          JSON.stringify({
            data: {
              id: SAMPLE_UUID_1,
              status: "FINALIZED",
              fileObjectStatus: "QUARANTINED",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    const mockBinaryUploader = async (req: BinaryUploadRequest): Promise<BinaryUploadResponse> => {
      req.onProgress(6, 12);
      await new Promise((r) => setTimeout(r, 10));
      if (req.body.name === "segundo.pdf" && shouldFailSecondFile) {
        return { status: 502, responseText: "Bad Gateway" };
      }
      req.onProgress(12, 12);
      return { status: 200, responseText: "" };
    };

    const onFinished = vi.fn();
    renderDialog({
      defaultCategoryId: SAMPLE_UUID_1,
      fetchFn: mockFetch,
      binaryUploader: mockBinaryUploader,
      onUploadBatchFinished: onFinished,
    });

    const fileInput = screen.getByLabelText("Selecionar arquivos para envio") as HTMLInputElement;
    const file1 = new File(["%PDF-1.7-one"], "primeiro.pdf", { type: "application/pdf" });
    const file2 = new File(["%PDF-1.7-two"], "segundo.pdf", { type: "application/pdf" });

    fireEvent.change(fileInput, { target: { files: [file1, file2] } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar envio (2)" }));

    // Partial failure summary: 1 sent to quarantine ("Em análise"), 1 failed ("Falha no envio")
    expect(
      await screen.findByText(/1 arquivo\(s\) enviado\(s\) e 1 item\(ns\) não concluído\(s\)/),
    ).toBeInTheDocument();
    expect(screen.getByText("Em análise")).toBeInTheDocument();
    expect(screen.getByText("Falha no envio")).toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledTimes(1);

    // Retry ONLY the failed file cleanly
    shouldFailSecondFile = false;
    fireEvent.click(screen.getByRole("button", { name: /Tentar novamente segundo\.pdf/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Em análise")).toHaveLength(2);
    });
    expect(screen.queryByText("Falha no envio")).not.toBeInTheDocument();
  });

  it("supports mid-flight progress reporting and individual upload cancellation", async () => {
    let releaseUpload!: () => void;
    const uploadDeferred = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });

    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-abc" } }), { status: 200 });
      }
      if (url.endsWith("/uploads/sessions")) {
        return new Response(
          JSON.stringify({
            data: {
              id: SAMPLE_UUID_1,
              organizationId: SAMPLE_UUID_1,
              userId: SAMPLE_UUID_2,
              storageConnectionId: SAMPLE_UUID_3,
              fileObjectId: SAMPLE_UUID_3,
              objectKey: "org/1/documents/d/versions/v/obj",
              declaredSizeBytes: 100,
              declaredContentType: "application/pdf",
              idempotencyKey: "idem-cancel",
              status: "PENDING",
              expiresAt: "2026-11-21T14:00:00.000Z",
              finalizedAt: null,
              createdAt: "2026-11-21T12:00:00.000Z",
              updatedAt: "2026-11-21T12:00:00.000Z",
            },
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/signed-target")) {
        // Return 409 to also test local API streaming fallback!
        return new Response(
          JSON.stringify({
            error: {
              code: "CONFLICT",
              message: "Streaming local exigido",
              requestId: SAMPLE_UUID_1,
            },
          }),
          { status: 409 },
        );
      }
      return new Response(null, { status: 404 });
    });

    let capturedUrl = "";
    const binaryUploader = async (req: BinaryUploadRequest): Promise<BinaryUploadResponse> => {
      capturedUrl = req.url;
      req.onProgress(45, 100);
      await uploadDeferred;
      if (req.signal.aborted) {
        return { status: 0, responseText: "" };
      }
      return { status: 200, responseText: "{}" };
    };

    renderDialog({
      defaultCategoryId: SAMPLE_UUID_1,
      fetchFn: mockFetch,
      binaryUploader,
    });

    const fileInput = screen.getByLabelText("Selecionar arquivos para envio") as HTMLInputElement;
    const docFile = new File([new Uint8Array(100)], "cancelavel.pdf", {
      type: "application/pdf",
    });

    fireEvent.change(fileInput, { target: { files: [docFile] } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar envio (1)" }));

    // Verify 45% progress bar & API local content fallback route
    const progressBar = await screen.findByLabelText("Progresso de envio de cancelavel.pdf");
    expect(progressBar).toHaveAttribute("aria-valuenow", "45");
    expect(capturedUrl).toBe(`${CONTRACTS_API_PREFIX}/uploads/sessions/${SAMPLE_UUID_1}/content`);

    // Cancel active upload
    fireEvent.click(screen.getByRole("button", { name: /Cancelar cancelavel\.pdf/i }));
    releaseUpload();

    expect(await screen.findByText("Cancelado")).toBeInTheDocument();
    expect(screen.getByText("Envio cancelado pelo usuário.")).toBeInTheDocument();
  });
});
