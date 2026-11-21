import type { DocumentListItem, DocumentStatus } from "@docuflow/contracts";
import { DataTable, type DataTableColumn } from "@docuflow/ui";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import { Box, Button, Chip, Stack, Typography } from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DocumentFiltersBar } from "./DocumentFiltersBar.js";
import { UploadDialog } from "./UploadDialog.js";
import {
  DEFAULT_DOCUMENT_LIST_FILTERS,
  type DocumentListFiltersState,
  type DocumentListSortField,
  useDocumentListCategoriesQuery,
  useDocumentListFoldersQuery,
  useDocumentListQuery,
  useDocumentOwnersQuery,
} from "./useDocumentList.js";

const DOCUMENT_STATUS_BADGE: Readonly<
  Record<
    DocumentStatus,
    { readonly label: string; readonly color: "default" | "info" | "success" | "warning" | "error" }
  >
> = {
  DRAFT: { label: "Rascunho", color: "default" },
  IN_REVIEW: { label: "Em revisão", color: "info" },
  APPROVED: { label: "Aprovado", color: "success" },
  REJECTED: { label: "Rejeitado", color: "error" },
  ARCHIVED: { label: "Arquivado", color: "default" },
  EXPIRED: { label: "Expirado", color: "warning" },
  DELETED: { label: "Excluído", color: "error" },
};

const SERVER_SORTABLE_FIELDS = new Set<string>([
  "title",
  "status",
  "issueDate",
  "expirationDate",
  "createdAt",
  "updatedAt",
  "id",
]);

function formatIsoDatePtBr(isoDate: string | null): string {
  if (!isoDate) {
    return "Não informado";
  }
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) {
    return isoDate;
  }
  return `${day}/${month}/${year}`;
}

function formatDateTimePtBr(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

/**
 * Authorized document repository listing page with server-controlled filtering,
 * sorting, pagination, and navigation to document detail pages.
 */
export function DocumentListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);

  const [filters, setFilters] = useState<DocumentListFiltersState>(() => ({
    ...DEFAULT_DOCUMENT_LIST_FILTERS,
    search: searchParams.get("search") ?? "",
  }));

  const categoriesQuery = useDocumentListCategoriesQuery();
  const foldersQuery = useDocumentListFoldersQuery();
  const ownersQuery = useDocumentOwnersQuery();
  const documentsQuery = useDocumentListQuery(filters);

  const categories = categoriesQuery.data ?? [];
  const folders = foldersQuery.data ?? [];
  const owners = ownersQuery.data ?? [];

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );
  const folderNameById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );

  const updateFilters = (patch: Partial<DocumentListFiltersState>): void => {
    setFilters((prev) => ({
      ...prev,
      ...patch,
    }));
  };

  const clearFilters = (): void => {
    setFilters((prev) => ({
      ...DEFAULT_DOCUMENT_LIST_FILTERS,
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
      sortBy: field as DocumentListSortField,
      sortDirection: direction,
      page: 1,
    });
  };

  const columns: DataTableColumn<DocumentListItem>[] = [
    {
      id: "title",
      label: "Título",
      sortable: true,
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.title}
        </Typography>
      ),
    },
    {
      id: "categoryId",
      label: "Categoria",
      sortable: false,
      render: (row) => categoryNameById.get(row.categoryId) ?? "Categoria restrita/arquivada",
    },
    {
      id: "folderId",
      label: "Pasta",
      sortable: false,
      render: (row) =>
        row.folderId === null
          ? "Sem pasta (raiz)"
          : (folderNameById.get(row.folderId) ?? "Pasta restrita"),
    },
    {
      id: "status",
      label: "Status",
      sortable: true,
      render: (row) => {
        const badge = DOCUMENT_STATUS_BADGE[row.status];
        return <Chip label={badge.label} color={badge.color} size="small" />;
      },
    },
    {
      id: "expirationDate",
      label: "Vencimento",
      sortable: true,
      render: (row) => formatIsoDatePtBr(row.expirationDate),
    },
    {
      id: "updatedAt",
      label: "Atualizado em",
      sortable: true,
      render: (row) => formatDateTimePtBr(row.updatedAt),
    },
    {
      id: "actions",
      label: "Ações",
      align: "right",
      render: (row) => (
        <Button
          size="small"
          variant="text"
          endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            void navigate(`/documentos/${row.id}`);
          }}
          aria-label={`Abrir ${row.title}`}
        >
          Abrir
        </Button>
      ),
    },
  ];

  const responseData = documentsQuery.data;
  const rows = responseData?.items ?? [];
  const totalItems = responseData?.pagination.totalItems ?? 0;

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h1" gutterBottom>
          Documentos
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Pesquisa, filtros, paginação e gestão de documentos autorizados no servidor.
        </Typography>
      </Box>

      <DocumentFiltersBar
        filters={filters}
        categories={categories}
        folders={folders}
        owners={owners}
        onUpdateFilters={updateFilters}
        onClearFilters={clearFilters}
        onOpenUpload={() => setUploadOpen(true)}
      />

      <DataTable
        ariaLabel="Tabela de documentos"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        page={filters.page}
        pageSize={filters.pageSize}
        totalItems={totalItems}
        onPageChange={(nextPage) => updateFilters({ page: nextPage })}
        onPageSizeChange={(nextPageSize) => updateFilters({ pageSize: nextPageSize, page: 1 })}
        sortBy={filters.sortBy}
        sortDirection={filters.sortDirection}
        onSortChange={handleSortChange}
        onRowClick={(row) => void navigate(`/documentos/${row.id}`)}
        loading={documentsQuery.isLoading}
        errorMessage={documentsQuery.isError ? documentsQuery.error.message : null}
        onRetry={() => void documentsQuery.refetch()}
        emptyTitle="Nenhum documento encontrado"
        emptyDescription="Nenhum documento autorizado corresponde aos filtros selecionados."
        emptyActionLabel="Enviar documentos"
        onEmptyAction={() => setUploadOpen(true)}
      />

      <UploadDialog
        open={uploadOpen}
        categories={categories.map((cat) => ({ id: cat.id, name: cat.name }))}
        folders={folders.map((folder) => ({ id: folder.id, name: folder.name }))}
        onUploadBatchFinished={() => {
          void queryClient.invalidateQueries({ queryKey: ["documents", "search"] });
        }}
        onClose={() => setUploadOpen(false)}
      />
    </Stack>
  );
}
