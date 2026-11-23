import type {
  DocumentDetail,
  DocumentVersionHistoryItem,
  FileObjectStatus,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState, LoadingState } from "@docuflow/ui";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import RestoreOutlinedIcon from "@mui/icons-material/RestoreOutlined";
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
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import {
  documentDetailsQueryKey,
  requestVersionDownloadTarget,
  useDocumentVersionsQuery,
  useRestoreDocumentVersionMutation,
} from "./useDocumentDetails.js";

const FILE_STATUS_BADGE: Readonly<
  Record<
    FileObjectStatus,
    {
      readonly label: string;
      readonly color: "default" | "info" | "success" | "warning" | "error";
    }
  >
> = {
  UPLOADING: { label: "Enviando", color: "info" },
  QUARANTINED: { label: "Em verificação", color: "warning" },
  AVAILABLE: { label: "Disponível", color: "success" },
  REJECTED: { label: "Bloqueado", color: "error" },
  MISSING: { label: "Indisponível", color: "error" },
  DELETE_PENDING: { label: "Exclusão pendente", color: "default" },
};

function formatDateTimePtBr(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

function formatFileSizePtBr(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface VersionHistoryProps {
  readonly document: DocumentDetail;
  readonly onUploadNewVersion?: (() => void) | undefined;
  readonly onDownloadVersion?:
    | ((version: DocumentVersionHistoryItem) => Promise<void> | void)
    | undefined;
}

/**
 * Append-only version history table displaying version number, timestamp, author,
 * change note, file status, and server-authorized actions (download / non-destructive restore).
 */
export function VersionHistory({
  document,
  onUploadNewVersion,
  onDownloadVersion,
}: VersionHistoryProps) {
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
        `Versão v${response.data.versionNumber} criada a partir da versão v${restoreTarget.versionNumber} preservando todo o histórico.`,
      );
      setRestoreTarget(null);
      setRestoreNote("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Não foi possível restaurar a versão selecionada.";
      setActionError(message);
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
      const message =
        error instanceof Error
          ? error.message
          : "Não foi possível iniciar o download desta versão.";
      setActionError(message);
    } finally {
      setDownloadingVersionId(null);
    }
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2.5,
        bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
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
                Histórico de versões
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Versões anteriores são imutáveis; restaurar cria uma nova versão.
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
          <LoadingState message="Carregando histórico de versões..." />
        ) : versionsQuery.isError ? (
          <ErrorState
            title="Não foi possível carregar o histórico de versões"
            description={versionsQuery.error.message}
            onRetry={() => void versionsQuery.refetch()}
          />
        ) : versions.length === 0 ? (
          <EmptyState
            title="Nenhuma versão registrada"
            description="Este documento ainda não possui versões de arquivo associadas."
            {...(document.permissions.canUpload && onUploadNewVersion
              ? {
                  actionLabel: "Enviar primeira versão",
                  onAction: onUploadNewVersion,
                }
              : {})}
          />
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Histórico de versões do documento">
              <TableHead>
                <TableRow>
                  <TableCell component="th" scope="col">
                    Versão
                  </TableCell>
                  <TableCell component="th" scope="col">
                    Data
                  </TableCell>
                  <TableCell component="th" scope="col">
                    Autor
                  </TableCell>
                  <TableCell component="th" scope="col">
                    Observação e arquivo
                  </TableCell>
                  <TableCell component="th" scope="col" align="right">
                    Ações
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {versions.map((version) => {
                  const fileStatus = version.fileObject
                    ? FILE_STATUS_BADGE[version.fileObject.status]
                    : null;
                  const isDownloading = downloadingVersionId === version.id;

                  return (
                    <TableRow key={version.id} hover>
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="body2" fontWeight={600}>
                            v{version.versionNumber}
                          </Typography>
                          {version.isCurrent ? (
                            <Chip label="Vigente" color="primary" size="small" />
                          ) : null}
                        </Stack>
                      </TableCell>

                      <TableCell>
                        <Typography variant="body2" noWrap>
                          {formatDateTimePtBr(version.createdAt)}
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
                            {version.changeNote ?? "Sem observação registrada"}
                          </Typography>
                          {version.fileObject ? (
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                              <Typography variant="caption" color="text.secondary">
                                {version.fileObject.originalFileName} (
                                {formatFileSizePtBr(version.fileObject.sizeBytes)})
                              </Typography>
                              {fileStatus ? (
                                <Chip
                                  label={fileStatus.label}
                                  color={fileStatus.color}
                                  size="small"
                                  variant="outlined"
                                />
                              ) : null}
                            </Stack>
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              Objeto binário não vinculado
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
                          {version.permissions.canDownload ? (
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<DownloadOutlinedIcon />}
                              disabled={isDownloading || restoreMutation.isPending}
                              onClick={() => void handleDownloadClick(version)}
                              aria-label={`Baixar versão v${version.versionNumber}`}
                            >
                              {isDownloading ? "Baixando..." : "Baixar"}
                            </Button>
                          ) : null}

                          {version.permissions.canRestore ? (
                            <Button
                              size="small"
                              variant="text"
                              startIcon={<RestoreOutlinedIcon />}
                              disabled={restoreMutation.isPending}
                              onClick={() => handleOpenRestoreDialog(version)}
                              aria-label={`Restaurar versão v${version.versionNumber}`}
                            >
                              Restaurar versão
                            </Button>
                          ) : null}

                          {!version.permissions.canDownload && !version.permissions.canRestore ? (
                            <Typography variant="caption" color="text.secondary">
                              Sem ações disponíveis
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
          {restoreTarget ? `Restaurar versão v${restoreTarget.versionNumber}` : "Restaurar versão"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText id={restoreDialogDescId}>
              {restoreTarget
                ? `Será criada uma nova versão vigente (v${nextRestoredNumber}) com base no arquivo da versão v${restoreTarget.versionNumber}. O histórico anterior continuará preservado integralmente.`
                : ""}
            </DialogContentText>

            <TextField
              label="Observação da restauração (opcional)"
              value={restoreNote}
              onChange={(event) => setRestoreNote(event.target.value)}
              placeholder={
                restoreTarget
                  ? `Restauração lógica da versão ${restoreTarget.versionNumber}`
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
            Cancelar
          </Button>
          <Button
            onClick={() => void handleConfirmRestore()}
            disabled={restoreMutation.isPending}
            variant="contained"
          >
            {restoreMutation.isPending ? "Restaurando..." : "Confirmar restauração"}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
