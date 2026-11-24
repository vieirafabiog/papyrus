import {
  CONTRACTS_API_PREFIX,
  type CategoryFieldRecord,
  type DocumentMetadataValue,
  categoryFieldListResponseSchema,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS } from "@docuflow/ui";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HourglassEmptyOutlinedIcon from "@mui/icons-material/HourglassEmptyOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import SubdirectoryArrowRightOutlinedIcon from "@mui/icons-material/SubdirectoryArrowRightOutlined";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildFolderTreeOptions } from "../folders/folderTree.js";
import {
  getFileProcessingDescriptor,
  sanitizeUserFacingRejectionMessage,
} from "./FileProcessingStatus.js";
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
  readonly fields?: readonly CategoryFieldRecord[] | undefined;
}

export interface UploadFolderOption {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string | null | undefined;
}

export interface UploadDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly categories?: readonly UploadCategoryOption[] | undefined;
  readonly folders?: readonly UploadFolderOption[] | undefined;
  readonly defaultCategoryId?: string | undefined;
  readonly defaultFolderId?: string | null | undefined;
  readonly documentId?: string | undefined;
  readonly createDocumentOnFinalize?: boolean | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly binaryUploader?: BinaryUploadExecutor | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly onUploadBatchFinished?: (() => void) | undefined;
}

function isValidIsoDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [yRaw, mRaw, dRaw] = value.split("-");
  const y = Number(yRaw);
  const m = Number(mRaw);
  const d = Number(dRaw);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  );
}

function validateUploadCategoryFields(params: {
  readonly fields: readonly CategoryFieldRecord[];
  readonly textValues: Readonly<Record<string, string>>;
  readonly booleanValues: Readonly<Record<string, boolean>>;
  readonly multiValues: Readonly<Record<string, readonly string[]>>;
}): {
  readonly valid: boolean;
  readonly fieldErrors: Record<string, string>;
  readonly normalizedMetadata: Record<string, DocumentMetadataValue>;
} {
  const fieldErrors: Record<string, string> = {};
  const normalizedMetadata: Record<string, DocumentMetadataValue> = {};

  for (const field of params.fields) {
    switch (field.type) {
      case "TEXT": {
        const value = (params.textValues[field.key] ?? "").trim();
        if (value.length === 0) {
          if (field.required) {
            fieldErrors[field.key] = "Campo obrigatório não informado.";
          } else {
            normalizedMetadata[field.key] = null;
          }
        } else {
          normalizedMetadata[field.key] = value;
        }
        break;
      }
      case "NUMBER": {
        const raw = (params.textValues[field.key] ?? "").trim();
        if (raw.length === 0) {
          if (field.required) {
            fieldErrors[field.key] = "Campo obrigatório não informado.";
          } else {
            normalizedMetadata[field.key] = null;
          }
        } else {
          const normalizedNumeric =
            raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw;
          const num = Number(normalizedNumeric);
          if (!Number.isFinite(num)) {
            fieldErrors[field.key] = "Deve ser um número válido.";
          } else {
            normalizedMetadata[field.key] = num;
          }
        }
        break;
      }
      case "DATE": {
        const raw = (params.textValues[field.key] ?? "").trim();
        if (raw.length === 0) {
          if (field.required) {
            fieldErrors[field.key] = "Campo obrigatório não informado.";
          } else {
            normalizedMetadata[field.key] = null;
          }
        } else if (!isValidIsoDateString(raw)) {
          fieldErrors[field.key] = "Informe uma data válida no formato AAAA-MM-DD.";
        } else {
          normalizedMetadata[field.key] = raw;
        }
        break;
      }
      case "BOOLEAN": {
        normalizedMetadata[field.key] = params.booleanValues[field.key] ?? false;
        break;
      }
      case "SINGLE_SELECT": {
        const raw = (params.textValues[field.key] ?? "").trim();
        const allowed = field.options ?? [];
        if (raw.length === 0) {
          if (field.required) {
            fieldErrors[field.key] = "Selecione uma opção obrigatória.";
          } else {
            normalizedMetadata[field.key] = null;
          }
        } else if (!allowed.includes(raw)) {
          fieldErrors[field.key] = "Opção selecionada não é permitida.";
        } else {
          normalizedMetadata[field.key] = raw;
        }
        break;
      }
      case "MULTI_SELECT": {
        const selected = params.multiValues[field.key] ?? [];
        const allowed = field.options ?? [];
        if (field.required && selected.length === 0) {
          fieldErrors[field.key] = "Selecione ao menos uma opção.";
        } else if (selected.some((item) => !allowed.includes(item))) {
          fieldErrors[field.key] = "Contém opção não permitida.";
        } else {
          normalizedMetadata[field.key] = [...selected];
        }
        break;
      }
    }
  }

  return {
    valid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
    normalizedMetadata,
  };
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
    case "QUARANTINED": {
      const descriptor = getFileProcessingDescriptor("QUARANTINED");
      return {
        label: descriptor.label,
        color: descriptor.chipColor,
        icon: <HourglassEmptyOutlinedIcon fontSize="small" />,
      };
    }
    case "AVAILABLE": {
      const descriptor = getFileProcessingDescriptor("AVAILABLE");
      return {
        label: descriptor.label,
        color: descriptor.chipColor,
        icon: <CheckCircleOutlineIcon fontSize="small" />,
      };
    }
    case "REJECTED": {
      const descriptor = getFileProcessingDescriptor("REJECTED");
      return {
        label: descriptor.label,
        color: descriptor.chipColor,
        icon: <ErrorOutlineIcon fontSize="small" />,
      };
    }
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
  createDocumentOnFinalize,
  maxFileBytes,
  binaryUploader,
  fetchFn,
  onUploadBatchFinished,
}: UploadDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fetchImpl = fetchFn ?? globalThis.fetch;

  const [isDragging, setIsDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState(defaultCategoryId);
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? "");
  const [expirationDate, setExpirationDate] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [categoryFields, setCategoryFields] = useState<readonly CategoryFieldRecord[]>([]);
  const [loadingCategoryFields, setLoadingCategoryFields] = useState(false);
  const [categoryFieldsError, setCategoryFieldsError] = useState<string | null>(null);
  const [customTextValues, setCustomTextValues] = useState<Record<string, string>>({});
  const [customBooleanValues, setCustomBooleanValues] = useState<Record<string, boolean>>({});
  const [customMultiValues, setCustomMultiValues] = useState<Record<string, string[]>>({});
  const [customFieldErrors, setCustomFieldErrors] = useState<Record<string, string>>({});

  const selectedCategory = useMemo(
    () => categories.find((cat) => cat.id === categoryId),
    [categories, categoryId],
  );

  const sortedCategoryFields = useMemo(
    () => [...categoryFields].sort((a, b) => a.sortOrder - b.sortOrder),
    [categoryFields],
  );

  const folderTreeOptions = useMemo(() => buildFolderTreeOptions(folders), [folders]);
  const folderById = useMemo(
    () => new Map(folderTreeOptions.map((item) => [item.id, item])),
    [folderTreeOptions],
  );

  const shouldLoadCategoryFields = Boolean(createDocumentOnFinalize) && !documentId;

  useEffect(() => {
    const trimmedCategoryId = categoryId.trim();
    setCustomTextValues({});
    setCustomBooleanValues({});
    setCustomMultiValues({});
    setCustomFieldErrors({});
    setCategoryFieldsError(null);

    if (!open || !shouldLoadCategoryFields || trimmedCategoryId.length === 0) {
      setCategoryFields([]);
      setLoadingCategoryFields(false);
      return;
    }

    if (selectedCategory?.fields !== undefined) {
      setCategoryFields(selectedCategory.fields);
      setLoadingCategoryFields(false);
      return;
    }

    const controller = new AbortController();
    setLoadingCategoryFields(true);

    void (async () => {
      try {
        const response = await fetchImpl(
          `${CONTRACTS_API_PREFIX}/categories/${trimmedCategoryId}/fields`,
          {
            method: "GET",
            credentials: "include",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) {
          return;
        }
        if (response.status === 404) {
          setCategoryFields([]);
          return;
        }
        if (!response.ok) {
          setCategoryFields([]);
          setCategoryFieldsError(
            "Não foi possível carregar os campos personalizados da categoria.",
          );
          return;
        }
        const rawJson: unknown = await response.json();
        if (controller.signal.aborted) {
          return;
        }
        const parsed = categoryFieldListResponseSchema.safeParse(rawJson);
        if (!parsed.success) {
          setCategoryFields([]);
          setCategoryFieldsError("Resposta inválida ao carregar os campos da categoria.");
          return;
        }
        setCategoryFields(parsed.data.data);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setCategoryFields([]);
      } finally {
        if (!controller.signal.aborted) {
          setLoadingCategoryFields(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [open, shouldLoadCategoryFields, categoryId, selectedCategory?.fields, fetchImpl]);

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
    createDocumentOnFinalize,
    maxFileBytes,
    binaryUploader,
    fetchFn,
  });

  const clearSingleCustomFieldError = (fieldKey: string): void => {
    setCustomFieldErrors((prev) => {
      if (prev[fieldKey] === undefined) {
        return prev;
      }
      const next = { ...prev };
      delete next[fieldKey];
      return next;
    });
  };

  const buildValidatedMetadataValues = (): UploadMetadataFormValues | null => {
    setFormError(null);
    setCategoryError(null);

    if (categories.length > 0 && categoryId.trim().length === 0) {
      setCategoryError("Selecione uma categoria documental antes de enviar.");
      return null;
    }

    if (loadingCategoryFields) {
      setFormError("Aguarde o carregamento dos campos personalizados da categoria.");
      return null;
    }

    const customValidation = validateUploadCategoryFields({
      fields: sortedCategoryFields,
      textValues: customTextValues,
      booleanValues: customBooleanValues,
      multiValues: customMultiValues,
    });

    if (!customValidation.valid) {
      setCustomFieldErrors(customValidation.fieldErrors);
      setFormError("Preencha corretamente os campos personalizados obrigatórios da categoria.");
      return null;
    }

    setCustomFieldErrors({});

    return {
      title,
      categoryId,
      folderId: folderId.trim().length > 0 ? folderId : null,
      expirationDate,
      changeNote,
      metadata: customValidation.normalizedMetadata,
    };
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const validatedMetadata = buildValidatedMetadataValues();
    if (!validatedMetadata) {
      return;
    }
    if (summary.ready === 0) {
      setFormError("Selecione ao menos um arquivo válido para iniciar o envio.");
      return;
    }
    await startBatchUpload(validatedMetadata);
    onUploadBatchFinished?.();
  };

  const handleRetryItem = async (localId: string): Promise<void> => {
    const validatedMetadata = buildValidatedMetadataValues();
    if (!validatedMetadata) {
      return;
    }
    await retryItem(localId, validatedMetadata);
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
                    slotProps={{
                      inputLabel: { shrink: true },
                      select: {
                        displayEmpty: true,
                        renderValue: (selected) => {
                          const value = typeof selected === "string" ? selected : "";
                          if (value.length === 0) {
                            return "Raiz do acervo";
                          }
                          return folderById.get(value)?.fullPath ?? "";
                        },
                      },
                    }}
                    fullWidth
                  >
                    <MenuItem value="">Raiz do acervo</MenuItem>
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

                {shouldLoadCategoryFields &&
                (loadingCategoryFields ||
                  categoryFieldsError !== null ||
                  sortedCategoryFields.length > 0) ? (
                  <>
                    <Divider />
                    <Stack spacing={1.5}>
                      <Typography variant="subtitle2" component="h3">
                        Campos personalizados da categoria
                      </Typography>

                      {loadingCategoryFields ? (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <CircularProgress size={16} />
                          <Typography variant="body2" color="text.secondary">
                            Carregando campos da categoria...
                          </Typography>
                        </Stack>
                      ) : null}

                      {categoryFieldsError ? (
                        <Alert severity="warning" role="alert">
                          {categoryFieldsError}
                        </Alert>
                      ) : null}

                      {!loadingCategoryFields && sortedCategoryFields.length > 0 ? (
                        <Box
                          sx={{
                            display: "grid",
                            gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                            gap: 2,
                          }}
                        >
                          {sortedCategoryFields.map((field) => {
                            const errorMsg = customFieldErrors[field.key];
                            const helperId = `upload-field-error-${field.key}`;

                            switch (field.type) {
                              case "TEXT":
                                return (
                                  <TextField
                                    key={field.id}
                                    fullWidth
                                    required={field.required}
                                    label={field.label}
                                    value={customTextValues[field.key] ?? ""}
                                    onChange={(event) => {
                                      setCustomTextValues((prev) => ({
                                        ...prev,
                                        [field.key]: event.target.value,
                                      }));
                                      clearSingleCustomFieldError(field.key);
                                    }}
                                    error={Boolean(errorMsg)}
                                    helperText={errorMsg}
                                    disabled={summary.isUploading}
                                  />
                                );

                              case "NUMBER":
                                return (
                                  <TextField
                                    key={field.id}
                                    fullWidth
                                    required={field.required}
                                    type="text"
                                    inputMode="decimal"
                                    label={field.label}
                                    value={customTextValues[field.key] ?? ""}
                                    onChange={(event) => {
                                      setCustomTextValues((prev) => ({
                                        ...prev,
                                        [field.key]: event.target.value,
                                      }));
                                      clearSingleCustomFieldError(field.key);
                                    }}
                                    error={Boolean(errorMsg)}
                                    helperText={errorMsg}
                                    disabled={summary.isUploading}
                                  />
                                );

                              case "DATE":
                                return (
                                  <TextField
                                    key={field.id}
                                    fullWidth
                                    required={field.required}
                                    type="date"
                                    label={field.label}
                                    value={customTextValues[field.key] ?? ""}
                                    onChange={(event) => {
                                      setCustomTextValues((prev) => ({
                                        ...prev,
                                        [field.key]: event.target.value,
                                      }));
                                      clearSingleCustomFieldError(field.key);
                                    }}
                                    slotProps={{ inputLabel: { shrink: true } }}
                                    error={Boolean(errorMsg)}
                                    helperText={errorMsg}
                                    disabled={summary.isUploading}
                                  />
                                );

                              case "BOOLEAN":
                                return (
                                  <FormControl
                                    key={field.id}
                                    error={Boolean(errorMsg)}
                                    component="fieldset"
                                  >
                                    <FormControlLabel
                                      control={
                                        <Switch
                                          checked={customBooleanValues[field.key] ?? false}
                                          onChange={(event) => {
                                            setCustomBooleanValues((prev) => ({
                                              ...prev,
                                              [field.key]: event.target.checked,
                                            }));
                                            clearSingleCustomFieldError(field.key);
                                          }}
                                          disabled={summary.isUploading}
                                        />
                                      }
                                      label={field.required ? `${field.label} *` : field.label}
                                    />
                                    {errorMsg ? (
                                      <FormHelperText id={helperId}>{errorMsg}</FormHelperText>
                                    ) : null}
                                  </FormControl>
                                );

                              case "SINGLE_SELECT": {
                                const labelId = `upload-select-label-${field.key}`;
                                return (
                                  <FormControl
                                    key={field.id}
                                    fullWidth
                                    required={field.required}
                                    error={Boolean(errorMsg)}
                                  >
                                    <InputLabel id={labelId}>{field.label}</InputLabel>
                                    <Select
                                      labelId={labelId}
                                      label={field.label}
                                      value={customTextValues[field.key] ?? ""}
                                      onChange={(event) => {
                                        setCustomTextValues((prev) => ({
                                          ...prev,
                                          [field.key]: String(event.target.value),
                                        }));
                                        clearSingleCustomFieldError(field.key);
                                      }}
                                      disabled={summary.isUploading}
                                      aria-describedby={errorMsg ? helperId : undefined}
                                    >
                                      <MenuItem value="">
                                        <em>Selecione...</em>
                                      </MenuItem>
                                      {(field.options ?? []).map((option) => (
                                        <MenuItem key={option} value={option}>
                                          {option}
                                        </MenuItem>
                                      ))}
                                    </Select>
                                    {errorMsg ? (
                                      <FormHelperText id={helperId}>{errorMsg}</FormHelperText>
                                    ) : null}
                                  </FormControl>
                                );
                              }

                              case "MULTI_SELECT": {
                                const labelId = `upload-multiselect-label-${field.key}`;
                                const selectedValues = customMultiValues[field.key] ?? [];
                                return (
                                  <FormControl
                                    key={field.id}
                                    fullWidth
                                    required={field.required}
                                    error={Boolean(errorMsg)}
                                  >
                                    <InputLabel id={labelId}>{field.label}</InputLabel>
                                    <Select
                                      multiple
                                      labelId={labelId}
                                      label={field.label}
                                      value={selectedValues}
                                      onChange={(event) => {
                                        const raw = event.target.value;
                                        const next =
                                          typeof raw === "string"
                                            ? raw.split(",")
                                            : Array.from(raw);
                                        setCustomMultiValues((prev) => ({
                                          ...prev,
                                          [field.key]: next,
                                        }));
                                        clearSingleCustomFieldError(field.key);
                                      }}
                                      renderValue={(selected) => selected.join(", ")}
                                      disabled={summary.isUploading}
                                      aria-describedby={errorMsg ? helperId : undefined}
                                    >
                                      {(field.options ?? []).map((option) => (
                                        <MenuItem key={option} value={option}>
                                          <Checkbox checked={selectedValues.includes(option)} />
                                          <ListItemText primary={option} />
                                        </MenuItem>
                                      ))}
                                    </Select>
                                    {errorMsg ? (
                                      <FormHelperText id={helperId}>{errorMsg}</FormHelperText>
                                    ) : null}
                                  </FormControl>
                                );
                              }
                            }
                          })}
                        </Box>
                      ) : null}
                    </Stack>
                  </>
                ) : null}

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
                                onClick={() => void handleRetryItem(item.localId)}
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
                            {item.status === "REJECTED"
                              ? sanitizeUserFacingRejectionMessage(item.errorMessage)
                              : item.errorMessage}
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
