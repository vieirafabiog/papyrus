import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, DOCUFLOW_DENSITY_TOKENS } from "@docuflow/ui";
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
import { useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SESSION_QUERY_KEY, useSessionQuery } from "../app/session.js";

export interface AppHeaderProps {
  readonly desktopCollapsed: boolean;
  readonly onToggleMobileMenu: () => void;
  readonly onToggleDesktopSidebar: () => void;
}

export function AppHeader({
  desktopCollapsed,
  onToggleMobileMenu,
  onToggleDesktopSidebar,
}: AppHeaderProps) {
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
      const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Não foi possível encerrar a sessão.");
      }
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      handleCloseMenu();
      navigate("/login", { replace: true });
    } catch {
      setLogoutError("Erro ao encerrar sessão. Tente novamente.");
    } finally {
      setIsLoggingOut(false);
    }
  };

  const drawerOffset = desktopCollapsed ? 0 : DOCUFLOW_DENSITY_TOKENS.sidebarWidth;

  return (
    <>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{
          width: { md: `calc(100% - ${drawerOffset}px)` },
          ml: { md: `${drawerOffset}px` },
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.paper,
          borderBottom: `1px solid ${DOCUFLOW_COLOR_TOKENS.surface.outlineVariant}`,
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
            aria-label="Abrir menu de navegação"
            sx={{ display: { md: "none" } }}
          >
            <MenuIcon />
          </IconButton>
          <IconButton
            color="inherit"
            edge="start"
            onClick={onToggleDesktopSidebar}
            aria-label={desktopCollapsed ? "Expandir barra lateral" : "Recolher barra lateral"}
            sx={{ display: { xs: "none", md: "inline-flex" } }}
          >
            <MenuIcon />
          </IconButton>

          <Typography variant="subtitle1" component="span" sx={{ flexGrow: 1 }}>
            Gestão Eletrônica de Documentos
          </Typography>

          {session ? (
            <Box>
              <IconButton
                color="inherit"
                onClick={handleOpenMenu}
                aria-label="Perfil do usuário"
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
                <MenuItem
                  onClick={() => void handleLogout()}
                  disabled={isLoggingOut}
                >
                  <ListItemIcon>
                    <LogoutOutlinedIcon fontSize="small" />
                  </ListItemIcon>
                  {isLoggingOut ? "Saindo..." : "Sair"}
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
