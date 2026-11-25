import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import { Box, Button, Chip, Stack, Typography } from "@mui/material";
import type { DocumentListItem, DocumentStatus } from "@papyrus/contracts";
import { DataTable, type DataTableColumn } from "@papyrus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { HighlightedSnippet } from "../../components/HighlightedSnippet.js";
import { useI18n } from "../../i18n/index.js";
import { buildFolderTreeOptions } from "../folders/folderTree.js";
import { DocumentBulkActionBar } from "./DocumentBulkActionBar.js";
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

const DOCUMENT_STATUS_COLOR: Readonly<
  Record<DocumentStatus, "default" | "info" | "success" | "warning" | "error">
> = {
  DRAFT: "default",
  IN_REVIEW: "info",
  APPROVED: "success",
  REJECTED: "error",
  ARCHIVED: "default",
  EXPIRED: "warning",
  DELETED: "error",
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

function formatIsoCalendarDate(
  isoDate: string | null,
  formatDateFn: (value: string | Date | null | undefined, emptyFallback?: string) => string,
  emptyFallback: string,
): string {
  if (!isoDate) {
    return emptyFallback;
  }
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) {
    return isoDate;
  }
  const localDate = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(localDate.getTime())) {
    return isoDate;
  }
  return formatDateFn(localDate, emptyFallback);
}

/**
 * Authorized document library listing page with server-controlled filtering,
 * sorting, pagination, and navigation to document detail pages.
 */
export function DocumentListPage() {
  const { locale, t, formatDate, formatDateTime } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

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
  const folderPathById = useMemo(
    () =>
      new Map(
        buildFolderTreeOptions(folders, locale).map((folder) => [folder.id, folder.fullPath]),
      ),
    [folders, locale],
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

  const notProvided = t("documents.common.notProvided");

  const columns: DataTableColumn<DocumentListItem>[] = [
    {
      id: "title",
      label: t("documents.list.columns.title"),
      sortable: true,
      render: (row) => (
        <Stack spacing={0.25}>
          <Typography variant="body2" fontWeight={500}>
            {row.title}
          </Typography>
          {row.contentSnippet ? <HighlightedSnippet text={row.contentSnippet} /> : null}
        </Stack>
      ),
    },
    {
      id: "categoryId",
      label: t("documents.list.columns.category"),
      sortable: false,
      render: (row) =>
        categoryNameById.get(row.categoryId) ?? t("documents.list.restrictedCategory"),
    },
    {
      id: "folderId",
      label: t("documents.list.columns.folder"),
      sortable: false,
      render: (row) =>
        row.folderId === null
          ? t("documents.common.noFolderRoot")
          : (folderPathById.get(row.folderId) ?? t("documents.list.restrictedFolder")),
    },
    {
      id: "status",
      label: t("documents.list.columns.status"),
      sortable: true,
      render: (row) => (
        <Chip
          label={t(`documents.status.${row.status}`)}
          color={DOCUMENT_STATUS_COLOR[row.status]}
          size="small"
        />
      ),
    },
    {
      id: "expirationDate",
      label: t("documents.list.columns.expirationDate"),
      sortable: true,
      render: (row) => formatIsoCalendarDate(row.expirationDate, formatDate, notProvided),
    },
    {
      id: "updatedAt",
      label: t("documents.list.columns.updatedAt"),
      sortable: true,
      render: (row) => formatDateTime(row.updatedAt, notProvided),
    },
    {
      id: "actions",
      label: t("documents.list.columns.actions"),
      align: "right",
      render: (row) => (
        <Button
          size="small"
          variant="text"
          endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            void navigate(`/documents/${row.id}`);
          }}
          aria-label={t("documents.list.openDocumentAria", { title: row.title })}
        >
          {t("documents.common.open")}
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
          {t("documents.list.title")}
        </Typography>
        <Typography variant="body1" color="text.secondary">
          {t("documents.list.subtitle")}
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
        onOpenTrash={() => void navigate("/trash")}
      />

      <DocumentBulkActionBar
        selectedIds={selectedIds}
        folders={folders}
        onClearSelection={() => setSelectedIds([])}
      />

      <DataTable
        ariaLabel={t("documents.list.tableAriaLabel")}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        page={filters.page}
        pageSize={filters.pageSize}
        totalItems={totalItems}
        onPageChange={(nextPage) => updateFilters({ page: nextPage })}
        onPageSizeChange={(nextPageSize) => updateFilters({ pageSize: nextPageSize, page: 1 })}
        sortBy={filters.sortBy}
        sortDirection={filters.sortDirection}
        onSortChange={handleSortChange}
        onRowClick={(row) => void navigate(`/documents/${row.id}`)}
        loading={documentsQuery.isLoading}
        errorMessage={documentsQuery.isError ? documentsQuery.error.message : null}
        onRetry={() => void documentsQuery.refetch()}
        emptyTitle={t("documents.list.emptyTitle")}
        emptyDescription={t("documents.list.emptyDescription")}
        emptyActionLabel={t("documents.list.uploadAction")}
        onEmptyAction={() => setUploadOpen(true)}
      />

      <UploadDialog
        open={uploadOpen}
        categories={categories.map((cat) => ({
          id: cat.id,
          name: cat.name,
          textIndexingMode: cat.textIndexingMode,
        }))}
        folders={folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          parentId: folder.parentId,
        }))}
        createDocumentOnFinalize
        onUploadBatchFinished={() => {
          void queryClient.invalidateQueries({ queryKey: ["documents", "search"] });
        }}
        onClose={() => setUploadOpen(false)}
      />
    </Stack>
  );
}
