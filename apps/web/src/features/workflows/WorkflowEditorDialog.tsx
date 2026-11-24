import type {
  WorkflowAssigneeCatalog,
  WorkflowStepDefinition,
  WorkflowStepInput,
} from "@docuflow/contracts";
import { PAPYRUS_COLOR_TOKENS } from "@docuflow/ui";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import ArrowDownwardOutlinedIcon from "@mui/icons-material/ArrowDownwardOutlined";
import ArrowUpwardOutlinedIcon from "@mui/icons-material/ArrowUpwardOutlined";
import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useI18n } from "../../i18n/index.js";

type AssigneeType = "USER" | "GROUP" | "ROLE";

interface StepDraft {
  readonly key: string;
  readonly name: string;
  readonly assigneeType: AssigneeType;
  readonly assigneeTargetId: string;
  readonly dueDays: string;
  readonly requireOnApprove: boolean;
}

export interface WorkflowEditorDialogProps {
  readonly open: boolean;
  readonly mode: "create" | "newVersion";
  readonly existingName?: string | undefined;
  readonly existingDescription?: string | null | undefined;
  readonly initialSteps?: readonly WorkflowStepDefinition[] | undefined;
  readonly catalog: WorkflowAssigneeCatalog;
  readonly submitting: boolean;
  readonly serverError: string | null;
  readonly onClose: () => void;
  readonly onSubmitCreate: (payload: {
    readonly name: string;
    readonly description: string | null;
    readonly steps: readonly WorkflowStepInput[];
  }) => Promise<void>;
  readonly onSubmitNewVersion: (payload: {
    readonly steps: readonly WorkflowStepInput[];
  }) => Promise<void>;
}

let stepKeySequence = 0;

function createEmptyStep(catalog: WorkflowAssigneeCatalog): StepDraft {
  stepKeySequence += 1;
  const defaultType: AssigneeType =
    catalog.users.length > 0 ? "USER" : catalog.groups.length > 0 ? "GROUP" : "ROLE";
  const defaultTarget =
    defaultType === "USER"
      ? (catalog.users[0]?.id ?? "")
      : defaultType === "GROUP"
        ? (catalog.groups[0]?.id ?? "")
        : (catalog.roles[0]?.id ?? "");

  return {
    key: `step-${stepKeySequence}`,
    name: "",
    assigneeType: defaultType,
    assigneeTargetId: defaultTarget,
    dueDays: "3",
    requireOnApprove: false,
  };
}

function toStepDrafts(
  steps: readonly WorkflowStepDefinition[] | undefined,
  catalog: WorkflowAssigneeCatalog,
): StepDraft[] {
  if (!steps || steps.length === 0) {
    return [createEmptyStep(catalog)];
  }
  return [...steps]
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((step) => {
      stepKeySequence += 1;
      const targetId =
        step.assignee.type === "USER"
          ? step.assignee.userId
          : step.assignee.type === "GROUP"
            ? step.assignee.groupId
            : step.assignee.roleId;
      return {
        key: `step-${stepKeySequence}`,
        name: step.name,
        assigneeType: step.assignee.type,
        assigneeTargetId: targetId,
        dueDays: step.dueDays !== null ? String(step.dueDays) : "",
        requireOnApprove: step.commentRules?.requireOnApprove ?? false,
      };
    });
}

export function WorkflowEditorDialog({
  open,
  mode,
  existingName = "",
  existingDescription = null,
  initialSteps,
  catalog,
  submitting,
  serverError,
  onClose,
  onSubmitCreate,
  onSubmitNewVersion,
}: WorkflowEditorDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const [name, setName] = useState(existingName);
  const [description, setDescription] = useState(existingDescription ?? "");
  const [steps, setSteps] = useState<StepDraft[]>(() => toStepDrafts(initialSteps, catalog));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(existingName);
    setDescription(existingDescription ?? "");
    setSteps(toStepDrafts(initialSteps, catalog));
    setValidationError(null);
  }, [open, existingName, existingDescription, initialSteps, catalog]);

  const updateStep = (index: number, patch: Partial<StepDraft>): void => {
    setSteps((prev) => prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)));
    setValidationError(null);
  };

  const handleAssigneeTypeChange = (index: number, nextType: AssigneeType): void => {
    const fallbackTarget =
      nextType === "USER"
        ? (catalog.users[0]?.id ?? "")
        : nextType === "GROUP"
          ? (catalog.groups[0]?.id ?? "")
          : (catalog.roles[0]?.id ?? "");
    updateStep(index, { assigneeType: nextType, assigneeTargetId: fallbackTarget });
  };

  const handleAddStep = (): void => {
    if (steps.length >= 20) {
      return;
    }
    setSteps((prev) => [...prev, createEmptyStep(catalog)]);
  };

  const handleRemoveStep = (index: number): void => {
    if (steps.length <= 1) {
      return;
    }
    setSteps((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleMoveStep = (index: number, delta: -1 | 1): void => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= steps.length) {
      return;
    }
    setSteps((prev) => {
      const next = [...prev];
      const current = next[index];
      const target = next[targetIndex];
      if (!current || !target) {
        return prev;
      }
      next[index] = target;
      next[targetIndex] = current;
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setValidationError(null);

    if (mode === "create" && name.trim().length === 0) {
      setValidationError(t("workflows.editor.validation.nameRequired"));
      return;
    }

    const builtSteps: WorkflowStepInput[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (!step) {
        continue;
      }
      const stepNumber = i + 1;
      const trimmedName = step.name.trim();
      if (trimmedName.length === 0) {
        setValidationError(t("workflows.editor.validation.stepNameRequired", { step: stepNumber }));
        return;
      }
      if (step.assigneeTargetId.trim().length === 0) {
        setValidationError(t("workflows.editor.validation.assigneeRequired", { step: stepNumber }));
        return;
      }

      let parsedDueDays: number | null = null;
      const trimmedDue = step.dueDays.trim();
      if (trimmedDue.length > 0) {
        const numericDue = Number.parseInt(trimmedDue, 10);
        if (!Number.isInteger(numericDue) || numericDue < 1 || numericDue > 365) {
          setValidationError(t("workflows.editor.validation.dueDaysRange", { step: stepNumber }));
          return;
        }
        parsedDueDays = numericDue;
      }

      const assignee =
        step.assigneeType === "USER"
          ? ({ type: "USER", userId: step.assigneeTargetId } as const)
          : step.assigneeType === "GROUP"
            ? ({ type: "GROUP", groupId: step.assigneeTargetId } as const)
            : ({ type: "ROLE", roleId: step.assigneeTargetId } as const);

      builtSteps.push({
        stepOrder: stepNumber,
        name: trimmedName,
        assignee,
        dueDays: parsedDueDays,
        commentRules: {
          requireOnApprove: step.requireOnApprove,
        },
      });
    }

    if (builtSteps.length === 0) {
      setValidationError(t("workflows.editor.validation.atLeastOneStep"));
      return;
    }

    if (mode === "create") {
      await onSubmitCreate({
        name: name.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
        steps: builtSteps,
      });
    } else {
      await onSubmitNewVersion({ steps: builtSteps });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      maxWidth="md"
      fullWidth
      aria-labelledby={titleId}
    >
      <DialogTitle
        id={titleId}
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pb: 1 }}
      >
        <span>
          {mode === "create"
            ? t("workflows.editor.createTitle")
            : t("workflows.editor.newVersionTitle", { name: existingName })}
        </span>
        <IconButton
          aria-label={t("workflows.editor.closeAriaLabel")}
          onClick={onClose}
          disabled={submitting}
          size="small"
        >
          <CloseOutlinedIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <Box component="form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <DialogContent dividers>
          <Stack spacing={2.5}>
            {mode === "newVersion" ? (
              <Alert severity="info">{t("workflows.editor.newVersionNotice")}</Alert>
            ) : null}

            {validationError ? (
              <Alert severity="error" role="alert">
                {validationError}
              </Alert>
            ) : null}

            {serverError ? (
              <Alert severity="error" role="alert">
                {serverError}
              </Alert>
            ) : null}

            {mode === "create" ? (
              <Stack spacing={2}>
                <TextField
                  label={t("workflows.editor.nameLabel")}
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={submitting}
                  inputProps={{ maxLength: 120 }}
                  placeholder={t("workflows.editor.namePlaceholder")}
                  fullWidth
                />
                <TextField
                  label={t("workflows.editor.descriptionLabel")}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={submitting}
                  multiline
                  minRows={2}
                  maxRows={3}
                  inputProps={{ maxLength: 500 }}
                  placeholder={t("workflows.editor.descriptionPlaceholder")}
                  fullWidth
                />
              </Stack>
            ) : null}

            <Stack spacing={1.5}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="subtitle1" component="h2">
                    {t("workflows.editor.stepsHeading", { count: steps.length })}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t("workflows.editor.stepsHint")}
                  </Typography>
                </Box>
                <Button
                  type="button"
                  size="small"
                  variant="outlined"
                  startIcon={<AddOutlinedIcon />}
                  onClick={handleAddStep}
                  disabled={submitting || steps.length >= 20}
                >
                  {t("workflows.editor.addStep")}
                </Button>
              </Stack>

              {steps.map((step, index) => {
                const stepNumber = index + 1;
                const targetOptions =
                  step.assigneeType === "USER"
                    ? catalog.users.map((user) => ({
                        id: user.id,
                        label: `${user.fullName} (${user.email})`,
                      }))
                    : step.assigneeType === "GROUP"
                      ? catalog.groups.map((group) => ({ id: group.id, label: group.name }))
                      : catalog.roles.map((role) => ({ id: role.id, label: role.name }));

                return (
                  <Paper
                    key={step.key}
                    variant="outlined"
                    sx={{
                      p: 2,
                      bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                      borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
                    }}
                  >
                    <Stack spacing={2}>
                      <Stack direction="row" alignItems="center" justifyContent="space-between">
                        <Typography variant="subtitle2">
                          {t("workflows.editor.stepTitle", { step: stepNumber })}
                        </Typography>
                        <Stack direction="row" spacing={0.5}>
                          <IconButton
                            size="small"
                            aria-label={t("workflows.editor.moveStepUpAria", { step: stepNumber })}
                            onClick={() => handleMoveStep(index, -1)}
                            disabled={submitting || index === 0}
                          >
                            <ArrowUpwardOutlinedIcon fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            aria-label={t("workflows.editor.moveStepDownAria", {
                              step: stepNumber,
                            })}
                            onClick={() => handleMoveStep(index, 1)}
                            disabled={submitting || index === steps.length - 1}
                          >
                            <ArrowDownwardOutlinedIcon fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            aria-label={t("workflows.editor.removeStepAria", { step: stepNumber })}
                            onClick={() => handleRemoveStep(index)}
                            disabled={submitting || steps.length <= 1}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Stack>
                      </Stack>

                      <Box
                        sx={{
                          display: "grid",
                          gridTemplateColumns: { xs: "1fr", sm: "1.4fr 1fr" },
                          gap: 2,
                        }}
                      >
                        <TextField
                          label={t("workflows.editor.stepNameLabel", { step: stepNumber })}
                          required
                          value={step.name}
                          onChange={(event) => updateStep(index, { name: event.target.value })}
                          disabled={submitting}
                          inputProps={{ maxLength: 120 }}
                          placeholder={t("workflows.editor.stepNamePlaceholder")}
                          fullWidth
                        />

                        <TextField
                          label={t("workflows.editor.dueDaysLabel")}
                          type="number"
                          value={step.dueDays}
                          onChange={(event) => updateStep(index, { dueDays: event.target.value })}
                          disabled={submitting}
                          inputProps={{ min: 1, max: 365 }}
                          fullWidth
                        />

                        <TextField
                          select
                          label={t("workflows.editor.assigneeTypeLabel")}
                          value={step.assigneeType}
                          onChange={(event) =>
                            handleAssigneeTypeChange(index, event.target.value as AssigneeType)
                          }
                          disabled={submitting}
                          fullWidth
                        >
                          <MenuItem value="USER">
                            {t("workflows.editor.assigneeType.USER")}
                          </MenuItem>
                          <MenuItem value="GROUP">
                            {t("workflows.editor.assigneeType.GROUP")}
                          </MenuItem>
                          <MenuItem value="ROLE">
                            {t("workflows.editor.assigneeType.ROLE")}
                          </MenuItem>
                        </TextField>

                        <TextField
                          select
                          label={t("workflows.editor.assigneeTargetLabel")}
                          required
                          value={
                            targetOptions.some((opt) => opt.id === step.assigneeTargetId)
                              ? step.assigneeTargetId
                              : ""
                          }
                          onChange={(event) =>
                            updateStep(index, { assigneeTargetId: event.target.value })
                          }
                          disabled={submitting || targetOptions.length === 0}
                          helperText={
                            targetOptions.length === 0
                              ? step.assigneeType === "GROUP"
                                ? t("workflows.editor.noGroupsHelper")
                                : t("workflows.editor.noAssigneesHelper")
                              : undefined
                          }
                          fullWidth
                        >
                          {targetOptions.map((option) => (
                            <MenuItem key={option.id} value={option.id}>
                              {option.label}
                            </MenuItem>
                          ))}
                        </TextField>
                      </Box>

                      <FormControlLabel
                        control={
                          <Checkbox
                            size="small"
                            checked={step.requireOnApprove}
                            onChange={(event) =>
                              updateStep(index, { requireOnApprove: event.target.checked })
                            }
                            disabled={submitting}
                          />
                        }
                        label={t("workflows.editor.requireCommentOnApprove")}
                      />
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          </Stack>
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button type="button" color="inherit" onClick={onClose} disabled={submitting}>
            {t("workflows.editor.cancel")}
          </Button>
          <Button type="submit" variant="contained" disabled={submitting}>
            {submitting
              ? t("workflows.editor.saving")
              : mode === "create"
                ? t("workflows.editor.submitCreate")
                : t("workflows.editor.submitNewVersion")}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
