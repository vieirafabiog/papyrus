/**
 * Tokens visuais do DocuFlow.
 *
 * Nota arquitetural: `@mui/material` é a biblioteca React de componentes utilizada
 * na implementação, enquanto o Material Design 3 (MD3) orienta os tokens de cor,
 * superfícies tonais, forma, densidade, foco e estados. O tema padrão do MUI não é
 * uma implementação integral do MD3; esta camada centraliza a aproximação visual.
 */

export const DOCUFLOW_COLOR_TOKENS = {
  primary: {
    main: "#0F5C73",
    light: "#2B7A91",
    dark: "#084152",
    container: "#D8EEF5",
    onContainer: "#062A36",
    contrastText: "#FFFFFF",
  },
  secondary: {
    main: "#475E6B",
    light: "#69808E",
    dark: "#2F424D",
    container: "#E2ECF1",
    onContainer: "#1C2B33",
    contrastText: "#FFFFFF",
  },
  surface: {
    background: "#F6F8F9",
    paper: "#FFFFFF",
    containerLowest: "#FFFFFF",
    containerLow: "#F1F5F7",
    container: "#EBF0F3",
    containerHigh: "#E2E9ED",
    outline: "#728088",
    outlineVariant: "#D3DCE1",
    divider: "#DDE5E9",
  },
  text: {
    primary: "#162026",
    secondary: "#4B5B64",
    disabled: "#8A98A0",
  },
  semantic: {
    successMain: "#1B6E41",
    successContainer: "#DCF3E5",
    successContrast: "#FFFFFF",
    warningMain: "#9A5B00",
    warningContainer: "#FCECD2",
    warningContrast: "#FFFFFF",
    errorMain: "#B3261E",
    errorContainer: "#F9DEDC",
    errorContrast: "#FFFFFF",
    infoMain: "#0E5E8A",
    infoContainer: "#D8EEFA",
    infoContrast: "#FFFFFF",
  },
  states: {
    hoverOpacity: 0.06,
    focusOpacity: 0.12,
    selectedOpacity: 0.1,
    disabledBackground: "#E9EEF1",
    focusRingColor: "#0F5C73",
    focusRingWidth: "2px",
    focusRingOffset: "2px",
  },
} as const;

export const DOCUFLOW_TYPOGRAPHY_TOKENS = {
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

export const DOCUFLOW_SHAPE_TOKENS = {
  borderRadiusBase: 8,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
} as const;

export const DOCUFLOW_SPACING_TOKENS = {
  unit: 8,
  compactCellPaddingY: 8,
  compactCellPaddingX: 12,
  sectionGap: 24,
  panelPadding: 20,
} as const;

export const DOCUFLOW_DENSITY_TOKENS = {
  buttonMinHeight: 36,
  inputSize: "small" as const,
  tableSize: "small" as const,
  toolbarMinHeight: 56,
  sidebarWidth: 260,
} as const;
