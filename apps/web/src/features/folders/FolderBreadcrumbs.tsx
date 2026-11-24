import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import NavigateNextOutlinedIcon from "@mui/icons-material/NavigateNextOutlined";
import { Breadcrumbs, Chip, Link, Stack, Typography } from "@mui/material";
import { useI18n } from "../../i18n/index.js";
import type { FolderBreadcrumbItem } from "./useFolderNavigation.js";

export interface FolderBreadcrumbsProps {
  readonly items: readonly FolderBreadcrumbItem[];
  readonly onNavigate: (folderId: string | null) => void;
}

/**
 * Renders an accessible Material UI hierarchical breadcrumb trail where each
 * authorized level navigates on click, restricted ancestors are non-navigable,
 * and archived or removed states are clearly labeled.
 */
export function FolderBreadcrumbs({ items, onNavigate }: FolderBreadcrumbsProps) {
  const { t } = useI18n();

  if (items.length === 0) {
    return null;
  }

  return (
    <Breadcrumbs
      aria-label={t("folders.breadcrumbs.ariaLabel")}
      separator={<NavigateNextOutlinedIcon fontSize="small" />}
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        const isRoot = item.id === null;

        if (!item.accessible) {
          return (
            <Stack
              key={`${item.id ?? "restricted"}-${index}`}
              direction="row"
              spacing={0.5}
              alignItems="center"
            >
              <LockOutlinedIcon fontSize="inherit" color="disabled" />
              <Typography variant="body2" color="text.secondary">
                {item.label}
              </Typography>
            </Stack>
          );
        }

        if (isLast) {
          return (
            <Stack
              key={item.id ?? "root-current"}
              direction="row"
              spacing={0.75}
              alignItems="center"
            >
              {isRoot ? <HomeOutlinedIcon fontSize="small" color="action" /> : null}
              <Typography variant="body2" fontWeight={600} color="text.primary" aria-current="page">
                {item.label}
              </Typography>
              {item.status === "ARCHIVED" ? (
                <Chip label={t("folders.status.archived")} size="small" variant="outlined" />
              ) : null}
            </Stack>
          );
        }

        return (
          <Stack key={item.id ?? `root-${index}`} direction="row" spacing={0.5} alignItems="center">
            <Link
              component="button"
              type="button"
              underline="hover"
              color="inherit"
              variant="body2"
              onClick={() => onNavigate(item.id)}
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 0.5,
                cursor: "pointer",
              }}
            >
              {isRoot ? <HomeOutlinedIcon fontSize="small" /> : null}
              <span>{item.label}</span>
            </Link>
            {item.status === "ARCHIVED" ? (
              <Chip label={t("folders.status.archived")} size="small" variant="outlined" />
            ) : null}
          </Stack>
        );
      })}
    </Breadcrumbs>
  );
}
