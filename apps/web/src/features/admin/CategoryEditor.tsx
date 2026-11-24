import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Grid,
  MenuItem,
  Paper,
  Stack,
  Switch,
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
  CategoryFieldRecord,
  CategoryFieldType,
  CategorySummaryRecord,
  FieldMigrationStrategy,
} from "@papyrus/contracts";
import {
  createCategoryFieldInputSchema,
  createCategoryInputSchema,
  updateCategoryFieldInputSchema,
  updateCategoryInputSchema,
} from "@papyrus/contracts";
import { EmptyState, ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import {
  useAddCategoryFieldMutation,
  useCategoryFieldsQuery,
  useCreateCategoryMutation,
  useDeleteCategoryFieldMutation,
  useUpdateCategoryFieldMutation,
  useUpdateCategoryMutation,
} from "./useCategoriesAdmin.js";
import {
  useClearCategoryRoutingRuleMutation,
  useStorageConnectionsQuery,
  useStorageRoutingRulesQuery,
  useUpsertStorageRoutingRuleMutation,
} from "./useStorageSettings.js";

const FIELD_TYPE_LABEL_KEYS: Readonly<Record<CategoryFieldType, MessageKey>> = {
  TEXT: "admin.categories.fieldType.TEXT",
  NUMBER: "admin.categories.fieldType.NUMBER",
  DATE: "admin.categories.fieldType.DATE",
  BOOLEAN: "admin.categories.fieldType.BOOLEAN",
  SINGLE_SELECT: "admin.categories.fieldType.SINGLE_SELECT",
  MULTI_SELECT: "admin.categories.fieldType.MULTI_SELECT",
};

const FIELD_TYPE_VALUES: readonly CategoryFieldType[] = [
  "TEXT",
  "NUMBER",
  "DATE",
  "BOOLEAN",
  "SINGLE_SELECT",
  "MULTI_SELECT",
];

type MigrationMode = "NONE" | "BACKFILL_DEFAULT" | "RESET_TO_DEFAULT";

interface CategoryFormState {
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly icon: string;
  readonly isActive: boolean;
}

interface FieldFormState {
  readonly key: string;
  readonly keyTouched: boolean;
  readonly label: string;
  readonly type: CategoryFieldType;
  readonly required: boolean;
  readonly sortOrder: string;
  readonly options: readonly string[];
  readonly newOptionInput: string;
  readonly migrationMode: MigrationMode;
  readonly migrationDefaultRaw: string;
}

export interface CategoryEditorFeedback {
  readonly severity: "success" | "error" | "info";
  readonly text: string;
}

export interface CategoryEditorProps {
  readonly open: boolean;
  readonly category: CategorySummaryRecord | null;
  readonly canEditCategory: boolean;
  readonly canManageStoragePolicy: boolean;
  readonly onClose: () => void;
  readonly onFeedback: (feedback: CategoryEditorFeedback) => void;
}

function toFieldKey(rawLabel: string): string {
  const normalized = rawLabel
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "";
  }
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 64) : `field_${normalized}`.slice(0, 64);
}

function createEmptyCategoryForm(category: CategorySummaryRecord | null): CategoryFormState {
  return {
    name: category?.name ?? "",
    description: category?.description ?? "",
    color: category?.color ?? "",
    icon: category?.icon ?? "",
    isActive: category?.isActive ?? true,
  };
}

function createEmptyFieldForm(nextSortOrder: number): FieldFormState {
  return {
    key: "",
    keyTouched: false,
    label: "",
    type: "TEXT",
    required: false,
    sortOrder: String(nextSortOrder),
    options: [],
    newOptionInput: "",
    migrationMode: "NONE",
    migrationDefaultRaw: "",
  };
}

function formFromFieldRecord(field: CategoryFieldRecord): FieldFormState {
  return {
    key: field.key,
    keyTouched: true,
    label: field.label,
    type: field.type,
    required: field.required,
    sortOrder: String(field.sortOrder),
    options: field.options ? [...field.options] : [],
    newOptionInput: "",
    migrationMode: "NONE",
    migrationDefaultRaw: "",
  };
}

function isSelectType(type: CategoryFieldType): boolean {
  return type === "SINGLE_SELECT" || type === "MULTI_SELECT";
}

function buildMigrationStrategy(
  mode: MigrationMode,
  rawDefault: string,
  fieldType: CategoryFieldType,
  t: ReturnType<typeof useI18n>["t"],
): { readonly strategy?: FieldMigrationStrategy; readonly error?: string } {
  if (mode === "NONE") {
    return { strategy: { type: "NONE" } };
  }

  const trimmed = rawDefault.trim();
  if (!trimmed) {
    return { error: t("admin.categories.editor.validation.migrationDefaultRequired") };
  }

  if (fieldType === "NUMBER") {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return { error: t("admin.categories.editor.validation.migrationNumberInvalid") };
    }
    return { strategy: { type: mode, defaultValue: parsed } };
  }

  if (fieldType === "BOOLEAN") {
    const normalized = trimmed.toLowerCase();
    if (normalized === "true" || normalized === "sim" || normalized === "yes") {
      return { strategy: { type: mode, defaultValue: true } };
    }
    if (
      normalized === "false" ||
      normalized === "nao" ||
      normalized === "não" ||
      normalized === "no"
    ) {
      return { strategy: { type: mode, defaultValue: false } };
    }
    return { error: t("admin.categories.editor.validation.migrationBooleanInvalid") };
  }

  if (fieldType === "MULTI_SELECT") {
    const values = trimmed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (values.length === 0) {
      return { error: t("admin.categories.editor.validation.migrationMultiInvalid") };
    }
    return { strategy: { type: mode, defaultValue: values } };
  }

  return { strategy: { type: mode, defaultValue: trimmed } };
}

/**
 * Unified editor dialog for category metadata, custom field definitions/options,
 * compatibility migration strategy, and per-category storage destination policy.
 */
export function CategoryEditor({
  open,
  category,
  canEditCategory,
  canManageStoragePolicy,
  onClose,
  onFeedback,
}: CategoryEditorProps) {
  const titleId = useId();
  const { t } = useI18n();
  const [activeCategory, setActiveCategory] = useState<CategorySummaryRecord | null>(category);
  const [catForm, setCatForm] = useState<CategoryFormState>(() =>
    createEmptyCategoryForm(category),
  );
  const [catError, setCatError] = useState<string | null>(null);

  const [editingField, setEditingField] = useState<CategoryFieldRecord | null>(null);
  const [fieldForm, setFieldForm] = useState<FieldFormState>(() => createEmptyFieldForm(0));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pendingDeleteField, setPendingDeleteField] = useState<CategoryFieldRecord | null>(null);
  const [removeExistingMetadata, setRemoveExistingMetadata] = useState(true);

  const [selectedStorageConnectionId, setSelectedStorageConnectionId] = useState("");
  const [storageError, setStorageError] = useState<string | null>(null);

  const createCategoryMutation = useCreateCategoryMutation();
  const updateCategoryMutation = useUpdateCategoryMutation();
  const addFieldMutation = useAddCategoryFieldMutation();
  const updateFieldMutation = useUpdateCategoryFieldMutation();
  const deleteFieldMutation = useDeleteCategoryFieldMutation();

  const fieldsQuery = useCategoryFieldsQuery(activeCategory?.id ?? null, open);
  const storageConnectionsQuery = useStorageConnectionsQuery(open && canManageStoragePolicy);
  const routingRulesQuery = useStorageRoutingRulesQuery(open && canManageStoragePolicy);
  const upsertRoutingRuleMutation = useUpsertStorageRoutingRuleMutation();
  const clearRoutingRuleMutation = useClearCategoryRoutingRuleMutation();

  useEffect(() => {
    if (!open) {
      return;
    }
    setActiveCategory(category);
    setCatForm(createEmptyCategoryForm(category));
    setCatError(null);
    setEditingField(null);
    setFieldForm(createEmptyFieldForm(0));
    setFieldError(null);
    setPendingDeleteField(null);
    setStorageError(null);
  }, [open, category]);

  const currentFields = fieldsQuery.data ?? [];
  const activeStorageConnections = useMemo(
    () => (storageConnectionsQuery.data ?? []).filter((conn) => conn.status === "ACTIVE"),
    [storageConnectionsQuery.data],
  );

  const currentCategoryRoutingRule = useMemo(() => {
    if (!activeCategory) {
      return null;
    }
    return (
      (routingRulesQuery.data ?? []).find((rule) => rule.categoryId === activeCategory.id) ?? null
    );
  }, [routingRulesQuery.data, activeCategory]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedStorageConnectionId(currentCategoryRoutingRule?.storageConnectionId ?? "");
  }, [open, currentCategoryRoutingRule]);

  const nextSortOrder = currentFields.length;

  async function handleSaveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCatError(null);

    const normalizedDescription = catForm.description.trim();
    const normalizedColor = catForm.color.trim();
    const normalizedIcon = catForm.icon.trim();

    if (!activeCategory) {
      const parsed = createCategoryInputSchema.safeParse({
        name: catForm.name.trim(),
        description: normalizedDescription.length > 0 ? normalizedDescription : null,
        color: normalizedColor.length > 0 ? normalizedColor : null,
        icon: normalizedIcon.length > 0 ? normalizedIcon : null,
      });
      if (!parsed.success) {
        setCatError(t("admin.categories.editor.reviewCategoryData"));
        return;
      }

      try {
        const created = await createCategoryMutation.mutateAsync(parsed.data);
        setActiveCategory(created);
        setCatForm(createEmptyCategoryForm(created));
        onFeedback({
          severity: "success",
          text: t("admin.categories.editor.categoryCreated", { name: created.name }),
        });
      } catch (error) {
        setCatError(
          error instanceof Error ? error.message : t("admin.categories.errors.createFailed"),
        );
      }
      return;
    }

    const parsed = updateCategoryInputSchema.safeParse({
      name: catForm.name.trim(),
      description: normalizedDescription.length > 0 ? normalizedDescription : null,
      color: normalizedColor.length > 0 ? normalizedColor : null,
      icon: normalizedIcon.length > 0 ? normalizedIcon : null,
      isActive: catForm.isActive,
    });
    if (!parsed.success) {
      setCatError(t("admin.categories.editor.reviewCategoryData"));
      return;
    }

    try {
      const updated = await updateCategoryMutation.mutateAsync({
        categoryId: activeCategory.id,
        payload: parsed.data,
      });
      setActiveCategory(updated);
      setCatForm(createEmptyCategoryForm(updated));
      onFeedback({
        severity: "success",
        text: t("admin.categories.editor.categoryUpdated", { name: updated.name }),
      });
    } catch (error) {
      setCatError(
        error instanceof Error ? error.message : t("admin.categories.errors.updateFailed"),
      );
    }
  }

  function handleAddOption() {
    setFieldError(null);
    const trimmed = fieldForm.newOptionInput.trim();
    if (!trimmed) {
      return;
    }
    if (fieldForm.options.includes(trimmed)) {
      setFieldError(t("admin.categories.editor.optionAlreadyAdded"));
      return;
    }
    setFieldForm((prev) => ({
      ...prev,
      options: [...prev.options, trimmed],
      newOptionInput: "",
    }));
  }

  function handleRemoveOption(optionToRemove: string) {
    setFieldForm((prev) => ({
      ...prev,
      options: prev.options.filter((opt) => opt !== optionToRemove),
    }));
  }

  async function handleSaveField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCategory) {
      return;
    }
    setFieldError(null);

    const parsedSortOrder = Number(fieldForm.sortOrder);
    if (!Number.isInteger(parsedSortOrder) || parsedSortOrder < 0) {
      setFieldError(t("admin.categories.editor.validation.invalidOrder"));
      return;
    }

    const migrationBuilt = buildMigrationStrategy(
      fieldForm.migrationMode,
      fieldForm.migrationDefaultRaw,
      fieldForm.type,
      t,
    );
    if (migrationBuilt.error) {
      setFieldError(migrationBuilt.error);
      return;
    }

    const optionsForPayload = isSelectType(fieldForm.type) ? [...fieldForm.options] : undefined;

    if (!editingField) {
      const parsed = createCategoryFieldInputSchema.safeParse({
        key: fieldForm.key.trim(),
        label: fieldForm.label.trim(),
        type: fieldForm.type,
        required: fieldForm.required,
        options: optionsForPayload,
        sortOrder: parsedSortOrder,
        ...(migrationBuilt.strategy && migrationBuilt.strategy.type !== "NONE"
          ? { migrationStrategy: migrationBuilt.strategy }
          : {}),
      });
      if (!parsed.success) {
        setFieldError(t("admin.categories.editor.validation.reviewFieldData"));
        return;
      }

      try {
        const added = await addFieldMutation.mutateAsync({
          categoryId: activeCategory.id,
          payload: parsed.data,
        });
        setFieldForm(createEmptyFieldForm(nextSortOrder + 1));
        onFeedback({
          severity: "success",
          text: t("admin.categories.editor.feedback.fieldAdded", {
            label: added.label,
            categoryName: activeCategory.name,
          }),
        });
      } catch (error) {
        setFieldError(
          error instanceof Error
            ? error.message
            : t("admin.categories.editor.errors.addFieldFailed"),
        );
      }
      return;
    }

    const parsed = updateCategoryFieldInputSchema.safeParse({
      label: fieldForm.label.trim(),
      type: fieldForm.type,
      required: fieldForm.required,
      options: isSelectType(fieldForm.type) ? [...fieldForm.options] : null,
      sortOrder: parsedSortOrder,
      ...(migrationBuilt.strategy && migrationBuilt.strategy.type !== "NONE"
        ? { migrationStrategy: migrationBuilt.strategy }
        : {}),
    });
    if (!parsed.success) {
      setFieldError(t("admin.categories.editor.validation.reviewFieldData"));
      return;
    }

    try {
      const updated = await updateFieldMutation.mutateAsync({
        categoryId: activeCategory.id,
        fieldId: editingField.id,
        payload: parsed.data,
      });
      setEditingField(null);
      setFieldForm(createEmptyFieldForm(nextSortOrder));
      onFeedback({
        severity: "success",
        text: t("admin.categories.editor.feedback.fieldUpdated", { label: updated.label }),
      });
    } catch (error) {
      setFieldError(
        error instanceof Error
          ? error.message
          : t("admin.categories.editor.errors.updateFieldFailed"),
      );
    }
  }

  async function handleConfirmDeleteField() {
    if (!activeCategory || !pendingDeleteField) {
      return;
    }
    setFieldError(null);
    try {
      await deleteFieldMutation.mutateAsync({
        categoryId: activeCategory.id,
        fieldId: pendingDeleteField.id,
        payload: {
          migrationStrategy: removeExistingMetadata
            ? { type: "REMOVE_FROM_DOCUMENTS" }
            : { type: "NONE" },
        },
      });
      if (editingField?.id === pendingDeleteField.id) {
        setEditingField(null);
        setFieldForm(createEmptyFieldForm(Math.max(0, nextSortOrder - 1)));
      }
      const removedLabel = pendingDeleteField.label;
      setPendingDeleteField(null);
      onFeedback({
        severity: "success",
        text: t("admin.categories.editor.feedback.fieldRemoved", {
          label: removedLabel,
          categoryName: activeCategory.name,
        }),
      });
    } catch (error) {
      setPendingDeleteField(null);
      setFieldError(
        error instanceof Error
          ? error.message
          : t("admin.categories.editor.errors.removeFieldFailed"),
      );
    }
  }

  async function handleSaveStoragePolicy() {
    if (!activeCategory || !canManageStoragePolicy) {
      return;
    }
    setStorageError(null);
    try {
      if (!selectedStorageConnectionId) {
        if (currentCategoryRoutingRule) {
          await clearRoutingRuleMutation.mutateAsync(activeCategory.id);
          onFeedback({
            severity: "success",
            text: t("admin.categories.editor.feedback.storageReset", {
              name: activeCategory.name,
            }),
          });
        }
        return;
      }

      await upsertRoutingRuleMutation.mutateAsync({
        categoryId: activeCategory.id,
        storageConnectionId: selectedStorageConnectionId,
      });
      const targetConnection = activeStorageConnections.find(
        (conn) => conn.id === selectedStorageConnectionId,
      );
      onFeedback({
        severity: "success",
        text: t("admin.categories.editor.feedback.storageUpdated", {
          name: activeCategory.name,
          target: targetConnection?.name ?? selectedStorageConnectionId,
        }),
      });
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : t("admin.categories.editor.errors.storageFailed"),
      );
    }
  }

  const isSavingCategory = createCategoryMutation.isPending || updateCategoryMutation.isPending;
  const isSavingField = addFieldMutation.isPending || updateFieldMutation.isPending;
  const isSavingStorage = upsertRoutingRuleMutation.isPending || clearRoutingRuleMutation.isPending;

  return (
    <Dialog
      open={open}
      onClose={isSavingCategory || isSavingField || isSavingStorage ? undefined : onClose}
      aria-labelledby={titleId}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle id={titleId}>
        {activeCategory
          ? t("admin.categories.editor.editTitle", { name: activeCategory.name })
          : t("admin.categories.editor.newTitle")}
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={3} sx={{ pt: 0.5 }}>
          <Box component="form" onSubmit={handleSaveCategory} noValidate>
            <Stack spacing={2}>
              <Typography variant="subtitle1" fontWeight={600}>
                {t("admin.categories.editor.basicInfo")}
              </Typography>
              {catError ? <Alert severity="error">{catError}</Alert> : null}

              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    label={t("admin.categories.editor.name")}
                    required
                    fullWidth
                    value={catForm.name}
                    onChange={(event) =>
                      setCatForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                    disabled={!canEditCategory || isSavingCategory}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 3 }}>
                  <TextField
                    label={t("admin.categories.editor.color")}
                    fullWidth
                    placeholder="#0F5C73"
                    value={catForm.color}
                    onChange={(event) =>
                      setCatForm((prev) => ({ ...prev, color: event.target.value }))
                    }
                    disabled={!canEditCategory || isSavingCategory}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 3 }}>
                  <TextField
                    label={t("admin.categories.editor.icon")}
                    fullWidth
                    placeholder="description"
                    value={catForm.icon}
                    onChange={(event) =>
                      setCatForm((prev) => ({ ...prev, icon: event.target.value }))
                    }
                    disabled={!canEditCategory || isSavingCategory}
                  />
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    label={t("admin.categories.editor.description")}
                    multiline
                    minRows={2}
                    fullWidth
                    value={catForm.description}
                    onChange={(event) =>
                      setCatForm((prev) => ({ ...prev, description: event.target.value }))
                    }
                    disabled={!canEditCategory || isSavingCategory}
                  />
                </Grid>
              </Grid>

              {activeCategory ? (
                <FormControlLabel
                  control={
                    <Switch
                      checked={catForm.isActive}
                      onChange={(event) =>
                        setCatForm((prev) => ({ ...prev, isActive: event.target.checked }))
                      }
                      disabled={!canEditCategory || isSavingCategory}
                    />
                  }
                  label={t("admin.categories.editor.activeSwitch")}
                />
              ) : null}

              {canEditCategory ? (
                <Box>
                  <Button
                    type="submit"
                    variant="contained"
                    startIcon={<SaveOutlinedIcon />}
                    disabled={isSavingCategory}
                  >
                    {isSavingCategory
                      ? t("admin.common.saving")
                      : activeCategory
                        ? t("admin.categories.editor.saveCategory")
                        : t("admin.categories.editor.createCategory")}
                  </Button>
                </Box>
              ) : null}
            </Stack>
          </Box>

          {activeCategory ? (
            <>
              <Divider />

              <Stack spacing={2}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <TuneOutlinedIcon color="primary" fontSize="small" />
                  <Typography variant="subtitle1" fontWeight={600}>
                    {t("admin.categories.editor.customFieldsTitle")}
                  </Typography>
                </Stack>

                {fieldError ? <Alert severity="error">{fieldError}</Alert> : null}

                {fieldsQuery.isLoading ? (
                  <LoadingState
                    message={t("admin.categories.editor.loadingFields")}
                    minHeight={100}
                  />
                ) : fieldsQuery.isError ? (
                  <ErrorState
                    title={t("admin.categories.editor.loadFieldsErrorTitle")}
                    description={fieldsQuery.error.message}
                    onRetry={() => void fieldsQuery.refetch()}
                  />
                ) : currentFields.length === 0 ? (
                  <EmptyState
                    title={t("admin.categories.editor.emptyFieldsTitle")}
                    description={t("admin.categories.editor.emptyFieldsDescription")}
                  />
                ) : (
                  <TableContainer component={Paper} variant="outlined">
                    <Table size="small" aria-label={t("admin.categories.editor.fieldsTableAria")}>
                      <TableHead>
                        <TableRow>
                          <TableCell>{t("admin.categories.editor.colLabel")}</TableCell>
                          <TableCell>{t("admin.categories.editor.colFieldId")}</TableCell>
                          <TableCell>{t("admin.categories.editor.colType")}</TableCell>
                          <TableCell>{t("admin.categories.editor.colRequired")}</TableCell>
                          <TableCell>{t("admin.categories.editor.colOptionsOrder")}</TableCell>
                          <TableCell align="right">{t("admin.common.actions")}</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {currentFields.map((field) => (
                          <TableRow key={field.id} hover>
                            <TableCell>
                              <Typography variant="body2" fontWeight={600}>
                                {field.label}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              <Typography variant="caption" component="code">
                                {field.key}
                              </Typography>
                            </TableCell>
                            <TableCell>{t(FIELD_TYPE_LABEL_KEYS[field.type])}</TableCell>
                            <TableCell>
                              <Chip
                                label={
                                  field.required
                                    ? t("admin.categories.editor.required")
                                    : t("admin.categories.editor.optional")
                                }
                                size="small"
                                color={field.required ? "primary" : "default"}
                                variant="outlined"
                              />
                            </TableCell>
                            <TableCell>
                              <Stack spacing={0.25}>
                                {field.options && field.options.length > 0 ? (
                                  <Typography variant="caption" color="text.secondary">
                                    {t("admin.categories.editor.optionsSummary", {
                                      options: field.options.join(", "),
                                    })}
                                  </Typography>
                                ) : null}
                                <Typography variant="caption" color="text.secondary">
                                  {t("admin.categories.editor.orderSummary", {
                                    order: field.sortOrder,
                                  })}
                                </Typography>
                              </Stack>
                            </TableCell>
                            <TableCell align="right">
                              {canEditCategory ? (
                                <Stack direction="row" spacing={1} justifyContent="flex-end">
                                  <Button
                                    size="small"
                                    variant="text"
                                    startIcon={<EditOutlinedIcon />}
                                    onClick={() => {
                                      setEditingField(field);
                                      setFieldForm(formFromFieldRecord(field));
                                      setFieldError(null);
                                      setPendingDeleteField(null);
                                    }}
                                  >
                                    {t("admin.common.edit")}
                                  </Button>
                                  <Button
                                    size="small"
                                    variant="text"
                                    color="error"
                                    startIcon={<DeleteOutlineOutlinedIcon />}
                                    onClick={() => {
                                      setPendingDeleteField(field);
                                      setFieldError(null);
                                    }}
                                  >
                                    {t("admin.common.remove")}
                                  </Button>
                                </Stack>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}

                {pendingDeleteField ? (
                  <Alert
                    severity="warning"
                    action={
                      <Stack direction="row" spacing={1}>
                        <Button
                          size="small"
                          color="inherit"
                          disabled={deleteFieldMutation.isPending}
                          onClick={() => setPendingDeleteField(null)}
                        >
                          {t("admin.common.cancel")}
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          variant="contained"
                          disabled={deleteFieldMutation.isPending}
                          onClick={() => void handleConfirmDeleteField()}
                        >
                          {deleteFieldMutation.isPending
                            ? t("admin.common.removing")
                            : t("admin.categories.editor.confirmRemove")}
                        </Button>
                      </Stack>
                    }
                  >
                    <Stack spacing={1}>
                      <Typography variant="body2">
                        {t("admin.categories.editor.deleteFieldPrompt", {
                          label: pendingDeleteField.label,
                          key: pendingDeleteField.key,
                        })}
                      </Typography>
                      <FormControlLabel
                        control={
                          <Switch
                            size="small"
                            checked={removeExistingMetadata}
                            onChange={(event) => setRemoveExistingMetadata(event.target.checked)}
                          />
                        }
                        label={t("admin.categories.editor.removeExistingValues")}
                      />
                    </Stack>
                  </Alert>
                ) : null}

                {canEditCategory ? (
                  <Paper
                    variant="outlined"
                    sx={{
                      p: 2,
                      borderRadius: 2,
                      bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                    }}
                  >
                    <Box component="form" onSubmit={handleSaveField} noValidate>
                      <Stack spacing={2}>
                        <Typography variant="subtitle2" fontWeight={600}>
                          {editingField
                            ? t("admin.categories.editor.editFieldTitle", {
                                label: editingField.label,
                              })
                            : t("admin.categories.editor.addFieldTitle")}
                        </Typography>

                        <Grid container spacing={2}>
                          <Grid size={{ xs: 12, sm: 4 }}>
                            <TextField
                              label={t("admin.categories.editor.fieldLabel")}
                              required
                              fullWidth
                              value={fieldForm.label}
                              onChange={(event) => {
                                const nextLabel = event.target.value;
                                setFieldForm((prev) => ({
                                  ...prev,
                                  label: nextLabel,
                                  key:
                                    !editingField && !prev.keyTouched
                                      ? toFieldKey(nextLabel)
                                      : prev.key,
                                }));
                              }}
                              disabled={isSavingField}
                            />
                          </Grid>
                          <Grid size={{ xs: 12, sm: 4 }}>
                            <TextField
                              label={t("admin.categories.editor.fieldId")}
                              helperText={t("admin.categories.editor.fieldIdHelper")}
                              required
                              fullWidth
                              value={fieldForm.key}
                              onChange={(event) =>
                                setFieldForm((prev) => ({
                                  ...prev,
                                  key: event.target.value,
                                  keyTouched: true,
                                }))
                              }
                              disabled={editingField !== null || isSavingField}
                            />
                          </Grid>
                          <Grid size={{ xs: 12, sm: 4 }}>
                            <TextField
                              select
                              label={t("admin.categories.editor.fieldType")}
                              fullWidth
                              value={fieldForm.type}
                              onChange={(event) =>
                                setFieldForm((prev) => ({
                                  ...prev,
                                  type: event.target.value as CategoryFieldType,
                                }))
                              }
                              disabled={isSavingField}
                            >
                              {FIELD_TYPE_VALUES.map((typeValue) => (
                                <MenuItem key={typeValue} value={typeValue}>
                                  {t(FIELD_TYPE_LABEL_KEYS[typeValue])}
                                </MenuItem>
                              ))}
                            </TextField>
                          </Grid>
                          <Grid size={{ xs: 12, sm: 4 }}>
                            <TextField
                              label={t("admin.categories.editor.displayOrder")}
                              type="number"
                              fullWidth
                              value={fieldForm.sortOrder}
                              onChange={(event) =>
                                setFieldForm((prev) => ({ ...prev, sortOrder: event.target.value }))
                              }
                              disabled={isSavingField}
                            />
                          </Grid>
                          <Grid
                            size={{ xs: 12, sm: 8 }}
                            sx={{ display: "flex", alignItems: "center" }}
                          >
                            <FormControlLabel
                              control={
                                <Switch
                                  checked={fieldForm.required}
                                  onChange={(event) =>
                                    setFieldForm((prev) => ({
                                      ...prev,
                                      required: event.target.checked,
                                    }))
                                  }
                                  disabled={isSavingField}
                                />
                              }
                              label={t("admin.categories.editor.requiredSwitch")}
                            />
                          </Grid>
                        </Grid>

                        {isSelectType(fieldForm.type) ? (
                          <Stack spacing={1.5}>
                            <Typography variant="caption" fontWeight={600} color="text.secondary">
                              {t("admin.categories.editor.selectionOptions")}
                            </Typography>
                            <Stack direction="row" spacing={1}>
                              <TextField
                                label={t("admin.categories.editor.newOption")}
                                size="small"
                                fullWidth
                                value={fieldForm.newOptionInput}
                                onChange={(event) =>
                                  setFieldForm((prev) => ({
                                    ...prev,
                                    newOptionInput: event.target.value,
                                  }))
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    handleAddOption();
                                  }
                                }}
                                disabled={isSavingField}
                              />
                              <Button
                                type="button"
                                variant="outlined"
                                onClick={handleAddOption}
                                disabled={isSavingField || !fieldForm.newOptionInput.trim()}
                              >
                                {t("admin.categories.editor.addOption")}
                              </Button>
                            </Stack>
                            {fieldForm.options.length > 0 ? (
                              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                                {fieldForm.options.map((opt) => (
                                  <Chip
                                    key={opt}
                                    label={opt}
                                    onDelete={() => handleRemoveOption(opt)}
                                  />
                                ))}
                              </Stack>
                            ) : (
                              <Typography variant="caption" color="text.secondary">
                                {t("admin.categories.editor.addAtLeastOneOption")}
                              </Typography>
                            )}
                          </Stack>
                        ) : null}

                        <Grid container spacing={2}>
                          <Grid size={{ xs: 12, sm: 6 }}>
                            <TextField
                              select
                              label={t("admin.categories.editor.migrationLabel")}
                              fullWidth
                              size="small"
                              value={fieldForm.migrationMode}
                              onChange={(event) =>
                                setFieldForm((prev) => ({
                                  ...prev,
                                  migrationMode: event.target.value as MigrationMode,
                                }))
                              }
                              disabled={isSavingField}
                            >
                              <MenuItem value="NONE">
                                {t("admin.categories.editor.migrationNone")}
                              </MenuItem>
                              <MenuItem value="BACKFILL_DEFAULT">
                                {t("admin.categories.editor.migrationBackfill")}
                              </MenuItem>
                              <MenuItem value="RESET_TO_DEFAULT">
                                {t("admin.categories.editor.migrationReset")}
                              </MenuItem>
                            </TextField>
                          </Grid>
                          {fieldForm.migrationMode !== "NONE" ? (
                            <Grid size={{ xs: 12, sm: 6 }}>
                              <TextField
                                label={t("admin.categories.editor.migrationDefaultValue")}
                                fullWidth
                                size="small"
                                placeholder={t(
                                  "admin.categories.editor.migrationDefaultPlaceholder",
                                )}
                                value={fieldForm.migrationDefaultRaw}
                                onChange={(event) =>
                                  setFieldForm((prev) => ({
                                    ...prev,
                                    migrationDefaultRaw: event.target.value,
                                  }))
                                }
                                disabled={isSavingField}
                              />
                            </Grid>
                          ) : null}
                        </Grid>

                        <Stack direction="row" spacing={1}>
                          <Button
                            type="submit"
                            variant="contained"
                            size="small"
                            startIcon={editingField ? <SaveOutlinedIcon /> : <AddOutlinedIcon />}
                            disabled={isSavingField}
                          >
                            {isSavingField
                              ? t("admin.categories.editor.savingField")
                              : editingField
                                ? t("admin.categories.editor.saveFieldChanges")
                                : t("admin.categories.editor.addField")}
                          </Button>
                          {editingField ? (
                            <Button
                              type="button"
                              variant="text"
                              size="small"
                              disabled={isSavingField}
                              onClick={() => {
                                setEditingField(null);
                                setFieldForm(createEmptyFieldForm(nextSortOrder));
                                setFieldError(null);
                              }}
                            >
                              {t("admin.categories.editor.cancelFieldEdit")}
                            </Button>
                          ) : null}
                        </Stack>
                      </Stack>
                    </Box>
                  </Paper>
                ) : null}
              </Stack>

              <Divider />

              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <RouteOutlinedIcon color="primary" fontSize="small" />
                  <Typography variant="subtitle1" fontWeight={600}>
                    {t("admin.categories.editor.storageSectionTitle")}
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {t("admin.categories.editor.storageSectionDescription")}
                </Typography>

                {storageError ? <Alert severity="error">{storageError}</Alert> : null}

                {!canManageStoragePolicy ? (
                  <Alert severity="info">
                    {t("admin.categories.editor.storagePermissionRequired")}
                  </Alert>
                ) : storageConnectionsQuery.isLoading || routingRulesQuery.isLoading ? (
                  <LoadingState
                    message={t("admin.categories.editor.loadingStorage")}
                    minHeight={80}
                  />
                ) : (
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems="center">
                    <TextField
                      select
                      fullWidth
                      size="small"
                      label={t("admin.categories.editor.storageDestinationLabel")}
                      value={selectedStorageConnectionId}
                      onChange={(event) => setSelectedStorageConnectionId(event.target.value)}
                      disabled={isSavingStorage}
                    >
                      <MenuItem value="">
                        {t("admin.categories.editor.useOrganizationDefault")}
                      </MenuItem>
                      {activeStorageConnections.map((conn) => (
                        <MenuItem key={conn.id} value={conn.id}>
                          {conn.isDefault
                            ? t("admin.categories.editor.optionDefaultSuffix", { name: conn.name })
                            : `${conn.name} (${conn.kind.toUpperCase()})`}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Button
                      type="button"
                      variant="outlined"
                      onClick={() => void handleSaveStoragePolicy()}
                      disabled={isSavingStorage}
                      sx={{ whiteSpace: "nowrap" }}
                    >
                      {isSavingStorage
                        ? t("admin.categories.editor.applyingStorage")
                        : t("admin.categories.editor.applyStorage")}
                    </Button>
                  </Stack>
                )}
              </Stack>
            </>
          ) : null}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} variant="text">
          {t("admin.common.close")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
