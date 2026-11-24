import type {
  AuditEventRecord,
  AuditExportFormat,
  AuditResult,
  AuthMeResponse,
} from "@docuflow/contracts";
import {
  DataTable,
  type DataTableColumn,
  ErrorState,
  LoadingState,
  PAPYRUS_COLOR_TOKENS,
} from "@docuflow/ui";
import ClearOutlinedIcon from "@mui/icons-material/ClearOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import HistoryEduOutlinedIcon from "@mui/icons-material/HistoryEduOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useSessionQuery } from "../../app/session.js";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import {
  type AuditFiltersState,
  DEFAULT_AUDIT_FILTERS,
  downloadAuthorizedAuditExport,
  hasInvalidAuditPeriod,
  useAuditEventsQuery,
  useAuditFacetsQuery,
} from "./useAuditEvents.js";

const RESULT_BADGE_CONFIG: Readonly<
  Record<
    AuditResult,
    { readonly labelKey: MessageKey; readonly color: "success" | "warning" | "error" }
  >
> = {
  SUCCESS: { labelKey: "audit.result.SUCCESS", color: "success" },
  DENIED: { labelKey: "audit.result.DENIED", color: "warning" },
  FAILURE: { labelKey: "audit.result.FAILURE", color: "error" },
};

const ACTION_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  AUTH_LOGIN_SUCCEEDED: "audit.action.AUTH_LOGIN_SUCCEEDED",
  AUTH_LOGIN_FAILED: "audit.action.AUTH_LOGIN_FAILED",
  AUTH_LOGOUT: "audit.action.AUTH_LOGOUT",
  DOCUMENT_CREATED: "audit.action.DOCUMENT_CREATED",
  DOCUMENT_VIEWED: "audit.action.DOCUMENT_VIEWED",
  DOCUMENT_UPDATED: "audit.action.DOCUMENT_UPDATED",
  DOCUMENT_MOVED: "audit.action.DOCUMENT_MOVED",
  DOCUMENT_ARCHIVED: "audit.action.DOCUMENT_ARCHIVED",
  DOCUMENT_TRASHED: "audit.action.DOCUMENT_TRASHED",
  DOCUMENT_VERSION_CREATED: "audit.action.DOCUMENT_VERSION_CREATED",
  DOCUMENT_VERSION_RESTORED: "audit.action.DOCUMENT_VERSION_RESTORED",
  DOCUMENT_DOWNLOAD_REQUESTED: "audit.action.DOCUMENT_DOWNLOAD_REQUESTED",
  DOCUMENT_DOWNLOADED: "audit.action.DOCUMENT_DOWNLOADED",
  DOCUMENT_DOWNLOAD_DENIED: "audit.action.DOCUMENT_DOWNLOAD_DENIED",
  DOCUMENT_DOWNLOAD_FAILED: "audit.action.DOCUMENT_DOWNLOAD_FAILED",
  DOCUMENT_PREVIEWED: "audit.action.DOCUMENT_PREVIEWED",
  DOCUMENT_PREVIEW_DENIED: "audit.action.DOCUMENT_PREVIEW_DENIED",
  PERMISSION_ASSIGNED: "audit.action.PERMISSION_ASSIGNED",
  PERMISSION_REVOKED: "audit.action.PERMISSION_REVOKED",
  AUTHORIZATION_DENIED: "audit.action.AUTHORIZATION_DENIED",
  WORKFLOW_STARTED: "audit.action.WORKFLOW_STARTED",
  WORKFLOW_TASK_CREATED: "audit.action.WORKFLOW_TASK_CREATED",
  WORKFLOW_TASK_DECIDED: "audit.action.WORKFLOW_TASK_DECIDED",
  WORKFLOW_TASK_CANCELLED: "audit.action.WORKFLOW_TASK_CANCELLED",
  AUDIT_EXPORTED: "audit.action.AUDIT_EXPORTED",
  AUDIT_EXPORT_DENIED: "audit.action.AUDIT_EXPORT_DENIED",
};

const RESOURCE_TYPE_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  DOCUMENT: "audit.resourceType.DOCUMENT",
  FOLDER: "audit.resourceType.FOLDER",
  CATEGORY: "audit.resourceType.CATEGORY",
  WORKFLOW_INSTANCE: "audit.resourceType.WORKFLOW_INSTANCE",
  WORKFLOW_TASK: "audit.resourceType.WORKFLOW_TASK",
  ROLE_SCOPE: "audit.resourceType.ROLE_SCOPE",
  USER: "audit.resourceType.USER",
  GROUP: "audit.resourceType.GROUP",
  STORAGE_CONNECTION: "audit.resourceType.STORAGE_CONNECTION",
  AUDIT: "audit.resourceType.AUDIT",
};

const SERVER_SORTABLE_FIELDS = new Set<string>(["occurredAt", "action", "resourceType", "result"]);

export function hasAuditViewPermission(session: AuthMeResponse | null | undefined): boolean {
  if (!session) {
    return false;
  }
  const hasAdminRole = session.roles.some((role) => role.key === "admin");
  const hasViewAuditPerm = session.permissions.some(
    (perm) => perm.action === "VIEW_AUDIT" && perm.resource === "AUDIT",
  );
  return hasAdminRole || hasViewAuditPerm;
}

/**
 * Authorized audit log explorer with server-side filters (actor user, action,
 * resource type, result, and period), details dialog, and authorized CSV/JSON export.
 */
export function AuditPage() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const sessionQuery = useSessionQuery();
  const canViewAudit = hasAuditViewPermission(sessionQuery.data);

  const [filters, setFilters] = useState<AuditFiltersState>(DEFAULT_AUDIT_FILTERS);
  const [selectedEvent, setSelectedEvent] = useState<AuditEventRecord | null>(null);
  const [exportingFormat, setExportingFormat] = useState<AuditExportFormat | null>(null);
  const [exportFeedback, setExportFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const invalidPeriod = hasInvalidAuditPeriod(filters);
  const eventsQuery = useAuditEventsQuery(filters, canViewAudit);
  const facetsQuery = useAuditFacetsQuery(canViewAudit);

  const actionOptions = useMemo(() => {
    const merged = new Set<string>(facetsQuery.data?.actions ?? []);
    if (filters.action.length > 0) {
      merged.add(filters.action);
    }
    return Array.from(merged).sort();
  }, [facetsQuery.data?.actions, filters.action]);

  const resourceTypeOptions = useMemo(() => {
    const merged = new Set<string>(facetsQuery.data?.resourceTypes ?? []);
    if (filters.resourceType.length > 0) {
      merged.add(filters.resourceType);
    }
    return Array.from(merged).sort();
  }, [facetsQuery.data?.resourceTypes, filters.resourceType]);

  const formatActorLabel = (event: AuditEventRecord): string => {
    if (event.actorName && event.actorEmail) {
      return `${event.actorName} (${event.actorEmail})`;
    }
    if (event.actorName) {
      return event.actorName;
    }
    if (event.actorUserId) {
      return event.actorUserId;
    }
    return t("audit.actor.system");
  };

  const formatActionLabel = (action: string): string => {
    const key = ACTION_LABEL_KEYS[action];
    return key ? t(key) : action;
  };

  const formatResourceTypeLabel = (resourceType: string): string => {
    const key = RESOURCE_TYPE_LABEL_KEYS[resourceType];
    return key ? t(key) : resourceType;
  };

  const updateFilters = (patch: Partial<AuditFiltersState>): void => {
    setFilters((prev) => ({
      ...prev,
      ...patch,
    }));
  };

  const clearFilters = (): void => {
    setFilters((prev) => ({
      ...DEFAULT_AUDIT_FILTERS,
      pageSize: prev.pageSize,
    }));
  };

  const hasActiveFilters =
    filters.actorUserId.length > 0 ||
    filters.action.length > 0 ||
    filters.resourceType.length > 0 ||
    filters.result.length > 0 ||
    filters.from.length > 0 ||
    filters.to.length > 0;

  const handleExport = async (format: AuditExportFormat): Promise<void> => {
    if (!canViewAudit || invalidPeriod) {
      return;
    }
    setExportFeedback(null);
    setExportingFormat(format);
    try {
      const fileName = await downloadAuthorizedAuditExport(filters, format);
      setExportFeedback({
        severity: "success",
        message: t("audit.feedback.exported", { fileName }),
      });
    } catch (err) {
      setExportFeedback({
        severity: "error",
        message: err instanceof Error ? err.message : t("audit.errors.exportFailed"),
      });
    } finally {
      setExportingFormat(null);
    }
  };

  if (sessionQuery.isPending) {
    return <LoadingState message={t("audit.loadingPermissions")} />;
  }

  if (sessionQuery.isError) {
    return (
      <ErrorState
        title={t("audit.sessionErrorTitle")}
        description={sessionQuery.error.message}
        onRetry={() => void sessionQuery.refetch()}
      />
    );
  }

  if (!canViewAudit) {
    return (
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center">
          <HistoryEduOutlinedIcon color="action" fontSize="small" />
          <Typography variant="h1">{t("audit.title")}</Typography>
        </Stack>
        <ErrorState title={t("audit.noAccessTitle")} description={t("audit.noAccessDescription")} />
      </Stack>
    );
  }

  const columns: readonly DataTableColumn<AuditEventRecord>[] = [
    {
      id: "occurredAt",
      label: t("audit.table.occurredAt"),
      sortable: true,
      width: 185,
      render: (row) => (
        <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {formatDateTime(row.occurredAt)}
        </Typography>
      ),
    },
    {
      id: "actor",
      label: t("audit.table.user"),
      render: (row) => (
        <Box>
          <Typography variant="body2" fontWeight={500}>
            {row.actorName ??
              (row.actorUserId ? row.actorUserId.slice(0, 8) : t("audit.actor.system"))}
          </Typography>
          {row.actorEmail ? (
            <Typography variant="caption" color="text.secondary">
              {row.actorEmail}
            </Typography>
          ) : null}
        </Box>
      ),
    },
    {
      id: "action",
      label: t("audit.table.action"),
      sortable: true,
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {formatActionLabel(row.action)}
        </Typography>
      ),
    },
    {
      id: "resourceType",
      label: t("audit.table.resource"),
      sortable: true,
      render: (row) => (
        <Box>
          <Typography variant="body2">{formatResourceTypeLabel(row.resourceType)}</Typography>
          {row.resourceId ? (
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
              {row.resourceId}
            </Typography>
          ) : null}
        </Box>
      ),
    },
    {
      id: "result",
      label: t("audit.table.result"),
      sortable: true,
      width: 120,
      render: (row) => {
        const badge = RESULT_BADGE_CONFIG[row.result];
        return <Chip size="small" label={t(badge.labelKey)} color={badge.color} />;
      },
    },
    {
      id: "details",
      label: t("audit.table.details"),
      align: "right",
      width: 130,
      render: (row) => (
        <Button
          size="small"
          variant="text"
          startIcon={<VisibilityOutlinedIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            setSelectedEvent(row);
          }}
        >
          {t("audit.actions.details")}
        </Button>
      ),
    },
  ];

  const data = eventsQuery.data;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", md: "center" }}
        spacing={2}
      >
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <HistoryEduOutlinedIcon color="primary" fontSize="small" />
            <Typography variant="h1">{t("audit.title")}</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {t("audit.subtitle")}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshOutlinedIcon />}
            disabled={eventsQuery.isFetching}
            onClick={() => void eventsQuery.refetch()}
          >
            {t("audit.actions.refresh")}
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            disabled={exportingFormat !== null || invalidPeriod}
            onClick={() => void handleExport("csv")}
          >
            {exportingFormat === "csv"
              ? t("audit.actions.exportingCsv")
              : t("audit.actions.exportCsv")}
          </Button>
          <Button
            variant="contained"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            disabled={exportingFormat !== null || invalidPeriod}
            onClick={() => void handleExport("json")}
          >
            {exportingFormat === "json"
              ? t("audit.actions.exportingJson")
              : t("audit.actions.exportJson")}
          </Button>
        </Stack>
      </Stack>

      {exportFeedback ? (
        <Alert severity={exportFeedback.severity} onClose={() => setExportFeedback(null)}>
          {exportFeedback.message}
        </Alert>
      ) : null}

      <Paper sx={{ p: 2, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
        <Stack spacing={1.5}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.5}
            alignItems={{ xs: "stretch", md: "center" }}
            flexWrap="wrap"
            useFlexGap
          >
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="audit-filter-actor-label">{t("audit.filters.user")}</InputLabel>
              <Select
                labelId="audit-filter-actor-label"
                id="audit-filter-actor"
                value={filters.actorUserId}
                label={t("audit.filters.user")}
                onChange={(event) =>
                  updateFilters({ actorUserId: String(event.target.value), page: 1 })
                }
              >
                <MenuItem value="">{t("audit.filters.allUsers")}</MenuItem>
                {(facetsQuery.data?.actors ?? []).map((actor) => (
                  <MenuItem key={actor.id} value={actor.id}>
                    {actor.fullName} ({actor.email})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 210 }}>
              <InputLabel id="audit-filter-action-label">{t("audit.filters.action")}</InputLabel>
              <Select
                labelId="audit-filter-action-label"
                id="audit-filter-action"
                value={filters.action}
                label={t("audit.filters.action")}
                onChange={(event) => updateFilters({ action: String(event.target.value), page: 1 })}
              >
                <MenuItem value="">{t("audit.filters.allActions")}</MenuItem>
                {actionOptions.map((action) => (
                  <MenuItem key={action} value={action}>
                    {formatActionLabel(action)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel id="audit-filter-resource-label">
                {t("audit.filters.resource")}
              </InputLabel>
              <Select
                labelId="audit-filter-resource-label"
                id="audit-filter-resource"
                value={filters.resourceType}
                label={t("audit.filters.resource")}
                onChange={(event) =>
                  updateFilters({ resourceType: String(event.target.value), page: 1 })
                }
              >
                <MenuItem value="">{t("audit.filters.allResources")}</MenuItem>
                {resourceTypeOptions.map((resourceType) => (
                  <MenuItem key={resourceType} value={resourceType}>
                    {formatResourceTypeLabel(resourceType)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="audit-filter-result-label">{t("audit.filters.result")}</InputLabel>
              <Select
                labelId="audit-filter-result-label"
                id="audit-filter-result"
                value={filters.result}
                label={t("audit.filters.result")}
                onChange={(event) =>
                  updateFilters({
                    result: String(event.target.value) as AuditResult | "",
                    page: 1,
                  })
                }
              >
                <MenuItem value="">{t("audit.filters.allResults")}</MenuItem>
                <MenuItem value="SUCCESS">{t("audit.result.SUCCESS")}</MenuItem>
                <MenuItem value="DENIED">{t("audit.result.DENIED")}</MenuItem>
                <MenuItem value="FAILURE">{t("audit.result.FAILURE")}</MenuItem>
              </Select>
            </FormControl>

            <TextField
              id="audit-filter-from"
              label={t("audit.filters.fromDate")}
              type="date"
              size="small"
              value={filters.from}
              onChange={(event) => updateFilters({ from: event.target.value, page: 1 })}
              slotProps={{
                inputLabel: { shrink: true },
              }}
            />

            <TextField
              id="audit-filter-to"
              label={t("audit.filters.toDate")}
              type="date"
              size="small"
              value={filters.to}
              onChange={(event) => updateFilters({ to: event.target.value, page: 1 })}
              slotProps={{
                inputLabel: { shrink: true },
              }}
            />

            {hasActiveFilters ? (
              <Button
                variant="text"
                size="small"
                startIcon={<ClearOutlinedIcon fontSize="small" />}
                onClick={clearFilters}
              >
                {t("audit.actions.clearFilters")}
              </Button>
            ) : null}
          </Stack>

          {invalidPeriod ? (
            <Alert severity="error">{t("audit.filters.invalidPeriod")}</Alert>
          ) : null}

          {data ? (
            <Typography variant="caption" color="text.secondary">
              {data.pagination.totalItems === 1
                ? t("audit.count.singular", { count: formatNumber(data.pagination.totalItems) })
                : t("audit.count.plural", { count: formatNumber(data.pagination.totalItems) })}
            </Typography>
          ) : null}
        </Stack>
      </Paper>

      <DataTable
        ariaLabel={t("audit.table.ariaLabel")}
        columns={columns}
        rows={data?.items ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) =>
          t("audit.table.rowLabel", {
            action: formatActionLabel(row.action),
            occurredAt: formatDateTime(row.occurredAt),
          })
        }
        page={data?.pagination.page ?? filters.page}
        pageSize={data?.pagination.pageSize ?? filters.pageSize}
        totalItems={data?.pagination.totalItems ?? 0}
        onPageChange={(nextPage) => updateFilters({ page: nextPage })}
        onPageSizeChange={(nextPageSize) => updateFilters({ pageSize: nextPageSize, page: 1 })}
        sortBy={filters.sortBy}
        sortDirection={filters.sortDirection}
        onSortChange={(field, direction) => {
          if (SERVER_SORTABLE_FIELDS.has(field)) {
            updateFilters({
              sortBy: field as AuditFiltersState["sortBy"],
              sortDirection: direction,
              page: 1,
            });
          }
        }}
        onRowClick={(row) => setSelectedEvent(row)}
        loading={eventsQuery.isPending}
        errorMessage={eventsQuery.isError ? eventsQuery.error.message : null}
        onRetry={() => void eventsQuery.refetch()}
        emptyTitle={
          hasActiveFilters ? t("audit.table.emptyFilteredTitle") : t("audit.table.emptyTitle")
        }
        emptyDescription={
          hasActiveFilters
            ? t("audit.table.emptyFilteredDescription")
            : t("audit.table.emptyDescription")
        }
        {...(hasActiveFilters
          ? { emptyActionLabel: t("audit.actions.clearFilters"), onEmptyAction: clearFilters }
          : {})}
      />

      <Dialog
        open={selectedEvent !== null}
        onClose={() => setSelectedEvent(null)}
        maxWidth="sm"
        fullWidth
        aria-labelledby="audit-event-dialog-title"
      >
        <DialogTitle id="audit-event-dialog-title">{t("audit.dialog.title")}</DialogTitle>
        <DialogContent dividers>
          {selectedEvent ? (
            <Stack spacing={2}>
              <Table size="small" aria-label={t("audit.dialog.tableAria")}>
                <TableBody>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      {t("audit.dialog.eventId")}
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>{selectedEvent.id}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      {t("audit.dialog.occurredAt")}
                    </TableCell>
                    <TableCell>{formatDateTime(selectedEvent.occurredAt)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      {t("audit.dialog.user")}
                    </TableCell>
                    <TableCell>{formatActorLabel(selectedEvent)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      {t("audit.dialog.action")}
                    </TableCell>
                    <TableCell>{formatActionLabel(selectedEvent.action)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      {t("audit.dialog.resource")}
                    </TableCell>
                    <TableCell>
                      {formatResourceTypeLabel(selectedEvent.resourceType)}
                      {selectedEvent.resourceId ? ` — ${selectedEvent.resourceId}` : ""}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      {t("audit.dialog.result")}
                    </TableCell>
                    <TableCell>{t(RESULT_BADGE_CONFIG[selectedEvent.result].labelKey)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      {t("audit.dialog.referenceId")}
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {selectedEvent.requestId}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      {t("audit.dialog.ipAddress")}
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {selectedEvent.ipAddress ?? t("audit.dialog.notProvided")}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>

              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  {t("audit.dialog.additionalDetailsTitle")}
                </Typography>
                {Object.keys(selectedEvent.metadata).length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    {t("audit.dialog.additionalDetailsEmpty")}
                  </Typography>
                ) : (
                  <Table size="small" aria-label={t("audit.dialog.additionalDetailsAria")}>
                    <TableBody>
                      {Object.entries(selectedEvent.metadata).map(([key, value]) => (
                        <TableRow key={key}>
                          <TableCell
                            component="th"
                            scope="row"
                            sx={{ fontFamily: "monospace", fontWeight: 500 }}
                          >
                            {key}
                          </TableCell>
                          <TableCell>{value === null ? "—" : String(value)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Box>
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedEvent(null)}>{t("admin.common.close")}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
