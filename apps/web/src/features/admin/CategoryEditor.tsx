import type {
  CategoryFieldRecord,
  CategoryFieldType,
  CategorySummaryRecord,
  FieldMigrationStrategy,
} from "@docuflow/contracts";
import {
  createCategoryFieldInputSchema,
  createCategoryInputSchema,
  updateCategoryFieldInputSchema,
  updateCategoryInputSchema,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState, LoadingState } from "@docuflow/ui";
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
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
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

const FIELD_TYPE_LABELS: Readonly<Record<CategoryFieldType, string>> = {
  TEXT: "Texto",
  NUMBER: "Número",
  DATE: "Data",
  BOOLEAN: "Sim / Não",
  SINGLE_SELECT: "Seleção única",
  MULTI_SELECT: "Seleção múltipla",
};

const FIELD_TYPE_OPTIONS: ReadonlyArray<{
  readonly value: CategoryFieldType;
  readonly label: string;
}> = [
  { value: "TEXT", label: "Texto" },
  { value: "NUMBER", label: "Número" },
  { value: "DATE", label: "Data" },
  { value: "BOOLEAN", label: "Sim / Não" },
  { value: "SINGLE_SELECT", label: "Seleção única" },
  { value: "MULTI_SELECT", label: "Seleção múltipla" },
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

function toSnakeCaseKey(rawLabel: string): string {
  const normalized = rawLabel
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "";
  }
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 64) : `campo_${normalized}`.slice(0, 64);
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
): { readonly strategy?: FieldMigrationStrategy; readonly error?: string } {
  if (mode === "NONE") {
    return { strategy: { type: "NONE" } };
  }

  const trimmed = rawDefault.trim();
  if (!trimmed) {
    return { error: "Informe o valor padrão da estratégia de migração." };
  }

  if (fieldType === "NUMBER") {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return { error: "Informe um valor numérico válido para a estratégia de migração." };
    }
    return { strategy: { type: mode, defaultValue: parsed } };
  }

  if (fieldType === "BOOLEAN") {
    if (trimmed === "true" || trimmed === "sim") {
      return { strategy: { type: mode, defaultValue: true } };
    }
    if (trimmed === "false" || trimmed === "nao" || trimmed === "não") {
      return { strategy: { type: mode, defaultValue: false } };
    }
    return { error: "Informe 'true' ou 'false' para valor padrão booleano." };
  }

  if (fieldType === "MULTI_SELECT") {
    const values = trimmed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (values.length === 0) {
      return { error: "Informe ao menos uma opção padrão separada por vírgula." };
    }
    return { strategy: { type: mode, defaultValue: values } };
  }

  return { strategy: { type: mode, defaultValue: trimmed } };
}

/**
 * Unified editor dialog for category metadata, custom field definitions/options,
 * compatibility migration strategy, and per-category storage routing policy.
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
        setCatError(parsed.error.issues[0]?.message ?? "Revise os dados da categoria.");
        return;
      }

      try {
        const created = await createCategoryMutation.mutateAsync(parsed.data);
        setActiveCategory(created);
        setCatForm(createEmptyCategoryForm(created));
        onFeedback({
          severity: "success",
          text: `Categoria "${created.name}" criada com sucesso. Agora você pode adicionar campos personalizados e definir a política de storage.`,
        });
      } catch (error) {
        setCatError(error instanceof Error ? error.message : "Não foi possível criar a categoria.");
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
      setCatError(parsed.error.issues[0]?.message ?? "Revise os dados da categoria.");
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
        text: `Categoria "${updated.name}" atualizada com sucesso.`,
      });
    } catch (error) {
      setCatError(
        error instanceof Error ? error.message : "Não foi possível atualizar a categoria.",
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
      setFieldError("Esta opção já foi adicionada.");
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
      setFieldError("Informe uma ordem numérica inteira maior ou igual a zero.");
      return;
    }

    const migrationBuilt = buildMigrationStrategy(
      fieldForm.migrationMode,
      fieldForm.migrationDefaultRaw,
      fieldForm.type,
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
        setFieldError(parsed.error.issues[0]?.message ?? "Revise os dados do campo.");
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
          text: `Campo "${added.label}" adicionado à categoria "${activeCategory.name}".`,
        });
      } catch (error) {
        setFieldError(
          error instanceof Error ? error.message : "Não foi possível adicionar o campo.",
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
      setFieldError(parsed.error.issues[0]?.message ?? "Revise os dados do campo.");
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
        text: `Campo "${updated.label}" atualizado com sucesso.`,
      });
    } catch (error) {
      setFieldError(error instanceof Error ? error.message : "Não foi possível atualizar o campo.");
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
        text: `Campo "${removedLabel}" removido da categoria "${activeCategory.name}".`,
      });
    } catch (error) {
      setPendingDeleteField(null);
      setFieldError(error instanceof Error ? error.message : "Não foi possível remover o campo.");
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
            text: `Política de storage da categoria "${activeCategory.name}" redefinida para o padrão da organização.`,
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
        text: `Política de storage da categoria "${activeCategory.name}" definida para "${targetConnection?.name ?? selectedStorageConnectionId}".`,
      });
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : "Não foi possível atualizar a política de storage.",
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
        {activeCategory ? `Editar categoria: ${activeCategory.name}` : "Nova categoria"}
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={3} sx={{ pt: 0.5 }}>
          <Box component="form" onSubmit={handleSaveCategory} noValidate>
            <Stack spacing={2}>
              <Typography variant="subtitle1" fontWeight={600}>
                Dados básicos da categoria
              </Typography>
              {catError ? <Alert severity="error">{catError}</Alert> : null}

              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    label="Nome da categoria"
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
                    label="Cor hexadecimal (opcional)"
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
                    label="Ícone (opcional)"
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
                    label="Descrição da categoria (opcional)"
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
                  label="Categoria ativa para novos documentos"
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
                      ? "Salvando..."
                      : activeCategory
                        ? "Salvar categoria"
                        : "Criar categoria"}
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
                    Campos personalizados de metadados
                  </Typography>
                </Stack>

                {fieldError ? <Alert severity="error">{fieldError}</Alert> : null}

                {fieldsQuery.isLoading ? (
                  <LoadingState message="Carregando campos personalizados..." minHeight={100} />
                ) : fieldsQuery.isError ? (
                  <ErrorState
                    title="Erro ao carregar campos"
                    description={fieldsQuery.error.message}
                    onRetry={() => void fieldsQuery.refetch()}
                  />
                ) : currentFields.length === 0 ? (
                  <EmptyState
                    title="Nenhum campo personalizado cadastrado"
                    description="Adicione campos para estruturar os metadados específicos desta categoria."
                  />
                ) : (
                  <TableContainer component={Paper} variant="outlined">
                    <Table size="small" aria-label="Campos personalizados da categoria">
                      <TableHead>
                        <TableRow>
                          <TableCell>Rótulo</TableCell>
                          <TableCell>Chave</TableCell>
                          <TableCell>Tipo</TableCell>
                          <TableCell>Obrigatoriedade</TableCell>
                          <TableCell>Opções / Ordem</TableCell>
                          <TableCell align="right">Ações</TableCell>
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
                            <TableCell>{FIELD_TYPE_LABELS[field.type]}</TableCell>
                            <TableCell>
                              <Chip
                                label={field.required ? "Obrigatório" : "Opcional"}
                                size="small"
                                color={field.required ? "primary" : "default"}
                                variant="outlined"
                              />
                            </TableCell>
                            <TableCell>
                              <Stack spacing={0.25}>
                                {field.options && field.options.length > 0 ? (
                                  <Typography variant="caption" color="text.secondary">
                                    Opções: {field.options.join(", ")}
                                  </Typography>
                                ) : null}
                                <Typography variant="caption" color="text.secondary">
                                  Ordem: {field.sortOrder}
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
                                    Editar
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
                                    Remover
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
                          Cancelar
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          variant="contained"
                          disabled={deleteFieldMutation.isPending}
                          onClick={() => void handleConfirmDeleteField()}
                        >
                          {deleteFieldMutation.isPending ? "Removendo..." : "Confirmar remoção"}
                        </Button>
                      </Stack>
                    }
                  >
                    <Stack spacing={1}>
                      <Typography variant="body2">
                        Remover o campo "{pendingDeleteField.label}" ({pendingDeleteField.key})?
                      </Typography>
                      <FormControlLabel
                        control={
                          <Switch
                            size="small"
                            checked={removeExistingMetadata}
                            onChange={(event) => setRemoveExistingMetadata(event.target.checked)}
                          />
                        }
                        label="Remover também os valores existentes em documentos desta categoria (REMOVE_FROM_DOCUMENTS)"
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
                      bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow,
                    }}
                  >
                    <Box component="form" onSubmit={handleSaveField} noValidate>
                      <Stack spacing={2}>
                        <Typography variant="subtitle2" fontWeight={600}>
                          {editingField
                            ? `Editar campo: ${editingField.label}`
                            : "Adicionar campo personalizado"}
                        </Typography>

                        <Grid container spacing={2}>
                          <Grid size={{ xs: 12, sm: 4 }}>
                            <TextField
                              label="Rótulo do campo"
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
                                      ? toSnakeCaseKey(nextLabel)
                                      : prev.key,
                                }));
                              }}
                              disabled={isSavingField}
                            />
                          </Grid>
                          <Grid size={{ xs: 12, sm: 4 }}>
                            <TextField
                              label="Chave técnica (snake_case)"
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
                              label="Tipo do campo"
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
                              {FIELD_TYPE_OPTIONS.map((option) => (
                                <MenuItem key={option.value} value={option.value}>
                                  {option.label}
                                </MenuItem>
                              ))}
                            </TextField>
                          </Grid>
                          <Grid size={{ xs: 12, sm: 4 }}>
                            <TextField
                              label="Ordem de exibição"
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
                              label="Preenchimento obrigatório nos documentos desta categoria"
                            />
                          </Grid>
                        </Grid>

                        {isSelectType(fieldForm.type) ? (
                          <Stack spacing={1.5}>
                            <Typography variant="caption" fontWeight={600} color="text.secondary">
                              Opções de seleção
                            </Typography>
                            <Stack direction="row" spacing={1}>
                              <TextField
                                label="Nova opção de seleção"
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
                                Adicionar opção
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
                                Adicione ao menos uma opção para este campo.
                              </Typography>
                            )}
                          </Stack>
                        ) : null}

                        <Grid container spacing={2}>
                          <Grid size={{ xs: 12, sm: 6 }}>
                            <TextField
                              select
                              label="Migração para documentos existentes"
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
                                Não alterar documentos existentes (NONE)
                              </MenuItem>
                              <MenuItem value="BACKFILL_DEFAULT">
                                Preencher documentos vazios com valor padrão (BACKFILL_DEFAULT)
                              </MenuItem>
                              <MenuItem value="RESET_TO_DEFAULT">
                                Redefinir todos os documentos para o valor padrão (RESET_TO_DEFAULT)
                              </MenuItem>
                            </TextField>
                          </Grid>
                          {fieldForm.migrationMode !== "NONE" ? (
                            <Grid size={{ xs: 12, sm: 6 }}>
                              <TextField
                                label="Valor padrão de migração"
                                fullWidth
                                size="small"
                                placeholder="Ex.: N/A, 0, 2026-01-01 ou opção"
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
                              ? "Salvando campo..."
                              : editingField
                                ? "Salvar alterações do campo"
                                : "Adicionar campo"}
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
                              Cancelar edição de campo
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
                    Política de storage da categoria
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Defina qual conexão de armazenamento receberá novos uploads desta categoria.
                  Arquivos existentes permanecem na conexão em que foram gravados originalmente.
                </Typography>

                {storageError ? <Alert severity="error">{storageError}</Alert> : null}

                {!canManageStoragePolicy ? (
                  <Alert severity="info">
                    A edição da política de storage por categoria exige permissão de gerenciamento
                    de armazenamento.
                  </Alert>
                ) : storageConnectionsQuery.isLoading || routingRulesQuery.isLoading ? (
                  <LoadingState
                    message="Carregando conexões e regras de storage..."
                    minHeight={80}
                  />
                ) : (
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems="center">
                    <TextField
                      select
                      fullWidth
                      size="small"
                      label="Política de destino de storage"
                      value={selectedStorageConnectionId}
                      onChange={(event) => setSelectedStorageConnectionId(event.target.value)}
                      disabled={isSavingStorage}
                    >
                      <MenuItem value="">Usar destino padrão da organização</MenuItem>
                      {activeStorageConnections.map((conn) => (
                        <MenuItem key={conn.id} value={conn.id}>
                          {conn.isDefault
                            ? `${conn.name} (Padrão da organização)`
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
                      {isSavingStorage ? "Aplicando..." : "Aplicar política de storage"}
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
          Fechar
        </Button>
      </DialogActions>
    </Dialog>
  );
}
