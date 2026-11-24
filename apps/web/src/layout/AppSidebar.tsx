import {
  PAPYRUS_COLOR_TOKENS,
  PAPYRUS_DENSITY_TOKENS,
  PAPYRUS_SHAPE_TOKENS,
  PapyrusLogo,
} from "@docuflow/ui";
import AssessmentOutlinedIcon from "@mui/icons-material/AssessmentOutlined";
import CategoryOutlinedIcon from "@mui/icons-material/CategoryOutlined";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import EventAvailableOutlinedIcon from "@mui/icons-material/EventAvailableOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import GroupOutlinedIcon from "@mui/icons-material/GroupOutlined";
import HistoryEduOutlinedIcon from "@mui/icons-material/HistoryEduOutlined";
import LabelOutlinedIcon from "@mui/icons-material/LabelOutlined";
import MonitorHeartOutlinedIcon from "@mui/icons-material/MonitorHeartOutlined";
import RuleOutlinedIcon from "@mui/icons-material/RuleOutlined";
import SecurityOutlinedIcon from "@mui/icons-material/SecurityOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import TaskAltOutlinedIcon from "@mui/icons-material/TaskAltOutlined";
import {
  Box,
  Divider,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
} from "@mui/material";
import type { ReactElement } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";

interface NavItem {
  readonly label: string;
  readonly to: string;
  readonly icon: ReactElement;
}

const PRIMARY_NAV_ITEMS: readonly NavItem[] = [
  { label: "Visão geral", to: "/", icon: <DashboardOutlinedIcon fontSize="small" /> },
  { label: "Documentos", to: "/documents", icon: <DescriptionOutlinedIcon fontSize="small" /> },
  { label: "Lixeira", to: "/trash", icon: <DeleteOutlineOutlinedIcon fontSize="small" /> },
  { label: "Pastas", to: "/folders", icon: <FolderOutlinedIcon fontSize="small" /> },
  {
    label: "Categorias e campos",
    to: "/categories",
    icon: <CategoryOutlinedIcon fontSize="small" />,
  },
  {
    label: "Etiquetas",
    to: "/tags",
    icon: <LabelOutlinedIcon fontSize="small" />,
  },
  { label: "Fluxos de aprovação", to: "/workflows", icon: <RuleOutlinedIcon fontSize="small" /> },
  { label: "Minhas tarefas", to: "/tasks", icon: <TaskAltOutlinedIcon fontSize="small" /> },
  {
    label: "Vencimentos",
    to: "/expirations",
    icon: <EventAvailableOutlinedIcon fontSize="small" />,
  },
  { label: "Relatórios", to: "/reports", icon: <AssessmentOutlinedIcon fontSize="small" /> },
];

const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  {
    label: "Usuários e grupos",
    to: "/admin/users",
    icon: <GroupOutlinedIcon fontSize="small" />,
  },
  {
    label: "Papéis e permissões",
    to: "/admin/permissions",
    icon: <SecurityOutlinedIcon fontSize="small" />,
  },
  {
    label: "Armazenamento",
    to: "/admin/storage",
    icon: <StorageOutlinedIcon fontSize="small" />,
  },
  {
    label: "Status operacional",
    to: "/admin/status",
    icon: <MonitorHeartOutlinedIcon fontSize="small" />,
  },
  {
    label: "Auditoria",
    to: "/admin/audit",
    icon: <HistoryEduOutlinedIcon fontSize="small" />,
  },
  {
    label: "Configurações",
    to: "/admin/settings",
    icon: <SettingsOutlinedIcon fontSize="small" />,
  },
];

export interface AppSidebarProps {
  readonly mobileOpen: boolean;
  readonly desktopCollapsed: boolean;
  readonly onCloseMobile: () => void;
}

function SidebarNavSection({
  heading,
  items,
  currentPath,
  onSelectItem,
}: {
  readonly heading?: string;
  readonly items: readonly NavItem[];
  readonly currentPath: string;
  readonly onSelectItem: () => void;
}) {
  return (
    <Box>
      {heading ? (
        <Typography
          variant="caption"
          component="p"
          sx={{
            px: 2,
            pt: 1.5,
            pb: 0.5,
            display: "block",
            color: "text.secondary",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {heading}
        </Typography>
      ) : null}
      <List dense disablePadding sx={{ px: 1 }}>
        {items.map((item) => {
          const isActive = item.to === "/" ? currentPath === "/" : currentPath.startsWith(item.to);
          return (
            <ListItem key={item.to} disablePadding sx={{ mb: 0.25 }}>
              <ListItemButton
                component={RouterLink}
                to={item.to}
                selected={isActive}
                onClick={onSelectItem}
                sx={{
                  borderRadius: `${PAPYRUS_SHAPE_TOKENS.md}px`,
                  "&.Mui-selected": {
                    bgcolor: PAPYRUS_COLOR_TOKENS.primary.container,
                    color: PAPYRUS_COLOR_TOKENS.primary.onContainer,
                    "& .MuiListItemIcon-root": {
                      color: PAPYRUS_COLOR_TOKENS.primary.onContainer,
                    },
                    "&:hover": {
                      bgcolor: PAPYRUS_COLOR_TOKENS.primary.container,
                    },
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 34, color: "text.secondary" }}>
                  {item.icon}
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  primaryTypographyProps={{
                    variant: "body2",
                    fontWeight: isActive ? 600 : 500,
                  }}
                />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
}

export function AppSidebar({ mobileOpen, desktopCollapsed, onCloseMobile }: AppSidebarProps) {
  const location = useLocation();
  const drawerWidth = PAPYRUS_DENSITY_TOKENS.sidebarWidth;

  const drawerContent = (
    <Box
      component="nav"
      aria-label="Navegação principal"
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Toolbar sx={{ px: 2 }}>
        <PapyrusLogo size="sm" />
      </Toolbar>
      <Divider />
      <Box sx={{ flex: 1, overflowY: "auto", py: 1 }}>
        <SidebarNavSection
          items={PRIMARY_NAV_ITEMS}
          currentPath={location.pathname}
          onSelectItem={onCloseMobile}
        />
        <Divider sx={{ my: 1.5 }} />
        <SidebarNavSection
          heading="Administração"
          items={ADMIN_NAV_ITEMS}
          currentPath={location.pathname}
          onSelectItem={onCloseMobile}
        />
      </Box>
    </Box>
  );

  return (
    <Box
      component="aside"
      sx={{
        width: { md: desktopCollapsed ? 0 : drawerWidth },
        flexShrink: { md: 0 },
        transition: "width 150ms ease",
      }}
    >
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={onCloseMobile}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: "block", md: "none" },
          "& .MuiDrawer-paper": {
            width: drawerWidth,
            boxSizing: "border-box",
            borderRadius: 0,
            borderTop: "none",
            borderBottom: "none",
            borderLeft: "none",
          },
        }}
      >
        {drawerContent}
      </Drawer>
      <Drawer
        variant="permanent"
        open={!desktopCollapsed}
        sx={{
          display: { xs: "none", md: desktopCollapsed ? "none" : "block" },
          "& .MuiDrawer-paper": {
            width: drawerWidth,
            boxSizing: "border-box",
            borderRadius: 0,
            borderTop: "none",
            borderBottom: "none",
            borderLeft: "none",
          },
        }}
      >
        {drawerContent}
      </Drawer>
    </Box>
  );
}
