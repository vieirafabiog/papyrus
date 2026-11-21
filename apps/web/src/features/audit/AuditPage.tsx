import type {
  AuditEventRecord,
  AuditExportFormat,
  AuditResult,
  AuthMeResponse,
} from "@docuflow/contracts";
import {
  DOCUFLOW_COLOR_TOKENS,
  DataTable,
  type DataTableColumn,
  ErrorState,
  LoadingState,
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
import {
  type AuditFiltersState,
  DEFAULT_AUDIT_FILTERS,
  downloadAuthorizedAuditExport,
  hasInvalidAuditPeriod,
  useAuditEventsQuery,
  useAuditFacetsQuery,
} from "./useAuditEvents.js";

const RESULT_BADGE: Readonly<
  Record<AuditResult, { readonly label: string; readonly color: "success" | "warning" | "error" }>
> = {
  SUCCESS: { label: "Sucesso", color: "success" },
  DENIED: { label: "Negado", color: "warning" },
  FAILURE: { label: "Falha", color: "error" },
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  AUTH_LOGIN_SUCCEEDED: "Login realizado",
  AUTH_LOGIN_FAILED: "Falha no login",
  AUTH_LOGOUT: "Sessão encerrada",
  DOCUMENT_CREATED: "Documento criado",
  DOCUMENT_VIEWED: "Documento visualizado",
  DOCUMENT_UPDATED: "Metadados atualizados",
  DOCUMENT_MOVED: "Documento movido",
  DOCUMENT_ARCHIVED: "Documento arquivado",
  DOCUMENT_TRASHED: "Enviado à lixeira",
  DOCUMENT_VERSION_CREATED: "Nova versão enviada",
  DOCUMENT_VERSION_RESTORED: "Versão restaurada",
  DOCUMENT_DOWNLOAD_REQUESTED: "Download solicitado",
  DOCUMENT_DOWNLOADED: "Download realizado",
  DOCUMENT_DOWNLOAD_DENIED: "Download bloqueado",
  DOCUMENT_DOWNLOAD_FAILED: "Falha no download",
  DOCUMENT_PREVIEWED: "Pré-visualização exibida",
  DOCUMENT_PREVIEW_DENIED: "Pré-visualização bloqueada",
  PERMISSION_ASSIGNED: "Permissão atribuída",
  PERMISSION_REVOKED: "Permissão revogada",
  AUTHORIZATION_DENIED: "Acesso negado",
  WORKFLOW_STARTED: "Fluxo iniciado",
  WORKFLOW_TASK_CREATED: "Tarefa gerada",
  WORKFLOW_TASK_DECIDED: "Decisão em tarefa",
  WORKFLOW_TASK_CANCELLED: "Tarefa cancelada",
  AUDIT_EXPORTED: "Auditoria exportada",
  AUDIT_EXPORT_DENIED: "Exportação de auditoria negada",
};

const RESOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  DOCUMENT: "Documento",
  FOLDER: "Pasta",
  CATEGORY: "Categoria",
  WORKFLOW_INSTANCE: "Fluxo",
  WORKFLOW_TASK: "Tarefa",
  ROLE_SCOPE: "Permissão",
  USER: "Usuário",
  GROUP: "Grupo",
  STORAGE_CONNECTION: "Armazenamento",
  AUDIT: "Auditoria",
};

const SERVER_SORTABLE_FIELDS = new Set<string>(["occurredAt", "action", "resourceType", "result"]);
const NUMBER_FORMATTER = new Intl.NumberFormat("pt-BR");

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

function formatDateTimePtBr(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

function formatActorLabel(event: AuditEventRecord): string {
  if (event.actorName && event.actorEmail) {
    return `${event.actorName} (${event.actorEmail})`;
  }
  if (event.actorName) {
    return event.actorName;
  }
  if (event.actorUserId) {
    return event.actorUserId;
  }
  return "Sistema";
}

function formatActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function formatResourceTypeLabel(resourceType: string): string {
  return RESOURCE_TYPE_LABELS[resourceType] ?? resourceType;
}

/**
 * Authorized audit trail explorer with server-side filters (actor user, action,
 * resource type, result, and period), details drawer/dialog, and authorized CSV/JSON export.
 */
export function AuditPage() {
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
        message: `Exportação concluída (${fileName}).`,
      });
    } catch (err) {
      setExportFeedback({
        severity: "error",
        message:
          err instanceof Error
            ? err.message
            : "Não foi possível concluir a exportação de auditoria.",
      });
    } finally {
      setExportingFormat(null);
    }
  };

  if (sessionQuery.isPending) {
    return <LoadingState message="Verificando permissões de auditoria..." />;
  }

  if (sessionQuery.isError) {
    return (
      <ErrorState
        title="Não foi possível validar suas permissões"
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
          <Typography variant="h1">Auditoria</Typography>
        </Stack>
        <ErrorState
          title="Acesso não autorizado à trilha de auditoria"
          description="Você não possui a permissão de visualização e exportação de auditoria configurada para esta organização."
        />
      </Stack>
    );
  }

  const columns: readonly DataTableColumn<AuditEventRecord>[] = [
    {
      id: "occurredAt",
      label: "Data e hora",
      sortable: true,
      width: 185,
      render: (row) => (
        <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {formatDateTimePtBr(row.occurredAt)}
        </Typography>
      ),
    },
    {
      id: "actor",
      label: "Usuário",
      render: (row) => (
        <Box>
          <Typography variant="body2" fontWeight={500}>
            {row.actorName ?? (row.actorUserId ? row.actorUserId.slice(0, 8) : "Sistema")}
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
      label: "Ação",
      sortable: true,
      render: (row) => (
        <Box>
          <Typography variant="body2" fontWeight={500}>
            {formatActionLabel(row.action)}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
            {row.action}
          </Typography>
        </Box>
      ),
    },
    {
      id: "resourceType",
      label: "Recurso",
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
      label: "Resultado",
      sortable: true,
      width: 120,
      render: (row) => {
        const badge = RESULT_BADGE[row.result];
        return <Chip size="small" label={badge.label} color={badge.color} />;
      },
    },
    {
      id: "details",
      label: "Detalhes",
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
          Detalhes
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
            <Typography variant="h1">Auditoria</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Trilha imutável de acessos, alterações documentais, permissões, fluxos e exportações.
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
            Atualizar
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            disabled={exportingFormat !== null || invalidPeriod}
            onClick={() => void handleExport("csv")}
          >
            {exportingFormat === "csv" ? "Exportando CSV..." : "Exportar CSV"}
          </Button>
          <Button
            variant="contained"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            disabled={exportingFormat !== null || invalidPeriod}
            onClick={() => void handleExport("json")}
          >
            {exportingFormat === "json" ? "Exportando JSON..." : "Exportar JSON"}
          </Button>
        </Stack>
      </Stack>

      {exportFeedback ? (
        <Alert severity={exportFeedback.severity} onClose={() => setExportFeedback(null)}>
          {exportFeedback.message}
        </Alert>
      ) : null}

      <Paper sx={{ p: 2, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
        <Stack spacing={1.5}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.5}
            alignItems={{ xs: "stretch", md: "center" }}
            flexWrap="wrap"
            useFlexGap
          >
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="audit-filter-actor-label">Usuário</InputLabel>
              <Select
                labelId="audit-filter-actor-label"
                id="audit-filter-actor"
                value={filters.actorUserId}
                label="Usuário"
                onChange={(event) =>
                  updateFilters({ actorUserId: String(event.target.value), page: 1 })
                }
              >
                <MenuItem value="">Todos os usuários</MenuItem>
                {(facetsQuery.data?.actors ?? []).map((actor) => (
                  <MenuItem key={actor.id} value={actor.id}>
                    {actor.fullName} ({actor.email})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 210 }}>
              <InputLabel id="audit-filter-action-label">Ação</InputLabel>
              <Select
                labelId="audit-filter-action-label"
                id="audit-filter-action"
                value={filters.action}
                label="Ação"
                onChange={(event) => updateFilters({ action: String(event.target.value), page: 1 })}
              >
                <MenuItem value="">Todas as ações</MenuItem>
                {actionOptions.map((action) => (
                  <MenuItem key={action} value={action}>
                    {formatActionLabel(action)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel id="audit-filter-resource-label">Recurso</InputLabel>
              <Select
                labelId="audit-filter-resource-label"
                id="audit-filter-resource"
                value={filters.resourceType}
                label="Recurso"
                onChange={(event) =>
                  updateFilters({ resourceType: String(event.target.value), page: 1 })
                }
              >
                <MenuItem value="">Todos os recursos</MenuItem>
                {resourceTypeOptions.map((resourceType) => (
                  <MenuItem key={resourceType} value={resourceType}>
                    {formatResourceTypeLabel(resourceType)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="audit-filter-result-label">Resultado</InputLabel>
              <Select
                labelId="audit-filter-result-label"
                id="audit-filter-result"
                value={filters.result}
                label="Resultado"
                onChange={(event) =>
                  updateFilters({
                    result: String(event.target.value) as AuditResult | "",
                    page: 1,
                  })
                }
              >
                <MenuItem value="">Todos</MenuItem>
                <MenuItem value="SUCCESS">Sucesso</MenuItem>
                <MenuItem value="DENIED">Negado</MenuItem>
                <MenuItem value="FAILURE">Falha</MenuItem>
              </Select>
            </FormControl>

            <TextField
              id="audit-filter-from"
              label="Data inicial"
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
              label="Data final"
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
                Limpar filtros
              </Button>
            ) : null}
          </Stack>

          {invalidPeriod ? (
            <Alert severity="error">
              A data inicial do período não pode ser posterior à data final.
            </Alert>
          ) : null}

          {data ? (
            <Typography variant="caption" color="text.secondary">
              {NUMBER_FORMATTER.format(data.pagination.totalItems)}{" "}
              {data.pagination.totalItems === 1 ? "evento localizado" : "eventos localizados"}
            </Typography>
          ) : null}
        </Stack>
      </Paper>

      <DataTable
        ariaLabel="Lista de eventos de auditoria"
        columns={columns}
        rows={data?.items ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => `${formatActionLabel(row.action)} em ${row.occurredAt}`}
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
          hasActiveFilters
            ? "Nenhum evento encontrado para os filtros aplicados"
            : "Nenhum evento de auditoria registrado"
        }
        emptyDescription={
          hasActiveFilters
            ? "Tente ampliar o período ou remover filtros para visualizar mais registros."
            : "Os eventos de acesso, edição, download, permissões e fluxo aparecerão aqui."
        }
        {...(hasActiveFilters
          ? { emptyActionLabel: "Limpar filtros", onEmptyAction: clearFilters }
          : {})}
      />

      <Dialog
        open={selectedEvent !== null}
        onClose={() => setSelectedEvent(null)}
        maxWidth="sm"
        fullWidth
        aria-labelledby="audit-event-dialog-title"
      >
        <DialogTitle id="audit-event-dialog-title">Detalhes do evento de auditoria</DialogTitle>
        <DialogContent dividers>
          {selectedEvent ? (
            <Stack spacing={2}>
              <Table size="small" aria-label="Campos técnicos do evento de auditoria">
                <TableBody>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      ID do evento
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>{selectedEvent.id}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      Data e hora
                    </TableCell>
                    <TableCell>{formatDateTimePtBr(selectedEvent.occurredAt)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      Usuário
                    </TableCell>
                    <TableCell>{formatActorLabel(selectedEvent)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      Ação
                    </TableCell>
                    <TableCell>
                      {formatActionLabel(selectedEvent.action)} ({selectedEvent.action})
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      Recurso
                    </TableCell>
                    <TableCell>
                      {formatResourceTypeLabel(selectedEvent.resourceType)}
                      {selectedEvent.resourceId ? ` — ${selectedEvent.resourceId}` : ""}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      Resultado
                    </TableCell>
                    <TableCell>{RESULT_BADGE[selectedEvent.result].label}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      Request ID
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {selectedEvent.requestId}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>
                      Origem técnica (IP)
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {selectedEvent.ipAddress ?? "Não informado"}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>

              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Metadados registrados
                </Typography>
                {Object.keys(selectedEvent.metadata).length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    Nenhum metadado adicional registrado neste evento.
                  </Typography>
                ) : (
                  <Table size="small" aria-label="Metadados do evento de auditoria">
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
                          <TableCell>{value === null ? "null" : String(value)}</TableCell>
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
          <Button onClick={() => setSelectedEvent(null)}>Fechar</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
