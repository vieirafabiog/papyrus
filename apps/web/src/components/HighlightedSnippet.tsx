import { Box, Typography } from "@mui/material";
import { Fragment } from "react";

const HL_START = "[[HL]]";
const HL_END = "[[/HL]]";

interface SnippetPart {
  readonly key: string;
  readonly text: string;
  readonly highlighted: boolean;
}

function parseHighlightedSnippet(rawText: string): readonly SnippetPart[] {
  const parts: SnippetPart[] = [];
  let cursor = 0;

  while (cursor < rawText.length) {
    const startIdx = rawText.indexOf(HL_START, cursor);
    if (startIdx === -1) {
      parts.push({ key: `txt-${cursor}`, text: rawText.slice(cursor), highlighted: false });
      break;
    }

    if (startIdx > cursor) {
      parts.push({
        key: `txt-${cursor}`,
        text: rawText.slice(cursor, startIdx),
        highlighted: false,
      });
    }

    const contentStart = startIdx + HL_START.length;
    const endIdx = rawText.indexOf(HL_END, contentStart);
    if (endIdx === -1) {
      parts.push({
        key: `txt-${contentStart}`,
        text: rawText.slice(contentStart),
        highlighted: false,
      });
      break;
    }

    const matchText = rawText.slice(contentStart, endIdx);
    if (matchText.length > 0) {
      parts.push({ key: `hl-${contentStart}`, text: matchText, highlighted: true });
    }
    cursor = endIdx + HL_END.length;
  }

  return parts;
}

export interface HighlightedSnippetProps {
  readonly text: string;
}

/**
 * Safely renders a PostgreSQL `ts_headline` snippet delimited with `[[HL]]...[[/HL]]`
 * into plain text nodes and `<mark>` highlights without HTML injection.
 */
export function HighlightedSnippet({ text }: HighlightedSnippetProps) {
  const parts = parseHighlightedSnippet(text);

  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
        lineHeight: 1.4,
      }}
    >
      {parts.map((part) =>
        part.highlighted ? (
          <Box
            key={part.key}
            component="mark"
            sx={{
              bgcolor: "warning.light",
              color: "text.primary",
              px: 0.35,
              borderRadius: 0.5,
              fontWeight: 600,
            }}
          >
            {part.text}
          </Box>
        ) : (
          <Fragment key={part.key}>{part.text}</Fragment>
        ),
      )}
    </Typography>
  );
}
