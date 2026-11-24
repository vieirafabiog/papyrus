import { EmptyState, ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@docuflow/ui";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import EventBusyOutlinedIcon from "@mui/icons-material/EventBusyOutlined";
import PendingActionsOutlinedIcon from "@mui/icons-material/PendingActionsOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import SecurityOutlinedIcon from "@mui/icons-material/SecurityOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import {
  Box,
  Button,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import { useDashboardSummary } from "./useDashboardSummary.js";

interface KpiCardProps {
  readonly label: string;
  readonly value: string | number;
  readonly subtitle?: string | undefined;
  readonly icon: ReactNode;
}

const ACTION_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  AUTH_LOGIN_SUCCEEDED: "dashboard.activity.action.AUTH_LOGIN_SUCCEEDED",
  AUTH_LOGIN_FAILED: "dashboard.activity.action.AUTH_LOGIN_FAILED",
  AUTH_LOGOUT: "dashboard.activity.action.AUTH_LOGOUT",
  DOCUMENT_CREATED: "dashboard.activity.action.DOCUMENT_CREATED",
  DOCUMENT_VIEWED: "dashboard.activity.action.DOCUMENT_VIEWED",
  DOCUMENT_UPDATED: "dashboard.activity.action.DOCUMENT_UPDATED",
  DOCUMENT_MOVED: "dashboard.activity.action.DOCUMENT_MOVED",
  DOCUMENT_ARCHIVED: "dashboard.activity.action.DOCUMENT_ARCHIVED",
  DOCUMENT_TRASHED: "dashboard.activity.action.DOCUMENT_TRASHED",
  DOCUMENT_RESTORED: "dashboard.activity.action.DOCUMENT_RESTORED",
  DOCUMENT_DELETED: "dashboard.activity.action.DOCUMENT_DELETED",
  DOCUMENT_VERSION_CREATED: "dashboard.activity.action.DOCUMENT_VERSION_CREATED",
  DOCUMENT_VERSION_RESTORED: "dashboard.activity.action.DOCUMENT_VERSION_RESTORED",
  DOCUMENT_DOWNLOAD_REQUESTED: "dashboard.activity.action.DOCUMENT_DOWNLOAD_REQUESTED",
  DOCUMENT_DOWNLOADED: "dashboard.activity.action.DOCUMENT_DOWNLOADED",
  DOCUMENT_DOWNLOAD_DENIED: "dashboard.activity.action.DOCUMENT_DOWNLOAD_DENIED",
  DOCUMENT_DOWNLOAD_FAILED: "dashboard.activity.action.DOCUMENT_DOWNLOAD_FAILED",
  DOCUMENT_PREVIEWED: "dashboard.activity.action.DOCUMENT_PREVIEWED",
  DOCUMENT_PREVIEW_DENIED: "dashboard.activity.action.DOCUMENT_PREVIEW_DENIED",
  PERMISSION_ASSIGNED: "dashboard.activity.action.PERMISSION_ASSIGNED",
  PERMISSION_REVOKED: "dashboard.activity.action.PERMISSION_REVOKED",
  AUTHORIZATION_DENIED: "dashboard.activity.action.AUTHORIZATION_DENIED",
  WORKFLOW_STARTED: "dashboard.activity.action.WORKFLOW_STARTED",
  WORKFLOW_TASK_CREATED: "dashboard.activity.action.WORKFLOW_TASK_CREATED",
  WORKFLOW_TASK_DECIDED: "dashboard.activity.action.WORKFLOW_TASK_DECIDED",
  WORKFLOW_TASK_CANCELLED: "dashboard.activity.action.WORKFLOW_TASK_CANCELLED",
  AUDIT_EXPORTED: "dashboard.activity.action.AUDIT_EXPORTED",
  AUDIT_EXPORT_DENIED: "dashboard.activity.action.AUDIT_EXPORT_DENIED",
};

const RESOURCE_TYPE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  DOCUMENT: "dashboard.activity.resource.DOCUMENT",
  FOLDER: "dashboard.activity.resource.FOLDER",
  CATEGORY: "dashboard.activity.resource.CATEGORY",
  WORKFLOW_INSTANCE: "dashboard.activity.resource.WORKFLOW_INSTANCE",
  WORKFLOW_TASK: "dashboard.activity.resource.WORKFLOW_TASK",
  ROLE_SCOPE: "dashboard.activity.resource.ROLE_SCOPE",
  USER: "dashboard.activity.resource.USER",
  GROUP: "dashboard.activity.resource.GROUP",
  STORAGE_CONNECTION: "dashboard.activity.resource.STORAGE_CONNECTION",
  AUDIT: "dashboard.activity.resource.AUDIT",
};

function formatFallbackToken(rawToken: string): string {
  const words = rawToken.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) {
    return rawToken;
  }
  const [first, ...rest] = words;
  return [first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}` : "", ...rest].join(" ");
}

function KpiSummaryItem({ label, value, subtitle, icon }: KpiCardProps) {
  return (
    <Paper
      sx={{
        p: 2.5,
        flex: "1 1 200px",
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Box sx={{ color: "text.secondary", display: "flex", alignItems: "center" }}>{icon}</Box>
      </Stack>
      <Typography variant="h2" component="p" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </Typography>
      {subtitle ? (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {subtitle}
        </Typography>
      ) : null}
    </Paper>
  );
}

export function DashboardPage() {
  const { t, formatDateTime, formatBytes, formatNumber } = useI18n();
  const navigate = useNavigate();
  const { data, isPending, isFetching, isError, error, refetch } = useDashboardSummary();

  const hasNoSummaryData =
    data === null ||
    (data !== undefined &&
      data.totalDocuments === 0 &&
      data.pendingTasks === 0 &&
      data.expiringSoonDocuments === 0 &&
      data.quarantinedFiles === 0 &&
      data.storageUsedBytes === 0 &&
      data.storageFileCount === 0 &&
      data.recentActivity.length === 0);

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
      >
        <Box>
          <Typography variant="h1" gutterBottom>
            {t("dashboard.title")}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t("dashboard.subtitle")}
          </Typography>
        </Box>
        {data !== undefined && data !== null ? (
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RefreshOutlinedIcon />}
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {isFetching ? t("dashboard.refreshing") : t("dashboard.refresh")}
            </Button>
            <Button variant="contained" size="small" onClick={() => navigate("/documents")}>
              {t("dashboard.viewDocuments")}
            </Button>
          </Stack>
        ) : null}
      </Stack>

      {isPending ? (
        <LoadingState message={t("dashboard.loading")} />
      ) : isError ? (
        <ErrorState description={error.message} onRetry={() => void refetch()} />
      ) : hasNoSummaryData ? (
        <EmptyState
          title={t("dashboard.emptyTitle")}
          description={t("dashboard.emptyDescription")}
          actionLabel={t("dashboard.emptyAction")}
          onAction={() => navigate("/documents")}
        />
      ) : data ? (
        <Stack spacing={3}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
            <KpiSummaryItem
              label={t("dashboard.kpi.totalDocuments")}
              value={formatNumber(data.totalDocuments)}
              icon={<DescriptionOutlinedIcon fontSize="small" />}
            />
            <KpiSummaryItem
              label={t("dashboard.kpi.pendingTasks")}
              value={formatNumber(data.pendingTasks)}
              icon={<PendingActionsOutlinedIcon fontSize="small" />}
            />
            <KpiSummaryItem
              label={t("dashboard.kpi.expiringSoon")}
              value={formatNumber(data.expiringSoonDocuments)}
              subtitle={t("dashboard.kpi.expiringSoonSubtitle")}
              icon={<EventBusyOutlinedIcon fontSize="small" />}
            />
            <KpiSummaryItem
              label={t("dashboard.kpi.quarantinedFiles")}
              value={formatNumber(data.quarantinedFiles)}
              icon={<SecurityOutlinedIcon fontSize="small" />}
            />
            <KpiSummaryItem
              label={t("dashboard.kpi.storageUsed")}
              value={formatBytes(data.storageUsedBytes)}
              subtitle={t(
                data.storageFileCount === 1
                  ? "dashboard.kpi.activeFileSingular"
                  : "dashboard.kpi.activeFilePlural",
                { count: formatNumber(data.storageFileCount) },
              )}
              icon={<StorageOutlinedIcon fontSize="small" />}
            />
          </Box>

          <Paper sx={{ p: 2.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
            <Typography variant="h3" component="h2" gutterBottom>
              {t("dashboard.recentActivity.title")}
            </Typography>
            {data.recentActivity.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("dashboard.recentActivity.empty")}
              </Typography>
            ) : (
              <List dense disablePadding>
                {data.recentActivity.map((item) => {
                  const isNavigableDoc =
                    item.resourceType === "DOCUMENT" && item.resourceId !== null;
                  const occurredLabel = formatDateTime(item.occurredAt);
                  const actionKey = ACTION_LABEL_KEYS[item.action];
                  const resourceKey = RESOURCE_TYPE_LABEL_KEYS[item.resourceType];
                  const actionLabel = actionKey ? t(actionKey) : formatFallbackToken(item.action);
                  const resourceLabel = resourceKey
                    ? t(resourceKey)
                    : formatFallbackToken(item.resourceType);
                  const titleLabel = t("dashboard.recentActivity.itemFormat", {
                    action: actionLabel,
                    resource: resourceLabel,
                  });

                  if (isNavigableDoc && item.resourceId) {
                    const targetId = item.resourceId;
                    return (
                      <ListItem key={item.id} divider disablePadding>
                        <ListItemButton onClick={() => navigate(`/documents/${targetId}`)}>
                          <ListItemText primary={titleLabel} secondary={occurredLabel} />
                        </ListItemButton>
                      </ListItem>
                    );
                  }

                  return (
                    <ListItem key={item.id} divider disableGutters>
                      <ListItemText primary={titleLabel} secondary={occurredLabel} />
                    </ListItem>
                  );
                })}
              </List>
            )}
          </Paper>
        </Stack>
      ) : null}
    </Stack>
  );
}
