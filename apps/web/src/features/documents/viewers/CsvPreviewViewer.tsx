import CheckOutlinedIcon from "@mui/icons-material/CheckOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  InputAdornment,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useMemo, useState } from "react";
import { useI18n } from "../../../i18n/index.js";
import { stripUtf8Bom } from "./preview-formats.js";

const MAX_DISPLAY_ROWS = 500;
const MAX_DISPLAY_COLS = 50;

export interface ParsedCsvPreview {
  readonly delimiter: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly totalDataRows: number;
  readonly totalColumns: number;
  readonly truncatedRows: boolean;
  readonly truncatedColumns: boolean;
}

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && ch === delimiter) {
      count += 1;
    }
  }
  return count;
}

function detectCsvDelimiter(content: string): string {
  const sampleLines = content
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);

  if (sampleLines.length === 0) {
    return ",";
  }

  const candidates = [",", ";", "\t"] as const;
  let bestDelimiter = ",";
  let bestScore = -1;

  for (const candidate of candidates) {
    const counts = sampleLines.map((line) => countDelimiterOutsideQuotes(line, candidate));
    const first = counts[0] ?? 0;
    if (first === 0) {
      continue;
    }
    const consistent = counts.every((value) => value === first);
    const total = counts.reduce((acc, value) => acc + value, 0);
    const score = total + (consistent ? 1000 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = candidate;
    }
  }

  return bestDelimiter;
}

/**
 * Parses RFC 4180 CSV text with automatic delimiter detection (comma, semicolon, tab),
 * quoted cell handling, and safe row/column display caps.
 */
export function parseCsvContent(
  rawText: string,
  maxRows = MAX_DISPLAY_ROWS,
  maxCols = MAX_DISPLAY_COLS,
): ParsedCsvPreview {
  const cleaned = stripUtf8Bom(rawText);
  const delimiter = detectCsvDelimiter(cleaned);

  const rawRows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          currentField += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      currentRow.push(currentField);
      currentField = "";
    } else if (ch === "\r") {
      if (cleaned[i + 1] === "\n") {
        i += 1;
      }
      currentRow.push(currentField);
      rawRows.push(currentRow);
      currentRow = [];
      currentField = "";
    } else if (ch === "\n") {
      currentRow.push(currentField);
      rawRows.push(currentRow);
      currentRow = [];
      currentField = "";
    } else {
      currentField += ch;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rawRows.push(currentRow);
  }

  const nonEmptyRows = rawRows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (nonEmptyRows.length === 0) {
    return {
      delimiter,
      headers: [],
      rows: [],
      totalDataRows: 0,
      totalColumns: 0,
      truncatedRows: false,
      truncatedColumns: false,
    };
  }

  const maxDetectedCols = nonEmptyRows.reduce((max, row) => Math.max(max, row.length), 0);
  const visibleCols = Math.min(maxDetectedCols, maxCols);
  const firstRow = nonEmptyRows[0] ?? [];
  const headers: string[] = [];
  for (let col = 0; col < visibleCols; col += 1) {
    const label = (firstRow[col] ?? "").trim();
    headers.push(label.length > 0 ? label : `Col ${col + 1}`);
  }

  const allDataRows = nonEmptyRows.slice(1);
  const limitedDataRows = allDataRows.slice(0, maxRows).map((row) => {
    const normalized: string[] = [];
    for (let col = 0; col < visibleCols; col += 1) {
      normalized.push(row[col] ?? "");
    }
    return normalized;
  });

  return {
    delimiter,
    headers,
    rows: limitedDataRows,
    totalDataRows: allDataRows.length,
    totalColumns: maxDetectedCols,
    truncatedRows: allDataRows.length > maxRows,
    truncatedColumns: maxDetectedCols > maxCols,
  };
}

export interface CsvPreviewViewerProps {
  readonly content: string;
  readonly expanded?: boolean | undefined;
}

export function CsvPreviewViewer({ content, expanded = false }: CsvPreviewViewerProps) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<"table" | "source">("table");
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => parseCsvContent(content), [content]);
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const headerColumns = useMemo(
    () =>
      parsed.headers.map((label, position) => ({
        id: `col-${position + 1}-${label}`,
        label,
      })),
    [parsed.headers],
  );

  const indexedFilteredRows = useMemo(() => {
    const withIndices = parsed.rows.map((cells, position) => {
      const rowNumber = position + 1;
      return {
        rowNumber,
        cells: cells.map((value, colPosition) => ({
          id: `r${rowNumber}-c${colPosition + 1}`,
          value,
        })),
      };
    });
    if (normalizedQuery.length === 0) {
      return withIndices;
    }
    return withIndices.filter(({ cells }) =>
      cells.some((cell) => cell.value.toLowerCase().includes(normalizedQuery)),
    );
  }, [parsed.rows, normalizedQuery]);

  const handleCopy = async (): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  };

  if (parsed.headers.length === 0) {
    return <Alert severity="info">{t("documents.preview.emptyContent")}</Alert>;
  }

  const delimiterLabel = parsed.delimiter === "\t" ? "TAB" : `"${parsed.delimiter}"`;

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1.5,
          flexWrap: "wrap",
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={viewMode}
            onChange={(_event, next: "table" | "source" | null) => {
              if (next) {
                setViewMode(next);
              }
            }}
            aria-label={t("documents.preview.title")}
          >
            <ToggleButton value="table">{t("documents.preview.csv.tableMode")}</ToggleButton>
            <ToggleButton value="source">{t("documents.preview.csv.sourceMode")}</ToggleButton>
          </ToggleButtonGroup>

          <Chip
            size="small"
            variant="outlined"
            label={t("documents.preview.csv.summary", {
              rows: parsed.totalDataRows,
              columns: parsed.totalColumns,
            })}
          />
          <Chip
            size="small"
            variant="outlined"
            label={t("documents.preview.csv.delimiter", { delimiter: delimiterLabel })}
          />
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          {viewMode === "table" ? (
            <TextField
              size="small"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("documents.preview.searchPlaceholder")}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchOutlinedIcon fontSize="small" color="action" />
                    </InputAdornment>
                  ),
                },
              }}
              sx={{ minWidth: 200 }}
            />
          ) : null}

          <Button
            size="small"
            variant="outlined"
            startIcon={copied ? <CheckOutlinedIcon /> : <ContentCopyOutlinedIcon />}
            onClick={() => void handleCopy()}
          >
            {copied ? t("documents.preview.copied") : t("documents.preview.copyContent")}
          </Button>
        </Stack>
      </Box>

      {parsed.truncatedRows ? (
        <Alert severity="info">
          {t("documents.preview.csv.truncated", {
            shownRows: parsed.rows.length,
            totalRows: parsed.totalDataRows,
          })}
        </Alert>
      ) : null}

      {viewMode === "table" ? (
        indexedFilteredRows.length === 0 ? (
          <Alert severity="info">{t("documents.preview.csv.noRowsMatch")}</Alert>
        ) : (
          <TableContainer
            sx={{
              maxHeight: expanded ? "calc(100vh - 200px)" : 520,
              border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
              borderRadius: 1,
              bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
            }}
          >
            <Table size="small" stickyHeader aria-label={t("documents.preview.csv.tableAriaLabel")}>
              <TableHead>
                <TableRow>
                  <TableCell
                    sx={{
                      width: 52,
                      color: "text.secondary",
                      bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                      fontWeight: 600,
                      textAlign: "right",
                    }}
                  >
                    #
                  </TableCell>
                  {headerColumns.map((column) => (
                    <TableCell
                      key={column.id}
                      sx={{
                        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {column.label}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {indexedFilteredRows.map(({ rowNumber, cells }) => (
                  <TableRow key={`r-${rowNumber}`} hover>
                    <TableCell
                      sx={{
                        color: "text.secondary",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        userSelect: "none",
                      }}
                    >
                      {rowNumber}
                    </TableCell>
                    {cells.map((cell) => (
                      <TableCell
                        key={cell.id}
                        sx={{
                          maxWidth: 320,
                          overflowWrap: "anywhere",
                          verticalAlign: "top",
                        }}
                      >
                        <Typography variant="body2" component="span">
                          {cell.value}
                        </Typography>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )
      ) : (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 2,
            maxHeight: expanded ? "calc(100vh - 200px)" : 520,
            overflow: "auto",
            border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
            borderRadius: 1,
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: "0.8125rem",
            lineHeight: 1.55,
            whiteSpace: "pre",
          }}
        >
          {stripUtf8Bom(content)}
        </Box>
      )}
    </Stack>
  );
}
