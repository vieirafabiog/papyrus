import type { CategorySummaryRecord, DocumentStatus, FolderRecord } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, FilterBar, type FilterBarSelect } from "@docuflow/ui";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import { Alert, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import {
  type DocumentListFiltersState,
  type OwnerFilterOption,
  isValidExpirationRange,
} from "./useDocumentList.js";

const DOCUMENT_STATUS_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: DocumentStatus;
  readonly label: string;
}> = [
  { value: "DRAFT", label: "Rascunho" },
  { value: "IN_REVIEW", label: "Em revisão" },
  { value: "APPROVED", label: "Aprovado" },
  { value: "REJECTED", label: "Rejeitado" },
  { value: "ARCHIVED", label: "Arquivado" },
  { value: "EXPIRED", label: "Expirado" },
];

export interface DocumentFiltersBarProps {
  readonly filters: DocumentListFiltersState;
  readonly categories: readonly CategorySummaryRecord[];
  readonly folders: readonly FolderRecord[];
  readonly owners: readonly OwnerFilterOption[];
  readonly onUpdateFilters: (patch: Partial<DocumentListFiltersState>) => void;
  readonly onClearFilters: () => void;
  readonly onOpenUpload: () => void;
}

/**
 * Document repository filter toolbar exposing search, category, folder, status,
 * owner, and expiration date range controls in pt-BR.
 */
export function DocumentFiltersBar({
  filters,
  categories,
  folders,
  owners,
  onUpdateFilters,
  onClearFilters,
  onOpenUpload,
}: DocumentFiltersBarProps) {
  const hasActiveFilters =
    filters.search.trim().length > 0 ||
    filters.categoryId.length > 0 ||
    filters.folderId.length > 0 ||
    filters.status.length > 0 ||
    filters.ownerUserId.length > 0 ||
    filters.expirationFrom.length > 0 ||
    filters.expirationTo.length > 0;

  const isDateRangeValid = isValidExpirationRange(filters.expirationFrom, filters.expirationTo);

  const selectFilters: FilterBarSelect[] = [
    {
      id: "category",
      label: "Categoria",
      value: filters.categoryId,
      allOptionLabel: "Todas as categorias",
      options: categories.map((cat) => ({ value: cat.id, label: cat.name })),
      onChange: (value) => onUpdateFilters({ categoryId: value, page: 1 }),
    },
    {
      id: "folder",
      label: "Pasta",
      value: filters.folderId,
      allOptionLabel: "Todas as pastas",
      options: folders.map((folder) => ({ value: folder.id, label: folder.name })),
      onChange: (value) => onUpdateFilters({ folderId: value, page: 1 }),
    },
    {
      id: "status",
      label: "Status",
      value: filters.status,
      allOptionLabel: "Todos os status",
      options: DOCUMENT_STATUS_FILTER_OPTIONS,
      onChange: (value) =>
        onUpdateFilters({
          status: value as DocumentStatus | "",
          page: 1,
        }),
    },
    {
      id: "owner",
      label: "Responsável",
      value: filters.ownerUserId,
      allOptionLabel: "Todos os responsáveis",
      options: owners.map((owner) => ({ value: owner.id, label: owner.label })),
      onChange: (value) => onUpdateFilters({ ownerUserId: value, page: 1 }),
    },
  ];

  return (
    <Stack spacing={1.5}>
      <FilterBar
        searchValue={filters.search}
        onSearchChange={(value) => onUpdateFilters({ search: value, page: 1 })}
        searchLabel="Pesquisar documento"
        searchPlaceholder="Título ou nome do arquivo..."
        filters={selectFilters}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={onClearFilters}
        actions={
          <Button
            variant="contained"
            startIcon={<CloudUploadOutlinedIcon />}
            onClick={onOpenUpload}
          >
            Enviar documentos
          </Button>
        }
      />

      <Paper
        sx={{
          px: 2,
          py: 1.5,
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          alignItems={{ xs: "stretch", sm: "center" }}
          flexWrap="wrap"
        >
          <Typography variant="body2" color="text.secondary" fontWeight={500}>
            Vencimento:
          </Typography>

          <TextField
            type="date"
            label="Vencimento a partir de"
            size="small"
            value={filters.expirationFrom}
            onChange={(event) => onUpdateFilters({ expirationFrom: event.target.value, page: 1 })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 190 }}
          />

          <TextField
            type="date"
            label="Vencimento até"
            size="small"
            value={filters.expirationTo}
            error={!isDateRangeValid}
            onChange={(event) => onUpdateFilters({ expirationTo: event.target.value, page: 1 })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 190 }}
          />
        </Stack>

        {!isDateRangeValid ? (
          <Alert severity="warning" role="alert" sx={{ mt: 1.5 }}>
            A data final de vencimento deve ser maior ou igual à data inicial.
          </Alert>
        ) : null}
      </Paper>
    </Stack>
  );
}
