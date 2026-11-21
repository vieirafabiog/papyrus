import { DOCUFLOW_COLOR_TOKENS } from "@docuflow/ui";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import HourglassEmptyOutlinedIcon from "@mui/icons-material/HourglassEmptyOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  List,
  ListItem,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type ChangeEvent, type DragEvent, type FormEvent, useId, useRef, useState } from "react";
import {
  type BinaryUploadExecutor,
  type UploadMetadataFormValues,
  type UploadQueueItem,
  formatBytesPtBr,
  useUploadDocuments,
} from "./useUploadDocuments.js";

export interface UploadCategoryOption {
  readonly id: string;
  readonly name: string;
}

export interface UploadFolderOption {
  readonly id: string;
  readonly name: string;
}

export interface UploadDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly categories?: readonly UploadCategoryOption[] | undefined;
  readonly folders?: readonly UploadFolderOption[] | undefined;
  readonly defaultCategoryId?: string | undefined;
  readonly defaultFolderId?: string | null | undefined;
  readonly documentId?: string | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly binaryUploader?: BinaryUploadExecutor | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly onUploadBatchFinished?: (() => void) | undefined;
}

function getStatusChipProps(status: UploadQueueItem["status"]): {
  readonly label: string;
  readonly color: "default" | "primary" | "info" | "success" | "warning" | "error";
  readonly icon: React.ReactElement;
} {
  switch (status) {
    case "READY":
      return {
        label: "Pronto para envio",
        color: "default",
        icon: <InsertDriveFileOutlinedIcon fontSize="small" />,
      };
    case "CREATING_SESSION":
      return {
        label: "Preparando envio",
        color: "info",
        icon: <HourglassEmptyOutlinedIcon fontSize="small" />,
      };
    case "UPLOADING":
      return {
        label: "Enviando",
        color: "primary",
        icon: <CloudUploadOutlinedIcon fontSize="small" />,
      };
    case "FINALIZING":
      return {
        label: "Confirmando envio",
        color: "info",
        icon: <HourglassEmptyOutlinedIcon fontSize="small" />,
      };
    case "QUARANTINED":
      return {
        label: "Em análise",
        color: "warning",
        icon: <HourglassEmptyOutlinedIcon fontSize="small" />,
      };
    case "AVAILABLE":
      return {
        label: "Disponível",
        color: "success",
        icon: <CheckCircleOutlineIcon fontSize="small" />,
      };
    case "REJECTED":
      return {
        label: "Rejeitado",
        color: "error",
        icon: <ErrorOutlineIcon fontSize="small" />,
      };
    case "CANCELLED":
      return {
        label: "Cancelado",
        color: "default",
        icon: <CancelOutlinedIcon fontSize="small" />,
      };
    case "ERROR":
      return {
        label: "Falha no envio",
        color: "error",
        icon: <ErrorOutlineIcon fontSize="small" />,
      };
  }
}

export function UploadDialog({
  open,
  onClose,
  categories = [],
  folders = [],
  defaultCategoryId = "",
  defaultFolderId = null,
  documentId,
  maxFileBytes,
  binaryUploader,
  fetchFn,
  onUploadBatchFinished,
}: UploadDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState(defaultCategoryId);
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? "");
  const [expirationDate, setExpirationDate] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    items,
    summary,
    maxFileBytes: resolvedMaxFileBytes,
    addFiles,
    removeItem,
    cancelItem,
    cancelAll,
    clearAll,
    startBatchUpload,
    retryItem,
  } = useUploadDocuments({
    documentId,
    maxFileBytes,
    binaryUploader,
    fetchFn,
  });

  const metadataValues: UploadMetadataFormValues = {
    title,
    categoryId,
    folderId: folderId.trim().length > 0 ? folderId : null,
    expirationDate,
    changeNote,
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files && event.target.files.length > 0) {
      addFiles(event.target.files);
      setFormError(null);
      event.target.value = "";
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      addFiles(event.dataTransfer.files);
      setFormError(null);
    }
  };

  const validateBeforeUpload = (): boolean => {
    setFormError(null);
    setCategoryError(null);

    if (categories.length > 0 && categoryId.trim().length === 0) {
      setCategoryError("Selecione uma categoria documental antes de enviar.");
      return false;
    }

    if (summary.ready === 0) {
      setFormError("Selecione ao menos um arquivo válido para iniciar o envio.");
      return false;
    }

    return true;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!validateBeforeUpload()) {
      return;
    }
    await startBatchUpload(metadataValues);
    onUploadBatchFinished?.();
  };

  const handleDialogClose = (): void => {
    if (summary.isUploading) {
      cancelAll();
    }
    onClose();
  };

  const showPartialBatchNotice =
    !summary.isUploading &&
    summary.total > 0 &&
    (summary.failed > 0 || summary.cancelled > 0) &&
    summary.succeeded > 0;

  return (
    <Dialog
      open={open}
      onClose={handleDialogClose}
      maxWidth="md"
      fullWidth
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle
        id={titleId}
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          pb: 1,
        }}
      >
        <span>Enviar documentos</span>
        <IconButton aria-label="Fechar janela de envio" onClick={handleDialogClose} size="small">
          <CloseOutlinedIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <Box component="form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <DialogContent dividers sx={{ pt: 2 }}>
          <Stack spacing={2.5}>
            <Typography id={descriptionId} variant="body2" color="text.secondary">
              Selecione um ou mais arquivos (até {formatBytesPtBr(resolvedMaxFileBytes)} por item),
              preencha os metadados iniciais e acompanhe o envio individualmente.
            </Typography>

            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow,
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Stack spacing={2}>
                <Typography variant="subtitle1" component="h2">
                  Metadados iniciais
                </Typography>

                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                    gap: 2,
                  }}
                >
                  <TextField
                    label="Título do documento"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={summary.isUploading}
                    helperText={
                      items.length > 1
                        ? "Opcional em lote: usado como prefixo ou mantém o nome de cada arquivo."
                        : "Opcional: se vazio, utiliza o nome do arquivo selecionado."
                    }
                    fullWidth
                  />

                  <TextField
                    select
                    label="Categoria"
                    value={categoryId}
                    onChange={(e) => {
                      setCategoryId(e.target.value);
                      if (e.target.value.trim().length > 0) {
                        setCategoryError(null);
                      }
                    }}
                    disabled={summary.isUploading || categories.length === 0}
                    required={categories.length > 0}
                    error={categoryError !== null}
                    helperText={
                      categoryError ??
                      (categories.length === 0
                        ? "Nenhuma categoria listada; será usada a rota padrão."
                        : undefined)
                    }
                    fullWidth
                  >
                    {categories.length === 0 ? (
                      <MenuItem value="">Rota padrão da organização</MenuItem>
                    ) : (
                      categories.map((cat) => (
                        <MenuItem key={cat.id} value={cat.id}>
                          {cat.name}
                        </MenuItem>
                      ))
                    )}
                  </TextField>

                  <TextField
                    select
                    label="Pasta de destino"
                    value={folderId}
                    onChange={(e) => setFolderId(e.target.value)}
                    disabled={summary.isUploading}
                    fullWidth
                  >
                    <MenuItem value="">Raiz do acervo</MenuItem>
                    {folders.map((folder) => (
                      <MenuItem key={folder.id} value={folder.id}>
                        {folder.name}
                      </MenuItem>
                    ))}
                  </TextField>

                  <TextField
                    label="Data de vencimento"
                    type="date"
                    value={expirationDate}
                    onChange={(e) => setExpirationDate(e.target.value)}
                    disabled={summary.isUploading}
                    slotProps={{ inputLabel: { shrink: true } }}
                    fullWidth
                  />
                </Box>

                <TextField
                  label="Observação da versão"
                  value={changeNote}
                  onChange={(e) => setChangeNote(e.target.value)}
                  disabled={summary.isUploading}
                  multiline
                  minRows={2}
                  maxRows={3}
                  fullWidth
                />
              </Stack>
            </Paper>

            <Paper
              variant="outlined"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              sx={{
                p: 2.5,
                textAlign: "center",
                borderStyle: "dashed",
                borderColor: isDragging
                  ? DOCUFLOW_COLOR_TOKENS.primary.main
                  : DOCUFLOW_COLOR_TOKENS.surface.outline,
                bgcolor: isDragging
                  ? DOCUFLOW_COLOR_TOKENS.primary.container
                  : DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                aria-label="Selecionar arquivos para envio"
                onChange={handleFileInputChange}
                style={{ display: "none" }}
              />
              <Stack spacing={1} alignItems="center">
                <CloudUploadOutlinedIcon color="primary" fontSize="large" />
                <Typography variant="body1">
                  Arraste e solte arquivos aqui ou selecione manualmente
                </Typography>
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={summary.isUploading}
                >
                  Selecionar arquivos
                </Button>
              </Stack>
            </Paper>

            {formError ? (
              <Alert severity="error" role="alert">
                {formError}
              </Alert>
            ) : null}

            {showPartialBatchNotice ? (
              <Alert severity="warning" aria-live="polite">
                {summary.succeeded} arquivo(s) enviado(s) e {summary.failed + summary.cancelled}{" "}
                item(ns) não concluído(s). Revise ou tente novamente os itens pendentes.
              </Alert>
            ) : null}

            {items.length > 0 ? (
              <Stack spacing={1}>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Typography variant="subtitle1" component="h2">
                    Arquivos selecionados ({items.length})
                  </Typography>
                  {!summary.isUploading ? (
                    <Button type="button" size="small" onClick={clearAll}>
                      Limpar lista
                    </Button>
                  ) : null}
                </Box>

                <List disablePadding aria-label="Fila de arquivos para envio">
                  {items.map((item) => {
                    const chip = getStatusChipProps(item.status);
                    const isActive =
                      item.status === "CREATING_SESSION" ||
                      item.status === "UPLOADING" ||
                      item.status === "FINALIZING";
                    const canRetry = item.status === "ERROR" || item.status === "CANCELLED";

                    return (
                      <ListItem
                        key={item.localId}
                        divider
                        disableGutters
                        sx={{ py: 1.25, flexDirection: "column", alignItems: "stretch", gap: 1 }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 1.5,
                            flexWrap: "wrap",
                          }}
                        >
                          <Box sx={{ minWidth: 0, flex: "1 1 220px" }}>
                            <Typography variant="body1" noWrap>
                              {item.file.name}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {formatBytesPtBr(item.file.size)}
                              {item.status === "UPLOADING"
                                ? ` — ${item.progressPercent}% enviado`
                                : ""}
                            </Typography>
                          </Box>

                          <Stack direction="row" spacing={1} alignItems="center">
                            <Chip
                              size="small"
                              color={chip.color}
                              icon={chip.icon}
                              label={chip.label}
                            />

                            {isActive ? (
                              <Button
                                type="button"
                                size="small"
                                color="inherit"
                                startIcon={<CancelOutlinedIcon fontSize="small" />}
                                onClick={() => cancelItem(item.localId)}
                              >
                                Cancelar {item.file.name}
                              </Button>
                            ) : null}

                            {canRetry ? (
                              <Button
                                type="button"
                                size="small"
                                variant="outlined"
                                startIcon={<RefreshOutlinedIcon fontSize="small" />}
                                onClick={() => void retryItem(item.localId, metadataValues)}
                              >
                                Tentar novamente {item.file.name}
                              </Button>
                            ) : null}

                            {!isActive ? (
                              <IconButton
                                type="button"
                                size="small"
                                aria-label={`Remover ${item.file.name}`}
                                onClick={() => removeItem(item.localId)}
                              >
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            ) : null}
                          </Stack>
                        </Box>

                        {isActive ? (
                          <LinearProgress
                            variant={item.status === "FINALIZING" ? "indeterminate" : "determinate"}
                            value={item.progressPercent}
                            aria-label={`Progresso de envio de ${item.file.name}`}
                          />
                        ) : null}

                        {item.errorMessage ? (
                          <Typography variant="caption" color="error" role="alert">
                            {item.errorMessage}
                          </Typography>
                        ) : null}
                      </ListItem>
                    );
                  })}
                </List>
              </Stack>
            ) : null}
          </Stack>
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 2, gap: 1 }}>
          {summary.isUploading ? (
            <Button type="button" color="warning" variant="outlined" onClick={cancelAll}>
              Cancelar todos
            </Button>
          ) : null}

          <Button type="button" onClick={handleDialogClose} color="inherit">
            {summary.isUploading ? "Cancelar e fechar" : "Fechar"}
          </Button>

          <Button
            type="submit"
            variant="contained"
            startIcon={<CloudUploadOutlinedIcon />}
            disabled={summary.isUploading || summary.ready === 0}
          >
            {summary.isUploading ? "Enviando..." : `Iniciar envio (${summary.ready})`}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
