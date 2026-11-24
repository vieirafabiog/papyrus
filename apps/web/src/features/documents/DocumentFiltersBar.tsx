import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import { Alert, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import type { CategorySummaryRecord, DocumentStatus, FolderRecord } from "@papyrus/contracts";
import { FilterBar, type FilterBarSelect, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useI18n } from "../../i18n/index.js";
import { buildFolderTreeOptions } from "../folders/folderTree.js";
import {
  type DocumentListFiltersState,
  type OwnerFilterOption,
  isValidExpirationRange,
} from "./useDocumentList.js";

const DOCUMENT_STATUS_VALUES: readonly DocumentStatus[] = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "ARCHIVED",
  "EXPIRED",
];

export interface DocumentFiltersBarProps {
  readonly filters: DocumentListFiltersState;
  readonly categories: readonly CategorySummaryRecord[];
  readonly folders: readonly FolderRecord[];
  readonly owners: readonly OwnerFilterOption[];
  readonly onUpdateFilters: (patch: Partial<DocumentListFiltersState>) => void;
  readonly onClearFilters: () => void;
  readonly onOpenUpload: () => void;
  readonly onOpenTrash?: (() => void) | undefined;
}

/**
 * Document library filter toolbar exposing search, category, folder, status,
 * owner, and expiration date range controls.
 */
export function DocumentFiltersBar({
  filters,
  categories,
  folders,
  owners,
  onUpdateFilters,
  onClearFilters,
  onOpenUpload,
  onOpenTrash,
}: DocumentFiltersBarProps) {
  const { locale, t } = useI18n();

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
      label: t("documents.filters.category"),
      value: filters.categoryId,
      allOptionLabel: t("documents.filters.allCategories"),
      options: categories.map((cat) => ({ value: cat.id, label: cat.name })),
      onChange: (value) => onUpdateFilters({ categoryId: value, page: 1 }),
    },
    {
      id: "folder",
      label: t("documents.filters.folder"),
      value: filters.folderId,
      allOptionLabel: t("documents.filters.allFolders"),
      options: buildFolderTreeOptions(folders, locale).map((folder) => ({
        value: folder.id,
        label: folder.treeLabel,
      })),
      onChange: (value) => onUpdateFilters({ folderId: value, page: 1 }),
    },
    {
      id: "status",
      label: t("documents.filters.status"),
      value: filters.status,
      allOptionLabel: t("documents.filters.allStatuses"),
      options: DOCUMENT_STATUS_VALUES.map((status) => ({
        value: status,
        label: t(`documents.status.${status}`),
      })),
      onChange: (value) =>
        onUpdateFilters({
          status: value as DocumentStatus | "",
          page: 1,
        }),
    },
    {
      id: "owner",
      label: t("documents.filters.owner"),
      value: filters.ownerUserId,
      allOptionLabel: t("documents.filters.allOwners"),
      options: owners.map((owner) => ({ value: owner.id, label: owner.label })),
      onChange: (value) => onUpdateFilters({ ownerUserId: value, page: 1 }),
    },
  ];

  return (
    <Stack spacing={1.5}>
      <FilterBar
        searchValue={filters.search}
        onSearchChange={(value) => onUpdateFilters({ search: value, page: 1 })}
        searchLabel={t("documents.filters.searchLabel")}
        searchPlaceholder={t("documents.filters.searchPlaceholder")}
        filters={selectFilters}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={onClearFilters}
        actions={
          <Stack direction="row" spacing={1}>
            {onOpenTrash ? (
              <Button
                variant="outlined"
                startIcon={<DeleteSweepOutlinedIcon />}
                onClick={onOpenTrash}
              >
                {t("documents.filters.trashButton")}
              </Button>
            ) : null}
            <Button
              variant="contained"
              startIcon={<CloudUploadOutlinedIcon />}
              onClick={onOpenUpload}
            >
              {t("documents.list.uploadAction")}
            </Button>
          </Stack>
        }
      />

      <Paper
        sx={{
          px: 2,
          py: 1.5,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          alignItems={{ xs: "stretch", sm: "center" }}
          flexWrap="wrap"
        >
          <Typography variant="body2" color="text.secondary" fontWeight={500}>
            {t("documents.filters.expirationLabel")}
          </Typography>

          <TextField
            type="date"
            label={t("documents.filters.expirationFrom")}
            size="small"
            value={filters.expirationFrom}
            onChange={(event) => onUpdateFilters({ expirationFrom: event.target.value, page: 1 })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 190 }}
          />

          <TextField
            type="date"
            label={t("documents.filters.expirationTo")}
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
            {t("documents.filters.invalidExpirationRange")}
          </Alert>
        ) : null}
      </Paper>
    </Stack>
  );
}
