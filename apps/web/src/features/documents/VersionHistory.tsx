import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import RestoreOutlinedIcon from "@mui/icons-material/RestoreOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
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
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import type {
  DocumentDetail,
  DocumentVersionHistoryItem,
  FileObjectStatus,
} from "@papyrus/contracts";
import { EmptyState, ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { containsTechnicalJargon } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";
import {
  documentDetailsQueryKey,
  requestVersionDownloadTarget,
  useDocumentVersionsQuery,
  useRestoreDocumentVersionMutation,
} from "./useDocumentDetails.js";

const FILE_STATUS_COLOR: Readonly<
  Record<FileObjectStatus, "default" | "info" | "success" | "warning" | "error">
> = {
  UPLOADING: "info",
  QUARANTINED: "warning",
  AVAILABLE: "success",
  REJECTED: "error",
  MISSING: "error",
  DELETE_PENDING: "default",
};

export interface VersionHistoryProps {
  readonly document: DocumentDetail;
  readonly activePreviewVersionId?: string | null | undefined;
  readonly onPreviewVersion?: ((version: DocumentVersionHistoryItem) => void) | undefined;
  readonly onUploadNewVersion?: (() => void) | undefined;
  readonly onDownloadVersion?:
    | ((version: DocumentVersionHistoryItem) => Promise<void> | void)
    | undefined;
}

/**
 * Version history table displaying version number, timestamp, author,
 * change note, file status, and server-authorized actions (preview / download / non-destructive restore).
 */
export function VersionHistory({
  document,
  activePreviewVersionId,
  onPreviewVersion,
  onUploadNewVersion,
  onDownloadVersion,
}: VersionHistoryProps) {
  const { t, formatDateTime, formatBytes } = useI18n();
  const restoreDialogTitleId = useId();
  const restoreDialogDescId = useId();

  const versionsQuery = useDocumentVersionsQuery(document.id);
  const restoreMutation = useRestoreDocumentVersionMutation(document.id);

  const [restoreTarget, setRestoreTarget] = useState<DocumentVersionHistoryItem | null>(null);
  const [restoreNote, setRestoreNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [downloadingVersionId, setDownloadingVersionId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const versions = versionsQuery.data ?? [];
  const currentInHistory = versions.find((item) => item.isCurrent);
  useEffect(() => {
    if (currentInHistory && currentInHistory.id !== document.currentVersionId) {
      void queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(document.id) });
    }
  }, [currentInHistory, document.currentVersionId, document.id, queryClient]);

  const nextRestoredNumber =
    versions.reduce((max, item) => (item.versionNumber > max ? item.versionNumber : max), 0) + 1;

  const handleOpenRestoreDialog = (version: DocumentVersionHistoryItem): void => {
    setActionError(null);
    setActionSuccess(null);
    setRestoreTarget(version);
    setRestoreNote("");
  };

  const handleCloseRestoreDialog = (): void => {
    if (restoreMutation.isPending) {
      return;
    }
    setRestoreTarget(null);
    setRestoreNote("");
  };

  const handleConfirmRestore = async (): Promise<void> => {
    if (!restoreTarget) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);

    try {
      const response = await restoreMutation.mutateAsync({
        versionId: restoreTarget.id,
        expectedVersion: document.version,
        changeNote: restoreNote,
      });
      setActionSuccess(
        t("documents.versions.restoreSuccess", {
          newVersion: response.data.versionNumber,
          sourceVersion: restoreTarget.versionNumber,
        }),
      );
      setRestoreTarget(null);
      setRestoreNote("");
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setActionError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("documents.versions.restoreFailed"),
      );
    }
  };

  const handleDownloadClick = async (version: DocumentVersionHistoryItem): Promise<void> => {
    setActionError(null);
    setActionSuccess(null);
    setDownloadingVersionId(version.id);

    try {
      if (onDownloadVersion) {
        await onDownloadVersion(version);
      } else {
        const result = await requestVersionDownloadTarget(document.id, version.id);
        if (result.url) {
          window.open(result.url, "_blank", "noopener,noreferrer");
        }
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setActionError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("documents.versions.downloadFailed"),
      );
    } finally {
      setDownloadingVersionId(null);
    }
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2.5,
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
      }}
    >
      <Stack spacing={2}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1.5,
            flexWrap: "wrap",
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <HistoryOutlinedIcon color="primary" fontSize="small" />
            <Box>
              <Typography variant="h6" component="h2">
                {t("documents.versions.title")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("documents.versions.subtitle")}
              </Typography>
            </Box>
          </Stack>
        </Box>

        <Divider />

        {actionError ? (
          <Alert severity="error" role="alert" onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        ) : null}

        {actionSuccess ? (
          <Alert severity="success" onClose={() => setActionSuccess(null)}>
            {actionSuccess}
          </Alert>
        ) : null}

        {versionsQuery.isLoading ? (
          <LoadingState message={t("documents.versions.loading")} />
        ) : versionsQuery.isError ? (
          <ErrorState
            title={t("documents.versions.loadErrorTitle")}
            description={versionsQuery.error.message}
            onRetry={() => void versionsQuery.refetch()}
          />
        ) : versions.length === 0 ? (
          <EmptyState
            title={t("documents.versions.emptyTitle")}
            description={t("documents.versions.emptyDescription")}
            {...(document.permissions.canUpload && onUploadNewVersion
              ? {
                  actionLabel: t("documents.versions.uploadFirstVersion"),
                  onAction: onUploadNewVersion,
                }
              : {})}
          />
        ) : (
          <TableContainer>
            <Table size="small" aria-label={t("documents.versions.tableAriaLabel")}>
              <TableHead>
                <TableRow>
                  <TableCell component="th" scope="col">
                    {t("documents.versions.columns.version")}
                  </TableCell>
                  <TableCell component="th" scope="col">
                    {t("documents.versions.columns.date")}
                  </TableCell>
                  <TableCell component="th" scope="col">
                    {t("documents.versions.columns.author")}
                  </TableCell>
                  <TableCell component="th" scope="col">
                    {t("documents.versions.columns.noteAndFile")}
                  </TableCell>
                  <TableCell component="th" scope="col" align="right">
                    {t("documents.versions.columns.actions")}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {versions.map((version) => {
                  const fileStatusColor = version.fileObject
                    ? FILE_STATUS_COLOR[version.fileObject.status]
                    : null;
                  const isDownloading = downloadingVersionId === version.id;
                  const canPreviewRow = Boolean(
                    onPreviewVersion && version.fileObject?.status === "AVAILABLE",
                  );
                  const isSelectedForPreview = Boolean(
                    activePreviewVersionId && activePreviewVersionId === version.id,
                  );

                  return (
                    <TableRow key={version.id} hover selected={isSelectedForPreview}>
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          <Typography variant="body2" fontWeight={600}>
                            v{version.versionNumber}
                          </Typography>
                          {version.isCurrent ? (
                            <Chip
                              label={t("documents.versions.currentBadge")}
                              color="primary"
                              size="small"
                            />
                          ) : null}
                          {isSelectedForPreview && !version.isCurrent ? (
                            <Chip
                              label={t("documents.versions.viewingBadge")}
                              color="secondary"
                              size="small"
                              variant="outlined"
                            />
                          ) : null}
                        </Stack>
                      </TableCell>

                      <TableCell>
                        <Typography variant="body2" noWrap>
                          {formatDateTime(version.createdAt)}
                        </Typography>
                      </TableCell>

                      <TableCell>
                        <Typography variant="body2" fontWeight={500}>
                          {version.uploadedByUser.fullName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {version.uploadedByUser.email}
                        </Typography>
                      </TableCell>

                      <TableCell>
                        <Stack spacing={0.5}>
                          <Typography variant="body2">
                            {version.changeNote ?? t("documents.versions.noChangeNote")}
                          </Typography>
                          {version.fileObject ? (
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                              <Typography variant="caption" color="text.secondary">
                                {version.fileObject.originalFileName} (
                                {formatBytes(version.fileObject.sizeBytes)})
                              </Typography>
                              {fileStatusColor ? (
                                <Chip
                                  label={t(
                                    `documents.versions.fileStatus.${version.fileObject.status}`,
                                  )}
                                  color={fileStatusColor}
                                  size="small"
                                  variant="outlined"
                                />
                              ) : null}
                            </Stack>
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              {t("documents.versions.noFileAttached")}
                            </Typography>
                          )}
                        </Stack>
                      </TableCell>

                      <TableCell align="right">
                        <Stack
                          direction="row"
                          spacing={1}
                          justifyContent="flex-end"
                          flexWrap="wrap"
                        >
                          {canPreviewRow ? (
                            <Button
                              size="small"
                              variant={isSelectedForPreview ? "contained" : "outlined"}
                              startIcon={<VisibilityOutlinedIcon />}
                              disabled={isSelectedForPreview || restoreMutation.isPending}
                              onClick={() => onPreviewVersion?.(version)}
                              aria-label={t("documents.versions.previewAria", {
                                version: version.versionNumber,
                              })}
                            >
                              {isSelectedForPreview
                                ? t("documents.versions.viewingBadge")
                                : t("documents.versions.previewButton")}
                            </Button>
                          ) : null}

                          {version.permissions.canDownload ? (
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<DownloadOutlinedIcon />}
                              disabled={isDownloading || restoreMutation.isPending}
                              onClick={() => void handleDownloadClick(version)}
                              aria-label={t("documents.versions.downloadAria", {
                                version: version.versionNumber,
                              })}
                            >
                              {isDownloading
                                ? t("documents.common.downloading")
                                : t("documents.common.download")}
                            </Button>
                          ) : null}

                          {version.permissions.canRestore ? (
                            <Button
                              size="small"
                              variant="text"
                              startIcon={<RestoreOutlinedIcon />}
                              disabled={restoreMutation.isPending}
                              onClick={() => handleOpenRestoreDialog(version)}
                              aria-label={t("documents.versions.restoreAria", {
                                version: version.versionNumber,
                              })}
                            >
                              {t("documents.versions.restoreButton")}
                            </Button>
                          ) : null}

                          {!canPreviewRow &&
                          !version.permissions.canDownload &&
                          !version.permissions.canRestore ? (
                            <Typography variant="caption" color="text.secondary">
                              {t("documents.versions.noActions")}
                            </Typography>
                          ) : null}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Stack>

      <Dialog
        open={restoreTarget !== null}
        onClose={handleCloseRestoreDialog}
        aria-labelledby={restoreDialogTitleId}
        aria-describedby={restoreDialogDescId}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle id={restoreDialogTitleId}>
          {restoreTarget
            ? t("documents.versions.restoreDialogTitle", {
                version: restoreTarget.versionNumber,
              })
            : t("documents.versions.restoreDialogTitleFallback")}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText id={restoreDialogDescId}>
              {restoreTarget
                ? t("documents.versions.restoreDialogDescription", {
                    nextVersion: nextRestoredNumber,
                    targetVersion: restoreTarget.versionNumber,
                  })
                : ""}
            </DialogContentText>

            <TextField
              label={t("documents.versions.restoreNoteLabel")}
              value={restoreNote}
              onChange={(event) => setRestoreNote(event.target.value)}
              placeholder={
                restoreTarget
                  ? t("documents.versions.restoreNotePlaceholder", {
                      version: restoreTarget.versionNumber,
                    })
                  : undefined
              }
              fullWidth
              multiline
              minRows={2}
              inputProps={{ maxLength: 1000 }}
              disabled={restoreMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={handleCloseRestoreDialog}
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
    </Paper>
  );
}
