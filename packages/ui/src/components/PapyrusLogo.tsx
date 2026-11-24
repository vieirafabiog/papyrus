import { Box, Stack, Typography } from "@mui/material";
import { PAPYRUS_COLOR_TOKENS } from "../theme/tokens.js";

export type PapyrusLogoVariant = "default" | "monochrome" | "inverse";
export type PapyrusLogoSize = "sm" | "md" | "lg";

export interface PapyrusMarkProps {
  readonly size?: number | undefined;
  readonly variant?: PapyrusLogoVariant | undefined;
  readonly title?: string | undefined;
}

export interface PapyrusLogoProps {
  readonly size?: PapyrusLogoSize | undefined;
  readonly variant?: PapyrusLogoVariant | undefined;
  readonly showTagline?: boolean | undefined;
  readonly tagline?: string | undefined;
}

const SIZE_MAP: Readonly<
  Record<
    PapyrusLogoSize,
    {
      readonly markSize: number;
      readonly wordmarkFontSize: string;
      readonly gap: number;
    }
  >
> = {
  sm: { markSize: 28, wordmarkFontSize: "1.25rem", gap: 1.25 },
  md: { markSize: 38, wordmarkFontSize: "1.625rem", gap: 1.5 },
  lg: { markSize: 48, wordmarkFontSize: "2rem", gap: 1.75 },
};

function resolveMarkPalette(variant: PapyrusLogoVariant): {
  readonly primary: string;
  readonly accent: string;
  readonly lines: string;
} {
  switch (variant) {
    case "inverse":
      return {
        primary: "#5CC2A7",
        accent: "#D6A35E",
        lines: "#142420",
      };
    case "monochrome":
      return {
        primary: "currentColor",
        accent: "currentColor",
        lines: "#FFFFFF",
      };
    default:
      return {
        primary: PAPYRUS_COLOR_TOKENS.primary.main,
        accent: PAPYRUS_COLOR_TOKENS.brand.accent,
        lines: PAPYRUS_COLOR_TOKENS.primary.contrastText,
      };
  }
}

/**
 * Símbolo geométrico "Papiro Arquitetural" do papyrus.
 * Construído com arcos simétricos em 180°, sem gradientes, legível de 16px a 128px.
 */
export function PapyrusMark({ size = 32, variant = "default", title }: PapyrusMarkProps) {
  const colors = resolveMarkPalette(variant);
  const decorative = !title;

  return (
    <Box
      component="svg"
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative ? true : undefined}
      sx={{
        width: size,
        height: size,
        display: "block",
        flexShrink: 0,
      }}
    >
      {title ? <title>{title}</title> : null}
      <path d="M39 6a4 4 0 0 1 4 4 4 4 0 0 1-4 4h-4v-4a4 4 0 0 1 4-4Z" fill={colors.accent} />
      <path d="M9 42a4 4 0 0 1-4-4 4 4 0 0 1 4-4h4v4a4 4 0 0 1-4 4Z" fill={colors.accent} />
      <path
        d="M17 6h22a4 4 0 0 0-4 4v28a4 4 0 0 1-4 4H9a4 4 0 0 0 4-4V10a4 4 0 0 1 4-4Z"
        fill={colors.primary}
      />
      <rect x="18" y="16" width="12" height="2.6" rx="1.3" fill={colors.lines} />
      <rect x="18" y="22.7" width="12" height="2.6" rx="1.3" fill={colors.lines} />
      <rect x="18" y="29.4" width="8" height="2.6" rx="1.3" fill={colors.lines} />
    </Box>
  );
}

/**
 * Lockup horizontal da marca `papyrus` (símbolo + wordmark em minúsculas).
 */
export function PapyrusLogo({
  size = "sm",
  variant = "default",
  showTagline = false,
  tagline = "Gestão Eletrônica de Documentos",
}: PapyrusLogoProps) {
  const dimensions = SIZE_MAP[size];
  const wordmarkColor = variant === "inverse" ? "#FFFFFF" : PAPYRUS_COLOR_TOKENS.primary.main;
  const taglineColor =
    variant === "inverse" ? "rgba(255, 255, 255, 0.78)" : PAPYRUS_COLOR_TOKENS.text.secondary;

  return (
    <Stack direction="row" spacing={dimensions.gap} alignItems="center">
      <PapyrusMark size={dimensions.markSize} variant={variant} />
      <Box sx={{ minWidth: 0 }}>
        <Typography
          component="span"
          sx={{
            display: "block",
            fontSize: dimensions.wordmarkFontSize,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            color: wordmarkColor,
          }}
        >
          papyrus
        </Typography>
        {showTagline ? (
          <Typography
            component="span"
            variant="caption"
            sx={{
              display: "block",
              mt: 0.25,
              color: taglineColor,
            }}
          >
            {tagline}
          </Typography>
        ) : null}
      </Box>
    </Stack>
  );
}
