import ArchiveOutlinedIcon from "@mui/icons-material/ArchiveOutlined";
import ClearOutlinedIcon from "@mui/icons-material/ClearOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import DriveFileMoveOutlinedIcon from "@mui/icons-material/DriveFileMoveOutlined";
import FolderZipOutlinedIcon from "@mui/icons-material/FolderZipOutlined";
import LocalOfferOutlinedIcon from "@mui/icons-material/LocalOfferOutlined";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  type BulkDocumentActionSummary,
  type FolderRecord,
  MAX_BULK_DOCUMENT_ITEMS,
} from "@papyrus/contracts";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useId, useMemo, useState } from "react";
import { containsTechnicalJargon } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";
import { buildFolderTreeOptions } from "../folders/folderTree.js";
import { fetchTags, useCreateTagMutation } from "../tags/useTagsApi.js";
import { downloadDocumentsZip, useBulkDocumentActionMutation } from "./useBulkDocumentActions.js";
import { useAvailableFoldersQuery } from "./useDocumentDetails.js";

export interface DocumentBulkActionBarProps {
  readonly selectedIds: readonly string[];
  readonly folders?: readonly FolderRecord[] | undefined;
  readonly onClearSelection: () => void;
  readonly onActionCompleted?: (() => void) | undefined;
}

type BulkDialogMode = "MOVE" | "ATTACH_TAG" | "ARCHIVE" | "TRASH" | null;

export function DocumentBulkActionBar({
  selectedIds,
  folders: providedFolders,
  onClearSelection,
  onActionCompleted,
}: DocumentBulkActionBarProps) {
  const { locale, t } = useI18n();
  const moveLabelId = useId();
  const tagSelectLabelId = useId();

  const [dialogMode, setDialogMode] = useState<BulkDialogMode>(null);
  const [targetFolderId, setTargetFolderId] = useState<string>("");
  const [selectedTagId, setSelectedTagId] = useState<string>("");
  const [newTagName, setNewTagName] = useState("");
  const [reason, setReason] = useState("");
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "warning" | "error";
    readonly message: string;
  } | null>(null);

  const bulkMutation = useBulkDocumentActionMutation();
  const createTagMutation = useCreateTagMutation();

  const shouldLoadFolders = dialogMode === "MOVE" && providedFolders === undefined;
  const availableFoldersQuery = useAvailableFoldersQuery(shouldLoadFolders);
  const effectiveFolders = providedFolders ?? availableFoldersQuery.data ?? [];

  const folderOptions = useMemo(
    () => buildFolderTreeOptions(effectiveFolders, locale),
    [effectiveFolders, locale],
  );

  const tagsQuery = useQuery({
    queryKey: ["tags", "bulk-options"],
    queryFn: () => fetchTags({ page: 1, pageSize: 100 }),
    enabled: dialogMode === "ATTACH_TAG",
  });
  const tags = tagsQuery.data?.items ?? [];

  const selectedCount = selectedIds.length;
  const exceedsLimit = selectedCount > MAX_BULK_DOCUMENT_ITEMS;
  const isBusy = bulkMutation.isPending || createTagMutation.isPending || downloadingZip;

  const formatSummaryFeedback = (
    summary: BulkDocumentActionSummary,
  ): {
    readonly severity: "success" | "warning" | "error";
    readonly message: string;
  } => {
    const firstFailure = summary.results.find((item) => item.status === "FAILED");
    const safeFailureDetail =
      firstFailure?.message && !containsTechnicalJargon(firstFailure.message)
        ? firstFailure.message
        : t("documents.bulk.errors.partialItemFallback");

    if (summary.failedCount === 0) {
      return {
        severity: "success",
        message: t(`documents.bulk.feedback.${summary.action}.allSucceeded`, {
          count: summary.succeededCount,
        }),
      };
    }
    if (summary.succeededCount > 0) {
      return {
        severity: "warning",
        message: t("documents.bulk.feedback.partial", {
          succeeded: summary.succeededCount,
          failed: summary.failedCount,
          reason: safeFailureDetail,
        }),
      };
    }
    return {
      severity: "error",
      message: t("documents.bulk.feedback.allFailed", {
        failed: summary.failedCount,
        reason: safeFailureDetail,
      }),
    };
  };

  const openDialog = (mode: Exclude<BulkDialogMode, null>): void => {
    setFeedback(null);
    setTargetFolderId("");
    setSelectedTagId("");
    setNewTagName("");
    setReason("");
    setDialogMode(mode);
  };

  const closeDialog = (): void => {
    if (bulkMutation.isPending || createTagMutation.isPending) {
      return;
    }
    setDialogMode(null);
  };

  const handleConfirmMove = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      const summary = await bulkMutation.mutateAsync({
        action: "MOVE",
        documentIds: [...selectedIds],
        targetFolderId: targetFolderId.length > 0 ? targetFolderId : null,
      });
      setDialogMode(null);
      setFeedback(formatSummaryFeedback(summary));
      if (summary.succeededCount > 0) {
        onClearSelection();
        onActionCompleted?.();
      }
    } catch (error) {
      setDialogMode(null);
      setFeedback({
        severity: "error",
        message: error instanceof Error ? error.message : t("documents.bulk.errors.actionFailed"),
      });
    }
  };

  const handleConfirmAttachTag = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    try {
      let tagIdToApply = selectedTagId;
      const trimmedNewName = newTagName.trim();
      if (tagIdToApply.length === 0 && trimmedNewName.length > 0) {
        const createdTag = await createTagMutation.mutateAsync({ name: trimmedNewName });
        tagIdToApply = createdTag.id;
      }
      if (tagIdToApply.length === 0) {
        return;
      }

      const summary = await bulkMutation.mutateAsync({
        action: "ATTACH_TAG",
        documentIds: [...selectedIds],
        tagId: tagIdToApply,
      });
      setDialogMode(null);
      setFeedback(formatSummaryFeedback(summary));
      if (summary.succeededCount > 0) {
        onClearSelection();
        onActionCompleted?.();
      }
    } catch (error) {
      setDialogMode(null);
      setFeedback({
        severity: "error",
        message: error instanceof Error ? error.message : t("documents.bulk.errors.actionFailed"),
      });
    }
  };

  const handleConfirmLifecycle = async (action: "ARCHIVE" | "TRASH"): Promise<void> => {
    try {
      const trimmedReason = reason.trim();
      const summary = await bulkMutation.mutateAsync({
        action,
        documentIds: [...selectedIds],
        ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
      });
      setDialogMode(null);
      setFeedback(formatSummaryFeedback(summary));
      if (summary.succeededCount > 0) {
        onClearSelection();
        onActionCompleted?.();
      }
    } catch (error) {
      setDialogMode(null);
      setFeedback({
        severity: "error",
        message: error instanceof Error ? error.message : t("documents.bulk.errors.actionFailed"),
      });
    }
  };

  const handleDownloadZip = async (): Promise<void> => {
    setFeedback(null);
    setDownloadingZip(true);
    try {
      await downloadDocumentsZip(selectedIds);
      setFeedback({
        severity: "success",
        message: t("documents.bulk.feedback.DOWNLOAD_ZIP.started", { count: selectedCount }),
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        message: error instanceof Error ? error.message : t("documents.bulk.errors.downloadFailed"),
      });
    } finally {
      setDownloadingZip(false);
    }
  };

  if (selectedCount === 0 && !feedback) {
    return null;
  }

  return (
    <Stack spacing={1.5}>
      {feedback ? (
        <Alert
          severity={feedback.severity}
          role={feedback.severity === "error" ? "alert" : "status"}
          onClose={() => setFeedback(null)}
        >
          {feedback.message}
        </Alert>
      ) : null}

      {selectedCount > 0 ? (
        <Paper
          component="section"
          variant="outlined"
          aria-label={t("documents.bulk.toolbarAriaLabel")}
          sx={{
            px: 2,
            py: 1.5,
            bgcolor: PAPYRUS_COLOR_TOKENS.primary.container,
            borderColor: PAPYRUS_COLOR_TOKENS.primary.main,
          }}
        >
          <Stack spacing={1}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 1.5,
                flexWrap: "wrap",
              }}
            >
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Typography
                  variant="subtitle2"
                  fontWeight={600}
                  color={PAPYRUS_COLOR_TOKENS.primary.onContainer}
                >
                  {t("documents.bulk.selectedCount", { count: selectedCount })}
                </Typography>
                <Button
                  size="small"
                  variant="text"
                  startIcon={<ClearOutlinedIcon />}
                  onClick={onClearSelection}
                  disabled={isBusy}
                >
                  {t("documents.bulk.clearSelection")}
                </Button>
              </Stack>

              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<DriveFileMoveOutlinedIcon />}
                  disabled={isBusy || exceedsLimit}
                  onClick={() => openDialog("MOVE")}
                >
                  {t("documents.bulk.actions.move")}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<LocalOfferOutlinedIcon />}
                  disabled={isBusy || exceedsLimit}
                  onClick={() => openDialog("ATTACH_TAG")}
                >
                  {t("documents.bulk.actions.tag")}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ArchiveOutlinedIcon />}
                  disabled={isBusy || exceedsLimit}
                  onClick={() => openDialog("ARCHIVE")}
                >
                  {t("documents.bulk.actions.archive")}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteOutlineOutlinedIcon />}
                  disabled={isBusy || exceedsLimit}
                  onClick={() => openDialog("TRASH")}
                >
                  {t("documents.bulk.actions.trash")}
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={
                    downloadingZip ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <FolderZipOutlinedIcon />
                    )
                  }
                  disabled={isBusy || exceedsLimit}
                  onClick={() => void handleDownloadZip()}
                >
                  {downloadingZip
                    ? t("documents.bulk.actions.downloadingZip")
                    : t("documents.bulk.actions.downloadZip")}
                </Button>
              </Stack>
            </Box>

            {exceedsLimit ? (
              <Alert severity="warning">
                {t("documents.bulk.limitWarning", { max: MAX_BULK_DOCUMENT_ITEMS })}
              </Alert>
            ) : null}
          </Stack>
        </Paper>
      ) : null}

      <Dialog open={dialogMode === "MOVE"} onClose={closeDialog} fullWidth maxWidth="xs">
        <form onSubmit={(event) => void handleConfirmMove(event)}>
          <DialogTitle>{t("documents.bulk.moveDialog.title")}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 0.5 }}>
              <DialogContentText>
                {t("documents.bulk.moveDialog.description", { count: selectedCount })}
              </DialogContentText>
              <FormControl fullWidth size="small">
                <InputLabel id={moveLabelId}>
                  {t("documents.lifecycle.destinationFolderLabel")}
                </InputLabel>
                <Select
                  labelId={moveLabelId}
                  label={t("documents.lifecycle.destinationFolderLabel")}
                  value={targetFolderId}
                  onChange={(event) => setTargetFolderId(event.target.value)}
                  disabled={bulkMutation.isPending}
                >
                  <MenuItem value="">{t("documents.common.noFolderRoot")}</MenuItem>
                  {folderOptions.map((folder) => (
                    <MenuItem key={folder.id} value={folder.id}>
                      {folder.fullPath}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeDialog} disabled={bulkMutation.isPending}>
              {t("documents.common.cancel")}
            </Button>
            <Button type="submit" variant="contained" disabled={bulkMutation.isPending}>
              {bulkMutation.isPending
                ? t("documents.lifecycle.moving")
                : t("documents.lifecycle.confirmMove")}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={dialogMode === "ATTACH_TAG"} onClose={closeDialog} fullWidth maxWidth="xs">
        <form onSubmit={(event) => void handleConfirmAttachTag(event)}>
          <DialogTitle>{t("documents.bulk.tagDialog.title")}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 0.5 }}>
              <DialogContentText>
                {t("documents.bulk.tagDialog.description", { count: selectedCount })}
              </DialogContentText>
              <FormControl fullWidth size="small">
                <InputLabel id={tagSelectLabelId}>{t("tags.field.attachExistingLabel")}</InputLabel>
                <Select
                  labelId={tagSelectLabelId}
                  label={t("tags.field.attachExistingLabel")}
                  value={selectedTagId}
                  onChange={(event) => {
                    setSelectedTagId(event.target.value);
                    if (event.target.value.length > 0) {
                      setNewTagName("");
                    }
                  }}
                  disabled={bulkMutation.isPending || createTagMutation.isPending}
                >
                  <MenuItem value="">{t("documents.common.selectOption")}</MenuItem>
                  {tags.map((tag) => (
                    <MenuItem key={tag.id} value={tag.id}>
                      {tag.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Divider />

              <TextField
                size="small"
                fullWidth
                label={t("tags.field.createAndAttachLabel")}
                placeholder={t("tags.field.createAndAttachPlaceholder")}
                value={newTagName}
                onChange={(event) => {
                  setNewTagName(event.target.value);
                  if (event.target.value.trim().length > 0) {
                    setSelectedTagId("");
                  }
                }}
                disabled={bulkMutation.isPending || createTagMutation.isPending}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={closeDialog}
              disabled={bulkMutation.isPending || createTagMutation.isPending}
            >
              {t("documents.common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={
                (selectedTagId.length === 0 && newTagName.trim().length === 0) ||
                bulkMutation.isPending ||
                createTagMutation.isPending
              }
            >
              {bulkMutation.isPending || createTagMutation.isPending
                ? t("documents.bulk.tagDialog.applying")
                : t("documents.bulk.tagDialog.confirm")}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={dialogMode === "ARCHIVE"} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>{t("documents.bulk.archiveDialog.title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText>
              {t("documents.bulk.archiveDialog.description", { count: selectedCount })}
            </DialogContentText>
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              label={t("documents.lifecycle.archiveReasonLabel")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={bulkMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={bulkMutation.isPending}>
            {t("documents.common.cancel")}
          </Button>
          <Button
            variant="contained"
            disabled={bulkMutation.isPending}
            onClick={() => void handleConfirmLifecycle("ARCHIVE")}
          >
            {bulkMutation.isPending
              ? t("documents.lifecycle.archiving")
              : t("documents.lifecycle.confirmArchive")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={dialogMode === "TRASH"} onClose={closeDialog} fullWidth maxWidth="xs">
        <DialogTitle>{t("documents.bulk.trashDialog.title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText>
              {t("documents.bulk.trashDialog.description", { count: selectedCount })}
            </DialogContentText>
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              label={t("documents.bulk.trashDialog.reasonLabel")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={bulkMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={bulkMutation.isPending}>
            {t("documents.common.cancel")}
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={bulkMutation.isPending}
            onClick={() => void handleConfirmLifecycle("TRASH")}
          >
            {bulkMutation.isPending
              ? t("documents.bulk.trashDialog.trashing")
              : t("documents.bulk.trashDialog.confirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
