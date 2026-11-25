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
  CONTRACTS_API_PREFIX,
  type CategoryFieldRecord,
  type CategoryTextIndexingMode,
  type DocumentMetadataValue,
  categoryFieldListResponseSchema,
} from "@papyrus/contracts";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
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
import { Link as RouterLink, useInRouterContext } from "react-router-dom";
import { type UiLocale, translate, useI18n } from "../../i18n/index.js";
import { buildFolderTreeOptions } from "../folders/folderTree.js";
import {
  getFileProcessingDescriptor,
  sanitizeUserFacingRejectionMessage,
} from "./FileProcessingStatus.js";
import {
  type BinaryUploadExecutor,
  type UploadMetadataFormValues,
  type UploadQueueItem,
  useUploadDocuments,
} from "./useUploadDocuments.js";

export interface UploadCategoryOption {
  readonly id: string;
  readonly name: string;
  readonly textIndexingMode?: CategoryTextIndexingMode | undefined;
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
  readonly categoryTextIndexingMode?: CategoryTextIndexingMode | undefined;
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
  readonly locale: UiLocale;
}): {
  readonly valid: boolean;
  readonly fieldErrors: Record<string, string>;
  readonly normalizedMetadata: Record<string, DocumentMetadataValue>;
} {
  const { locale } = params;
  const fieldErrors: Record<string, string> = {};
  const normalizedMetadata: Record<string, DocumentMetadataValue> = {};

  for (const field of params.fields) {
    switch (field.type) {
      case "TEXT": {
        const value = (params.textValues[field.key] ?? "").trim();
        if (value.length === 0) {
          if (field.required) {
            fieldErrors[field.key] = translate(
              "documents.validation.requiredField",
              undefined,
              locale,
            );
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
            fieldErrors[field.key] = translate(
              "documents.validation.requiredField",
              undefined,
              locale,
            );
          } else {
            normalizedMetadata[field.key] = null;
          }
        } else {
          const normalizedNumeric =
            raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw;
          const num = Number(normalizedNumeric);
          if (!Number.isFinite(num)) {
            fieldErrors[field.key] = translate(
              "documents.validation.invalidNumber",
              undefined,
              locale,
            );
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
            fieldErrors[field.key] = translate(
              "documents.validation.requiredField",
              undefined,
              locale,
            );
          } else {
            normalizedMetadata[field.key] = null;
          }
        } else if (!isValidIsoDateString(raw)) {
          fieldErrors[field.key] = translate("documents.validation.invalidDate", undefined, locale);
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
            fieldErrors[field.key] = translate(
              "documents.validation.selectRequiredOption",
              undefined,
              locale,
            );
          } else {
            normalizedMetadata[field.key] = null;
          }
        } else if (!allowed.includes(raw)) {
          fieldErrors[field.key] = translate(
            "documents.validation.optionNotAllowed",
            undefined,
            locale,
          );
        } else {
          normalizedMetadata[field.key] = raw;
        }
        break;
      }
      case "MULTI_SELECT": {
        const selected = params.multiValues[field.key] ?? [];
        const allowed = field.options ?? [];
        if (field.required && selected.length === 0) {
          fieldErrors[field.key] = translate(
            "documents.validation.selectAtLeastOneOption",
            undefined,
            locale,
          );
        } else if (selected.some((item) => !allowed.includes(item))) {
          fieldErrors[field.key] = translate(
            "documents.validation.containsDisallowedOption",
            undefined,
            locale,
          );
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

function getStatusChipProps(
  status: UploadQueueItem["status"],
  locale: UiLocale,
): {
  readonly label: string;
  readonly color: "default" | "primary" | "info" | "success" | "warning" | "error";
  readonly icon: React.ReactElement;
} {
  switch (status) {
    case "READY":
      return {
        label: translate("documents.upload.status.ready", undefined, locale),
        color: "default",
        icon: <InsertDriveFileOutlinedIcon fontSize="small" />,
      };
    case "CREATING_SESSION":
      return {
        label: translate("documents.upload.status.creatingSession", undefined, locale),
        color: "info",
        icon: <HourglassEmptyOutlinedIcon fontSize="small" />,
      };
    case "UPLOADING":
      return {
        label: translate("documents.upload.status.uploading", undefined, locale),
        color: "primary",
        icon: <CloudUploadOutlinedIcon fontSize="small" />,
      };
    case "FINALIZING":
      return {
        label: translate("documents.upload.status.finalizing", undefined, locale),
        color: "info",
        icon: <HourglassEmptyOutlinedIcon fontSize="small" />,
      };
    case "QUARANTINED": {
      const descriptor = getFileProcessingDescriptor("QUARANTINED", locale);
      return {
        label: descriptor.label,
        color: descriptor.chipColor,
        icon: <HourglassEmptyOutlinedIcon fontSize="small" />,
      };
    }
    case "AVAILABLE": {
      const descriptor = getFileProcessingDescriptor("AVAILABLE", locale);
      return {
        label: descriptor.label,
        color: descriptor.chipColor,
        icon: <CheckCircleOutlineIcon fontSize="small" />,
      };
    }
    case "REJECTED": {
      const descriptor = getFileProcessingDescriptor("REJECTED", locale);
      return {
        label: descriptor.label,
        color: descriptor.chipColor,
        icon: <ErrorOutlineIcon fontSize="small" />,
      };
    }
    case "CANCELLED":
      return {
        label: translate("documents.upload.status.cancelled", undefined, locale),
        color: "default",
        icon: <CancelOutlinedIcon fontSize="small" />,
      };
    case "ERROR":
      return {
        label: translate("documents.upload.status.error", undefined, locale),
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
  categoryTextIndexingMode,
  documentId,
  createDocumentOnFinalize,
  maxFileBytes,
  binaryUploader,
  fetchFn,
  onUploadBatchFinished,
}: UploadDialogProps) {
  const { locale, t, formatBytes } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const inRouterContext = useInRouterContext();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fetchImpl = fetchFn ?? globalThis.fetch;
  const missingRequiredCategory =
    Boolean(createDocumentOnFinalize) && !documentId && categories.length === 0;

  const [isDragging, setIsDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState(defaultCategoryId);
  const [folderId, setFolderId] = useState<string>(defaultFolderId ?? "");
  const [expirationDate, setExpirationDate] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [indexContentRequested, setIndexContentRequested] = useState(false);

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

  const effectiveTextIndexingMode: CategoryTextIndexingMode =
    categoryTextIndexingMode ?? selectedCategory?.textIndexingMode ?? "NEVER";

  const sortedCategoryFields = useMemo(
    () => [...categoryFields].sort((a, b) => a.sortOrder - b.sortOrder),
    [categoryFields],
  );

  const folderTreeOptions = useMemo(
    () => buildFolderTreeOptions(folders, locale),
    [folders, locale],
  );
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
    setIndexContentRequested(false);

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
            translate("documents.upload.categoryFieldsError", undefined, locale),
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
          setCategoryFieldsError(
            translate("documents.upload.categoryFieldsInvalid", undefined, locale),
          );
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
  }, [open, shouldLoadCategoryFields, categoryId, selectedCategory?.fields, fetchImpl, locale]);

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

    if (missingRequiredCategory) {
      setCategoryError(t("documents.upload.noCategoriesBlockingAlert"));
      return null;
    }

    if (categories.length > 0 && categoryId.trim().length === 0) {
      setCategoryError(t("documents.upload.selectCategoryRequired"));
      return null;
    }

    if (loadingCategoryFields) {
      setFormError(t("documents.upload.waitForCategoryFields"));
      return null;
    }

    const customValidation = validateUploadCategoryFields({
      fields: sortedCategoryFields,
      textValues: customTextValues,
      booleanValues: customBooleanValues,
      multiValues: customMultiValues,
      locale,
    });

    if (!customValidation.valid) {
      setCustomFieldErrors(customValidation.fieldErrors);
      setFormError(t("documents.upload.fixCustomFields"));
      return null;
    }

    setCustomFieldErrors({});

    return {
      title,
      categoryId,
      folderId: folderId.trim().length > 0 ? folderId : null,
      expirationDate,
      changeNote,
      ...(effectiveTextIndexingMode === "ASK" ? { indexContentRequested } : {}),
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
      setFormError(t("documents.upload.selectValidFile"));
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
        <span>{t("documents.upload.dialogTitle")}</span>
        <IconButton
          aria-label={t("documents.upload.closeAria")}
          onClick={handleDialogClose}
          size="small"
        >
          <CloseOutlinedIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <Box component="form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <DialogContent dividers sx={{ pt: 2 }}>
          <Stack spacing={2.5}>
            <Typography id={descriptionId} variant="body2" color="text.secondary">
              {t("documents.upload.description", {
                maxSize: formatBytes(resolvedMaxFileBytes),
              })}
            </Typography>

            {missingRequiredCategory ? (
              <Alert
                severity="warning"
                action={
                  inRouterContext ? (
                    <Button
                      component={RouterLink}
                      to="/categories"
                      color="inherit"
                      size="small"
                      onClick={handleDialogClose}
                    >
                      {t("documents.upload.goToCategories")}
                    </Button>
                  ) : (
                    <Button
                      component="a"
                      href="/categories"
                      color="inherit"
                      size="small"
                      onClick={handleDialogClose}
                    >
                      {t("documents.upload.goToCategories")}
                    </Button>
                  )
                }
              >
                {t("documents.upload.noCategoriesBlockingAlert")}
              </Alert>
            ) : null}

            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Stack spacing={2}>
                <Typography variant="subtitle1" component="h2">
                  {t("documents.upload.detailsHeading")}
                </Typography>

                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                    gap: 2,
                  }}
                >
                  <TextField
                    label={t("documents.form.titleLabel")}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={summary.isUploading}
                    helperText={
                      items.length > 1
                        ? t("documents.upload.titleHelperBatch")
                        : t("documents.upload.titleHelperSingle")
                    }
                    fullWidth
                  />

                  <TextField
                    select
                    label={t("documents.details.category")}
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
                        ? t("documents.upload.noCategoriesHelper")
                        : undefined)
                    }
                    slotProps={
                      categories.length === 0
                        ? {
                            inputLabel: { shrink: true },
                            select: {
                              displayEmpty: true,
                              renderValue: () => t("documents.upload.defaultCategoryOption"),
                            },
                          }
                        : undefined
                    }
                    fullWidth
                  >
                    {categories.length === 0 ? (
                      <MenuItem value="">{t("documents.upload.defaultCategoryOption")}</MenuItem>
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
                    label={t("documents.upload.destinationFolder")}
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
                            return t("documents.common.libraryRoot");
                          }
                          return folderById.get(value)?.fullPath ?? "";
                        },
                      },
                    }}
                    fullWidth
                  >
                    <MenuItem value="">{t("documents.common.libraryRoot")}</MenuItem>
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
                    label={t("documents.upload.expirationDate")}
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
                        {t("documents.upload.customFieldsHeading")}
                      </Typography>

                      {loadingCategoryFields ? (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <CircularProgress size={16} />
                          <Typography variant="body2" color="text.secondary">
                            {t("documents.upload.loadingCategoryFields")}
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
                                        <em>{t("documents.common.selectOption")}</em>
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

                {effectiveTextIndexingMode === "ASK" ? (
                  <Paper
                    variant="outlined"
                    sx={{
                      px: 2,
                      py: 1.25,
                      bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                      borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
                    }}
                  >
                    <FormControlLabel
                      control={
                        <Switch
                          checked={indexContentRequested}
                          onChange={(event) => setIndexContentRequested(event.target.checked)}
                          disabled={summary.isUploading}
                        />
                      }
                      label={t("documents.upload.indexContentSwitch")}
                    />
                    <FormHelperText sx={{ mt: 0.25 }}>
                      {t("documents.upload.indexContentHelper")}
                    </FormHelperText>
                  </Paper>
                ) : null}

                <TextField
                  label={t("documents.upload.versionNoteLabel")}
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
                  ? PAPYRUS_COLOR_TOKENS.primary.main
                  : PAPYRUS_COLOR_TOKENS.surface.outline,
                bgcolor: isDragging
                  ? PAPYRUS_COLOR_TOKENS.primary.container
                  : PAPYRUS_COLOR_TOKENS.surface.containerLowest,
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                aria-label={t("documents.upload.selectFilesAria")}
                onChange={handleFileInputChange}
                style={{ display: "none" }}
              />
              <Stack spacing={1} alignItems="center">
                <CloudUploadOutlinedIcon color="primary" fontSize="large" />
                <Typography variant="body1">{t("documents.upload.dropzonePrompt")}</Typography>
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={summary.isUploading}
                >
                  {t("documents.upload.selectFilesButton")}
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
                {t("documents.upload.partialBatchNotice", {
                  succeeded: summary.succeeded,
                  incomplete: summary.failed + summary.cancelled,
                })}
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
                    {t("documents.upload.selectedFilesHeading", { count: items.length })}
                  </Typography>
                  {!summary.isUploading ? (
                    <Button type="button" size="small" onClick={clearAll}>
                      {t("documents.upload.clearList")}
                    </Button>
                  ) : null}
                </Box>

                <List disablePadding aria-label={t("documents.upload.queueAriaLabel")}>
                  {items.map((item) => {
                    const chip = getStatusChipProps(item.status, locale);
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
                              {formatBytes(item.file.size)}
                              {item.status === "UPLOADING"
                                ? ` — ${t("documents.upload.percentUploaded", {
                                    percent: item.progressPercent,
                                  })}`
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
                                {t("documents.upload.cancelItem", { fileName: item.file.name })}
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
                                {t("documents.upload.retryItem", { fileName: item.file.name })}
                              </Button>
                            ) : null}

                            {!isActive ? (
                              <IconButton
                                type="button"
                                size="small"
                                aria-label={t("documents.upload.removeItemAria", {
                                  fileName: item.file.name,
                                })}
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
                            aria-label={t("documents.upload.progressAria", {
                              fileName: item.file.name,
                            })}
                          />
                        ) : null}

                        {item.errorMessage ? (
                          <Typography variant="caption" color="error" role="alert">
                            {item.status === "REJECTED"
                              ? sanitizeUserFacingRejectionMessage(item.errorMessage, locale)
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
              {t("documents.upload.cancelAll")}
            </Button>
          ) : null}

          <Button type="button" onClick={handleDialogClose} color="inherit">
            {summary.isUploading
              ? t("documents.upload.cancelAndClose")
              : t("documents.common.close")}
          </Button>

          <Button
            type="submit"
            variant="contained"
            startIcon={<CloudUploadOutlinedIcon />}
            disabled={summary.isUploading || summary.ready === 0 || missingRequiredCategory}
          >
            {summary.isUploading
              ? t("documents.upload.uploadingButton")
              : t("documents.upload.startUploadButton", { count: summary.ready })}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
