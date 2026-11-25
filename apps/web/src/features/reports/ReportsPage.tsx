import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import EventBusyOutlinedIcon from "@mui/icons-material/EventBusyOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import PendingActionsOutlinedIcon from "@mui/icons-material/PendingActionsOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import {
  Box,
  Button,
  Chip,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import type { DocumentStatus } from "@papyrus/contracts";
import { EmptyState, ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import { useDocumentListCategoriesQuery } from "../documents/useDocumentList.js";
import {
  DEFAULT_REPOSITORY_REPORT_FILTERS,
  type RepositoryReportFilters,
  buildRepositoryReportCsvUrl,
  useRepositoryReportQuery,
} from "./useRepositoryReport.js";

const DOCUMENT_STATUS_META: Readonly<
  Record<
    DocumentStatus,
    {
      readonly key: MessageKey;
      readonly color: "default" | "info" | "success" | "warning" | "error";
    }
  >
> = {
  DRAFT: { key: "workflows.documentStatus.DRAFT", color: "default" },
  IN_REVIEW: { key: "workflows.documentStatus.IN_REVIEW", color: "info" },
  APPROVED: { key: "workflows.documentStatus.APPROVED", color: "success" },
  REJECTED: { key: "workflows.documentStatus.REJECTED", color: "error" },
  ARCHIVED: { key: "workflows.documentStatus.ARCHIVED", color: "default" },
  EXPIRED: { key: "workflows.documentStatus.EXPIRED", color: "warning" },
  DELETED: { key: "workflows.documentStatus.DELETED", color: "error" },
};

const STORAGE_KIND_KEYS: Readonly<Record<string, MessageKey>> = {
  local: "reports.page.byStorage.kinds.local",
  s3: "reports.page.byStorage.kinds.s3",
  sharepoint: "reports.page.byStorage.kinds.sharepoint",
  azure_blob: "reports.page.byStorage.kinds.azure_blob",
  google_cloud: "reports.page.byStorage.kinds.google_cloud",
};

const WINDOW_OPTIONS = [7, 15, 30, 60, 90] as const;

function MetricSummaryCard({
  label,
  value,
  subtitle,
  icon,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly subtitle?: string | undefined;
  readonly icon: ReactNode;
}) {
  return (
    <Paper
      sx={{
        p: 2.25,
        flex: "1 1 190px",
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
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

/**
 * Consolidated document library reporting page (`/reports`) powered by server-side
 * aggregations scoped to the user's authorized documents.
 */
export function ReportsPage() {
  const { t, formatDateTime, formatNumber, formatBytes } = useI18n();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<RepositoryReportFilters>(
    DEFAULT_REPOSITORY_REPORT_FILTERS,
  );

  const categoriesQuery = useDocumentListCategoriesQuery();
  const reportQuery = useRepositoryReportQuery(filters);

  const categories = categoriesQuery.data ?? [];
  const report = reportQuery.data;

  const hasCustomFilter =
    filters.categoryId.length > 0 ||
    filters.status.length > 0 ||
    filters.expirationWindowDays !== DEFAULT_REPOSITORY_REPORT_FILTERS.expirationWindowDays;

  const csvExportUrl = buildRepositoryReportCsvUrl(filters);

  return (
    <Stack spacing={2.5}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
      >
        <Box>
          <Typography variant="h1" gutterBottom>
            {t("reports.page.title")}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t("reports.page.subtitle")}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshOutlinedIcon />}
            disabled={reportQuery.isFetching}
            onClick={() => void reportQuery.refetch()}
          >
            {reportQuery.isFetching ? t("reports.page.refreshing") : t("reports.page.refresh")}
          </Button>
          <Button
            component="a"
            href={csvExportUrl}
            download={t("reports.page.exportFilename")}
            variant="contained"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            disabled={reportQuery.isLoading || reportQuery.isError}
          >
            {t("reports.page.exportCsv")}
          </Button>
        </Stack>
      </Stack>

      <Paper sx={{ p: 2, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          alignItems={{ xs: "stretch", sm: "center" }}
          flexWrap="wrap"
        >
          <TextField
            select
            size="small"
            label={t("reports.page.filters.windowLabel")}
            value={filters.expirationWindowDays}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                expirationWindowDays: Number(event.target.value),
              }))
            }
            sx={{ minWidth: 190 }}
          >
            {WINDOW_OPTIONS.map((days) => (
              <MenuItem key={days} value={days}>
                {t("reports.page.filters.windowOption", { days })}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            size="small"
            label={t("reports.page.filters.categoryLabel")}
            value={filters.categoryId}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, categoryId: event.target.value }))
            }
            sx={{ minWidth: 210 }}
          >
            <MenuItem value="">{t("reports.page.filters.allCategories")}</MenuItem>
            {categories.map((cat) => (
              <MenuItem key={cat.id} value={cat.id}>
                {cat.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            size="small"
            label={t("reports.page.filters.statusLabel")}
            value={filters.status}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, status: event.target.value as DocumentStatus | "" }))
            }
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">{t("reports.page.filters.allActiveStatuses")}</MenuItem>
            {(["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED", "ARCHIVED", "EXPIRED"] as const).map(
              (statusKey) => (
                <MenuItem key={statusKey} value={statusKey}>
                  {t(DOCUMENT_STATUS_META[statusKey].key)}
                </MenuItem>
              ),
            )}
          </TextField>

          {hasCustomFilter ? (
            <Button
              size="small"
              color="inherit"
              onClick={() => setFilters(DEFAULT_REPOSITORY_REPORT_FILTERS)}
            >
              {t("reports.page.filters.clear")}
            </Button>
          ) : null}
        </Stack>
      </Paper>

      {reportQuery.isLoading ? (
        <LoadingState message={t("reports.page.loading")} />
      ) : reportQuery.isError ? (
        <ErrorState
          description={reportQuery.error.message}
          onRetry={() => void reportQuery.refetch()}
        />
      ) : !report || (report.totals.totalDocuments === 0 && !hasCustomFilter) ? (
        <EmptyState
          title={t("reports.page.emptyTitle")}
          description={t("reports.page.emptyDescription")}
          actionLabel={t("reports.page.emptyAction")}
          onAction={() => void navigate("/documents")}
        />
      ) : (
        <Stack spacing={2.5}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
            <MetricSummaryCard
              label={t("reports.page.cards.totalDocuments")}
              value={formatNumber(report.totals.totalDocuments)}
              icon={<DescriptionOutlinedIcon fontSize="small" />}
            />
            <MetricSummaryCard
              label={t("reports.page.cards.storedVersions")}
              value={formatNumber(report.totals.totalVersions)}
              subtitle={t(
                report.totals.totalActiveFiles === 1
                  ? "reports.page.cards.activeFilesSingular"
                  : "reports.page.cards.activeFilesPlural",
                { count: formatNumber(report.totals.totalActiveFiles) },
              )}
              icon={<LayersOutlinedIcon fontSize="small" />}
            />
            <MetricSummaryCard
              label={t("reports.page.cards.storageUsed")}
              value={formatBytes(report.totals.storageUsedBytes)}
              subtitle={t("reports.page.cards.underReview", {
                count: formatNumber(report.totals.quarantinedFiles),
              })}
              icon={<StorageOutlinedIcon fontSize="small" />}
            />
            <MetricSummaryCard
              label={t("reports.page.cards.expiredAndSoon")}
              value={`${formatNumber(report.expirations.expired)} / ${formatNumber(report.expirations.expiringSoon)}`}
              subtitle={t("reports.page.cards.windowDays", {
                days: report.expirations.windowDays,
              })}
              icon={<EventBusyOutlinedIcon fontSize="small" />}
            />
            <MetricSummaryCard
              label={t("reports.page.cards.pendingTasks")}
              value={formatNumber(report.totals.pendingTasks)}
              subtitle={t("reports.page.cards.assignedToYou")}
              icon={<PendingActionsOutlinedIcon fontSize="small" />}
            />
          </Box>

          <Paper sx={{ p: 2.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              justifyContent="space-between"
              alignItems={{ xs: "flex-start", sm: "center" }}
              spacing={1}
              mb={2}
            >
              <Typography variant="h3" component="h2">
                {t("reports.page.expirationsSection.title", {
                  days: report.expirations.windowDays,
                })}
              </Typography>
              <Button size="small" variant="text" onClick={() => void navigate("/expirations")}>
                {t("reports.page.expirationsSection.openPanel")}
              </Button>
            </Stack>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, 1fr)" },
                gap: 2,
              }}
            >
              <Paper
                variant="outlined"
                sx={{ p: 1.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow }}
              >
                <Typography variant="caption" color="error.main" fontWeight={600}>
                  {t("reports.page.expirationsSection.expired")}
                </Typography>
                <Typography variant="h3" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatNumber(report.expirations.expired)}
                </Typography>
              </Paper>
              <Paper
                variant="outlined"
                sx={{ p: 1.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow }}
              >
                <Typography variant="caption" color="warning.main" fontWeight={600}>
                  {t("reports.page.expirationsSection.soon", {
                    days: report.expirations.windowDays,
                  })}
                </Typography>
                <Typography variant="h3" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatNumber(report.expirations.expiringSoon)}
                </Typography>
              </Paper>
              <Paper
                variant="outlined"
                sx={{ p: 1.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow }}
              >
                <Typography variant="caption" color="success.main" fontWeight={600}>
                  {t("reports.page.expirationsSection.onTrack")}
                </Typography>
                <Typography variant="h3" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatNumber(report.expirations.onTrack)}
                </Typography>
              </Paper>
              <Paper
                variant="outlined"
                sx={{ p: 1.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow }}
              >
                <Typography variant="caption" color="text.secondary" fontWeight={600}>
                  {t("reports.page.expirationsSection.withoutDate")}
                </Typography>
                <Typography variant="h3" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatNumber(report.expirations.withoutDate)}
                </Typography>
              </Paper>
            </Box>
          </Paper>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
              gap: 2.5,
            }}
          >
            <Paper sx={{ p: 2.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
              <Typography variant="h3" component="h2" gutterBottom>
                {t("reports.page.byStatus.title")}
              </Typography>
              {report.byStatus.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t("reports.page.byStatus.empty")}
                </Typography>
              ) : (
                <TableContainer>
                  <Table size="small" aria-label={t("reports.page.byStatus.tableAriaLabel")}>
                    <TableHead>
                      <TableRow>
                        <TableCell>{t("reports.page.byStatus.columns.status")}</TableCell>
                        <TableCell align="right">
                          {t("reports.page.byStatus.columns.documents")}
                        </TableCell>
                        <TableCell sx={{ minWidth: 110 }}>
                          {t("reports.page.byStatus.columns.share")}
                        </TableCell>
                        <TableCell align="right">
                          {t("reports.page.byStatus.columns.storage")}
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {report.byStatus.map((row) => {
                        const meta = DOCUMENT_STATUS_META[row.status];
                        const pct =
                          report.totals.totalDocuments > 0
                            ? Math.round((row.documentCount / report.totals.totalDocuments) * 100)
                            : 0;
                        return (
                          <TableRow key={row.status}>
                            <TableCell>
                              <Chip size="small" label={t(meta.key)} color={meta.color} />
                            </TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                              {formatNumber(row.documentCount)}
                            </TableCell>
                            <TableCell>
                              <Stack direction="row" spacing={1} alignItems="center">
                                <LinearProgress
                                  variant="determinate"
                                  value={pct}
                                  sx={{ flex: 1, height: 6, borderRadius: 1 }}
                                />
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{ minWidth: 32, textAlign: "right" }}
                                >
                                  {pct}%
                                </Typography>
                              </Stack>
                            </TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                              {formatBytes(row.storageBytes)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Paper>

            <Paper sx={{ p: 2.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
              <Typography variant="h3" component="h2" gutterBottom>
                {t("reports.page.byStorage.title")}
              </Typography>
              {report.byStorageConnection.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t("reports.page.byStorage.empty")}
                </Typography>
              ) : (
                <TableContainer>
                  <Table size="small" aria-label={t("reports.page.byStorage.tableAriaLabel")}>
                    <TableHead>
                      <TableRow>
                        <TableCell>{t("reports.page.byStorage.columns.connection")}</TableCell>
                        <TableCell>{t("reports.page.byStorage.columns.type")}</TableCell>
                        <TableCell align="right">
                          {t("reports.page.byStorage.columns.files")}
                        </TableCell>
                        <TableCell align="right">
                          {t("reports.page.byStorage.columns.storageUsed")}
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {report.byStorageConnection.map((row) => {
                        const kindKey = STORAGE_KIND_KEYS[row.kind];
                        return (
                          <TableRow key={row.storageConnectionId}>
                            <TableCell>
                              <Typography variant="body2" fontWeight={500}>
                                {row.storageConnectionName}
                              </Typography>
                            </TableCell>
                            <TableCell>{kindKey ? t(kindKey) : row.kind}</TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                              {formatNumber(row.fileCount)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                              {formatBytes(row.storageBytes)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Paper>
          </Box>

          <Paper sx={{ p: 2.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
            <Typography variant="h3" component="h2" gutterBottom>
              {t("reports.page.byCategory.title")}
            </Typography>
            {report.byCategory.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("reports.page.byCategory.empty")}
              </Typography>
            ) : (
              <TableContainer>
                <Table size="small" aria-label={t("reports.page.byCategory.tableAriaLabel")}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t("reports.page.byCategory.columns.category")}</TableCell>
                      <TableCell align="right">
                        {t("reports.page.byCategory.columns.documents")}
                      </TableCell>
                      <TableCell align="right">
                        {t("reports.page.byCategory.columns.versions")}
                      </TableCell>
                      <TableCell align="right">
                        {t("reports.page.byCategory.columns.expired")}
                      </TableCell>
                      <TableCell align="right">
                        {t("reports.page.byCategory.columns.soon", {
                          days: report.expirations.windowDays,
                        })}
                      </TableCell>
                      <TableCell align="right">
                        {t("reports.page.byCategory.columns.storageUsed")}
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {report.byCategory.map((row) => (
                      <TableRow key={row.categoryId} hover>
                        <TableCell>
                          <Typography variant="body2" fontWeight={500}>
                            {row.categoryName}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {formatNumber(row.documentCount)}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {formatNumber(row.versionCount)}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {row.expiredCount > 0 ? (
                            <Chip
                              size="small"
                              color="error"
                              label={formatNumber(row.expiredCount)}
                            />
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {row.expiringSoonCount > 0 ? (
                            <Chip
                              size="small"
                              color="warning"
                              label={formatNumber(row.expiringSoonCount)}
                            />
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {formatBytes(row.storageBytes)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>

          <Typography variant="caption" color="text.secondary">
            {t("reports.page.footer", {
              date: formatDateTime(report.generatedAt),
              timezone: report.timezone,
            })}
          </Typography>
        </Stack>
      )}
    </Stack>
  );
}
