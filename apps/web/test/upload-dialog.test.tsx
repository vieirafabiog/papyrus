import "@testing-library/jest-dom/vitest";
import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import { papyrusTheme } from "@docuflow/ui";
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
    <ThemeProvider theme={papyrusTheme}>
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

    expect(screen.getByText("Document details")).toBeInTheDocument();

    const input = screen.getByLabelText("Select files to upload") as HTMLInputElement;
    const emptyFile = new File([], "vazio.pdf", { type: "application/pdf" });
    const hugeFile = new File([new Uint8Array(2048)], "grande.pdf", { type: "application/pdf" });
    const validFile = new File(["%PDF-1.7\n"], "valido.pdf", { type: "application/pdf" });

    fireEvent.change(input, { target: { files: [emptyFile, hugeFile, validFile] } });

    expect(await screen.findByText("Empty files cannot be uploaded.")).toBeInTheDocument();
    expect(screen.getByText(/File exceeds the maximum allowed size/)).toBeInTheDocument();
    expect(screen.getByText("valido.pdf")).toBeInTheDocument();

    // Attempt submit without selecting required category
    fireEvent.click(screen.getByRole("button", { name: "Start upload (1)" }));
    expect(
      await screen.findByText("Select a document category before uploading."),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders default category fallback without technical jargon when no categories are passed", () => {
    renderDialog({ categories: [] });

    expect(
      screen.getByText("No categories available; the default category will be used."),
    ).toBeInTheDocument();
    expect(screen.getByText("Default category")).toBeInTheDocument();
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

    const fileInput = screen.getByLabelText("Select files to upload") as HTMLInputElement;
    const file1 = new File(["%PDF-1.7-one"], "primeiro.pdf", { type: "application/pdf" });
    const file2 = new File(["%PDF-1.7-two"], "segundo.pdf", { type: "application/pdf" });

    fireEvent.change(fileInput, { target: { files: [file1, file2] } });
    fireEvent.click(screen.getByRole("button", { name: "Start upload (2)" }));

    // Partial failure summary: 1 sent to review ("Under review"), 1 failed ("Upload failed")
    expect(
      await screen.findByText(/1 file\(s\) uploaded and 1 item\(s\) did not complete/),
    ).toBeInTheDocument();
    expect(screen.getByText("Under review")).toBeInTheDocument();
    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledTimes(1);

    // Retry ONLY the failed file cleanly
    shouldFailSecondFile = false;
    fireEvent.click(screen.getByRole("button", { name: /Retry segundo\.pdf/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Under review")).toHaveLength(2);
    });
    expect(screen.queryByText("Upload failed")).not.toBeInTheDocument();
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
        return new Response(
          JSON.stringify({
            error: {
              code: "CONFLICT",
              message: "Direct upload fallback",
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

    const fileInput = screen.getByLabelText("Select files to upload") as HTMLInputElement;
    const docFile = new File([new Uint8Array(100)], "cancelavel.pdf", {
      type: "application/pdf",
    });

    fireEvent.change(fileInput, { target: { files: [docFile] } });
    fireEvent.click(screen.getByRole("button", { name: "Start upload (1)" }));

    const progressBar = await screen.findByLabelText("Upload progress for cancelavel.pdf");
    expect(progressBar).toHaveAttribute("aria-valuenow", "45");
    expect(capturedUrl).toBe(`${CONTRACTS_API_PREFIX}/uploads/sessions/${SAMPLE_UUID_1}/content`);

    fireEvent.click(screen.getByRole("button", { name: /Cancel cancelavel\.pdf/i }));
    releaseUpload();

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Upload cancelled by user.")).toBeInTheDocument();
  });

  it("loads custom category fields, validates required fields, and sends metadata on document creation", async () => {
    let capturedCreateDocBody: Record<string, unknown> | null = null;

    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/categories/${SAMPLE_UUID_1}/fields`)) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "550e8400-e29b-41d4-a716-446655440091",
                categoryId: SAMPLE_UUID_1,
                key: "n_do_ctrb",
                label: "Nº do CTRB",
                type: "TEXT",
                required: true,
                options: null,
                sortOrder: 0,
                createdAt: "2026-11-24T10:00:00.000Z",
                updatedAt: "2026-11-24T10:00:00.000Z",
              },
              {
                id: "550e8400-e29b-41d4-a716-446655440092",
                categoryId: SAMPLE_UUID_1,
                key: "valor_do_ctrb",
                label: "Valor do CTRB",
                type: "NUMBER",
                required: true,
                options: null,
                sortOrder: 1,
                createdAt: "2026-11-24T10:00:00.000Z",
                updatedAt: "2026-11-24T10:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-meta" } }), { status: 200 });
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
              declaredSizeBytes: 12,
              declaredContentType: "application/pdf",
              idempotencyKey: "idem-meta",
              status: "PENDING",
              expiresAt: "2026-11-24T14:00:00.000Z",
              finalizedAt: null,
              createdAt: "2026-11-24T12:00:00.000Z",
              updatedAt: "2026-11-24T12:00:00.000Z",
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
                expiresAt: "2026-11-24T12:15:00.000Z",
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
      if (url.endsWith("/documents") && init?.method === "POST") {
        capturedCreateDocBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: { id: SAMPLE_UUID_2 } }), { status: 201 });
      }
      return new Response(null, { status: 404 });
    });

    renderDialog({
      defaultCategoryId: SAMPLE_UUID_1,
      createDocumentOnFinalize: true,
      fetchFn: mockFetch,
      binaryUploader: async () => ({ status: 200, responseText: "" }),
    });

    const numField = await screen.findByLabelText(/Nº do CTRB/);
    const valField = await screen.findByLabelText(/Valor do CTRB/);

    const fileInput = screen.getByLabelText("Select files to upload") as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["%PDF-1.7-ctrb"], "ctrb.pdf", { type: "application/pdf" })] },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start upload (1)" }));
    expect(await screen.findAllByText("This field is required.")).toHaveLength(2);
    expect(capturedCreateDocBody).toBeNull();

    fireEvent.change(numField, { target: { value: "CTRB-2026-01" } });
    fireEvent.change(valField, { target: { value: "1250,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Start upload (1)" }));

    await waitFor(() => {
      expect(capturedCreateDocBody).not.toBeNull();
    });
    expect(capturedCreateDocBody?.metadata).toEqual({
      n_do_ctrb: "CTRB-2026-01",
      valor_do_ctrb: 1250.5,
    });
  });

  it("renders destination folders as a nested tree and displays full path when a subfolder is selected", async () => {
    renderDialog({
      folders: [
        { id: SAMPLE_UUID_3, name: "Teste de Subpasta", parentId: SAMPLE_UUID_2 },
        { id: SAMPLE_UUID_2, name: "Arquivos pessoais", parentId: null },
      ],
    });

    const folderSelect = screen.getByLabelText("Destination folder");
    fireEvent.mouseDown(folderSelect);

    const options = await screen.findAllByRole("option");
    expect(options.map((opt) => opt.textContent)).toEqual([
      "Document library root",
      "Arquivos pessoais",
      "Teste de Subpasta",
    ]);
    expect(options[1]).toHaveAttribute("data-depth", "0");
    expect(options[2]).toHaveAttribute("data-depth", "1");

    const subfolderOption = options[2];
    expect(subfolderOption).toBeDefined();
    if (subfolderOption) {
      fireEvent.click(subfolderOption);
    }
    expect(folderSelect).toHaveTextContent("Arquivos pessoais / Teste de Subpasta");
  });
});
