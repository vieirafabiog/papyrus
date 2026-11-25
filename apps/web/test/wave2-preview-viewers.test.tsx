import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { DocumentDetail } from "@papyrus/contracts";
import { papyrusTheme } from "@papyrus/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPreviewPanel } from "../src/features/documents/DocumentPreviewPanel.js";
import { parseXlsxWorkbook } from "../src/features/documents/viewers/xlsx-parser.js";

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
}): DocumentDetail {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Wave 2 Sample Document",
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
    category: { id: CAT_ID, name: "General", color: null, icon: null, fields: [] },
    folder: null,
    owner: { id: OWNER_ID, fullName: "Admin User", email: "admin@papyrus.local" },
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
        sizeBytes: options.sizeBytes ?? 2048,
        checksumSha256: "e".repeat(64),
        status: "AVAILABLE",
      },
    },
    tags: [],
    permissions: { canUpdate: false, canDelete: false, canUpload: false, canDownload: true },
  };
}

function buildMinimalXlsxBytes(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    ),
    "xl/workbook.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Details" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
    "xl/sharedStrings.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Quarterly Budget</t></si><si><t>Department</t></si><si><t>Amount</t></si><si><t>Finance</t></si><si><t>Engineering</t></si></sst>',
    ),
    "xl/styles.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font/><font><b/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6F2EE"/></patternFill></fill></fills><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="1" fillId="1"/></cellXfs></styleSheet>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s" s="1"><v>0</v></c></row><row r="2"><c r="A2" t="s" s="1"><v>1</v></c><c r="B2" t="s" s="1"><v>2</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>42500</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>',
    ),
    "xl/worksheets/sheet2.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c><c r="B1"><v>99000</v></c></row></sheetData></worksheet>',
    ),
  });
}

function buildTwoPageTiffBytes(): ArrayBuffer {
  // Minimal valid 2-page little-endian uncompressed 2x2 RGB TIFF
  const width = 2;
  const height = 2;
  const stripSize = width * height * 3; // 12 bytes
  const ifdEntries = 10;
  const ifdSize = 2 + ifdEntries * 12 + 4; // 126 bytes

  const ifd1Offset = 8;
  const bps1Offset = ifd1Offset + ifdSize; // 6 bytes
  const strip1Offset = bps1Offset + 6;
  const ifd2Offset = strip1Offset + stripSize;
  const bps2Offset = ifd2Offset + ifdSize;
  const strip2Offset = bps2Offset + 6;
  const totalSize = strip2Offset + stripSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Header: II, 42, offset to IFD1
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifd1Offset, true);

  const writeIfd = (
    offset: number,
    bpsOffset: number,
    stripOffset: number,
    nextIfdOffset: number,
  ) => {
    let pos = offset;
    view.setUint16(pos, ifdEntries, true);
    pos += 2;
    const entry = (tag: number, type: number, count: number, value: number) => {
      view.setUint16(pos, tag, true);
      view.setUint16(pos + 2, type, true);
      view.setUint32(pos + 4, count, true);
      view.setUint32(pos + 8, value, true);
      pos += 12;
    };
    entry(256, 4, 1, width); // ImageWidth
    entry(257, 4, 1, height); // ImageLength
    entry(258, 3, 3, bpsOffset); // BitsPerSample (8, 8, 8)
    entry(259, 3, 1, 1); // Compression = None
    entry(262, 3, 1, 2); // Photometric = RGB
    entry(273, 4, 1, stripOffset); // StripOffsets
    entry(277, 3, 1, 3); // SamplesPerPixel = 3
    entry(278, 4, 1, height); // RowsPerStrip
    entry(279, 4, 1, stripSize); // StripByteCounts
    entry(284, 3, 1, 1); // PlanarConfiguration = Chunky
    view.setUint32(pos, nextIfdOffset, true);

    view.setUint16(bpsOffset, 8, true);
    view.setUint16(bpsOffset + 2, 8, true);
    view.setUint16(bpsOffset + 4, 8, true);
  };

  writeIfd(ifd1Offset, bps1Offset, strip1Offset, ifd2Offset);
  bytes.fill(0x1f, strip1Offset, strip1Offset + stripSize);

  writeIfd(ifd2Offset, bps2Offset, strip2Offset, 0);
  bytes.fill(0xb0, strip2Offset, strip2Offset + stripSize);

  return buffer;
}

describe("DocumentPreviewPanel — Wave 2 viewers (Excel, Word/PPT PDF, TIFF, Zoom/Rotate & Expand)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("parses and renders multi-sheet Excel (.xlsx) with tabs, merged cells, and search", async () => {
    const xlsxBytes = buildMinimalXlsxBytes();
    const parsed = parseXlsxWorkbook(xlsxBytes);
    expect(parsed.sheets).toHaveLength(2);
    expect(parsed.sheets[0]?.name).toBe("Summary");
    expect(parsed.sheets[0]?.rows[0]?.cells[0]?.colSpan).toBe(2);

    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(new Uint8Array(xlsxBytes), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            fileName: "budget.xlsx",
          })}
          fetchFn={fetchMock}
        />
      </ThemeProvider>,
    );

    expect(await screen.findByText("Quarterly Budget")).toBeInTheDocument();
    expect(screen.getByText("42500")).toBeInTheDocument();

    // Switch to second sheet tab
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(await screen.findByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("99000")).toBeInTheDocument();

    // Universal Expand button opens fullscreen dialog
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("loads Word (.docx) and PowerPoint (.pptx) as read-only PDF via /preview and supports Expand", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:http://localhost/office-pdf-1"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    try {
      const fetchMock = vi.fn<typeof fetch>(async () => {
        return new Response(new Blob(["%PDF-1.4"], { type: "application/pdf" }), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      });

      render(
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <DocumentPreviewPanel
            document={createDocument({
              contentType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              fileName: "contract.docx",
            })}
            fetchFn={fetchMock}
          />
        </ThemeProvider>,
      );

      const iframe = await screen.findByTitle("PDF preview: contract.docx");
      expect(iframe).toHaveAttribute("src", "blob:http://localhost/office-pdf-1");
      expect(screen.getByText("Read-only PDF")).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/documents/${DOC_ID}/preview`,
        expect.objectContaining({ credentials: "include", method: "GET" }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Expand" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
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

  it("supports zoom, 90-degree rotation, and Expand on raster images", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:http://localhost/img-zoom-1"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    try {
      const fetchMock = vi.fn<typeof fetch>(async () => {
        return new Response(new Blob(["png"], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      });

      render(
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <DocumentPreviewPanel
            document={createDocument({ contentType: "image/png", fileName: "diagram.png" })}
            fetchFn={fetchMock}
          />
        </ThemeProvider>,
      );

      await screen.findByRole("img", { name: "Image preview: diagram.png" });

      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(screen.getByText("125%")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Rotate right 90°" }));
      expect(screen.getByText("90°")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Expand" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
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

  it("decodes multi-page TIFF images with page navigation, zoom, and rotation", async () => {
    const tiffBuffer = buildTwoPageTiffBytes();
    const putImageDataMock = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: putImageDataMock,
    } as unknown as CanvasRenderingContext2D);

    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(new Uint8Array(tiffBuffer), {
        status: 200,
        headers: { "Content-Type": "image/tiff" },
      });
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentPreviewPanel
          document={createDocument({ contentType: "image/tiff", fileName: "scan-multipage.tiff" })}
          fetchFn={fetchMock}
        />
      </ThemeProvider>,
    );

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("2 × 2 px")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => {
      expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    });
    expect(putImageDataMock).toHaveBeenCalled();
  });
});
