import CheckOutlinedIcon from "@mui/icons-material/CheckOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import WrapTextOutlinedIcon from "@mui/icons-material/WrapTextOutlined";
import { Alert, Box, Button, Chip, InputAdornment, Stack, TextField } from "@mui/material";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useMemo, useState } from "react";
import { useI18n } from "../../../i18n/index.js";
import { stripUtf8Bom } from "./preview-formats.js";

const MAX_DISPLAY_LINES = 5000;

export interface TextPreviewViewerProps {
  readonly content: string;
  readonly expanded?: boolean | undefined;
}

export function TextPreviewViewer({ content, expanded = false }: TextPreviewViewerProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [wrapLines, setWrapLines] = useState(true);
  const [copied, setCopied] = useState(false);

  const cleaned = useMemo(() => stripUtf8Bom(content), [content]);
  const allLines = useMemo(() => cleaned.split(/\r\n|\n/), [cleaned]);
  const cappedLines = useMemo(() => allLines.slice(0, MAX_DISPLAY_LINES), [allLines]);
  const truncated = allLines.length > MAX_DISPLAY_LINES;

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleLines = useMemo(() => {
    const indexed = cappedLines.map((text, idx) => ({ lineNumber: idx + 1, text }));
    if (normalizedQuery.length === 0) {
      return indexed;
    }
    return indexed.filter((line) => line.text.toLowerCase().includes(normalizedQuery));
  }, [cappedLines, normalizedQuery]);

  const handleCopy = async (): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(cleaned);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts.
    }
  };

  if (cleaned.length === 0) {
    return <Alert severity="info">{t("documents.preview.emptyContent")}</Alert>;
  }

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
        <Chip
          size="small"
          variant="outlined"
          label={
            normalizedQuery.length > 0
              ? t("documents.preview.filteredLinesCount", {
                  shown: visibleLines.length,
                  total: allLines.length,
                })
              : t("documents.preview.linesCount", { count: allLines.length })
          }
        />

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
            sx={{ minWidth: 200 }}
          />
          <Button
            size="small"
            variant={wrapLines ? "contained" : "outlined"}
            startIcon={<WrapTextOutlinedIcon />}
            onClick={() => setWrapLines((prev) => !prev)}
          >
            {t("documents.preview.wrapLines")}
          </Button>
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

      {truncated ? (
        <Alert severity="info">
          {t("documents.preview.truncatedLines", {
            shown: cappedLines.length,
            total: allLines.length,
          })}
        </Alert>
      ) : null}

      {visibleLines.length === 0 ? (
        <Alert severity="info">{t("documents.preview.noMatches")}</Alert>
      ) : (
        <Box
          component="section"
          aria-label={t("documents.preview.title")}
          sx={{
            maxHeight: expanded ? "calc(100vh - 200px)" : 520,
            overflow: "auto",
            border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
            borderRadius: 1,
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: "0.8125rem",
            lineHeight: 1.55,
            py: 1,
          }}
        >
          {visibleLines.map((line) => (
            <Box
              key={line.lineNumber}
              sx={{
                display: "flex",
                alignItems: "flex-start",
                px: 1.5,
                "&:hover": {
                  bgcolor: PAPYRUS_COLOR_TOKENS.surface.container,
                },
              }}
            >
              <Box
                component="span"
                sx={{
                  minWidth: 44,
                  pr: 1.5,
                  textAlign: "right",
                  color: "text.secondary",
                  userSelect: "none",
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {line.lineNumber}
              </Box>
              <Box
                component="span"
                sx={{
                  whiteSpace: wrapLines ? "pre-wrap" : "pre",
                  wordBreak: wrapLines ? "break-word" : "normal",
                  flex: 1,
                }}
              >
                {line.text.length > 0 ? line.text : " "}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Stack>
  );
}
