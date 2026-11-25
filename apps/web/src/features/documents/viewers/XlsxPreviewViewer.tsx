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
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useMemo, useState } from "react";
import { useI18n } from "../../../i18n/index.js";
import { parseXlsxWorkbook } from "./xlsx-parser.js";

export interface XlsxPreviewViewerProps {
  readonly buffer: ArrayBuffer;
  readonly expanded?: boolean | undefined;
}

export function XlsxPreviewViewer({ buffer, expanded = false }: XlsxPreviewViewerProps) {
  const { t } = useI18n();
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const parsedResult = useMemo(() => {
    try {
      return { ok: true as const, workbook: parseXlsxWorkbook(buffer) };
    } catch {
      return { ok: false as const };
    }
  }, [buffer]);

  if (!parsedResult.ok) {
    return <Alert severity="error">{t("documents.preview.xlsx.parseError")}</Alert>;
  }

  const { sheets } = parsedResult.workbook;
  if (sheets.length === 0) {
    return <Alert severity="info">{t("documents.preview.xlsx.emptyWorkbook")}</Alert>;
  }

  const safeIndex = Math.min(activeSheetIndex, sheets.length - 1);
  const activeSheet = sheets[safeIndex];
  if (!activeSheet) {
    return <Alert severity="info">{t("documents.preview.xlsx.emptyWorkbook")}</Alert>;
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isFiltering = normalizedQuery.length > 0;
  const visibleRows = isFiltering
    ? activeSheet.rows.filter((row) =>
        row.cells.some((cell) => cell.value.toLowerCase().includes(normalizedQuery)),
      )
    : activeSheet.rows;

  const handleCopySheet = async (): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    const tsv = visibleRows
      .map((row) => row.cells.map((cell) => cell.value.replace(/\t|\r|\n/g, " ")).join("\t"))
      .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  };

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
          <Chip
            size="small"
            variant="outlined"
            label={t("documents.preview.xlsx.sheetsCount", { count: sheets.length })}
          />
          <Chip
            size="small"
            variant="outlined"
            label={t("documents.preview.csv.summary", {
              rows: activeSheet.totalRows,
              columns: activeSheet.totalColumns,
            })}
          />
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
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
            sx={{ minWidth: 210 }}
          />

          <Button
            size="small"
            variant="outlined"
            startIcon={copied ? <CheckOutlinedIcon /> : <ContentCopyOutlinedIcon />}
            onClick={() => void handleCopySheet()}
          >
            {copied ? t("documents.preview.copied") : t("documents.preview.copyContent")}
          </Button>
        </Stack>
      </Box>

      {sheets.length > 1 ? (
        <Box
          sx={{
            borderBottom: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
          }}
        >
          <Tabs
            value={safeIndex}
            onChange={(_event, nextIndex: number) => {
              setActiveSheetIndex(nextIndex);
              setSearchQuery("");
            }}
            variant="scrollable"
            scrollButtons="auto"
            aria-label={t("documents.preview.xlsx.sheetsAriaLabel")}
          >
            {sheets.map((sheet, idx) => (
              <Tab
                key={sheet.id}
                value={idx}
                label={sheet.name}
                sx={{ textTransform: "none", minHeight: 40, py: 0.5 }}
              />
            ))}
          </Tabs>
        </Box>
      ) : null}

      {activeSheet.truncatedRows ? (
        <Alert severity="info">
          {t("documents.preview.csv.truncated", {
            shownRows: activeSheet.rows.length,
            totalRows: activeSheet.totalRows,
          })}
        </Alert>
      ) : null}

      {activeSheet.rows.length === 0 ? (
        <Alert severity="info">{t("documents.preview.emptyContent")}</Alert>
      ) : visibleRows.length === 0 ? (
        <Alert severity="info">{t("documents.preview.csv.noRowsMatch")}</Alert>
      ) : (
        <TableContainer
          sx={{
            maxHeight: expanded ? "calc(100vh - 230px)" : 520,
            border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
            borderRadius: 1,
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          }}
        >
          <Table
            size="small"
            stickyHeader
            aria-label={t("documents.preview.xlsx.tableAriaLabel", {
              sheetName: activeSheet.name,
            })}
          >
            <TableHead>
              <TableRow>
                <TableCell
                  sx={{
                    width: 48,
                    color: "text.secondary",
                    bgcolor: PAPYRUS_COLOR_TOKENS.surface.container,
                    borderRight: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                    fontWeight: 600,
                    textAlign: "center",
                    userSelect: "none",
                  }}
                >
                  #
                </TableCell>
                {activeSheet.columnLabels.map((label) => (
                  <TableCell
                    key={`${activeSheet.id}-col-${label}`}
                    sx={{
                      bgcolor: PAPYRUS_COLOR_TOKENS.surface.container,
                      borderRight: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                      color: "text.secondary",
                      fontWeight: 600,
                      textAlign: "center",
                      minWidth: 100,
                      userSelect: "none",
                    }}
                  >
                    {label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {visibleRows.map((row) => (
                <TableRow key={`${activeSheet.id}-row-${row.rowNumber}`} hover>
                  <TableCell
                    sx={{
                      color: "text.secondary",
                      bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                      borderRight: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      userSelect: "none",
                    }}
                  >
                    {row.rowNumber}
                  </TableCell>
                  {row.cells.map((cell) => {
                    if (!isFiltering && cell.hidden) {
                      return null;
                    }
                    const isFirstRowHeader = row.rowNumber === 1 && cell.isBold;
                    return (
                      <TableCell
                        key={cell.id}
                        colSpan={!isFiltering && cell.colSpan > 1 ? cell.colSpan : undefined}
                        rowSpan={!isFiltering && cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        sx={{
                          borderRight: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                          bgcolor:
                            cell.fillHex ??
                            (isFirstRowHeader
                              ? PAPYRUS_COLOR_TOKENS.surface.containerLow
                              : undefined),
                          textAlign: cell.isNumeric ? "right" : "left",
                          fontVariantNumeric: cell.isNumeric ? "tabular-nums" : undefined,
                          maxWidth: 320,
                          overflowWrap: "anywhere",
                          verticalAlign: "top",
                        }}
                      >
                        <Typography
                          variant="body2"
                          component="span"
                          sx={{ fontWeight: cell.isBold ? 600 : 400 }}
                        >
                          {cell.value}
                        </Typography>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}

export default XlsxPreviewViewer;
