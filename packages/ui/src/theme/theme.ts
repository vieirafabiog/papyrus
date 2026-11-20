import { createTheme, type Theme } from "@mui/material/styles";
import { ptBR } from "@mui/material/locale";
import {
  DOCUFLOW_COLOR_TOKENS,
  DOCUFLOW_DENSITY_TOKENS,
  DOCUFLOW_SHAPE_TOKENS,
  DOCUFLOW_SPACING_TOKENS,
  DOCUFLOW_TYPOGRAPHY_TOKENS,
} from "./tokens.js";

/**
 * Cria o tema MUI do DocuFlow inspirado em Material Design 3.
 * `@mui/material` implementa os componentes; os tokens em `tokens.ts`
 * aplicam superfícies tonais, densidade empresarial e foco acessível.
 */
export function createDocuflowTheme(): Theme {
  const focusVisibleRule = {
    outline: `${DOCUFLOW_COLOR_TOKENS.states.focusRingWidth} solid ${DOCUFLOW_COLOR_TOKENS.states.focusRingColor}`,
    outlineOffset: DOCUFLOW_COLOR_TOKENS.states.focusRingOffset,
  };

  return createTheme(
    {
      palette: {
        mode: "light",
        primary: {
          main: DOCUFLOW_COLOR_TOKENS.primary.main,
          light: DOCUFLOW_COLOR_TOKENS.primary.light,
          dark: DOCUFLOW_COLOR_TOKENS.primary.dark,
          contrastText: DOCUFLOW_COLOR_TOKENS.primary.contrastText,
        },
        secondary: {
          main: DOCUFLOW_COLOR_TOKENS.secondary.main,
          light: DOCUFLOW_COLOR_TOKENS.secondary.light,
          dark: DOCUFLOW_COLOR_TOKENS.secondary.dark,
          contrastText: DOCUFLOW_COLOR_TOKENS.secondary.contrastText,
        },
        success: {
          main: DOCUFLOW_COLOR_TOKENS.semantic.successMain,
          contrastText: DOCUFLOW_COLOR_TOKENS.semantic.successContrast,
        },
        warning: {
          main: DOCUFLOW_COLOR_TOKENS.semantic.warningMain,
          contrastText: DOCUFLOW_COLOR_TOKENS.semantic.warningContrast,
        },
        error: {
          main: DOCUFLOW_COLOR_TOKENS.semantic.errorMain,
          contrastText: DOCUFLOW_COLOR_TOKENS.semantic.errorContrast,
        },
        info: {
          main: DOCUFLOW_COLOR_TOKENS.semantic.infoMain,
          contrastText: DOCUFLOW_COLOR_TOKENS.semantic.infoContrast,
        },
        background: {
          default: DOCUFLOW_COLOR_TOKENS.surface.background,
          paper: DOCUFLOW_COLOR_TOKENS.surface.paper,
        },
        text: {
          primary: DOCUFLOW_COLOR_TOKENS.text.primary,
          secondary: DOCUFLOW_COLOR_TOKENS.text.secondary,
          disabled: DOCUFLOW_COLOR_TOKENS.text.disabled,
        },
        divider: DOCUFLOW_COLOR_TOKENS.surface.divider,
        action: {
          hoverOpacity: DOCUFLOW_COLOR_TOKENS.states.hoverOpacity,
          focusOpacity: DOCUFLOW_COLOR_TOKENS.states.focusOpacity,
          selectedOpacity: DOCUFLOW_COLOR_TOKENS.states.selectedOpacity,
          disabledBackground: DOCUFLOW_COLOR_TOKENS.states.disabledBackground,
        },
      },
      shape: {
        borderRadius: DOCUFLOW_SHAPE_TOKENS.borderRadiusBase,
      },
      spacing: DOCUFLOW_SPACING_TOKENS.unit,
      typography: {
        fontFamily: DOCUFLOW_TYPOGRAPHY_TOKENS.fontFamily,
        h1: DOCUFLOW_TYPOGRAPHY_TOKENS.h1,
        h2: DOCUFLOW_TYPOGRAPHY_TOKENS.h2,
        h3: DOCUFLOW_TYPOGRAPHY_TOKENS.h3,
        subtitle1: DOCUFLOW_TYPOGRAPHY_TOKENS.subtitle1,
        body1: DOCUFLOW_TYPOGRAPHY_TOKENS.body1,
        body2: DOCUFLOW_TYPOGRAPHY_TOKENS.body2,
        caption: DOCUFLOW_TYPOGRAPHY_TOKENS.caption,
        button: DOCUFLOW_TYPOGRAPHY_TOKENS.button,
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            body: {
              backgroundColor: DOCUFLOW_COLOR_TOKENS.surface.background,
              color: DOCUFLOW_COLOR_TOKENS.text.primary,
            },
          },
        },
        MuiButtonBase: {
          styleOverrides: {
            root: {
              "&.Mui-focusVisible": focusVisibleRule,
            },
          },
        },
        MuiButton: {
          defaultProps: {
            disableElevation: true,
            size: "medium",
          },
          styleOverrides: {
            root: {
              minHeight: DOCUFLOW_DENSITY_TOKENS.buttonMinHeight,
              borderRadius: DOCUFLOW_SHAPE_TOKENS.md,
              paddingInline: 16,
            },
          },
        },
        MuiTextField: {
          defaultProps: {
            size: DOCUFLOW_DENSITY_TOKENS.inputSize,
            variant: "outlined",
          },
        },
        MuiOutlinedInput: {
          styleOverrides: {
            root: {
              borderRadius: DOCUFLOW_SHAPE_TOKENS.sm,
              backgroundColor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
              "& .MuiOutlinedInput-notchedOutline": {
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
              },
              "&:hover .MuiOutlinedInput-notchedOutline": {
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outline,
              },
              "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                borderWidth: 2,
                borderColor: DOCUFLOW_COLOR_TOKENS.primary.main,
              },
            },
          },
        },
        MuiPaper: {
          defaultProps: {
            elevation: 0,
          },
          styleOverrides: {
            root: {
              backgroundImage: "none",
              border: `1px solid ${DOCUFLOW_COLOR_TOKENS.surface.outlineVariant}`,
              borderRadius: DOCUFLOW_SHAPE_TOKENS.lg,
            },
          },
        },
        MuiTable: {
          defaultProps: {
            size: DOCUFLOW_DENSITY_TOKENS.tableSize,
          },
        },
        MuiTableCell: {
          styleOverrides: {
            root: {
              paddingBlock: DOCUFLOW_SPACING_TOKENS.compactCellPaddingY,
              paddingInline: DOCUFLOW_SPACING_TOKENS.compactCellPaddingX,
              borderBottomColor: DOCUFLOW_COLOR_TOKENS.surface.divider,
            },
            head: {
              backgroundColor: DOCUFLOW_COLOR_TOKENS.surface.containerLow,
              color: DOCUFLOW_COLOR_TOKENS.text.secondary,
              fontWeight: 600,
            },
          },
        },
        MuiChip: {
          styleOverrides: {
            root: {
              borderRadius: DOCUFLOW_SHAPE_TOKENS.sm,
              fontWeight: 500,
            },
          },
        },
        MuiToolbar: {
          styleOverrides: {
            root: {
              minHeight: DOCUFLOW_DENSITY_TOKENS.toolbarMinHeight,
            },
          },
        },
      },
    },
    ptBR,
  );
}

export const docuflowTheme = createDocuflowTheme();
