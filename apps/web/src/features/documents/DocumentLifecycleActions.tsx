import type { DocumentDetail, RestoreTrashedDocumentTargetStatus } from "@docuflow/contracts";
import ArchiveOutlinedIcon from "@mui/icons-material/ArchiveOutlined";
import DriveFileMoveOutlinedIcon from "@mui/icons-material/DriveFileMoveOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import RestoreFromTrashOutlinedIcon from "@mui/icons-material/RestoreFromTrashOutlined";
import SubdirectoryArrowRightOutlinedIcon from "@mui/icons-material/SubdirectoryArrowRightOutlined";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import { useId, useMemo, useState } from "react";
import { containsTechnicalJargon } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";
import { buildFolderTreeOptions } from "../folders/folderTree.js";
import {
  useArchiveDocumentMutation,
  useAvailableFoldersQuery,
  useMoveDocumentMutation,
  useRestoreTrashedDocumentMutation,
} from "./useDocumentDetails.js";

export interface DocumentLifecycleActionsProps {
  readonly document: DocumentDetail;
  readonly onActionFeedback?:
    | ((feedback: { readonly severity: "success" | "error"; readonly message: string }) => void)
    | undefined;
}

/**
 * Toolbar actions and accessible confirmation dialogs for moving a document across folders,
 * archiving eligible documents, and restoring trashed documents.
 */
export function DocumentLifecycleActions({
  document,
  onActionFeedback,
}: DocumentLifecycleActionsProps) {
  const { locale, t } = useI18n();
  const moveTitleId = useId();
  const moveDescId = useId();
  const archiveTitleId = useId();
  const archiveDescId = useId();
  const restoreTitleId = useId();
  const restoreDescId = useId();

  const [moveOpen, setMoveOpen] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string>(document.folderId ?? "");
  const [moveError, setMoveError] = useState<string | null>(null);

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreTargetStatus, setRestoreTargetStatus] =
    useState<RestoreTrashedDocumentTargetStatus>("DRAFT");
  const [restoreReason, setRestoreReason] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const foldersQuery = useAvailableFoldersQuery(moveOpen);
  const moveMutation = useMoveDocumentMutation(document.id);
  const archiveMutation = useArchiveDocumentMutation(document.id);
  const restoreMutation = useRestoreTrashedDocumentMutation(document.id);

  const folderTreeOptions = useMemo(
    () => buildFolderTreeOptions(foldersQuery.data ?? [], locale),
    [foldersQuery.data, locale],
  );
  const folderById = useMemo(
    () => new Map(folderTreeOptions.map((item) => [item.id, item])),
    [folderTreeOptions],
  );

  if (document.status === "DELETED") {
    if (!document.permissions.canDelete) {
      return null;
    }

    const handleOpenRestore = (): void => {
      setRestoreError(null);
      setRestoreTargetStatus("DRAFT");
      setRestoreReason("");
      setRestoreOpen(true);
    };

    const handleCloseRestore = (): void => {
      if (restoreMutation.isPending) {
        return;
      }
      setRestoreOpen(false);
      setRestoreError(null);
    };

    const handleConfirmRestore = async (): Promise<void> => {
      setRestoreError(null);
      const trimmedReason = restoreReason.trim();
      try {
        const restored = await restoreMutation.mutateAsync({
          documentId: document.id,
          payload: {
            expectedVersion: document.version,
            targetStatus: restoreTargetStatus,
            ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
          },
        });
        const statusLabel =
          restored.status === "ARCHIVED"
            ? t("documents.status.ARCHIVED")
            : t("documents.status.DRAFT");
        onActionFeedback?.({
          severity: "success",
          message: t("documents.lifecycle.restoreSuccess", { status: statusLabel }),
        });
        setRestoreOpen(false);
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : "";
        setRestoreError(
          rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
            ? rawMessage
            : t("documents.lifecycle.restoreFailed"),
        );
      }
    };

    return (
      <>
        <Button
          variant="contained"
          startIcon={<RestoreFromTrashOutlinedIcon />}
          onClick={handleOpenRestore}
        >
          {t("documents.lifecycle.restoreFromTrashButton")}
        </Button>

        <Dialog
          open={restoreOpen}
          onClose={handleCloseRestore}
          aria-labelledby={restoreTitleId}
          aria-describedby={restoreDescId}
          maxWidth="xs"
          fullWidth
        >
          <DialogTitle id={restoreTitleId}>
            {t("documents.lifecycle.restoreDialogTitle")}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 0.5 }}>
              <DialogContentText id={restoreDescId}>
                {t("documents.lifecycle.restoreDialogDescription", { title: document.title })}
              </DialogContentText>

              {restoreError ? (
                <Alert severity="error" role="alert">
                  {restoreError}
                </Alert>
              ) : null}

              <TextField
                select
                label={t("documents.lifecycle.restoreStatusLabel")}
                value={restoreTargetStatus}
                onChange={(event) =>
                  setRestoreTargetStatus(event.target.value as RestoreTrashedDocumentTargetStatus)
                }
                fullWidth
                disabled={restoreMutation.isPending}
              >
                <MenuItem value="DRAFT">{t("documents.status.DRAFT")}</MenuItem>
                <MenuItem value="ARCHIVED">{t("documents.status.ARCHIVED")}</MenuItem>
              </TextField>

              <TextField
                label={t("documents.lifecycle.restoreReasonLabel")}
                value={restoreReason}
                onChange={(event) => setRestoreReason(event.target.value)}
                fullWidth
                multiline
                minRows={2}
                inputProps={{ maxLength: 500 }}
                disabled={restoreMutation.isPending}
              />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button
              onClick={handleCloseRestore}
              disabled={restoreMutation.isPending}
              variant="text"
            >
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
      </>
    );
  }

  if (!document.permissions.canUpdate) {
    return null;
  }

  const canArchive = document.status !== "ARCHIVED" && document.status !== "IN_REVIEW";

  const handleOpenMove = (): void => {
    setMoveError(null);
    setSelectedFolderId(document.folderId ?? "");
    setMoveOpen(true);
  };

  const handleCloseMove = (): void => {
    if (moveMutation.isPending) {
      return;
    }
    setMoveOpen(false);
    setMoveError(null);
  };

  const handleConfirmMove = async (): Promise<void> => {
    setMoveError(null);
    const targetFolderId = selectedFolderId.trim().length > 0 ? selectedFolderId : null;

    try {
      await moveMutation.mutateAsync({
        expectedVersion: document.version,
        targetFolderId,
      });
      const folderName =
        targetFolderId === null
          ? t("documents.common.noFolderRoot")
          : (folderById.get(targetFolderId)?.fullPath ??
            t("documents.lifecycle.moveFallbackFolder"));
      onActionFeedback?.({
        severity: "success",
        message: t("documents.lifecycle.moveSuccess", { folderName }),
      });
      setMoveOpen(false);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      setMoveError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("documents.lifecycle.moveFailed"),
      );
    }
  };

  const handleOpenArchive = (): void => {
    setArchiveError(null);
    setArchiveReason("");
    setArchiveOpen(true);
  };

  const handleCloseArchive = (): void => {
    if (archiveMutation.isPending) {
      return;
    }
    setArchiveOpen(false);
    setArchiveError(null);
  };

  const handleConfirmArchive = async (): Promise<void> => {
    setArchiveError(null);
    try {
      await archiveMutation.mutateAsync({
        expectedVersion: document.version,
        reason: archiveReason,
      });
      onActionFeedback?.({
        severity: "success",
        message: t("documents.lifecycle.archiveSuccess"),
      });
      setArchiveOpen(false);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      setArchiveError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("documents.lifecycle.archiveFailed"),
      );
    }
  };

  return (
    <>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          variant="outlined"
          startIcon={<DriveFileMoveOutlinedIcon />}
          onClick={handleOpenMove}
        >
          {t("documents.lifecycle.moveButton")}
        </Button>

        {canArchive ? (
          <Button
            variant="outlined"
            color="warning"
            startIcon={<ArchiveOutlinedIcon />}
            onClick={handleOpenArchive}
          >
            {t("documents.lifecycle.archiveButton")}
          </Button>
        ) : null}
      </Stack>

      <Dialog
        open={moveOpen}
        onClose={handleCloseMove}
        aria-labelledby={moveTitleId}
        aria-describedby={moveDescId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={moveTitleId}>{t("documents.lifecycle.moveDialogTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText id={moveDescId}>
              {t("documents.lifecycle.moveDialogDescription", { title: document.title })}
            </DialogContentText>

            {moveError ? (
              <Alert severity="error" role="alert">
                {moveError}
              </Alert>
            ) : null}

            {foldersQuery.isError ? (
              <Alert severity="error" role="alert">
                {foldersQuery.error.message}
              </Alert>
            ) : null}

            <TextField
              select
              label={t("documents.lifecycle.destinationFolderLabel")}
              value={foldersQuery.isLoading ? "" : selectedFolderId}
              onChange={(event) => setSelectedFolderId(event.target.value)}
              slotProps={{
                inputLabel: { shrink: true },
                select: {
                  displayEmpty: true,
                  renderValue: (selected) => {
                    const value = typeof selected === "string" ? selected : "";
                    if (value.length === 0) {
                      return t("documents.common.noFolderRoot");
                    }
                    return folderById.get(value)?.fullPath ?? "";
                  },
                },
              }}
              fullWidth
              disabled={moveMutation.isPending || foldersQuery.isLoading}
            >
              <MenuItem value="">{t("documents.common.noFolderRoot")}</MenuItem>
              {folderTreeOptions.map((folder) => (
                <MenuItem
                  key={folder.id}
                  value={folder.id}
                  data-depth={folder.depth}
                  sx={{ pl: 2 + folder.depth * 2.5 }}
                >
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    {folder.depth > 0 ? (
                      <SubdirectoryArrowRightOutlinedIcon
                        fontSize="small"
                        color="action"
                        aria-hidden
                      />
                    ) : null}
                    <FolderOutlinedIcon fontSize="small" color="action" aria-hidden />
                    <span>{folder.name}</span>
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleCloseMove} disabled={moveMutation.isPending} variant="text">
            {t("documents.common.cancel")}
          </Button>
          <Button
            onClick={() => void handleConfirmMove()}
            disabled={moveMutation.isPending || foldersQuery.isLoading}
            variant="contained"
          >
            {moveMutation.isPending
              ? t("documents.lifecycle.moving")
              : t("documents.lifecycle.confirmMove")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={archiveOpen}
        onClose={handleCloseArchive}
        aria-labelledby={archiveTitleId}
        aria-describedby={archiveDescId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={archiveTitleId}>{t("documents.lifecycle.archiveDialogTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText id={archiveDescId}>
              {t("documents.lifecycle.archiveDialogDescription", { title: document.title })}
            </DialogContentText>

            {archiveError ? (
              <Alert severity="error" role="alert">
                {archiveError}
              </Alert>
            ) : null}

            <TextField
              label={t("documents.lifecycle.archiveReasonLabel")}
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              inputProps={{ maxLength: 500 }}
              disabled={archiveMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleCloseArchive} disabled={archiveMutation.isPending} variant="text">
            {t("documents.common.cancel")}
          </Button>
          <Button
            onClick={() => void handleConfirmArchive()}
            disabled={archiveMutation.isPending}
            color="warning"
            variant="contained"
          >
            {archiveMutation.isPending
              ? t("documents.lifecycle.archiving")
              : t("documents.lifecycle.confirmArchive")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
