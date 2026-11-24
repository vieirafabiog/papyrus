import { enUS, esES, ptBR } from "@mui/material/locale";
import { type Theme, createTheme } from "@mui/material/styles";
import { DEFAULT_PAPYRUS_LOCALE, type PapyrusLocale } from "../locale.js";
import {
  PAPYRUS_COLOR_TOKENS,
  PAPYRUS_DENSITY_TOKENS,
  PAPYRUS_SHAPE_TOKENS,
  PAPYRUS_SPACING_TOKENS,
  PAPYRUS_TYPOGRAPHY_TOKENS,
} from "./tokens.js";

function resolveMuiLocale(locale: PapyrusLocale) {
  switch (locale) {
    case "pt-BR":
      return ptBR;
    case "es-ES":
      return esES;
    default:
      return enUS;
  }
}

/**
 * Cria o tema MUI do papyrus inspirado em Material Design 3.
 * `@mui/material` implementa os componentes; os tokens em `tokens.ts`
 * aplicam a paleta Junco & Papiro, superfícies tonais, densidade empresarial e foco acessível.
 */
export function createPapyrusTheme(locale: PapyrusLocale = DEFAULT_PAPYRUS_LOCALE): Theme {
  const focusVisibleRule = {
    outline: `${PAPYRUS_COLOR_TOKENS.states.focusRingWidth} solid ${PAPYRUS_COLOR_TOKENS.states.focusRingColor}`,
    outlineOffset: PAPYRUS_COLOR_TOKENS.states.focusRingOffset,
  };

  return createTheme(
    {
      palette: {
        mode: "light",
        primary: {
          main: PAPYRUS_COLOR_TOKENS.primary.main,
          light: PAPYRUS_COLOR_TOKENS.primary.light,
          dark: PAPYRUS_COLOR_TOKENS.primary.dark,
          contrastText: PAPYRUS_COLOR_TOKENS.primary.contrastText,
        },
        secondary: {
          main: PAPYRUS_COLOR_TOKENS.secondary.main,
          light: PAPYRUS_COLOR_TOKENS.secondary.light,
          dark: PAPYRUS_COLOR_TOKENS.secondary.dark,
          contrastText: PAPYRUS_COLOR_TOKENS.secondary.contrastText,
        },
        success: {
          main: PAPYRUS_COLOR_TOKENS.semantic.successMain,
          contrastText: PAPYRUS_COLOR_TOKENS.semantic.successContrast,
        },
        warning: {
          main: PAPYRUS_COLOR_TOKENS.semantic.warningMain,
          contrastText: PAPYRUS_COLOR_TOKENS.semantic.warningContrast,
        },
        error: {
          main: PAPYRUS_COLOR_TOKENS.semantic.errorMain,
          contrastText: PAPYRUS_COLOR_TOKENS.semantic.errorContrast,
        },
        info: {
          main: PAPYRUS_COLOR_TOKENS.semantic.infoMain,
          contrastText: PAPYRUS_COLOR_TOKENS.semantic.infoContrast,
        },
        background: {
          default: PAPYRUS_COLOR_TOKENS.surface.background,
          paper: PAPYRUS_COLOR_TOKENS.surface.paper,
        },
        text: {
          primary: PAPYRUS_COLOR_TOKENS.text.primary,
          secondary: PAPYRUS_COLOR_TOKENS.text.secondary,
          disabled: PAPYRUS_COLOR_TOKENS.text.disabled,
        },
        divider: PAPYRUS_COLOR_TOKENS.surface.divider,
        action: {
          hoverOpacity: PAPYRUS_COLOR_TOKENS.states.hoverOpacity,
          focusOpacity: PAPYRUS_COLOR_TOKENS.states.focusOpacity,
          selectedOpacity: PAPYRUS_COLOR_TOKENS.states.selectedOpacity,
          disabledBackground: PAPYRUS_COLOR_TOKENS.states.disabledBackground,
        },
      },
      shape: {
        borderRadius: PAPYRUS_SHAPE_TOKENS.borderRadiusBase,
      },
      spacing: PAPYRUS_SPACING_TOKENS.unit,
      typography: {
        fontFamily: PAPYRUS_TYPOGRAPHY_TOKENS.fontFamily,
        h1: PAPYRUS_TYPOGRAPHY_TOKENS.h1,
        h2: PAPYRUS_TYPOGRAPHY_TOKENS.h2,
        h3: PAPYRUS_TYPOGRAPHY_TOKENS.h3,
        subtitle1: PAPYRUS_TYPOGRAPHY_TOKENS.subtitle1,
        body1: PAPYRUS_TYPOGRAPHY_TOKENS.body1,
        body2: PAPYRUS_TYPOGRAPHY_TOKENS.body2,
        caption: PAPYRUS_TYPOGRAPHY_TOKENS.caption,
        button: PAPYRUS_TYPOGRAPHY_TOKENS.button,
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            body: {
              backgroundColor: PAPYRUS_COLOR_TOKENS.surface.background,
              color: PAPYRUS_COLOR_TOKENS.text.primary,
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
              minHeight: PAPYRUS_DENSITY_TOKENS.buttonMinHeight,
              borderRadius: PAPYRUS_SHAPE_TOKENS.md,
              paddingInline: 16,
            },
          },
        },
        MuiTextField: {
          defaultProps: {
            size: PAPYRUS_DENSITY_TOKENS.inputSize,
            variant: "outlined",
          },
        },
        MuiOutlinedInput: {
          styleOverrides: {
            root: {
              borderRadius: PAPYRUS_SHAPE_TOKENS.sm,
              backgroundColor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
              "& .MuiOutlinedInput-notchedOutline": {
                borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
              },
              "&:hover .MuiOutlinedInput-notchedOutline": {
                borderColor: PAPYRUS_COLOR_TOKENS.surface.outline,
              },
              "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                borderWidth: 2,
                borderColor: PAPYRUS_COLOR_TOKENS.primary.main,
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
              border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
              borderRadius: PAPYRUS_SHAPE_TOKENS.lg,
            },
          },
        },
        MuiTable: {
          defaultProps: {
            size: PAPYRUS_DENSITY_TOKENS.tableSize,
          },
        },
        MuiTableCell: {
          styleOverrides: {
            root: {
              paddingBlock: PAPYRUS_SPACING_TOKENS.compactCellPaddingY,
              paddingInline: PAPYRUS_SPACING_TOKENS.compactCellPaddingX,
              borderBottomColor: PAPYRUS_COLOR_TOKENS.surface.divider,
            },
            head: {
              backgroundColor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
              color: PAPYRUS_COLOR_TOKENS.text.secondary,
              fontWeight: 600,
            },
          },
        },
        MuiChip: {
          styleOverrides: {
            root: {
              borderRadius: PAPYRUS_SHAPE_TOKENS.sm,
              fontWeight: 500,
            },
          },
        },
        MuiToolbar: {
          styleOverrides: {
            root: {
              minHeight: PAPYRUS_DENSITY_TOKENS.toolbarMinHeight,
            },
          },
        },
      },
    },
    resolveMuiLocale(locale),
  );
}

export const papyrusTheme = createPapyrusTheme();
