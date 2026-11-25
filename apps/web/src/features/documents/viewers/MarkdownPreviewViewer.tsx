import CheckOutlinedIcon from "@mui/icons-material/CheckOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { useI18n } from "../../../i18n/index.js";
import { stripUtf8Bom } from "./preview-formats.js";

interface MarkdownTextItem {
  readonly id: string;
  readonly text: string;
}

interface MarkdownTableRowItem {
  readonly id: string;
  readonly cells: readonly MarkdownTextItem[];
}

type MarkdownBlock =
  | { readonly id: string; readonly type: "heading"; readonly level: number; readonly text: string }
  | { readonly id: string; readonly type: "code"; readonly language: string; readonly code: string }
  | { readonly id: string; readonly type: "hr" }
  | { readonly id: string; readonly type: "blockquote"; readonly lines: readonly string[] }
  | {
      readonly id: string;
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: readonly MarkdownTextItem[];
    }
  | {
      readonly id: string;
      readonly type: "table";
      readonly headers: readonly MarkdownTextItem[];
      readonly rows: readonly MarkdownTableRowItem[];
    }
  | { readonly id: string; readonly type: "paragraph"; readonly text: string };

/**
 * Allows only safe http/https/mailto URLs in rendered Markdown links.
 * Blocks javascript:, data:, vbscript:, and protocol-relative schemes.
 */
export function sanitizeMarkdownHref(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "mailto:"
    ) {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

function splitPipeRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !trimmed.includes("-")) {
    return false;
  }
  const cells = splitPipeRow(trimmed);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownBlocks(source: string): readonly MarkdownBlock[] {
  const lines = source.split(/\r\n|\n/);
  const blocks: MarkdownBlock[] = [];
  let blockSeq = 0;
  const nextId = (prefix: string): string => {
    blockSeq += 1;
    return `${prefix}-${blockSeq}`;
  };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = /^```([^\s`]*)/.exec(trimmed);
    if (fenceMatch) {
      const language = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      blocks.push({ id: nextId("code"), type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ id: nextId("hr"), type: "hr" });
      i += 1;
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        id: nextId("heading"),
        type: "heading",
        level: headingMatch[1]?.length ?? 1,
        text: headingMatch[2]?.trim() ?? "",
      });
      i += 1;
      continue;
    }

    // Pipe table
    const nextLine = lines[i + 1] ?? "";
    if (trimmed.includes("|") && isTableSeparatorLine(nextLine)) {
      const tableId = nextId("table");
      const rawHeaders = splitPipeRow(trimmed);
      const headers: MarkdownTextItem[] = rawHeaders.map((text, pos) => ({
        id: `${tableId}-h-${pos + 1}`,
        text,
      }));
      const rows: MarkdownTableRowItem[] = [];
      let rowNum = 0;
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i] ?? "";
        if (rowLine.trim().length === 0 || !rowLine.includes("|")) {
          break;
        }
        rowNum += 1;
        const cells = splitPipeRow(rowLine);
        const normalized: MarkdownTextItem[] = [];
        for (let col = 0; col < headers.length; col += 1) {
          normalized.push({
            id: `${tableId}-r-${rowNum}-c-${col + 1}`,
            text: cells[col] ?? "",
          });
        }
        rows.push({ id: `${tableId}-r-${rowNum}`, cells: normalized });
        i += 1;
      }
      blocks.push({ id: tableId, type: "table", headers, rows });
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) {
        quoteLines.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ id: nextId("quote"), type: "blockquote", lines: quoteLines });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const listId = nextId("ul");
      const items: MarkdownTextItem[] = [];
      let itemNum = 0;
      while (i < lines.length && /^[-*+]\s+/.test((lines[i] ?? "").trim())) {
        itemNum += 1;
        items.push({
          id: `${listId}-i-${itemNum}`,
          text: (lines[i] ?? "").trim().replace(/^[-*+]\s+/, ""),
        });
        i += 1;
      }
      blocks.push({ id: listId, type: "list", ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const listId = nextId("ol");
      const items: MarkdownTextItem[] = [];
      let itemNum = 0;
      while (i < lines.length && /^\d+\.\s+/.test((lines[i] ?? "").trim())) {
        itemNum += 1;
        items.push({
          id: `${listId}-i-${itemNum}`,
          text: (lines[i] ?? "").trim().replace(/^\d+\.\s+/, ""),
        });
        i += 1;
      }
      blocks.push({ id: listId, type: "list", ordered: true, items });
      continue;
    }

    // Paragraph (coalesce consecutive plain lines)
    const paragraphLines: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = (lines[i] ?? "").trim();
      if (
        next.length === 0 ||
        next.startsWith("```") ||
        /^#{1,6}\s+/.test(next) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(next) ||
        next.startsWith(">") ||
        /^[-*+]\s+/.test(next) ||
        /^\d+\.\s+/.test(next)
      ) {
        break;
      }
      paragraphLines.push(next);
      i += 1;
    }
    blocks.push({ id: nextId("p"), type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

const INLINE_TOKEN_REGEX =
  /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/g;

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIdx = 0;

  INLINE_TOKEN_REGEX.lastIndex = 0;
  let match = INLINE_TOKEN_REGEX.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${tokenIdx}`;
    tokenIdx += 1;

    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <Box
          key={key}
          component="code"
          sx={{
            px: 0.6,
            py: 0.15,
            borderRadius: 0.75,
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerHigh,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: "0.85em",
          }}
        >
          {token.slice(1, -1)}
        </Box>,
      );
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        const label = linkMatch[1] ?? "";
        const safeHref = sanitizeMarkdownHref(linkMatch[2] ?? "");
        if (safeHref) {
          nodes.push(
            <Link key={key} href={safeHref} target="_blank" rel="noopener noreferrer">
              {label}
            </Link>,
          );
        } else {
          nodes.push(<Fragment key={key}>{label}</Fragment>);
        }
      } else {
        nodes.push(token);
      }
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      nodes.push(token);
    }

    lastIndex = match.index + token.length;
    match = INLINE_TOKEN_REGEX.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

const HEADING_VARIANTS = ["h4", "h5", "h6", "subtitle1", "subtitle2", "subtitle2"] as const;

export interface MarkdownPreviewViewerProps {
  readonly content: string;
  readonly expanded?: boolean | undefined;
}

export function MarkdownPreviewViewer({ content, expanded = false }: MarkdownPreviewViewerProps) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  const [copied, setCopied] = useState(false);

  const cleaned = useMemo(() => stripUtf8Bom(content), [content]);
  const blocks = useMemo(() => parseMarkdownBlocks(cleaned), [cleaned]);

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

  if (cleaned.trim().length === 0) {
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
        <Stack direction="row" spacing={1} alignItems="center">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={viewMode}
            onChange={(_event, next: "rendered" | "source" | null) => {
              if (next) {
                setViewMode(next);
              }
            }}
            aria-label={t("documents.preview.title")}
          >
            <ToggleButton value="rendered">
              {t("documents.preview.markdown.renderedMode")}
            </ToggleButton>
            <ToggleButton value="source">{t("documents.preview.markdown.sourceMode")}</ToggleButton>
          </ToggleButtonGroup>
          <Chip size="small" variant="outlined" label={t("documents.preview.markdown.badge")} />
        </Stack>

        <Button
          size="small"
          variant="outlined"
          startIcon={copied ? <CheckOutlinedIcon /> : <ContentCopyOutlinedIcon />}
          onClick={() => void handleCopy()}
        >
          {copied ? t("documents.preview.copied") : t("documents.preview.copyContent")}
        </Button>
      </Box>

      {viewMode === "rendered" ? (
        <Box
          component="section"
          aria-label={t("documents.preview.title")}
          sx={{
            p: 3,
            maxHeight: expanded ? "calc(100vh - 200px)" : 560,
            overflow: "auto",
            border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
            borderRadius: 1,
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          }}
        >
          <Stack spacing={1.75}>
            {blocks.map((block) => {
              const blockKey = block.id;
              switch (block.type) {
                case "heading": {
                  const variant =
                    HEADING_VARIANTS[Math.min(block.level - 1, HEADING_VARIANTS.length - 1)] ??
                    "h6";
                  return (
                    <Typography
                      key={blockKey}
                      variant={variant}
                      component="div"
                      sx={{
                        fontWeight: 600,
                        mt: block.level <= 2 ? 0.5 : 0,
                        pb: block.level <= 2 ? 0.5 : 0,
                        borderBottom:
                          block.level <= 2
                            ? `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`
                            : "none",
                      }}
                    >
                      {renderInlineMarkdown(block.text, blockKey)}
                    </Typography>
                  );
                }
                case "hr":
                  return <Divider key={blockKey} />;
                case "code":
                  return (
                    <Box
                      key={blockKey}
                      component="pre"
                      sx={{
                        m: 0,
                        p: 1.75,
                        overflow: "auto",
                        borderRadius: 1,
                        border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        fontSize: "0.8125rem",
                        lineHeight: 1.55,
                      }}
                    >
                      <code>{block.code}</code>
                    </Box>
                  );
                case "blockquote":
                  return (
                    <Box
                      key={blockKey}
                      component="blockquote"
                      sx={{
                        m: 0,
                        pl: 2,
                        py: 0.75,
                        borderLeft: `3px solid ${PAPYRUS_COLOR_TOKENS.primary.main}`,
                        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                        borderRadius: "0 4px 4px 0",
                      }}
                    >
                      <Typography variant="body2" color="text.secondary">
                        {renderInlineMarkdown(block.lines.join(" "), blockKey)}
                      </Typography>
                    </Box>
                  );
                case "list":
                  return (
                    <Box
                      key={blockKey}
                      component={block.ordered ? "ol" : "ul"}
                      sx={{ m: 0, pl: 3, display: "flex", flexDirection: "column", gap: 0.5 }}
                    >
                      {block.items.map((item) => (
                        <Box key={item.id} component="li">
                          <Typography variant="body2">
                            {renderInlineMarkdown(item.text, item.id)}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  );
                case "table":
                  return (
                    <TableContainer
                      key={blockKey}
                      sx={{
                        border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                        borderRadius: 1,
                      }}
                    >
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            {block.headers.map((header) => (
                              <TableCell
                                key={header.id}
                                sx={{
                                  fontWeight: 600,
                                  bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                                }}
                              >
                                {renderInlineMarkdown(header.text, header.id)}
                              </TableCell>
                            ))}
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {block.rows.map((row) => (
                            <TableRow key={row.id} hover>
                              {row.cells.map((cell) => (
                                <TableCell key={cell.id}>
                                  {renderInlineMarkdown(cell.text, cell.id)}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  );
                case "paragraph":
                  return (
                    <Typography key={blockKey} variant="body2" sx={{ lineHeight: 1.7 }}>
                      {renderInlineMarkdown(block.text, blockKey)}
                    </Typography>
                  );
              }
            })}
          </Stack>
        </Box>
      ) : (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 2,
            maxHeight: expanded ? "calc(100vh - 200px)" : 560,
            overflow: "auto",
            border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
            borderRadius: 1,
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: "0.8125rem",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
          }}
        >
          {cleaned}
        </Box>
      )}
    </Stack>
  );
}
