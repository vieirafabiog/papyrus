import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import DnsOutlinedIcon from "@mui/icons-material/DnsOutlined";
import ErrorOutlineOutlinedIcon from "@mui/icons-material/ErrorOutlineOutlined";
import MonitorHeartOutlinedIcon from "@mui/icons-material/MonitorHeartOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import SettingsEthernetOutlinedIcon from "@mui/icons-material/SettingsEthernetOutlined";
import StarOutlineOutlinedIcon from "@mui/icons-material/StarOutlineOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Grid,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type { OperationalDependencyStateContract } from "@papyrus/contracts";
import { EmptyState, ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { Link as RouterLink } from "react-router-dom";
import { useSessionQuery } from "../../app/session.js";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import { canViewSystemStatus, useSystemStatusQuery } from "./useSystemStatus.js";

const DEPENDENCY_BADGE_CONFIG: Readonly<
  Record<
    OperationalDependencyStateContract,
    {
      readonly labelKey: MessageKey;
      readonly color: "success" | "error" | "warning";
    }
  >
> = {
  ok: { labelKey: "admin.systemStatus.dependency.ok", color: "success" },
  degraded: { labelKey: "admin.systemStatus.dependency.degraded", color: "error" },
  unavailable: { labelKey: "admin.systemStatus.dependency.unavailable", color: "warning" },
};

const STORAGE_STATUS_BADGE_CONFIG: Readonly<
  Record<
    string,
    {
      readonly labelKey: MessageKey;
      readonly color: "success" | "default" | "error";
    }
  >
> = {
  ACTIVE: { labelKey: "admin.storage.status.ACTIVE", color: "success" },
  INACTIVE: { labelKey: "admin.storage.status.INACTIVE", color: "default" },
  ERROR: { labelKey: "admin.storage.status.ERROR", color: "error" },
};

const STORAGE_KIND_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  local: "admin.storage.kind.local",
  s3: "admin.storage.kind.s3",
  azure_blob: "admin.storage.kind.azure_blob",
  google_cloud: "admin.storage.kind.google_cloud",
};

function renderStatusIcon(state: OperationalDependencyStateContract) {
  if (state === "ok") {
    return <CheckCircleOutlineOutlinedIcon color="success" fontSize="small" />;
  }
  if (state === "degraded") {
    return <ErrorOutlineOutlinedIcon color="error" fontSize="small" />;
  }
  return <WarningAmberOutlinedIcon color="warning" fontSize="small" />;
}

/**
 * Administrative operational status page showing live verified health of database,
 * background services, and configured storage connections along with last verification time.
 */
export function SystemStatusPage() {
  const { t, formatDateTime } = useI18n();
  const sessionQuery = useSessionQuery();
  const hasStatusAccess = canViewSystemStatus(sessionQuery.data);
  const statusQuery = useSystemStatusQuery(hasStatusAccess);

  if (sessionQuery.isLoading) {
    return <LoadingState message={t("admin.systemStatus.loadingPermissions")} />;
  }

  if (sessionQuery.isError) {
    return (
      <ErrorState
        title={t("admin.common.sessionErrorTitle")}
        description={sessionQuery.error.message}
        onRetry={() => void sessionQuery.refetch()}
      />
    );
  }

  if (!hasStatusAccess) {
    return (
      <ErrorState
        title={t("admin.common.restrictedAccessTitle")}
        description={t("admin.systemStatus.noAccessDescription")}
      />
    );
  }

  if (statusQuery.isLoading) {
    return <LoadingState message={t("admin.systemStatus.loadingReport")} />;
  }

  if (statusQuery.isError) {
    return (
      <ErrorState
        title={t("admin.systemStatus.loadErrorTitle")}
        description={statusQuery.error.message}
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }

  const report = statusQuery.data;
  if (!report) {
    return (
      <ErrorState
        title={t("admin.systemStatus.unavailableTitle")}
        description={t("admin.systemStatus.unavailableDescription")}
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }

  const componentsList = [
    {
      key: "database" as const,
      title: t("admin.systemStatus.components.database"),
      icon: <DnsOutlinedIcon color="primary" />,
      data: report.components.database,
    },
    {
      key: "worker" as const,
      title: t("admin.systemStatus.components.backgroundServices"),
      icon: <SettingsEthernetOutlinedIcon color="primary" />,
      data: report.components.worker,
    },
  ] as const;

  const formatCheckedTime = (isoValue: string | null): string =>
    formatDateTime(isoValue, t("admin.common.neverChecked"));

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <MonitorHeartOutlinedIcon color="primary" fontSize="large" />
          <Box>
            <Typography variant="h4" fontWeight={700}>
              {t("admin.systemStatus.title")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("admin.systemStatus.subtitle")}
            </Typography>
          </Box>
        </Stack>

        <Button
          variant="contained"
          startIcon={<RefreshOutlinedIcon />}
          disabled={statusQuery.isFetching}
          onClick={() => void statusQuery.refetch()}
        >
          {statusQuery.isFetching
            ? t("admin.systemStatus.refreshing")
            : t("admin.systemStatus.refresh")}
        </Button>
      </Stack>

      <Alert severity={report.overallStatus === "healthy" ? "success" : "warning"}>
        {report.overallStatus === "healthy"
          ? t("admin.systemStatus.overallHealthy")
          : t("admin.systemStatus.overallAttention")}{" "}
        {t("admin.systemStatus.lastCheckedLabel")}{" "}
        <strong>{formatCheckedTime(report.checkedAt)}</strong>
      </Alert>

      <Grid container spacing={2}>
        {componentsList.map(({ key, title, icon, data }) => {
          const badge = DEPENDENCY_BADGE_CONFIG[data.status];
          return (
            <Grid key={key} size={{ xs: 12, md: 6 }}>
              <Paper
                variant="outlined"
                sx={{
                  p: 2.5,
                  height: "100%",
                  borderRadius: 3,
                  borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
                  backgroundColor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                }}
              >
                <Stack spacing={1.5}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Stack direction="row" spacing={1} alignItems="center">
                      {icon}
                      <Typography variant="subtitle1" fontWeight={600}>
                        {title}
                      </Typography>
                    </Stack>
                    <Chip
                      icon={renderStatusIcon(data.status)}
                      label={t(badge.labelKey)}
                      color={badge.color}
                      size="small"
                      variant="outlined"
                    />
                  </Stack>

                  <Typography variant="body2" color="text.secondary">
                    {data.message}
                  </Typography>

                  <Typography variant="caption" color="text.secondary">
                    {t("admin.systemStatus.checkedAt", {
                      time: formatCheckedTime(data.checkedAt),
                    })}
                  </Typography>
                </Stack>
              </Paper>
            </Grid>
          );
        })}
      </Grid>

      <Paper
        variant="outlined"
        sx={{
          p: 3,
          borderRadius: 3,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
          backgroundColor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack spacing={2}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="space-between"
            alignItems={{ xs: "flex-start", sm: "center" }}
            spacing={1}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <StorageOutlinedIcon color="primary" />
              <Box>
                <Typography variant="h6" fontWeight={600}>
                  {t("admin.systemStatus.storageTitle")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("admin.systemStatus.storageSubtitle")}
                </Typography>
              </Box>
            </Stack>

            <Button component={RouterLink} to="/admin/storage" size="small" variant="outlined">
              {t("admin.systemStatus.manageConnections")}
            </Button>
          </Stack>

          {report.storageConnections.length === 0 ? (
            <EmptyState
              title={t("admin.storage.emptyConnectionsTitle")}
              description={t("admin.storage.emptyConnectionsDescription")}
            />
          ) : (
            <TableContainer>
              <Table aria-label={t("admin.systemStatus.tableAria")}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t("admin.systemStatus.colConnection")}</TableCell>
                    <TableCell>{t("admin.systemStatus.colType")}</TableCell>
                    <TableCell>{t("admin.systemStatus.colStatus")}</TableCell>
                    <TableCell>{t("admin.systemStatus.colLastChecked")}</TableCell>
                    <TableCell>{t("admin.systemStatus.colResult")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {report.storageConnections.map((conn) => {
                    const statusConfig = STORAGE_STATUS_BADGE_CONFIG[conn.status];
                    const statusLabel = statusConfig ? t(statusConfig.labelKey) : conn.status;
                    const statusColor = statusConfig ? statusConfig.color : ("default" as const);
                    const kindKey = STORAGE_KIND_LABEL_KEYS[conn.kind];
                    const kindLabel = kindKey ? t(kindKey) : conn.kind;
                    return (
                      <TableRow key={conn.id} hover>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="body2" fontWeight={600}>
                              {conn.name}
                            </Typography>
                            {conn.isDefault ? (
                              <Chip
                                label={t("admin.common.defaultBadge")}
                                size="small"
                                color="primary"
                                icon={<StarOutlineOutlinedIcon />}
                              />
                            ) : null}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip label={kindLabel} size="small" variant="outlined" />
                        </TableCell>
                        <TableCell>
                          <Chip label={statusLabel} color={statusColor} size="small" />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {formatCheckedTime(conn.lastHealthCheckAt)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {conn.lastHealthMessage ?? "—"}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
