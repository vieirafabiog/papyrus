import CheckOutlinedIcon from "@mui/icons-material/CheckOutlined";
import TranslateOutlinedIcon from "@mui/icons-material/TranslateOutlined";
import { Button, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { type MouseEvent, useState } from "react";
import { SUPPORTED_UI_LOCALES, type UiLocale, useI18n } from "../i18n/index.js";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const currentOption =
    SUPPORTED_UI_LOCALES.find((option) => option.code === locale) ?? SUPPORTED_UI_LOCALES[0];

  const handleOpen = (event: MouseEvent<HTMLButtonElement>): void => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = (): void => {
    setAnchorEl(null);
  };

  const handleSelect = (nextLocale: UiLocale): void => {
    setLocale(nextLocale);
    handleClose();
  };

  return (
    <>
      <Button
        color="inherit"
        size="small"
        onClick={handleOpen}
        startIcon={<TranslateOutlinedIcon fontSize="small" />}
        aria-label={t("common.language.ariaLabel")}
        aria-controls={anchorEl ? "language-switcher-menu" : undefined}
        aria-haspopup="menu"
        aria-expanded={anchorEl ? "true" : undefined}
        sx={{
          minWidth: 0,
          px: 1.25,
          color: "text.secondary",
          fontWeight: 600,
        }}
      >
        {currentOption?.shortLabel ?? "EN"}
      </Button>

      <Menu
        id="language-switcher-menu"
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {SUPPORTED_UI_LOCALES.map((option) => {
          const isSelected = option.code === locale;
          return (
            <MenuItem
              key={option.code}
              selected={isSelected}
              onClick={() => handleSelect(option.code)}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                {isSelected ? <CheckOutlinedIcon fontSize="small" color="primary" /> : null}
              </ListItemIcon>
              <ListItemText primary={option.nativeLabel} />
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
