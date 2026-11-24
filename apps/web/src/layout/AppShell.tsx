import { Box, Link, Toolbar } from "@mui/material";
import { useState } from "react";
import { Outlet } from "react-router-dom";
import { useI18n } from "../i18n/index.js";
import { AppHeader } from "./AppHeader.js";
import { AppSidebar } from "./AppSidebar.js";

export function AppShell() {
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      <Link
        href="#main-content"
        sx={{
          position: "absolute",
          left: -9999,
          top: 8,
          zIndex: (theme) => theme.zIndex.tooltip,
          px: 2,
          py: 1,
          bgcolor: "primary.main",
          color: "primary.contrastText",
          borderRadius: 1,
          "&:focus": {
            left: 8,
          },
        }}
      >
        {t("shell.skipToMain")}
      </Link>

      <AppHeader
        desktopCollapsed={desktopCollapsed}
        onToggleMobileMenu={() => setMobileOpen((prev) => !prev)}
        onToggleDesktopSidebar={() => setDesktopCollapsed((prev) => !prev)}
      />

      <AppSidebar
        mobileOpen={mobileOpen}
        desktopCollapsed={desktopCollapsed}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <Box
        component="main"
        id="main-content"
        tabIndex={-1}
        sx={{
          flexGrow: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Toolbar />
        <Box sx={{ flex: 1, p: { xs: 2, md: 3 } }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
