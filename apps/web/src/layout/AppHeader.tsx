import AccountCircleOutlinedIcon from "@mui/icons-material/AccountCircleOutlined";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import {
  Alert,
  AppBar,
  Box,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Snackbar,
  Toolbar,
  Typography,
} from "@mui/material";
import { CONTRACTS_API_PREFIX } from "@papyrus/contracts";
import { PAPYRUS_COLOR_TOKENS, PAPYRUS_DENSITY_TOKENS } from "@papyrus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SESSION_QUERY_KEY, useSessionQuery } from "../app/session.js";
import { GlobalSearch } from "../components/GlobalSearch.js";
import { LanguageSwitcher } from "../components/LanguageSwitcher.js";
import { NotificationBell } from "../components/NotificationBell.js";
import { extractUserErrorMessage } from "../i18n/api-errors.js";
import { useI18n } from "../i18n/index.js";

export interface AppHeaderProps {
  readonly desktopCollapsed: boolean;
  readonly onToggleMobileMenu: () => void;
  readonly onToggleDesktopSidebar: () => void;
}

const CSRF_COOKIE_NAME = "papyrus_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
    }
  }
  return null;
}

async function resolveLogoutCsrfToken(): Promise<string | null> {
  const fromCookie = readCookieValue(CSRF_COOKIE_NAME);
  if (fromCookie) {
    return fromCookie;
  }
  try {
    const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/csrf-token`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return readCookieValue(CSRF_COOKIE_NAME);
    }
    const rawJson: unknown = await response.json();
    if (
      typeof rawJson === "object" &&
      rawJson !== null &&
      "data" in rawJson &&
      typeof rawJson.data === "object" &&
      rawJson.data !== null &&
      "csrfToken" in rawJson.data &&
      typeof rawJson.data.csrfToken === "string" &&
      rawJson.data.csrfToken.length > 0
    ) {
      return rawJson.data.csrfToken;
    }
  } catch {
    // Fallback to cookie if dedicated CSRF endpoint is unavailable in tests.
  }
  return readCookieValue(CSRF_COOKIE_NAME);
}

export function AppHeader({
  desktopCollapsed,
  onToggleMobileMenu,
  onToggleDesktopSidebar,
}: AppHeaderProps) {
  const { t, locale } = useI18n();
  const { data: session } = useSessionQuery();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const handleOpenMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    setAnchorEl(event.currentTarget);
  };

  const handleCloseMenu = (): void => {
    setAnchorEl(null);
  };

  const handleLogout = async (): Promise<void> => {
    if (isLoggingOut) {
      return;
    }
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      const csrfToken = await resolveLogoutCsrfToken();
      const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
        },
      });
      if (!response.ok) {
        const errorMessage = await extractUserErrorMessage(
          response,
          "shell.header.signOutError",
          locale,
        );
        setLogoutError(errorMessage);
        return;
      }
      queryClient.clear();
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      handleCloseMenu();
      navigate("/login", { replace: true });
    } catch {
      setLogoutError(t("shell.header.signOutError"));
    } finally {
      setIsLoggingOut(false);
    }
  };

  const drawerOffset = desktopCollapsed ? 0 : PAPYRUS_DENSITY_TOKENS.sidebarWidth;

  return (
    <>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{
          width: { md: `calc(100% - ${drawerOffset}px)` },
          ml: { md: `${drawerOffset}px` },
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.paper,
          borderBottom: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
          borderRadius: 0,
          borderTop: "none",
          borderLeft: "none",
          borderRight: "none",
          transition: "width 150ms ease, margin-left 150ms ease",
        }}
      >
        <Toolbar sx={{ gap: 1 }}>
          <IconButton
            color="inherit"
            edge="start"
            onClick={onToggleMobileMenu}
            aria-label={t("shell.header.openMenu")}
            sx={{ display: { md: "none" } }}
          >
            <MenuIcon />
          </IconButton>
          <IconButton
            color="inherit"
            edge="start"
            onClick={onToggleDesktopSidebar}
            aria-label={
              desktopCollapsed ? t("shell.header.expandSidebar") : t("shell.header.collapseSidebar")
            }
            sx={{ display: { xs: "none", md: "inline-flex" } }}
          >
            <MenuIcon />
          </IconButton>

          <Typography
            variant="subtitle1"
            component="span"
            sx={{ display: { xs: "none", sm: "inline" }, mr: 2 }}
          >
            {t("common.tagline")}
          </Typography>

          <Box sx={{ flexGrow: 1, display: "flex", justifyContent: "flex-end", mr: 1 }}>
            {session ? <GlobalSearch /> : null}
          </Box>

          {session ? <NotificationBell /> : null}

          <LanguageSwitcher />

          {session ? (
            <Box>
              <IconButton
                color="inherit"
                onClick={handleOpenMenu}
                aria-label={t("shell.header.userMenuAriaLabel")}
                aria-controls={anchorEl ? "user-profile-menu" : undefined}
                aria-haspopup="true"
                aria-expanded={anchorEl ? "true" : undefined}
              >
                <AccountCircleOutlinedIcon />
              </IconButton>
              <Menu
                id="user-profile-menu"
                anchorEl={anchorEl}
                open={Boolean(anchorEl)}
                onClose={handleCloseMenu}
                anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                transformOrigin={{ vertical: "top", horizontal: "right" }}
              >
                <Box sx={{ px: 2, py: 1, maxWidth: 260 }}>
                  <Typography variant="subtitle1" noWrap>
                    {session.user.fullName}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {session.user.email}
                  </Typography>
                </Box>
                <MenuItem onClick={() => void handleLogout()} disabled={isLoggingOut}>
                  <ListItemIcon>
                    <LogoutOutlinedIcon fontSize="small" />
                  </ListItemIcon>
                  {isLoggingOut ? t("shell.header.signingOut") : t("shell.header.signOut")}
                </MenuItem>
              </Menu>
            </Box>
          ) : null}
        </Toolbar>
      </AppBar>

      <Snackbar
        open={logoutError !== null}
        autoHideDuration={6000}
        onClose={() => setLogoutError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert severity="error" onClose={() => setLogoutError(null)}>
          {logoutError}
        </Alert>
      </Snackbar>
    </>
  );
}
