export const UI_DESIGN_SYSTEM_DIRECTION = "material-design-3-inspired" as const;

export { ConfirmDialog, type ConfirmDialogProps } from "./components/ConfirmDialog.js";
export { EmptyState, type EmptyStateProps } from "./components/EmptyState.js";
export { ErrorState, type ErrorStateProps } from "./components/ErrorState.js";
export { LoadingState, type LoadingStateProps } from "./components/LoadingState.js";

export { createDocuflowTheme, docuflowTheme } from "./theme/theme.js";
export {
  DOCUFLOW_COLOR_TOKENS,
  DOCUFLOW_DENSITY_TOKENS,
  DOCUFLOW_SHAPE_TOKENS,
  DOCUFLOW_SPACING_TOKENS,
  DOCUFLOW_TYPOGRAPHY_TOKENS,
} from "./theme/tokens.js";
