import type {
  DocumentExpirationItem,
  DocumentStatus,
  ExpirationBucket,
  ExpirationState,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, DataTable, type DataTableColumn } from "@docuflow/ui";
import ClearOutlinedIcon from "@mui/icons-material/ClearOutlined";
import EventAvailableOutlinedIcon from "@mui/icons-material/EventAvailableOutlined";
import EventBusyOutlinedIcon from "@mui/icons-material/EventBusyOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import {
  Box,
  Button,
  Chip,
  FormControl,
  FormControlLabel,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useDocumentListCategoriesQuery,
  useDocumentOwnersQuery,
} from "../documents/useDocumentList.js";
import {
  DEFAULT_EXPIRATIONS_FILTERS,
  type ExpirationsFiltersState,
  type ExpirationsSortField,
  useDocumentExpirationsQuery,
} from "./useExpirations.js";

const DOCUMENT_STATUS_LABEL: Readonly<Record<DocumentStatus, string>> = {
  DRAFT: "Rascunho",
  IN_REVIEW: "Em revisão",
  APPROVED: "Aprovado",
  REJECTED: "Rejeitado",
  ARCHIVED: "Arquivado",
  EXPIRED: "Expirado",
  DELETED: "Excluído",
};

const EXPIRATION_BADGE: Readonly<
  Record<
    ExpirationState,
    { readonly label: string; readonly color: "error" | "warning" | "success" | "default" }
  >
> = {
  EXPIRED: { label: "Vencido", color: "error" },
  EXPIRING_SOON: { label: "Próximo do vencimento", color: "warning" },
  UP_TO_DATE: { label: "Em dia", color: "success" },
  NO_DATE: { label: "Sem data", color: "default" },
};

const WINDOW_DAY_OPTIONS = [7, 15, 30, 60, 90] as const;
const SERVER_SORTABLE_FIELDS = new Set<string>(["expirationDate", "title", "status", "updatedAt"]);
const NUMBER_FORMATTER = new Intl.NumberFormat("pt-BR");

function formatIsoDatePtBr(isoDate: string | null): string {
  if (!isoDate) {
    return "Sem data";
  }
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) {
    return isoDate;
  }
  return `${day}/${month}/${year}`;
}

function formatExpirationDeltaLabel(item: DocumentExpirationItem): string {
  if (item.daysUntilExpiration === null) {
    return "Sem data definida";
  }
  if (item.daysUntilExpiration < 0) {
    const overdueDays = Math.abs(item.daysUntilExpiration);
    return overdueDays === 1 ? "Vencido há 1 dia" : `Vencido há ${overdueDays} dias`;
  }
  if (item.daysUntilExpiration === 0) {
    return "Vence hoje";
  }
  if (item.daysUntilExpiration === 1) {
    return "Vence em 1 dia";
  }
  return `Vence em ${item.daysUntilExpiration} dias`;
}

/**
 * Authorized document expiration monitoring page filtering overdue, expiring-soon,
 * up-to-date, and undated documents in PostgreSQL according to the organization timezone.
 */
export function ExpirationsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<ExpirationsFiltersState>(DEFAULT_EXPIRATIONS_FILTERS);

  const expirationsQuery = useDocumentExpirationsQuery(filters);
  const categoriesQuery = useDocumentListCategoriesQuery();
  const ownersQuery = useDocumentOwnersQuery();

  const updateFilters = (patch: Partial<ExpirationsFiltersState>): void => {
    setFilters((prev) => ({
      ...prev,
      ...patch,
    }));
  };

  const clearFilters = (): void => {
    setFilters((prev) => ({
      ...DEFAULT_EXPIRATIONS_FILTERS,
      pageSize: prev.pageSize,
    }));
  };

  const hasActiveFilters =
    filters.bucket !== "ALL" ||
    filters.windowDays !== 30 ||
    filters.categoryId.length > 0 ||
    filters.ownerUserId.length > 0 ||
    filters.search.trim().length > 0 ||
    filters.includeArchived;

  const data = expirationsQuery.data;
  const summary = data?.summary;
  const totalTracked = summary
    ? summary.expiredCount +
      summary.expiringSoonCount +
      summary.upToDateCount +
      summary.noExpirationCount
    : null;

  const columns: readonly DataTableColumn<DocumentExpirationItem>[] = [
    {
      id: "title",
      label: "Documento",
      sortable: true,
      render: (row) => (
        <Box>
          <Typography variant="body2" fontWeight={600}>
            {row.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {row.categoryName ?? row.categoryId}
          </Typography>
        </Box>
      ),
    },
    {
      id: "ownerName",
      label: "Responsável",
      render: (row) => <Typography variant="body2">{row.ownerName ?? row.ownerUserId}</Typography>,
    },
    {
      id: "status",
      label: "Status",
      sortable: true,
      width: 140,
      render: (row) => (
        <Chip size="small" variant="outlined" label={DOCUMENT_STATUS_LABEL[row.status]} />
      ),
    },
    {
      id: "expirationDate",
      label: "Data de vencimento",
      sortable: true,
      width: 165,
      render: (row) => (
        <Typography
          variant="body2"
          fontWeight={row.expirationState === "EXPIRED" ? 600 : 400}
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatIsoDatePtBr(row.expirationDate)}
        </Typography>
      ),
    },
    {
      id: "expirationSituation",
      label: "Situação",
      width: 240,
      render: (row) => {
        const badge = EXPIRATION_BADGE[row.expirationState];
        return (
          <Stack spacing={0.5} alignItems="flex-start">
            <Chip size="small" label={badge.label} color={badge.color} />
            <Typography variant="caption" color="text.secondary">
              {formatExpirationDeltaLabel(row)}
            </Typography>
          </Stack>
        );
      },
    },
    {
      id: "actions",
      label: "Ação",
      align: "right",
      width: 145,
      render: (row) => (
        <Button
          size="small"
          variant="text"
          endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/documentos/${encodeURIComponent(row.id)}`);
          }}
        >
          Abrir
        </Button>
      ),
    },
  ];

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
            <EventBusyOutlinedIcon color="primary" fontSize="small" />
            <Typography variant="h1">Vencimentos</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Acompanhamento de documentos vencidos, próximos do vencimento e sem data definida.
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          {data ? (
            <Chip
              size="small"
              variant="outlined"
              icon={<PublicOutlinedIcon fontSize="small" />}
              label={`Fuso: ${data.timezone} • Data base: ${formatIsoDatePtBr(data.referenceDate)}`}
            />
          ) : null}
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshOutlinedIcon />}
            disabled={expirationsQuery.isFetching}
            onClick={() => void expirationsQuery.refetch()}
          >
            Atualizar
          </Button>
        </Stack>
      </Stack>

      <Paper sx={{ bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
        <Tabs
          value={filters.bucket}
          onChange={(_event, nextValue: ExpirationBucket) =>
            updateFilters({ bucket: nextValue, page: 1 })
          }
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Filtros por situação de vencimento"
          sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}
        >
          <Tab
            value="ALL"
            label={
              totalTracked !== null ? `Todos (${NUMBER_FORMATTER.format(totalTracked)})` : "Todos"
            }
          />
          <Tab
            value="EXPIRED"
            label={
              summary ? `Vencidos (${NUMBER_FORMATTER.format(summary.expiredCount)})` : "Vencidos"
            }
          />
          <Tab
            value="EXPIRING_SOON"
            label={
              summary
                ? `Próximos (${NUMBER_FORMATTER.format(summary.expiringSoonCount)})`
                : "Próximos"
            }
          />
          <Tab
            value="NO_DATE"
            label={
              summary
                ? `Sem data (${NUMBER_FORMATTER.format(summary.noExpirationCount)})`
                : "Sem data"
            }
          />
          <Tab
            value="UP_TO_DATE"
            icon={<EventAvailableOutlinedIcon fontSize="small" />}
            iconPosition="start"
            label={
              summary ? `Em dia (${NUMBER_FORMATTER.format(summary.upToDateCount)})` : "Em dia"
            }
          />
        </Tabs>

        <Stack spacing={1.5} sx={{ p: 2 }}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.5}
            alignItems={{ xs: "stretch", md: "center" }}
            flexWrap="wrap"
            useFlexGap
          >
            <TextField
              id="expirations-search"
              size="small"
              label="Buscar documento"
              placeholder="Título ou nome do arquivo"
              value={filters.search}
              onChange={(event) => updateFilters({ search: event.target.value, page: 1 })}
              sx={{ minWidth: { xs: "100%", sm: 240 } }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchOutlinedIcon fontSize="small" color="action" />
                    </InputAdornment>
                  ),
                },
              }}
            />

            <FormControl size="small" sx={{ minWidth: 165 }}>
              <InputLabel id="expirations-window-label">Janela de alerta</InputLabel>
              <Select
                labelId="expirations-window-label"
                id="expirations-window"
                value={String(filters.windowDays)}
                label="Janela de alerta"
                onChange={(event) => {
                  const days = Number.parseInt(String(event.target.value), 10);
                  if (!Number.isNaN(days) && days > 0) {
                    updateFilters({ windowDays: days, page: 1 });
                  }
                }}
              >
                {WINDOW_DAY_OPTIONS.map((days) => (
                  <MenuItem key={days} value={String(days)}>
                    Próximos {days} dias
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 190 }}>
              <InputLabel id="expirations-category-label">Categoria</InputLabel>
              <Select
                labelId="expirations-category-label"
                id="expirations-category"
                value={filters.categoryId}
                label="Categoria"
                onChange={(event) =>
                  updateFilters({ categoryId: String(event.target.value), page: 1 })
                }
              >
                <MenuItem value="">Todas as categorias</MenuItem>
                {(categoriesQuery.data ?? []).map((category) => (
                  <MenuItem key={category.id} value={category.id}>
                    {category.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 190 }}>
              <InputLabel id="expirations-owner-label">Responsável</InputLabel>
              <Select
                labelId="expirations-owner-label"
                id="expirations-owner"
                value={filters.ownerUserId}
                label="Responsável"
                onChange={(event) =>
                  updateFilters({ ownerUserId: String(event.target.value), page: 1 })
                }
              >
                <MenuItem value="">Todos os responsáveis</MenuItem>
                {(ownersQuery.data ?? []).map((owner) => (
                  <MenuItem key={owner.id} value={owner.id}>
                    {owner.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControlLabel
              control={
                <Switch
                  checked={filters.includeArchived}
                  onChange={(_event, checked) =>
                    updateFilters({ includeArchived: checked, page: 1 })
                  }
                />
              }
              label="Incluir arquivados"
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
        </Stack>
      </Paper>

      <DataTable
        ariaLabel="Lista de documentos por vencimento"
        columns={columns}
        rows={data?.items ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
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
              sortBy: field as ExpirationsSortField,
              sortDirection: direction,
              page: 1,
            });
          }
        }}
        onRowClick={(row) => navigate(`/documentos/${encodeURIComponent(row.id)}`)}
        loading={expirationsQuery.isPending}
        errorMessage={expirationsQuery.isError ? expirationsQuery.error.message : null}
        onRetry={() => void expirationsQuery.refetch()}
        emptyTitle={
          hasActiveFilters
            ? "Nenhum documento encontrado para esta situação de vencimento"
            : "Nenhum documento cadastrado para monitoramento"
        }
        emptyDescription={
          hasActiveFilters
            ? "Ajuste a janela de dias, categoria ou filtros aplicados."
            : "Os documentos cadastrados aparecerão aqui com suas datas de vencimento."
        }
        {...(hasActiveFilters
          ? { emptyActionLabel: "Limpar filtros", onEmptyAction: clearFilters }
          : {})}
      />
    </Stack>
  );
}
