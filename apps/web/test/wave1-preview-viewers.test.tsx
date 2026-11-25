import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { DocumentDetail } from "@papyrus/contracts";
import { papyrusTheme } from "@papyrus/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPreviewPanel } from "../src/features/documents/DocumentPreviewPanel.js";
import { parseCsvContent } from "../src/features/documents/viewers/CsvPreviewViewer.js";
import { sanitizeMarkdownHref } from "../src/features/documents/viewers/MarkdownPreviewViewer.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440004";
const VER_ID = "550e8400-e29b-41d4-a716-446655440005";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440006";

function createDocument(options: {
  readonly contentType: string;
  readonly fileName: string;
  readonly sizeBytes?: number;
  readonly canDownload?: boolean;
}): DocumentDetail {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Wave 1 Test Document",
    categoryId: CAT_ID,
    folderId: null,
    status: "APPROVED",
    currentVersionId: VER_ID,
    ownerUserId: OWNER_ID,
    issueDate: "2026-01-10",
    expirationDate: null,
    metadata: {},
    version: 1,
    createdAt: "2026-01-10T12:00:00Z",
    updatedAt: "2026-01-11T15:30:00Z",
    category: {
      id: CAT_ID,
      name: "General",
      color: null,
      icon: null,
      fields: [],
    },
    folder: null,
    owner: {
      id: OWNER_ID,
      fullName: "Admin User",
      email: "admin@papyrus.local",
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
        originalFileName: options.fileName,
        detectedContentType: options.contentType,
        sizeBytes: options.sizeBytes ?? 1024,
        checksumSha256: "b".repeat(64),
        status: "AVAILABLE",
      },
    },
    tags: [],
    permissions: {
      canUpdate: false,
      canDelete: false,
      canUpload: false,
      canDownload: options.canDownload ?? true,
    },
  };
}

describe("DocumentPreviewPanel — Wave 1 viewers (BMP, CSV, JSON, TXT/LOG, Markdown)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders BMP images from /content endpoint", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:http://localhost/bmp-preview-1"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    try {
      const fetchMock = vi.fn<typeof fetch>(async () => {
        return new Response(new Blob(["BMtest"], { type: "image/bmp" }), {
          status: 200,
          headers: { "Content-Type": "image/bmp" },
        });
      });

      render(
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <DocumentPreviewPanel
            document={createDocument({ contentType: "image/bmp", fileName: "diagram.bmp" })}
            fetchFn={fetchMock}
          />
        </ThemeProvider>,
      );

      const image = await screen.findByRole("img", { name: "Image preview: diagram.bmp" });
      expect(image).toHaveAttribute("src", "blob:http://localhost/bmp-preview-1");
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

  it("parses and renders semicolon-delimited CSV as a filterable table", async () => {
    const csvBody =
      '\uFEFFCode;Department;Notes\n101;Finance;"Approved, Q1"\n102;Operations;"Pending ""audit"""';
    const parsed = parseCsvContent(csvBody);
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["Code", "Department", "Notes"]);
    expect(parsed.rows).toEqual([
      ["101", "Finance", "Approved, Q1"],
      ["102", "Operations", 'Pending "audit"'],
    ]);

    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(csvBody, {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({ contentType: "text/csv", fileName: "budget.csv" })}
          fetchFn={fetchMock}
        />
      </ThemeProvider>,
    );

    expect(
      await screen.findByRole("table", { name: "CSV spreadsheet preview" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Approved, Q1")).toBeInTheDocument();
    expect(screen.getByText('Pending "audit"')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Filter content..."), {
      target: { value: "Finance" },
    });
    expect(screen.getByText("Approved, Q1")).toBeInTheDocument();
    expect(screen.queryByText('Pending "audit"')).not.toBeInTheDocument();
  });

  it("pretty-prints valid JSON and falls back cleanly for malformed JSON", async () => {
    const fetchValid = vi.fn<typeof fetch>(async () => {
      return new Response('{"service":"papyrus","active":true,"items":[1,2]}', {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    });

    const { unmount } = render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({ contentType: "application/json", fileName: "config.json" })}
          fetchFn={fetchValid}
        />
      </ThemeProvider>,
    );

    expect(await screen.findByText("JSON object · 3 keys")).toBeInTheDocument();
    expect(screen.getByText(/"service": "papyrus"/)).toBeInTheDocument();
    unmount();

    const fetchInvalid = vi.fn<typeof fetch>(async () => {
      return new Response("{broken-json", {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({ contentType: "application/json", fileName: "broken.json" })}
          fetchFn={fetchInvalid}
        />
      </ThemeProvider>,
    );

    expect(
      await screen.findByText(
        "This file could not be parsed as strict JSON. Displaying raw content instead.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("{broken-json")).toBeInTheDocument();
  });

  it("renders plain text and log files with line filtering", async () => {
    const logBody =
      "2026-11-25 INFO Startup complete\n2026-11-25 WARN Retry scheduled\n2026-11-25 INFO Healthy";
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(logBody, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({ contentType: "text/plain", fileName: "system.log" })}
          fetchFn={fetchMock}
        />
      </ThemeProvider>,
    );

    expect(await screen.findByText("3 lines")).toBeInTheDocument();
    expect(screen.getByText(/Startup complete/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Filter content..."), {
      target: { value: "WARN" },
    });
    expect(screen.getByText("1 of 3 lines")).toBeInTheDocument();
    expect(screen.queryByText(/Startup complete/)).not.toBeInTheDocument();
    expect(screen.getByText(/Retry scheduled/)).toBeInTheDocument();
  });

  it("renders Markdown safely without executing javascript links or raw HTML", async () => {
    expect(sanitizeMarkdownHref("https://example.com/docs")).toBe("https://example.com/docs");
    expect(sanitizeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(sanitizeMarkdownHref("data:text/html,<script>alert(1)</script>")).toBeNull();

    const mdBody = [
      "# Retention Policy",
      "",
      "Check [Official Guide](https://example.com/guide) and [Unsafe](javascript:alert(1)).",
      "",
      "<script>window.__xss = true;</script>",
      "",
      "| Stage | Days |",
      "| --- | --- |",
      "| Active | 365 |",
    ].join("\n");

    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(mdBody, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({ contentType: "text/plain", fileName: "policy.md" })}
          fetchFn={fetchMock}
        />
      </ThemeProvider>,
    );

    expect(await screen.findByText("Retention Policy")).toBeInTheDocument();
    const safeLink = screen.getByRole("link", { name: "Official Guide" });
    expect(safeLink).toHaveAttribute("href", "https://example.com/guide");
    expect(screen.queryByRole("link", { name: "Unsafe" })).not.toBeInTheDocument();
    expect(screen.getByText(/<script>window\.__xss = true;<\/script>/)).toBeInTheDocument();
    expect(screen.getByText("365")).toBeInTheDocument();
  });

  it("enforces maxTextBytes size limit without fetching inline preview", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const onDownload = vi.fn();

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({
            contentType: "text/csv",
            fileName: "huge-export.csv",
            sizeBytes: 8 * 1024 * 1024,
          })}
          maxTextBytes={5 * 1024 * 1024}
          fetchFn={fetchMock}
          onDownload={onDownload}
        />
      </ThemeProvider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/exceeds the 5\.00 MB limit for in-page preview/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download file" }));
    await waitFor(() => {
      expect(onDownload).toHaveBeenCalledTimes(1);
    });
  });
});
