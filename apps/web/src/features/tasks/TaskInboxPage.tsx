import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import PendingActionsOutlinedIcon from "@mui/icons-material/PendingActionsOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  Box,
  Button,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import type { DocumentStatus, TaskInboxItem, WorkflowTaskStatus } from "@papyrus/contracts";
import { DataTable, type DataTableColumn, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import {
  DEFAULT_TASK_INBOX_FILTERS,
  type TaskAssigneeFilterType,
  type TaskInboxFiltersState,
  type TaskInboxSortField,
  resolveTaskDocumentTarget,
  useTaskInboxCountsQuery,
  useTaskInboxQuery,
} from "./useTaskInbox.js";

const TASK_STATUS_BADGE: Readonly<
  Record<
    WorkflowTaskStatus,
    {
      readonly key: MessageKey;
      readonly color: "default" | "info" | "success" | "warning" | "error";
    }
  >
> = {
  PENDING: { key: "workflows.taskStatus.PENDING", color: "info" },
  APPROVED: { key: "workflows.taskStatus.APPROVED", color: "success" },
  REJECTED: { key: "workflows.taskStatus.REJECTED", color: "error" },
  CHANGES_REQUESTED: { key: "workflows.taskStatus.CHANGES_REQUESTED", color: "warning" },
  CANCELLED: { key: "workflows.taskStatus.CANCELLED", color: "default" },
  EXPIRED: { key: "workflows.taskStatus.EXPIRED", color: "error" },
};

const DOCUMENT_STATUS_KEY: Readonly<Record<DocumentStatus, MessageKey>> = {
  DRAFT: "workflows.documentStatus.DRAFT",
  IN_REVIEW: "workflows.documentStatus.IN_REVIEW",
  APPROVED: "workflows.documentStatus.APPROVED",
  REJECTED: "workflows.documentStatus.REJECTED",
  ARCHIVED: "workflows.documentStatus.ARCHIVED",
  EXPIRED: "workflows.documentStatus.EXPIRED",
  DELETED: "workflows.documentStatus.DELETED",
};

const ASSIGNEE_TYPE_KEY: Readonly<Record<TaskAssigneeFilterType, MessageKey>> = {
  USER: "tasks.inbox.assigneeFilter.USER",
  GROUP: "tasks.inbox.assigneeFilter.GROUP",
  ROLE: "tasks.inbox.assigneeFilter.ROLE",
};

const TASK_STATUS_FILTER_VALUES: readonly WorkflowTaskStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "CANCELLED",
  "EXPIRED",
];

const ASSIGNEE_TYPE_FILTER_VALUES: readonly TaskAssigneeFilterType[] = ["USER", "GROUP", "ROLE"];

const SERVER_SORTABLE_FIELDS = new Set<string>(["dueAt", "createdAt", "status", "stepOrder", "id"]);

/**
 * Authorized task inbox listing with server-filtered status, assignee type,
 * overdue filter, counts, and scoped navigation to the task's bound document.
 */
export function TaskInboxPage() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<TaskInboxFiltersState>(DEFAULT_TASK_INBOX_FILTERS);

  const tasksQuery = useTaskInboxQuery(filters);
  const countsQuery = useTaskInboxCountsQuery();

  const updateFilters = (patch: Partial<TaskInboxFiltersState>): void => {
    setFilters((prev) => ({
      ...prev,
      ...patch,
    }));
  };

  const clearFilters = (): void => {
    setFilters((prev) => ({
      ...DEFAULT_TASK_INBOX_FILTERS,
      pageSize: prev.pageSize,
      sortBy: prev.sortBy,
      sortDirection: prev.sortDirection,
    }));
  };

  const handleSortChange = (field: string, direction: "asc" | "desc"): void => {
    if (!SERVER_SORTABLE_FIELDS.has(field)) {
      return;
    }
    updateFilters({
      sortBy: field as TaskInboxSortField,
      sortDirection: direction,
      page: 1,
    });
  };

  const handleRefresh = (): void => {
    void tasksQuery.refetch();
    void countsQuery.refetch();
  };

  const openScopedDocument = (task: TaskInboxItem): void => {
    const target = resolveTaskDocumentTarget(task);
    if (!target) {
      return;
    }
    void navigate(target);
  };

  const hasActiveFilters =
    filters.status.length > 0 || filters.assigneeType.length > 0 || filters.overdueOnly;

  const isPendingShortcutActive = filters.status === "PENDING" && !filters.overdueOnly;
  const isOverdueShortcutActive = filters.status === "PENDING" && filters.overdueOnly;

  const rows = tasksQuery.data?.items ?? [];
  const totalItems = tasksQuery.data?.pagination.totalItems ?? 0;

  const columns: DataTableColumn<TaskInboxItem>[] = [
    {
      id: "workflowDefinitionName",
      label: t("tasks.inbox.columns.workflowAndStep"),
      sortable: false,
      render: (row) => (
        <Stack spacing={0.25}>
          <Typography variant="body2" fontWeight={600}>
            {row.workflowDefinitionName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("tasks.inbox.stepLabel", { order: row.stepOrder, name: row.stepName })}
          </Typography>
        </Stack>
      ),
    },
    {
      id: "documentTitle",
      label: t("tasks.inbox.columns.document"),
      sortable: false,
      render: (row) => (
        <Stack spacing={0.25}>
          <Typography variant="body2" fontWeight={500}>
            {row.documentTitle}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("tasks.inbox.versionAndStatus", {
              version: row.documentVersionNumber,
              status: t(DOCUMENT_STATUS_KEY[row.documentStatus]),
            })}
          </Typography>
        </Stack>
      ),
    },
    {
      id: "assigneeType",
      label: t("tasks.inbox.columns.assignment"),
      sortable: false,
      render: (row) => (
        <Typography variant="body2" color="text.secondary">
          {t(ASSIGNEE_TYPE_KEY[row.assignee.type])}
        </Typography>
      ),
    },
    {
      id: "dueAt",
      label: t("tasks.inbox.columns.dueAt"),
      sortable: true,
      render: (row) => (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="body2">
            {formatDateTime(row.dueAt, t("tasks.inbox.noDueDate"))}
          </Typography>
          {row.isOverdue ? (
            <Chip
              icon={<WarningAmberOutlinedIcon fontSize="small" />}
              label={t("tasks.inbox.overdueChipLabel")}
              color="error"
              size="small"
            />
          ) : null}
        </Stack>
      ),
    },
    {
      id: "status",
      label: t("tasks.inbox.columns.status"),
      sortable: true,
      render: (row) => {
        const badge = TASK_STATUS_BADGE[row.status];
        return <Chip label={t(badge.key)} color={badge.color} size="small" />;
      },
    },
    {
      id: "createdAt",
      label: t("tasks.inbox.columns.createdAt"),
      sortable: true,
      render: (row) => formatDateTime(row.createdAt, t("tasks.inbox.notProvided")),
    },
    {
      id: "actions",
      label: t("tasks.inbox.columns.actions"),
      align: "right",
      render: (row) => {
        const target = resolveTaskDocumentTarget(row);
        return (
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button
              size="small"
              variant="outlined"
              onClick={(event) => {
                event.stopPropagation();
                void navigate(`/tasks/${encodeURIComponent(row.id)}`);
              }}
              aria-label={t("tasks.inbox.actions.reviewAria", {
                workflow: row.workflowDefinitionName,
                document: row.documentTitle,
              })}
            >
              {t("tasks.inbox.actions.review")}
            </Button>

            {target ? (
              <Button
                size="small"
                variant="text"
                endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
                onClick={(event) => {
                  event.stopPropagation();
                  openScopedDocument(row);
                }}
                aria-label={t("tasks.inbox.actions.openDocumentAria", {
                  document: row.documentTitle,
                  version: row.documentVersionNumber,
                })}
              >
                {t("tasks.inbox.actions.openDocument")}
              </Button>
            ) : (
              <Button size="small" variant="text" disabled>
                {t("tasks.inbox.actions.documentUnavailable")}
              </Button>
            )}
          </Stack>
        );
      },
    },
  ];

  const isRefreshing = tasksQuery.isFetching || countsQuery.isFetching;

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
            {t("tasks.inbox.title")}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t("tasks.inbox.subtitle")}
          </Typography>
        </Box>

        <Button
          variant="outlined"
          size="small"
          startIcon={<RefreshOutlinedIcon />}
          disabled={isRefreshing}
          onClick={handleRefresh}
        >
          {isRefreshing ? t("tasks.inbox.refreshing") : t("tasks.inbox.refresh")}
        </Button>
      </Stack>

      <Paper
        variant="outlined"
        sx={{
          px: 2,
          py: 1.5,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          alignItems={{ xs: "flex-start", sm: "center" }}
          justifyContent="space-between"
          flexWrap="wrap"
        >
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip
              icon={<PendingActionsOutlinedIcon fontSize="small" />}
              label={
                countsQuery.data
                  ? t("tasks.inbox.pendingChip", {
                      count: formatNumber(countsQuery.data.pendingCount),
                    })
                  : t("tasks.inbox.pendingChipLoading")
              }
              color={isPendingShortcutActive ? "primary" : "default"}
              variant={isPendingShortcutActive ? "filled" : "outlined"}
              clickable
              onClick={() =>
                updateFilters(
                  isPendingShortcutActive
                    ? { status: "", overdueOnly: false, page: 1 }
                    : { status: "PENDING", overdueOnly: false, page: 1 },
                )
              }
            />

            <Chip
              icon={<ScheduleOutlinedIcon fontSize="small" />}
              label={
                countsQuery.data
                  ? t("tasks.inbox.overdueChip", {
                      count: formatNumber(countsQuery.data.overduePendingCount),
                    })
                  : t("tasks.inbox.overdueChipLoading")
              }
              color={isOverdueShortcutActive ? "error" : "default"}
              variant={isOverdueShortcutActive ? "filled" : "outlined"}
              clickable
              onClick={() =>
                updateFilters(
                  isOverdueShortcutActive
                    ? { status: "", overdueOnly: false, page: 1 }
                    : { status: "PENDING", overdueOnly: true, page: 1 },
                )
              }
            />
          </Stack>

          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontVariantNumeric: "tabular-nums" }}
          >
            {tasksQuery.data
              ? t(totalItems === 1 ? "tasks.inbox.totalSingular" : "tasks.inbox.totalPlural", {
                  count: formatNumber(totalItems),
                })
              : t("tasks.inbox.loadingCounts")}
          </Typography>
        </Stack>
      </Paper>

      <Paper
        sx={{
          p: 2,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          alignItems={{ xs: "stretch", md: "center" }}
          justifyContent="space-between"
        >
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1.5}
            alignItems={{ xs: "stretch", sm: "center" }}
            flexWrap="wrap"
            sx={{ flex: 1 }}
          >
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="task-filter-status-label">
                {t("tasks.inbox.filters.statusLabel")}
              </InputLabel>
              <Select
                labelId="task-filter-status-label"
                id="task-filter-status"
                value={filters.status}
                label={t("tasks.inbox.filters.statusLabel")}
                onChange={(event) =>
                  updateFilters({
                    status: event.target.value as WorkflowTaskStatus | "",
                    page: 1,
                  })
                }
              >
                <MenuItem value="">{t("tasks.inbox.filters.allStatuses")}</MenuItem>
                {TASK_STATUS_FILTER_VALUES.map((statusValue) => (
                  <MenuItem key={statusValue} value={statusValue}>
                    {t(TASK_STATUS_BADGE[statusValue].key)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="task-filter-assignee-label">
                {t("tasks.inbox.filters.assignmentLabel")}
              </InputLabel>
              <Select
                labelId="task-filter-assignee-label"
                id="task-filter-assignee"
                value={filters.assigneeType}
                label={t("tasks.inbox.filters.assignmentLabel")}
                onChange={(event) =>
                  updateFilters({
                    assigneeType: event.target.value as TaskAssigneeFilterType | "",
                    page: 1,
                  })
                }
              >
                <MenuItem value="">{t("tasks.inbox.filters.allAssignments")}</MenuItem>
                {ASSIGNEE_TYPE_FILTER_VALUES.map((assigneeValue) => (
                  <MenuItem key={assigneeValue} value={assigneeValue}>
                    {t(ASSIGNEE_TYPE_KEY[assigneeValue])}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControlLabel
              control={
                <Switch
                  checked={filters.overdueOnly}
                  onChange={(event) =>
                    updateFilters({
                      overdueOnly: event.target.checked,
                      page: 1,
                    })
                  }
                />
              }
              label={t("tasks.inbox.filters.overdueOnly")}
            />

            {hasActiveFilters ? (
              <Button variant="text" onClick={clearFilters}>
                {t("tasks.inbox.filters.clear")}
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </Paper>

      <DataTable
        ariaLabel={t("tasks.inbox.tableAriaLabel")}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => `${row.workflowDefinitionName} — ${row.documentTitle}`}
        page={filters.page}
        pageSize={filters.pageSize}
        totalItems={totalItems}
        onPageChange={(nextPage) => updateFilters({ page: nextPage })}
        onPageSizeChange={(nextPageSize) => updateFilters({ pageSize: nextPageSize, page: 1 })}
        sortBy={filters.sortBy}
        sortDirection={filters.sortDirection}
        onSortChange={handleSortChange}
        onRowClick={openScopedDocument}
        loading={tasksQuery.isLoading}
        errorMessage={tasksQuery.isError ? tasksQuery.error.message : null}
        onRetry={handleRefresh}
        emptyTitle={t("tasks.inbox.emptyTitle")}
        emptyDescription={
          hasActiveFilters
            ? t("tasks.inbox.emptyFilteredDescription")
            : t("tasks.inbox.emptyDefaultDescription")
        }
        emptyActionLabel={
          hasActiveFilters ? t("tasks.inbox.filters.clear") : t("tasks.inbox.refresh")
        }
        onEmptyAction={hasActiveFilters ? clearFilters : handleRefresh}
      />
    </Stack>
  );
}
