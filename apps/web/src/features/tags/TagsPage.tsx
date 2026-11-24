import type { TagRecord } from "@docuflow/contracts";
import { DataTable, type DataTableColumn, FilterBar } from "@docuflow/ui";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type FormEvent, useMemo, useState } from "react";
import { containsTechnicalJargon } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";
import { useCreateTagMutation, useTagsQuery } from "./useTagsApi.js";

/**
 * Organization tags administration and search page wired to the tags backend.
 */
export function TagsPage() {
  const { t, formatDate } = useI18n();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#00639B");
  const [formError, setFormError] = useState<string | null>(null);

  const tagsQuery = useTagsQuery(search, page, pageSize);
  const createTagMutation = useCreateTagMutation();

  const columns: readonly DataTableColumn<TagRecord>[] = useMemo(
    () => [
      {
        id: "name",
        label: t("tags.page.columns.tag"),
        render: (row) => (
          <Chip
            label={row.name}
            size="small"
            variant="outlined"
            sx={row.color ? { borderColor: row.color } : undefined}
          />
        ),
      },
      {
        id: "normalizedName",
        label: t("tags.page.columns.normalizedName"),
        render: (row) => (
          <Typography variant="body2" color="text.secondary">
            {row.normalizedName}
          </Typography>
        ),
      },
      {
        id: "color",
        label: t("tags.page.columns.color"),
        render: (row) =>
          row.color ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Box
                sx={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  bgcolor: row.color,
                  border: "1px solid",
                  borderColor: "divider",
                }}
              />
              <Typography variant="body2">{row.color}</Typography>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t("tags.page.defaultColor")}
            </Typography>
          ),
      },
      {
        id: "createdAt",
        label: t("tags.page.columns.createdAt"),
        render: (row) => <Typography variant="body2">{formatDate(row.createdAt)}</Typography>,
      },
    ],
    [t, formatDate],
  );

  const handleOpenCreate = () => {
    setFormError(null);
    setTagName("");
    setTagColor("#00639B");
    setCreateOpen(true);
  };

  const handleSubmitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = tagName.trim();
    if (trimmedName.length === 0) {
      setFormError(t("tags.page.nameRequired"));
      return;
    }

    setFormError(null);
    try {
      await createTagMutation.mutateAsync({
        name: trimmedName,
        color: tagColor.trim().length > 0 ? tagColor.trim() : null,
      });
      setCreateOpen(false);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setFormError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("tags.page.createFailed"),
      );
    }
  };

  const rows = tagsQuery.data?.items ?? [];
  const totalItems = tagsQuery.data?.pagination.totalItems ?? 0;

  return (
    <Stack spacing={2.5}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Box>
          <Typography variant="h1" gutterBottom>
            {t("tags.page.title")}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t("tags.page.subtitle")}
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddOutlinedIcon />} onClick={handleOpenCreate}>
          {t("tags.page.newTagButton")}
        </Button>
      </Box>

      <FilterBar
        searchValue={search}
        onSearchChange={(next) => {
          setSearch(next);
          setPage(1);
        }}
        searchLabel={t("tags.page.searchLabel")}
        searchPlaceholder={t("tags.page.searchPlaceholder")}
        hasActiveFilters={search.trim().length > 0}
        onClearFilters={() => {
          setSearch("");
          setPage(1);
        }}
      />

      <DataTable
        ariaLabel={t("tags.page.tableAriaLabel")}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        page={page}
        pageSize={pageSize}
        totalItems={totalItems}
        onPageChange={setPage}
        onPageSizeChange={(nextSize) => {
          setPageSize(nextSize);
          setPage(1);
        }}
        loading={tagsQuery.isLoading}
        errorMessage={tagsQuery.isError ? tagsQuery.error.message : null}
        onRetry={() => void tagsQuery.refetch()}
        emptyTitle={t("tags.page.emptyTitle")}
        emptyDescription={t("tags.page.emptyDescription")}
        emptyActionLabel={t("tags.page.newTagButton")}
        onEmptyAction={handleOpenCreate}
      />

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="xs">
        <form onSubmit={(event) => void handleSubmitCreate(event)}>
          <DialogTitle>{t("tags.page.dialogTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              {formError ? <Alert severity="error">{formError}</Alert> : null}
              <TextField
                autoFocus
                required
                label={t("tags.page.tagNameLabel")}
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
                inputProps={{ maxLength: 64 }}
              />
              <TextField
                label={t("tags.page.tagColorLabel")}
                value={tagColor}
                onChange={(event) => setTagColor(event.target.value)}
                helperText={t("tags.page.tagColorHelper")}
                inputProps={{ maxLength: 7 }}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)} disabled={createTagMutation.isPending}>
              {t("documents.common.cancel")}
            </Button>
            <Button type="submit" variant="contained" disabled={createTagMutation.isPending}>
              {t("tags.page.saveTag")}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
