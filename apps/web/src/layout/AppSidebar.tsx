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
import {
  PAPYRUS_COLOR_TOKENS,
  PAPYRUS_DENSITY_TOKENS,
  PAPYRUS_SHAPE_TOKENS,
  PapyrusLogo,
} from "@papyrus/ui";
import type { ReactElement } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";
import { type MessageKey, useI18n } from "../i18n/index.js";

interface NavItem {
  readonly labelKey: MessageKey;
  readonly to: string;
  readonly icon: ReactElement;
}

const PRIMARY_NAV_ITEMS: readonly NavItem[] = [
  { labelKey: "shell.nav.overview", to: "/", icon: <DashboardOutlinedIcon fontSize="small" /> },
  {
    labelKey: "shell.nav.documents",
    to: "/documents",
    icon: <DescriptionOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.trash",
    to: "/trash",
    icon: <DeleteOutlineOutlinedIcon fontSize="small" />,
  },
  { labelKey: "shell.nav.folders", to: "/folders", icon: <FolderOutlinedIcon fontSize="small" /> },
  {
    labelKey: "shell.nav.categories",
    to: "/categories",
    icon: <CategoryOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.tags",
    to: "/tags",
    icon: <LabelOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.workflows",
    to: "/workflows",
    icon: <RuleOutlinedIcon fontSize="small" />,
  },
  { labelKey: "shell.nav.tasks", to: "/tasks", icon: <TaskAltOutlinedIcon fontSize="small" /> },
  {
    labelKey: "shell.nav.expirations",
    to: "/expirations",
    icon: <EventAvailableOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.reports",
    to: "/reports",
    icon: <AssessmentOutlinedIcon fontSize="small" />,
  },
];

const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  {
    labelKey: "shell.nav.usersAndGroups",
    to: "/admin/users",
    icon: <GroupOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.rolesAndPermissions",
    to: "/admin/permissions",
    icon: <SecurityOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.storage",
    to: "/admin/storage",
    icon: <StorageOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.systemStatus",
    to: "/admin/status",
    icon: <MonitorHeartOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.audit",
    to: "/admin/audit",
    icon: <HistoryEduOutlinedIcon fontSize="small" />,
  },
  {
    labelKey: "shell.nav.settings",
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
  const { t } = useI18n();

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
                  primary={t(item.labelKey)}
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
  const { t } = useI18n();
  const location = useLocation();
  const drawerWidth = PAPYRUS_DENSITY_TOKENS.sidebarWidth;

  const drawerContent = (
    <Box
      component="nav"
      aria-label={t("shell.sidebar.navAriaLabel")}
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
          heading={t("shell.sidebar.adminHeading")}
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
