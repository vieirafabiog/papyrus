import type {
  RestoreTrashedDocumentTargetStatus,
  TrashDocumentListItem,
  TrashDocumentsSortField,
} from "@docuflow/contracts";
import { DataTable, type DataTableColumn, FilterBar, PAPYRUS_COLOR_TOKENS } from "@docuflow/ui";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import RestoreFromTrashOutlinedIcon from "@mui/icons-material/RestoreFromTrashOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { containsTechnicalJargon } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";
import { useRestoreTrashedDocumentMutation, useTrashDocumentsQuery } from "./useDocumentDetails.js";

const SERVER_SORTABLE_FIELDS = new Set<string>(["deletedAt", "title", "updatedAt"]);

/**
 * Trash bin management page listing authorized deleted documents,
 * restore deadline windows, and accessible confirmation dialogs to recover items.
 */
export function TrashDocumentsPage() {
  const { t, formatDateTime } = useI18n();
  const navigate = useNavigate();
  const dialogTitleId = useId();
  const dialogDescId = useId();

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<TrashDocumentsSortField>("deletedAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const [selectedDoc, setSelectedDoc] = useState<TrashDocumentListItem | null>(null);
  const [targetStatus, setTargetStatus] = useState<RestoreTrashedDocumentTargetStatus>("DRAFT");
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const trashQuery = useTrashDocumentsQuery({
    search: search.trim().length > 0 ? search.trim() : undefined,
    page,
    pageSize,
    sortBy,
    sortDirection,
  });

  const restoreMutation = useRestoreTrashedDocumentMutation();

  const handleSortChange = (field: string, direction: "asc" | "desc"): void => {
    if (!SERVER_SORTABLE_FIELDS.has(field)) {
      return;
    }
    setSortBy(field as TrashDocumentsSortField);
    setSortDirection(direction);
    setPage(1);
  };

  const openRestoreDialog = (doc: TrashDocumentListItem): void => {
    setSelectedDoc(doc);
    setTargetStatus("DRAFT");
    setReason("");
    setDialogError(null);
  };

  const closeRestoreDialog = (): void => {
    if (restoreMutation.isPending) {
      return;
    }
    setSelectedDoc(null);
    setDialogError(null);
  };

  const handleConfirmRestore = async (): Promise<void> => {
    if (!selectedDoc) {
      return;
    }
    setDialogError(null);
    const trimmedReason = reason.trim();

    try {
      const restored = await restoreMutation.mutateAsync({
        documentId: selectedDoc.id,
        payload: {
          expectedVersion: selectedDoc.version,
          targetStatus,
          ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        },
      });
      setSelectedDoc(null);
      setReason("");
      const statusLabel =
        restored.status === "ARCHIVED"
          ? t("documents.status.ARCHIVED")
          : t("documents.status.DRAFT");
      setFeedback({
        severity: "success",
        message: t("documents.trash.restoreSuccess", {
          title: restored.title,
          status: statusLabel,
        }),
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      const message =
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("documents.trash.restoreFailed");
      setDialogError(message);
      setFeedback({ severity: "error", message });
    }
  };

  const notProvided = t("documents.common.notProvidedFem");

  const columns: DataTableColumn<TrashDocumentListItem>[] = [
    {
      id: "title",
      label: t("documents.trash.columns.title"),
      sortable: true,
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.title}
        </Typography>
      ),
    },
    {
      id: "categoryId",
      label: t("documents.trash.columns.category"),
      sortable: false,
      render: (row) => row.categoryName ?? t("documents.trash.restrictedCategory"),
    },
    {
      id: "deletedAt",
      label: t("documents.trash.columns.deletedAt"),
      sortable: true,
      render: (row) => formatDateTime(row.deletedAt, notProvided),
    },
    {
      id: "restoreDeadlineAt",
      label: t("documents.trash.columns.restoreDeadline"),
      sortable: false,
      render: (row) => (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="body2">
            {formatDateTime(row.restoreDeadlineAt, notProvided)}
          </Typography>
          <Chip
            size="small"
            color={row.canRestore ? "success" : "error"}
            label={
              row.canRestore
                ? t("documents.trash.statusAvailable")
                : t("documents.trash.statusExpired")
            }
          />
        </Stack>
      ),
    },
    {
      id: "actions",
      label: t("documents.trash.columns.actions"),
      align: "right",
      render: (row) => (
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            size="small"
            variant="text"
            endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
            onClick={(event) => {
              event.stopPropagation();
              void navigate(`/documents/${row.id}`);
            }}
            aria-label={t("documents.trash.openAria", { title: row.title })}
          >
            {t("documents.trash.detailsButton")}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<RestoreFromTrashOutlinedIcon fontSize="small" />}
            disabled={!row.canRestore}
            onClick={(event) => {
              event.stopPropagation();
              openRestoreDialog(row);
            }}
            aria-label={t("documents.trash.restoreAria", { title: row.title })}
          >
            {t("documents.trash.restoreButton")}
          </Button>
        </Stack>
      ),
    },
  ];

  const rows = trashQuery.data?.items ?? [];
  const totalItems = trashQuery.data?.pagination.totalItems ?? 0;

  return (
    <Stack spacing={2.5}>
      <Paper
        variant="outlined"
        sx={{
          p: 2.5,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          justifyContent="space-between"
          alignItems={{ xs: "flex-start", sm: "center" }}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <DeleteSweepOutlinedIcon color="primary" />
              <Typography variant="h1">{t("documents.trash.title")}</Typography>
            </Stack>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
              {t("documents.trash.subtitle")}
            </Typography>
          </Box>
          <Button variant="outlined" onClick={() => void navigate("/documents")}>
            {t("documents.trash.backToDocuments")}
          </Button>
        </Stack>
      </Paper>

      {feedback ? (
        <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
          {feedback.message}
        </Alert>
      ) : null}

      <FilterBar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchLabel={t("documents.trash.searchLabel")}
        searchPlaceholder={t("documents.trash.searchPlaceholder")}
        filters={[]}
        hasActiveFilters={search.trim().length > 0}
        onClearFilters={() => {
          setSearch("");
          setPage(1);
        }}
      />

      <DataTable
        ariaLabel={t("documents.trash.tableAriaLabel")}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        page={page}
        pageSize={pageSize}
        totalItems={totalItems}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortChange={handleSortChange}
        onRowClick={(row) => void navigate(`/documents/${row.id}`)}
        loading={trashQuery.isLoading}
        errorMessage={trashQuery.isError ? trashQuery.error.message : null}
        onRetry={() => void trashQuery.refetch()}
        emptyTitle={t("documents.trash.emptyTitle")}
        emptyDescription={t("documents.trash.emptyDescription")}
      />

      <Dialog
        open={selectedDoc !== null}
        onClose={closeRestoreDialog}
        aria-labelledby={dialogTitleId}
        aria-describedby={dialogDescId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={dialogTitleId}>{t("documents.trash.dialogTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText id={dialogDescId}>
              {t("documents.trash.dialogDescription", { title: selectedDoc?.title ?? "" })}
            </DialogContentText>

            {dialogError ? (
              <Alert severity="error" role="alert">
                {dialogError}
              </Alert>
            ) : null}

            <TextField
              select
              label={t("documents.lifecycle.restoreStatusLabel")}
              value={targetStatus}
              onChange={(event) =>
                setTargetStatus(event.target.value as RestoreTrashedDocumentTargetStatus)
              }
              fullWidth
              disabled={restoreMutation.isPending}
            >
              <MenuItem value="DRAFT">{t("documents.status.DRAFT")}</MenuItem>
              <MenuItem value="ARCHIVED">{t("documents.status.ARCHIVED")}</MenuItem>
            </TextField>

            <TextField
              label={t("documents.lifecycle.restoreReasonLabel")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              inputProps={{ maxLength: 500 }}
              disabled={restoreMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeRestoreDialog} disabled={restoreMutation.isPending} variant="text">
            {t("documents.common.cancel")}
          </Button>
          <Button
            onClick={() => void handleConfirmRestore()}
            disabled={restoreMutation.isPending}
            variant="contained"
          >
            {restoreMutation.isPending
              ? t("documents.lifecycle.restoring")
              : t("documents.lifecycle.confirmRestore")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
