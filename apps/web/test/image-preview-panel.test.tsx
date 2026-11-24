import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { DocumentDetail } from "@papyrus/contracts";
import { papyrusTheme } from "@papyrus/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPreviewPanel } from "../src/features/documents/DocumentPreviewPanel.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440004";
const VER_ID = "550e8400-e29b-41d4-a716-446655440005";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440006";

function createDocument(options?: {
  readonly contentType?: string;
  readonly fileName?: string;
  readonly sizeBytes?: number;
  readonly fileStatus?: "AVAILABLE" | "QUARANTINED";
  readonly canDownload?: boolean;
}): DocumentDetail {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Documento com Anexo",
    categoryId: CAT_ID,
    folderId: null,
    status: "APPROVED",
    currentVersionId: VER_ID,
    ownerUserId: OWNER_ID,
    issueDate: "2026-01-10",
    expirationDate: "2026-12-31",
    metadata: {},
    version: 1,
    createdAt: "2026-01-10T12:00:00Z",
    updatedAt: "2026-01-11T15:30:00Z",
    category: {
      id: CAT_ID,
      name: "Vistorias",
      color: null,
      icon: null,
      fields: [],
    },
    folder: null,
    owner: {
      id: OWNER_ID,
      fullName: "Ana Souza",
      email: "ana@papyrus.local",
    },
    currentVersion: {
      id: VER_ID,
      versionNumber: 1,
      fileObjectId: FILE_ID,
      uploadedByUserId: OWNER_ID,
      changeNote: null,
      createdAt: "2026-01-10T12:00:00Z",
      fileObject: {
        id: FILE_ID,
        originalFileName: options?.fileName ?? "vistoria.png",
        detectedContentType: options?.contentType ?? "image/png",
        sizeBytes: options?.sizeBytes ?? 4096,
        checksumSha256: "a".repeat(64),
        status: options?.fileStatus ?? "AVAILABLE",
      },
    },
    tags: [],
    permissions: {
      canUpdate: false,
      canDelete: false,
      canUpload: false,
      canDownload: options?.canDownload ?? true,
    },
  };
}

describe("DocumentPreviewPanel — images and fallback formats", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders allowed image formats from /content endpoint with object URL cleanup", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectUrlMock = vi.fn(() => "blob:http://localhost/image-preview-1");
    const revokeObjectUrlMock = vi.fn();

    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectUrlMock,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: revokeObjectUrlMock,
    });

    try {
      const fetchMock = vi.fn<typeof fetch>(async () => {
        return new Response(new Blob(["pngdata"], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      });

      const { unmount } = render(
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <DocumentPreviewPanel
            document={createDocument({ contentType: "image/png", fileName: "foto-vistoria.png" })}
            fetchFn={fetchMock}
          />
        </ThemeProvider>,
      );

      const image = await screen.findByRole("img", {
        name: "Image preview: foto-vistoria.png",
      });
      expect(image).toHaveAttribute("src", "blob:http://localhost/image-preview-1");
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/documents/${DOC_ID}/content`,
        expect.objectContaining({ credentials: "include", method: "GET" }),
      );

      unmount();
      expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:http://localhost/image-preview-1");
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });

  it("enforces maxImageBytes size limit without fetching inline preview and offers download", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const onDownload = vi.fn();

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({
            contentType: "image/jpeg",
            fileName: "mapa-alta-resolucao.jpg",
            sizeBytes: 25 * 1024 * 1024,
          })}
          maxImageBytes={10 * 1024 * 1024}
          fetchFn={fetchMock}
          onDownload={onDownload}
        />
      </ThemeProvider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/exceeds the 10\.0 MB limit for in-page preview/i)).toBeInTheDocument();

    const downloadBtn = screen.getByRole("button", { name: "Download file" });
    fireEvent.click(downloadBtn);
    await waitFor(() => {
      expect(onDownload).toHaveBeenCalledTimes(1);
    });
  });

  it("does not inline-render unsupported or unsafe formats (DOCX, SVG) and offers authorized download", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const onDownload = vi.fn();

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({
            contentType: "image/svg+xml",
            fileName: "diagrama.svg",
            canDownload: true,
          })}
          fetchFn={fetchMock}
          onDownload={onDownload}
        />
      </ThemeProvider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Preview is not available for "image\/svg\+xml"/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download file" }));
    await waitFor(() => {
      expect(onDownload).toHaveBeenCalledTimes(1);
    });
  });

  it("hides download button for unsupported formats when user lacks DOWNLOAD permission", () => {
    const fetchMock = vi.fn<typeof fetch>();

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fileName: "minuta.docx",
            canDownload: false,
          })}
          fetchFn={fetchMock}
        />
      </ThemeProvider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Download file" })).not.toBeInTheDocument();
    expect(
      screen.getByText("You have view-only permission for this document."),
    ).toBeInTheDocument();
  });
});
