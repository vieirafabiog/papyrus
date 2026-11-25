import { strFromU8, unzipSync } from "fflate";

const MAX_PREVIEW_ROWS = 1000;
const MAX_PREVIEW_COLS = 50;

export interface ParsedSpreadsheetCell {
  readonly id: string;
  readonly value: string;
  readonly isNumeric: boolean;
  readonly isBold: boolean;
  readonly fillHex: string | null;
  readonly colSpan: number;
  readonly rowSpan: number;
  readonly hidden: boolean;
}

export interface ParsedSpreadsheetRow {
  readonly rowNumber: number;
  readonly cells: readonly ParsedSpreadsheetCell[];
}

export interface ParsedSpreadsheetSheet {
  readonly id: string;
  readonly name: string;
  readonly columnLabels: readonly string[];
  readonly rows: readonly ParsedSpreadsheetRow[];
  readonly totalRows: number;
  readonly totalColumns: number;
  readonly truncatedRows: boolean;
  readonly truncatedColumns: boolean;
}

export interface ParsedSpreadsheetWorkbook {
  readonly sheets: readonly ParsedSpreadsheetSheet[];
}

interface CellStyleInfo {
  readonly numFmtId: number;
  readonly numFmtCode: string;
  readonly isBold: boolean;
  readonly fillHex: string | null;
}

interface MergeRange {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export function indexToExcelColumn(colIndex: number): string {
  let n = colIndex + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function excelColumnToIndex(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col - 1;
}

function parseCellRef(ref: string): { readonly row: number; readonly col: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!match) {
    return null;
  }
  const colLetters = (match[1] ?? "").toUpperCase();
  const rowNum = Number(match[2]);
  if (!Number.isInteger(rowNum) || rowNum < 1) {
    return null;
  }
  return { row: rowNum - 1, col: excelColumnToIndex(colLetters) };
}

function parseXml(xmlText: string): Document {
  const parser = new DOMParser();
  return parser.parseFromString(xmlText, "application/xml");
}

function getElementsByLocalName(root: Document | Element, localName: string): Element[] {
  const result: Element[] = [];
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i += 1) {
    const el = all.item(i);
    if (el && (el.localName === localName || el.tagName === localName)) {
      result.push(el);
    }
  }
  return result;
}

function getDirectChildrenByLocalName(parent: Element, localName: string): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children.item(i);
    if (child && (child.localName === localName || child.tagName === localName)) {
      result.push(child);
    }
  }
  return result;
}

function findArchiveEntry(
  files: Readonly<Record<string, Uint8Array>>,
  targetPath: string,
): Uint8Array | null {
  const normalized = targetPath.replace(/^\/+/, "").replace(/\\/g, "/");
  if (files[normalized]) {
    return files[normalized] ?? null;
  }
  const lowerTarget = normalized.toLowerCase();
  for (const [key, data] of Object.entries(files)) {
    if (key.toLowerCase() === lowerTarget) {
      return data;
    }
  }
  return null;
}

function parseSharedStrings(files: Readonly<Record<string, Uint8Array>>): readonly string[] {
  const entry = findArchiveEntry(files, "xl/sharedStrings.xml");
  if (!entry) {
    return [];
  }
  const doc = parseXml(strFromU8(entry));
  const siNodes = getElementsByLocalName(doc, "si");
  return siNodes.map((si) => {
    const tNodes = getElementsByLocalName(si, "t");
    return tNodes.map((t) => t.textContent ?? "").join("");
  });
}

function normalizeArgbToHex(rawRgb: string | null): string | null {
  if (!rawRgb) {
    return null;
  }
  const clean = rawRgb.trim();
  if (/^[0-9a-f]{8}$/i.test(clean)) {
    const hex = `#${clean.slice(2).toUpperCase()}`;
    if (hex === "#FFFFFF" || hex === "#000000") {
      return null;
    }
    return hex;
  }
  if (/^[0-9a-f]{6}$/i.test(clean)) {
    const hex = `#${clean.toUpperCase()}`;
    if (hex === "#FFFFFF" || hex === "#000000") {
      return null;
    }
    return hex;
  }
  return null;
}

function parseStyles(files: Readonly<Record<string, Uint8Array>>): readonly CellStyleInfo[] {
  const entry = findArchiveEntry(files, "xl/styles.xml");
  if (!entry) {
    return [];
  }
  const doc = parseXml(strFromU8(entry));

  const customNumFmts = new Map<number, string>();
  for (const numFmt of getElementsByLocalName(doc, "numFmt")) {
    const id = Number(numFmt.getAttribute("numFmtId"));
    const code = numFmt.getAttribute("formatCode") ?? "";
    if (Number.isInteger(id)) {
      customNumFmts.set(id, code);
    }
  }

  const fontsRoot = getElementsByLocalName(doc, "fonts")[0];
  const fontBoldFlags: boolean[] = fontsRoot
    ? getDirectChildrenByLocalName(fontsRoot, "font").map(
        (font) => getDirectChildrenByLocalName(font, "b").length > 0,
      )
    : [];

  const fillsRoot = getElementsByLocalName(doc, "fills")[0];
  const fillColors: (string | null)[] = fillsRoot
    ? getDirectChildrenByLocalName(fillsRoot, "fill").map((fill) => {
        const pattern = getDirectChildrenByLocalName(fill, "patternFill")[0];
        if (!pattern) return null;
        const patternType = pattern.getAttribute("patternType") ?? "";
        if (patternType === "none" || patternType === "gray125") return null;
        const fg = getDirectChildrenByLocalName(pattern, "fgColor")[0];
        return normalizeArgbToHex(fg?.getAttribute("rgb") ?? null);
      })
    : [];

  const cellXfsRoot = getElementsByLocalName(doc, "cellXfs")[0];
  if (!cellXfsRoot) {
    return [];
  }

  return getDirectChildrenByLocalName(cellXfsRoot, "xf").map((xf) => {
    const numFmtId = Number(xf.getAttribute("numFmtId") ?? 0);
    const fontId = Number(xf.getAttribute("fontId") ?? 0);
    const fillId = Number(xf.getAttribute("fillId") ?? 0);
    return {
      numFmtId: Number.isInteger(numFmtId) ? numFmtId : 0,
      numFmtCode: customNumFmts.get(numFmtId) ?? "",
      isBold: fontBoldFlags[fontId] ?? false,
      fillHex: fillColors[fillId] ?? null,
    };
  });
}

function isDateFormat(style: CellStyleInfo | undefined): boolean {
  if (!style) return false;
  const id = style.numFmtId;
  if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) {
    return true;
  }
  const code = style.numFmtCode.replace(/"[^"]*"/g, "").toLowerCase();
  return /[ymd]/.test(code) && !code.includes("general");
}

function formatExcelSerialDate(serial: number): string {
  // Excel 1900 date system (accounting for Excel's 1900 leap-year bug)
  const utcDays = Math.floor(serial - 25569);
  const date = new Date(utcDays * 86_400_000);
  if (Number.isNaN(date.getTime())) {
    return String(serial);
  }
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatNumericValue(raw: string, style: CellStyleInfo | undefined): string {
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return raw;
  }
  if (isDateFormat(style)) {
    return formatExcelSerialDate(num);
  }
  const code = style?.numFmtCode ?? "";
  if (style?.numFmtId === 9 || style?.numFmtId === 10 || code.includes("%")) {
    const decimals = style?.numFmtId === 9 ? 0 : 2;
    return `${(num * 100).toFixed(decimals)}%`;
  }
  if (code.includes("R$")) {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(num);
  }
  if (code.includes("$")) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(num);
  }
  if (style?.numFmtId === 4 || style?.numFmtId === 3 || code.includes("#,##0")) {
    const hasDecimals = code.includes(".00") || style?.numFmtId === 4;
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: hasDecimals ? 2 : 4,
    }).format(num);
  }
  return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(6)));
}

function resolveSheetTargets(
  files: Readonly<Record<string, Uint8Array>>,
): readonly { readonly name: string; readonly path: string }[] {
  const workbookEntry = findArchiveEntry(files, "xl/workbook.xml");
  if (!workbookEntry) {
    return [];
  }
  const workbookDoc = parseXml(strFromU8(workbookEntry));
  const relsEntry = findArchiveEntry(files, "xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  if (relsEntry) {
    const relsDoc = parseXml(strFromU8(relsEntry));
    for (const rel of getElementsByLocalName(relsDoc, "Relationship")) {
      const id = rel.getAttribute("Id") ?? "";
      const target = rel.getAttribute("Target") ?? "";
      if (id && target) {
        const resolved = target.startsWith("/")
          ? target.slice(1)
          : target.startsWith("xl/")
            ? target
            : `xl/${target}`;
        relMap.set(id, resolved);
      }
    }
  }

  const sheetNodes = getElementsByLocalName(workbookDoc, "sheet");
  const targets: { readonly name: string; readonly path: string }[] = [];
  for (let idx = 0; idx < sheetNodes.length; idx += 1) {
    const node = sheetNodes[idx];
    if (!node) continue;
    const name = node.getAttribute("name") ?? `Sheet ${idx + 1}`;
    const rId =
      node.getAttribute("r:id") ??
      node.getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "id",
      ) ??
      "";
    const resolvedPath = relMap.get(rId) ?? `xl/worksheets/sheet${idx + 1}.xml`;
    targets.push({ name, path: resolvedPath });
  }
  return targets;
}

/**
 * Pure read-only OOXML `.xlsx` parser built on `fflate` + browser `DOMParser`.
 * Extracts sheets, cell values, basic formatting (dates, currencies, percentages, bold, fill),
 * and merged cells without executing macros or formulas.
 */
export function parseXlsxWorkbook(
  buffer: ArrayBuffer | Uint8Array,
  maxRows = MAX_PREVIEW_ROWS,
  maxCols = MAX_PREVIEW_COLS,
): ParsedSpreadsheetWorkbook {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = unzipSync(bytes);
  const sharedStrings = parseSharedStrings(files);
  const styles = parseStyles(files);
  const sheetTargets = resolveSheetTargets(files);

  const sheets: ParsedSpreadsheetSheet[] = [];

  for (let sheetIdx = 0; sheetIdx < sheetTargets.length; sheetIdx += 1) {
    const target = sheetTargets[sheetIdx];
    if (!target) continue;
    const sheetEntry = findArchiveEntry(files, target.path);
    if (!sheetEntry) continue;

    const sheetDoc = parseXml(strFromU8(sheetEntry));
    const merges: MergeRange[] = [];
    for (const mergeEl of getElementsByLocalName(sheetDoc, "mergeCell")) {
      const ref = mergeEl.getAttribute("ref") ?? "";
      const [startRef, endRef] = ref.split(":");
      if (!startRef || !endRef) continue;
      const start = parseCellRef(startRef);
      const end = parseCellRef(endRef);
      if (start && end) {
        merges.push({
          startRow: Math.min(start.row, end.row),
          startCol: Math.min(start.col, end.col),
          endRow: Math.max(start.row, end.row),
          endCol: Math.max(start.col, end.col),
        });
      }
    }

    const rowNodes = getElementsByLocalName(sheetDoc, "row");
    const cellMap = new Map<
      string,
      {
        readonly value: string;
        readonly isNumeric: boolean;
        readonly isBold: boolean;
        readonly fillHex: string | null;
      }
    >();

    let maxRowIdx = -1;
    let maxColIdx = -1;

    for (let r = 0; r < rowNodes.length; r += 1) {
      const rowNode = rowNodes[r];
      if (!rowNode) continue;
      const explicitRow = Number(rowNode.getAttribute("r") ?? r + 1) - 1;
      const cNodes = getDirectChildrenByLocalName(rowNode, "c");

      for (let c = 0; c < cNodes.length; c += 1) {
        const cNode = cNodes[c];
        if (!cNode) continue;
        const ref = cNode.getAttribute("r") ?? "";
        const parsedRef = parseCellRef(ref);
        const rowIdx = parsedRef ? parsedRef.row : explicitRow;
        const colIdx = parsedRef ? parsedRef.col : c;

        const cellType = cNode.getAttribute("t") ?? "n";
        const styleIdx = Number(cNode.getAttribute("s") ?? -1);
        const style = styleIdx >= 0 ? styles[styleIdx] : undefined;

        let displayValue = "";
        let isNumeric = false;

        if (cellType === "inlineStr") {
          const tNodes = getElementsByLocalName(cNode, "t");
          displayValue = tNodes.map((t) => t.textContent ?? "").join("");
        } else {
          const vNode = getDirectChildrenByLocalName(cNode, "v")[0];
          const rawVal = vNode?.textContent ?? "";
          if (cellType === "s") {
            const ssIdx = Number(rawVal);
            displayValue = Number.isInteger(ssIdx) ? (sharedStrings[ssIdx] ?? "") : "";
          } else if (cellType === "b") {
            displayValue = rawVal === "1" ? "TRUE" : "FALSE";
          } else if (cellType === "str" || cellType === "e") {
            displayValue = rawVal;
          } else if (rawVal.length > 0) {
            displayValue = formatNumericValue(rawVal, style);
            isNumeric = !isDateFormat(style);
          }
        }

        const hasStyle = Boolean(style?.fillHex || style?.isBold);
        if (displayValue.length > 0 || hasStyle) {
          maxRowIdx = Math.max(maxRowIdx, rowIdx);
          maxColIdx = Math.max(maxColIdx, colIdx);
          cellMap.set(`${rowIdx}:${colIdx}`, {
            value: displayValue,
            isNumeric,
            isBold: style?.isBold ?? false,
            fillHex: style?.fillHex ?? null,
          });
        }
      }
    }

    for (const m of merges) {
      maxRowIdx = Math.max(maxRowIdx, m.endRow);
      maxColIdx = Math.max(maxColIdx, m.endCol);
    }

    const totalRows = maxRowIdx + 1;
    const totalColumns = maxColIdx + 1;
    const visibleRows = Math.min(totalRows, maxRows);
    const visibleCols = Math.min(totalColumns, maxCols);

    const mergeOriginMap = new Map<
      string,
      { readonly colSpan: number; readonly rowSpan: number }
    >();
    const hiddenCells = new Set<string>();
    for (const m of merges) {
      if (m.startRow >= visibleRows || m.startCol >= visibleCols) continue;
      const clampedEndRow = Math.min(m.endRow, visibleRows - 1);
      const clampedEndCol = Math.min(m.endCol, visibleCols - 1);
      mergeOriginMap.set(`${m.startRow}:${m.startCol}`, {
        rowSpan: clampedEndRow - m.startRow + 1,
        colSpan: clampedEndCol - m.startCol + 1,
      });
      for (let r = m.startRow; r <= clampedEndRow; r += 1) {
        for (let c = m.startCol; c <= clampedEndCol; c += 1) {
          if (r !== m.startRow || c !== m.startCol) {
            hiddenCells.add(`${r}:${c}`);
          }
        }
      }
    }

    const columnLabels: string[] = [];
    for (let c = 0; c < visibleCols; c += 1) {
      columnLabels.push(indexToExcelColumn(c));
    }

    const rows: ParsedSpreadsheetRow[] = [];
    for (let r = 0; r < visibleRows; r += 1) {
      const cells: ParsedSpreadsheetCell[] = [];
      for (let c = 0; c < visibleCols; c += 1) {
        const key = `${r}:${c}`;
        const cellData = cellMap.get(key);
        const span = mergeOriginMap.get(key);
        cells.push({
          id: `s${sheetIdx + 1}-r${r + 1}-c${c + 1}`,
          value: cellData?.value ?? "",
          isNumeric: cellData?.isNumeric ?? false,
          isBold: cellData?.isBold ?? false,
          fillHex: cellData?.fillHex ?? null,
          colSpan: span?.colSpan ?? 1,
          rowSpan: span?.rowSpan ?? 1,
          hidden: hiddenCells.has(key),
        });
      }
      rows.push({ rowNumber: r + 1, cells });
    }

    sheets.push({
      id: `sheet-${sheetIdx + 1}-${target.name}`,
      name: target.name,
      columnLabels,
      rows,
      totalRows,
      totalColumns,
      truncatedRows: totalRows > maxRows,
      truncatedColumns: totalColumns > maxCols,
    });
  }

  return { sheets };
}
