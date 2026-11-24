import "@testing-library/jest-dom/vitest";
import type { DocumentDetail } from "@docuflow/contracts";
import { papyrusTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfPreviewPanel } from "../src/features/documents/PdfPreviewPanel.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440004";
const VER_ID = "550e8400-e29b-41d4-a716-446655440005";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440006";

function createSampleDocument(
  status: "AVAILABLE" | "QUARANTINED" = "AVAILABLE",
  contentType = "application/pdf",
): DocumentDetail {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato Vigente PDF",
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
      name: "Contratos",
      color: null,
      icon: null,
      fields: [],
    },
    folder: null,
    owner: {
      id: OWNER_ID,
      fullName: "Ana Souza",
      email: "ana@docuflow.local",
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
        originalFileName: "contrato-vigente.pdf",
        detectedContentType: contentType,
        sizeBytes: 2048,
        checksumSha256: "a".repeat(64),
        status,
      },
    },
    tags: [],
    permissions: {
      canUpdate: false,
      canDelete: false,
      canUpload: false,
      canDownload: true,
    },
  };
}

describe("PdfPreviewPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("fetches authorized PDF preview into object URL iframe and revokes it on unmount", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectUrlMock = vi.fn(() => "blob:http://localhost/pdf-preview-1");
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
        return new Response(new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" }), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      });

      const { unmount } = render(
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <PdfPreviewPanel document={createSampleDocument("AVAILABLE")} fetchFn={fetchMock} />
        </ThemeProvider>,
      );

      const frame = await screen.findByTitle("PDF preview: contrato-vigente.pdf");
      expect(frame).toHaveAttribute("src", "blob:http://localhost/pdf-preview-1");
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/documents/${DOC_ID}/preview`,
        expect.objectContaining({ credentials: "include", method: "GET" }),
      );
      expect(createObjectUrlMock).toHaveBeenCalledTimes(1);

      unmount();
      expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:http://localhost/pdf-preview-1");
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

  it("blocks preview fetch when file object is QUARANTINED and renders safe status message", () => {
    const fetchMock = vi.fn<typeof fetch>();

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <PdfPreviewPanel document={createSampleDocument("QUARANTINED")} fetchFn={fetchMock} />
      </ThemeProvider>,
    );

    expect(
      screen.getByText(/Preview is unavailable until the file passes security checks/i),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders accessible error state when server denies preview access (403)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para acessar este documento.",
            requestId: "550e8400-e29b-41d4-a716-446655440099",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <PdfPreviewPanel document={createSampleDocument("AVAILABLE")} fetchFn={fetchMock} />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByText("You do not have permission to preview this document."),
      ).toBeInTheDocument();
    });
  });
});
