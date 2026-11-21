import type { DocumentStatus, TaskInboxItem, WorkflowTaskStatus } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, DataTable, type DataTableColumn } from "@docuflow/ui";
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
import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
    { readonly label: string; readonly color: "default" | "info" | "success" | "warning" | "error" }
  >
> = {
  PENDING: { label: "Pendente", color: "info" },
  APPROVED: { label: "Aprovada", color: "success" },
  REJECTED: { label: "Rejeitada", color: "error" },
  CHANGES_REQUESTED: { label: "Ajustes solicitados", color: "warning" },
  CANCELLED: { label: "Cancelada", color: "default" },
  EXPIRED: { label: "Expirada", color: "error" },
};

const DOCUMENT_STATUS_LABEL: Readonly<Record<DocumentStatus, string>> = {
  DRAFT: "Rascunho",
  IN_REVIEW: "Em revisão",
  APPROVED: "Aprovado",
  REJECTED: "Rejeitado",
  ARCHIVED: "Arquivado",
  EXPIRED: "Expirado",
  DELETED: "Excluído",
};

const ASSIGNEE_TYPE_LABEL: Readonly<Record<TaskAssigneeFilterType, string>> = {
  USER: "Direta (usuário)",
  GROUP: "Grupo",
  ROLE: "Papel",
};

const TASK_STATUS_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: WorkflowTaskStatus;
  readonly label: string;
}> = [
  { value: "PENDING", label: "Pendente" },
  { value: "APPROVED", label: "Aprovada" },
  { value: "REJECTED", label: "Rejeitada" },
  { value: "CHANGES_REQUESTED", label: "Ajustes solicitados" },
  { value: "CANCELLED", label: "Cancelada" },
  { value: "EXPIRED", label: "Expirada" },
];

const ASSIGNEE_TYPE_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: TaskAssigneeFilterType;
  readonly label: string;
}> = [
  { value: "USER", label: "Direta (usuário)" },
  { value: "GROUP", label: "Grupo" },
  { value: "ROLE", label: "Papel" },
];

const SERVER_SORTABLE_FIELDS = new Set<string>(["dueAt", "createdAt", "status", "stepOrder", "id"]);

const NUMBER_FORMATTER = new Intl.NumberFormat("pt-BR");

function formatDateTimePtBr(isoDateTime: string | null, emptyLabel: string): string {
  if (!isoDateTime) {
    return emptyLabel;
  }
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

/**
 * Authorized "Minhas tarefas" inbox listing with server-filtered status, assignee type,
 * overdue filter, PostgreSQL counts, and scoped navigation to the task's bound document.
 */
export function TaskInboxPage() {
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
      label: "Fluxo e etapa",
      sortable: false,
      render: (row) => (
        <Stack spacing={0.25}>
          <Typography variant="body2" fontWeight={600}>
            {row.workflowDefinitionName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Etapa {row.stepOrder}: {row.stepName}
          </Typography>
        </Stack>
      ),
    },
    {
      id: "documentTitle",
      label: "Documento vinculado",
      sortable: false,
      render: (row) => (
        <Stack spacing={0.25}>
          <Typography variant="body2" fontWeight={500}>
            {row.documentTitle}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Versão v{row.documentVersionNumber} · {DOCUMENT_STATUS_LABEL[row.documentStatus]}
          </Typography>
        </Stack>
      ),
    },
    {
      id: "assigneeType",
      label: "Atribuição",
      sortable: false,
      render: (row) => (
        <Typography variant="body2" color="text.secondary">
          {ASSIGNEE_TYPE_LABEL[row.assignee.type]}
        </Typography>
      ),
    },
    {
      id: "dueAt",
      label: "Prazo",
      sortable: true,
      render: (row) => (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="body2">{formatDateTimePtBr(row.dueAt, "Sem prazo")}</Typography>
          {row.isOverdue ? (
            <Chip
              icon={<WarningAmberOutlinedIcon fontSize="small" />}
              label="Em atraso"
              color="error"
              size="small"
            />
          ) : null}
        </Stack>
      ),
    },
    {
      id: "status",
      label: "Status",
      sortable: true,
      render: (row) => {
        const badge = TASK_STATUS_BADGE[row.status];
        return <Chip label={badge.label} color={badge.color} size="small" />;
      },
    },
    {
      id: "createdAt",
      label: "Criada em",
      sortable: true,
      render: (row) => formatDateTimePtBr(row.createdAt, "Não informada"),
    },
    {
      id: "actions",
      label: "Documento",
      align: "right",
      render: (row) => {
        const target = resolveTaskDocumentTarget(row);
        if (!target) {
          return (
            <Button size="small" variant="text" disabled>
              Documento indisponível
            </Button>
          );
        }

        return (
          <Button
            size="small"
            variant="text"
            endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
            onClick={(event) => {
              event.stopPropagation();
              openScopedDocument(row);
            }}
            aria-label={`Abrir documento ${row.documentTitle} (versão v${row.documentVersionNumber})`}
          >
            Abrir documento
          </Button>
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
            Minhas tarefas
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Fila de revisões e aprovações atribuídas ao seu usuário, grupos ou papéis autorizados.
          </Typography>
        </Box>

        <Button
          variant="outlined"
          size="small"
          startIcon={<RefreshOutlinedIcon />}
          disabled={isRefreshing}
          onClick={handleRefresh}
        >
          {isRefreshing ? "Atualizando..." : "Atualizar"}
        </Button>
      </Stack>

      <Paper
        variant="outlined"
        sx={{
          px: 2,
          py: 1.5,
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
          borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
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
                  ? `Pendentes: ${NUMBER_FORMATTER.format(countsQuery.data.pendingCount)}`
                  : "Pendentes: —"
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
                  ? `Em atraso: ${NUMBER_FORMATTER.format(countsQuery.data.overduePendingCount)}`
                  : "Em atraso: —"
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
              ? `Total no filtro atual: ${NUMBER_FORMATTER.format(totalItems)} ${
                  totalItems === 1 ? "tarefa" : "tarefas"
                }`
              : "Consultando contagem de tarefas..."}
          </Typography>
        </Stack>
      </Paper>

      <Paper
        sx={{
          p: 2,
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
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
              <InputLabel id="task-filter-status-label">Status</InputLabel>
              <Select
                labelId="task-filter-status-label"
                id="task-filter-status"
                value={filters.status}
                label="Status"
                onChange={(event) =>
                  updateFilters({
                    status: event.target.value as WorkflowTaskStatus | "",
                    page: 1,
                  })
                }
              >
                <MenuItem value="">Todos os status</MenuItem>
                {TASK_STATUS_FILTER_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="task-filter-assignee-label">Atribuição</InputLabel>
              <Select
                labelId="task-filter-assignee-label"
                id="task-filter-assignee"
                value={filters.assigneeType}
                label="Atribuição"
                onChange={(event) =>
                  updateFilters({
                    assigneeType: event.target.value as TaskAssigneeFilterType | "",
                    page: 1,
                  })
                }
              >
                <MenuItem value="">Todas as atribuições</MenuItem>
                {ASSIGNEE_TYPE_FILTER_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
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
              label="Somente em atraso"
            />

            {hasActiveFilters ? (
              <Button variant="text" onClick={clearFilters}>
                Limpar filtros
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </Paper>

      <DataTable
        ariaLabel="Tabela de minhas tarefas"
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
        emptyTitle="Nenhuma tarefa encontrada"
        emptyDescription={
          hasActiveFilters
            ? "Nenhuma tarefa autorizada corresponde aos filtros selecionados."
            : "Não há tarefas de revisão ou aprovação atribuídas no momento."
        }
        emptyActionLabel={hasActiveFilters ? "Limpar filtros" : "Atualizar"}
        onEmptyAction={hasActiveFilters ? clearFilters : handleRefresh}
      />
    </Stack>
  );
}
