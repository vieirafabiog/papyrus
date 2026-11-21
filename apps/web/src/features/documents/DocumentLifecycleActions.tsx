import type { DocumentDetail } from "@docuflow/contracts";
import ArchiveOutlinedIcon from "@mui/icons-material/ArchiveOutlined";
import DriveFileMoveOutlinedIcon from "@mui/icons-material/DriveFileMoveOutlined";
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
import { useId, useState } from "react";
import {
  useArchiveDocumentMutation,
  useAvailableFoldersQuery,
  useMoveDocumentMutation,
} from "./useDocumentDetails.js";

export interface DocumentLifecycleActionsProps {
  readonly document: DocumentDetail;
  readonly onActionFeedback?:
    | ((feedback: { readonly severity: "success" | "error"; readonly message: string }) => void)
    | undefined;
}

/**
 * Toolbar actions and accessible confirmation dialogs for moving a document across folders
 * and archiving eligible documents in pt-BR.
 */
export function DocumentLifecycleActions({
  document,
  onActionFeedback,
}: DocumentLifecycleActionsProps) {
  const moveTitleId = useId();
  const moveDescId = useId();
  const archiveTitleId = useId();
  const archiveDescId = useId();

  const [moveOpen, setMoveOpen] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string>(document.folderId ?? "");
  const [moveError, setMoveError] = useState<string | null>(null);

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const foldersQuery = useAvailableFoldersQuery(moveOpen);
  const moveMutation = useMoveDocumentMutation(document.id);
  const archiveMutation = useArchiveDocumentMutation(document.id);

  if (!document.permissions.canUpdate || document.status === "DELETED") {
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
          ? "Sem pasta (raiz)"
          : (foldersQuery.data?.find((f) => f.id === targetFolderId)?.name ?? "pasta selecionada");
      onActionFeedback?.({
        severity: "success",
        message: `Documento movido para "${folderName}".`,
      });
      setMoveOpen(false);
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : "Não foi possível mover o documento.");
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
        message: "Documento arquivado com sucesso.",
      });
      setArchiveOpen(false);
    } catch (error) {
      setArchiveError(
        error instanceof Error ? error.message : "Não foi possível arquivar o documento.",
      );
    }
  };

  const folderOptions = foldersQuery.data ?? [];

  return (
    <>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          variant="outlined"
          startIcon={<DriveFileMoveOutlinedIcon />}
          onClick={handleOpenMove}
        >
          Mover pasta
        </Button>

        {canArchive ? (
          <Button
            variant="outlined"
            color="warning"
            startIcon={<ArchiveOutlinedIcon />}
            onClick={handleOpenArchive}
          >
            Arquivar
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
        <DialogTitle id={moveTitleId}>Mover documento de pasta</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText id={moveDescId}>
              Selecione a pasta de destino para organizar "{document.title}". Apenas pastas ativas e
              autorizadas são exibidas.
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
              label="Pasta de destino"
              value={foldersQuery.isLoading ? "" : selectedFolderId}
              onChange={(event) => setSelectedFolderId(event.target.value)}
              fullWidth
              disabled={moveMutation.isPending || foldersQuery.isLoading}
            >
              <MenuItem value="">Sem pasta (raiz)</MenuItem>
              {folderOptions.map((folder) => (
                <MenuItem key={folder.id} value={folder.id}>
                  {folder.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleCloseMove} disabled={moveMutation.isPending} variant="text">
            Cancelar
          </Button>
          <Button
            onClick={() => void handleConfirmMove()}
            disabled={moveMutation.isPending || foldersQuery.isLoading}
            variant="contained"
          >
            {moveMutation.isPending ? "Movendo..." : "Confirmar movimentação"}
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
        <DialogTitle id={archiveTitleId}>Arquivar documento</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText id={archiveDescId}>
              Ao arquivar "{document.title}", o registro e suas versões permanecem preservados para
              consulta, mas novas versões não poderão ser enviadas enquanto estiver arquivado.
            </DialogContentText>

            {archiveError ? (
              <Alert severity="error" role="alert">
                {archiveError}
              </Alert>
            ) : null}

            <TextField
              label="Motivo do arquivamento (opcional)"
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
            Cancelar
          </Button>
          <Button
            onClick={() => void handleConfirmArchive()}
            disabled={archiveMutation.isPending}
            color="warning"
            variant="contained"
          >
            {archiveMutation.isPending ? "Arquivando..." : "Confirmar arquivamento"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
