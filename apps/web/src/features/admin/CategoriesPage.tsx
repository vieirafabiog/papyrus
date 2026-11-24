import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import BlockOutlinedIcon from "@mui/icons-material/BlockOutlined";
import CategoryOutlinedIcon from "@mui/icons-material/CategoryOutlined";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import { Alert, Box, Button, Chip, Stack, Typography } from "@mui/material";
import type { CategorySummaryRecord } from "@papyrus/contracts";
import {
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  ErrorState,
  FilterBar,
  LoadingState,
} from "@papyrus/ui";
import { useCallback, useMemo, useState } from "react";
import { useSessionQuery } from "../../app/session.js";
import { useI18n } from "../../i18n/index.js";
import { CategoryEditor, type CategoryEditorFeedback } from "./CategoryEditor.js";
import {
  canCreateCategories,
  canDeleteCategories,
  canEditCategories,
  useAdminCategoriesQuery,
  useDeactivateCategoryMutation,
  useUpdateCategoryMutation,
} from "./useCategoriesAdmin.js";
import { canManageStorage } from "./useStorageSettings.js";

/**
 * Category and custom metadata management page wired at /categories.
 */
export function CategoriesPage() {
  const { t, formatDateTime } = useI18n();
  const sessionQuery = useSessionQuery();
  const [search, setSearch] = useState("");
  const [isActiveFilter, setIsActiveFilter] = useState<"true" | "false" | "">("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<"name" | "isActive" | "createdAt" | "updatedAt">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorCategory, setEditorCategory] = useState<CategorySummaryRecord | null>(null);
  const [feedback, setFeedback] = useState<CategoryEditorFeedback | null>(null);
  const [pendingDeactivate, setPendingDeactivate] = useState<CategorySummaryRecord | null>(null);

  const canCreate = canCreateCategories(sessionQuery.data);
  const canEdit = canEditCategories(sessionQuery.data);
  const canDelete = canDeleteCategories(sessionQuery.data);
  const canManageStoragePolicy = canManageStorage(sessionQuery.data);

  const categoriesQuery = useAdminCategoriesQuery(
    {
      search,
      isActive: isActiveFilter,
      page,
      pageSize,
      sortBy,
      sortDirection,
    },
    Boolean(sessionQuery.data),
  );
  const deactivateMutation = useDeactivateCategoryMutation();
  const updateMutation = useUpdateCategoryMutation();

  async function handleConfirmDeactivate() {
    if (!pendingDeactivate) {
      return;
    }
    setFeedback(null);
    try {
      const updated = await deactivateMutation.mutateAsync(pendingDeactivate.id);
      setPendingDeactivate(null);
      setFeedback({
        severity: "success",
        text: t("admin.categories.feedback.deactivated", { name: updated.name }),
      });
    } catch (error) {
      setPendingDeactivate(null);
      setFeedback({
        severity: "error",
        text:
          error instanceof Error ? error.message : t("admin.categories.errors.deactivateFailed"),
      });
    }
  }

  const handleReactivateCategory = useCallback(
    async (category: CategorySummaryRecord) => {
      setFeedback(null);
      try {
        const updated = await updateMutation.mutateAsync({
          categoryId: category.id,
          payload: { isActive: true },
        });
        setFeedback({
          severity: "success",
          text: t("admin.categories.feedback.reactivated", { name: updated.name }),
        });
      } catch (error) {
        setFeedback({
          severity: "error",
          text:
            error instanceof Error ? error.message : t("admin.categories.errors.reactivateFailed"),
        });
      }
    },
    [updateMutation.mutateAsync, t],
  );

  const columns: readonly DataTableColumn<CategorySummaryRecord>[] = useMemo(
    () => [
      {
        id: "name",
        label: t("admin.categories.table.category"),
        sortable: true,
        render: (row) => (
          <Stack spacing={0.5}>
            <Stack direction="row" spacing={1} alignItems="center">
              {row.color ? (
                <Box
                  aria-hidden="true"
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    bgcolor: row.color,
                    border: "1px solid rgba(0,0,0,0.12)",
                    flexShrink: 0,
                  }}
                />
              ) : null}
              <Typography variant="body2" fontWeight={600}>
                {row.name}
              </Typography>
            </Stack>
            {row.description ? (
              <Typography variant="caption" color="text.secondary">
                {row.description}
              </Typography>
            ) : null}
          </Stack>
        ),
      },
      {
        id: "isActive",
        label: t("admin.common.status"),
        sortable: true,
        width: 120,
        render: (row) => (
          <Chip
            label={
              row.isActive
                ? t("admin.categories.table.statusActive")
                : t("admin.categories.table.statusInactive")
            }
            color={row.isActive ? "success" : "default"}
            size="small"
          />
        ),
      },
      {
        id: "updatedAt",
        label: t("admin.common.updatedAt"),
        sortable: true,
        width: 180,
        render: (row) => (
          <Typography variant="body2" color="text.secondary">
            {formatDateTime(row.updatedAt)}
          </Typography>
        ),
      },
      {
        id: "actions",
        label: t("admin.common.actions"),
        align: "right",
        render: (row) => (
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button
              size="small"
              variant="outlined"
              startIcon={<EditOutlinedIcon />}
              onClick={() => {
                setEditorCategory(row);
                setEditorOpen(true);
              }}
            >
              {canEdit
                ? t("admin.categories.actions.configureFieldsAndStorage")
                : t("admin.categories.actions.viewFields")}
            </Button>
            {canDelete && row.isActive ? (
              <Button
                size="small"
                variant="text"
                color="warning"
                startIcon={<BlockOutlinedIcon />}
                disabled={deactivateMutation.isPending}
                onClick={() => setPendingDeactivate(row)}
              >
                {t("admin.common.deactivate")}
              </Button>
            ) : null}
            {canEdit && !row.isActive ? (
              <Button
                size="small"
                variant="text"
                color="primary"
                startIcon={<CheckCircleOutlineOutlinedIcon />}
                disabled={updateMutation.isPending}
                onClick={() => void handleReactivateCategory(row)}
              >
                {t("admin.common.reactivate")}
              </Button>
            ) : null}
          </Stack>
        ),
      },
    ],
    [
      t,
      formatDateTime,
      canEdit,
      canDelete,
      deactivateMutation.isPending,
      updateMutation.isPending,
      handleReactivateCategory,
    ],
  );

  if (sessionQuery.isLoading) {
    return <LoadingState message={t("admin.common.sessionLoading")} />;
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

  const rows = categoriesQuery.data?.items ?? [];
  const totalItems = categoriesQuery.data?.pagination.totalItems ?? 0;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <CategoryOutlinedIcon color="primary" fontSize="large" />
          <Box>
            <Typography variant="h1" component="h1">
              {t("admin.categories.title")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("admin.categories.subtitle")}
            </Typography>
          </Box>
        </Stack>
        {canCreate ? (
          <Button
            variant="contained"
            startIcon={<AddOutlinedIcon />}
            onClick={() => {
              setEditorCategory(null);
              setEditorOpen(true);
            }}
          >
            {t("admin.categories.actions.newCategory")}
          </Button>
        ) : null}
      </Stack>

      {feedback ? (
        <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
          {feedback.text}
        </Alert>
      ) : null}

      <FilterBar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchLabel={t("admin.categories.filters.searchLabel")}
        searchPlaceholder={t("admin.categories.filters.searchPlaceholder")}
        filters={[
          {
            id: "category-active-status",
            label: t("admin.common.status"),
            value: isActiveFilter,
            allOptionLabel: t("admin.categories.filters.all"),
            options: [
              { value: "true", label: t("admin.categories.filters.active") },
              { value: "false", label: t("admin.categories.filters.inactive") },
            ],
            onChange: (value) => {
              setIsActiveFilter(value as "true" | "false" | "");
              setPage(1);
            },
          },
        ]}
        hasActiveFilters={search.trim().length > 0 || isActiveFilter.length > 0}
        onClearFilters={() => {
          setSearch("");
          setIsActiveFilter("");
          setPage(1);
        }}
      />

      <DataTable
        ariaLabel={t("admin.categories.table.ariaLabel")}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        page={page}
        pageSize={pageSize}
        totalItems={totalItems}
        onPageChange={(nextPage) => setPage(nextPage)}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortChange={(field, direction) => {
          if (
            field === "name" ||
            field === "isActive" ||
            field === "createdAt" ||
            field === "updatedAt"
          ) {
            setSortBy(field);
            setSortDirection(direction);
            setPage(1);
          }
        }}
        loading={categoriesQuery.isLoading}
        errorMessage={categoriesQuery.isError ? categoriesQuery.error.message : null}
        onRetry={() => void categoriesQuery.refetch()}
        emptyTitle={t("admin.categories.table.emptyTitle")}
        emptyDescription={
          canCreate
            ? t("admin.categories.table.emptyDescriptionCanCreate")
            : t("admin.categories.table.emptyDescriptionReadOnly")
        }
        {...(canCreate
          ? {
              emptyActionLabel: t("admin.categories.actions.newCategory"),
              onEmptyAction: () => {
                setEditorCategory(null);
                setEditorOpen(true);
              },
            }
          : {})}
      />

      <CategoryEditor
        open={editorOpen}
        category={editorCategory}
        canEditCategory={editorCategory === null ? canCreate : canEdit}
        canManageStoragePolicy={canManageStoragePolicy}
        onClose={() => {
          setEditorOpen(false);
          setEditorCategory(null);
        }}
        onFeedback={(nextFeedback) => setFeedback(nextFeedback)}
      />

      <ConfirmDialog
        open={pendingDeactivate !== null}
        title={t("admin.categories.confirmDeactivate.title")}
        description={t("admin.categories.confirmDeactivate.description", {
          name: pendingDeactivate?.name ?? "",
        })}
        confirmLabel={t("admin.common.deactivate")}
        confirmColor="warning"
        loading={deactivateMutation.isPending}
        onConfirm={() => void handleConfirmDeactivate()}
        onCancel={() => setPendingDeactivate(null)}
      />
    </Stack>
  );
}
