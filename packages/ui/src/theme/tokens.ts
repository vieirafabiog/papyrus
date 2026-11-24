/**
 * Tokens visuais do papyrus (Paleta Junco & Papiro).
 *
 * Nota arquitetural: `@mui/material` é a biblioteca React de componentes utilizada
 * na implementação, enquanto o Material Design 3 (MD3) orienta os tokens de cor,
 * superfícies tonais, forma, densidade, foco e estados. O tema padrão do MUI não é
 * uma implementação integral do MD3; esta camada centraliza a aproximação visual.
 */

export const PAPYRUS_COLOR_TOKENS = {
  primary: {
    main: "#1F5C4D",
    light: "#377B69",
    dark: "#143F34",
    container: "#D6EDE6",
    onContainer: "#0D3027",
    contrastText: "#FFFFFF",
  },
  secondary: {
    main: "#7D541E",
    light: "#9E6E30",
    dark: "#5A3B12",
    container: "#F4E9D8",
    onContainer: "#3D260A",
    contrastText: "#FFFFFF",
  },
  brand: {
    accent: "#B07D3A",
    accentContainer: "#F4E9D8",
    onAccentContainer: "#4A3110",
  },
  surface: {
    background: "#FAF8F4",
    paper: "#FFFFFF",
    containerLowest: "#FFFFFF",
    containerLow: "#F3EFE7",
    container: "#ECE7DC",
    containerHigh: "#E3DDD0",
    outline: "#767066",
    outlineVariant: "#DBD4C7",
    divider: "#E4DED3",
  },
  text: {
    primary: "#1C1B18",
    secondary: "#57534A",
    disabled: "#8F8A80",
  },
  semantic: {
    successMain: "#1B6E41",
    successContainer: "#DCF3E5",
    successContrast: "#FFFFFF",
    warningMain: "#945600",
    warningContainer: "#FCECD2",
    warningContrast: "#FFFFFF",
    errorMain: "#B3261E",
    errorContainer: "#F9DEDC",
    errorContrast: "#FFFFFF",
    infoMain: "#195A7A",
    infoContainer: "#D8EEFA",
    infoContrast: "#FFFFFF",
  },
  states: {
    hoverOpacity: 0.06,
    focusOpacity: 0.12,
    selectedOpacity: 0.1,
    disabledBackground: "#EAE6DD",
    focusRingColor: "#1F5C4D",
    focusRingWidth: "2px",
    focusRingOffset: "2px",
  },
} as const;

export const PAPYRUS_TYPOGRAPHY_TOKENS = {
  fontFamily: '"Inter", "Roboto", "Helvetica Neue", Arial, sans-serif',
  h1: { fontSize: "1.75rem", fontWeight: 600, lineHeight: 1.25, letterSpacing: "-0.01em" },
  h2: { fontSize: "1.375rem", fontWeight: 600, lineHeight: 1.3, letterSpacing: "-0.005em" },
  h3: { fontSize: "1.125rem", fontWeight: 600, lineHeight: 1.35 },
  subtitle1: { fontSize: "0.9375rem", fontWeight: 600, lineHeight: 1.4 },
  body1: { fontSize: "0.875rem", fontWeight: 400, lineHeight: 1.5 },
  body2: { fontSize: "0.8125rem", fontWeight: 400, lineHeight: 1.45 },
  caption: { fontSize: "0.75rem", fontWeight: 500, lineHeight: 1.35 },
  button: {
    fontSize: "0.875rem",
    fontWeight: 600,
    lineHeight: 1.4,
    textTransform: "none" as const,
  },
} as const;

export const PAPYRUS_SHAPE_TOKENS = {
  borderRadiusBase: 8,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
} as const;

export const PAPYRUS_SPACING_TOKENS = {
  unit: 8,
  compactCellPaddingY: 8,
  compactCellPaddingX: 12,
  sectionGap: 24,
  panelPadding: 20,
} as const;

export const PAPYRUS_DENSITY_TOKENS = {
  buttonMinHeight: 36,
  inputSize: "small" as const,
  tableSize: "small" as const,
  toolbarMinHeight: 56,
  sidebarWidth: 260,
} as const;
