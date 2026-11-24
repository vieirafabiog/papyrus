import type {
  CategoryFieldDefinition,
  DocumentDetail,
  DocumentMetadataValue,
} from "@docuflow/contracts";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormHelperText,
  Grid,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { type FormEvent, useMemo, useState } from "react";
import { containsTechnicalJargon } from "../../i18n/api-errors.js";
import { type UiLocale, getCurrentUiLocale, translate, useI18n } from "../../i18n/index.js";
import {
  DocumentDetailFetchError,
  useUpdateDocumentMetadataMutation,
} from "./useDocumentDetails.js";

export interface DocumentMetadataFormProps {
  readonly document: DocumentDetail;
  readonly onSaved?: () => void;
  readonly onCancel?: () => void;
}

type FieldErrorMap = Readonly<Record<string, string>>;

interface ClientValidationResult {
  readonly valid: boolean;
  readonly fieldErrors: Record<string, string>;
  readonly normalizedMetadata: Record<string, DocumentMetadataValue>;
}

function toInitialTextValue(
  field: CategoryFieldDefinition,
  raw: DocumentMetadataValue | undefined,
): string {
  if (raw === undefined || raw === null) {
    return "";
  }
  if (field.type === "NUMBER" && typeof raw === "number") {
    return String(raw);
  }
  return typeof raw === "string" ? raw : "";
}

function buildInitialFieldState(document: DocumentDetail) {
  const textValues: Record<string, string> = {};
  const booleanValues: Record<string, boolean> = {};
  const multiValues: Record<string, string[]> = {};

  for (const field of document.category.fields) {
    const raw = document.metadata[field.key];
    if (field.type === "BOOLEAN") {
      booleanValues[field.key] = typeof raw === "boolean" ? raw : false;
    } else if (field.type === "MULTI_SELECT") {
      multiValues[field.key] = Array.isArray(raw) ? [...raw] : [];
    } else {
      textValues[field.key] = toInitialTextValue(field, raw);
    }
  }

  return { textValues, booleanValues, multiValues };
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

/**
 * Validates core fields and dynamic category fields client-side before submission.
 */
export function validateDocumentMetadataForm(params: {
  readonly title: string;
  readonly issueDate: string;
  readonly expirationDate: string;
  readonly fields: readonly CategoryFieldDefinition[];
  readonly textValues: Readonly<Record<string, string>>;
  readonly booleanValues: Readonly<Record<string, boolean>>;
  readonly multiValues: Readonly<Record<string, readonly string[]>>;
  readonly locale?: UiLocale | undefined;
}): ClientValidationResult {
  const locale = params.locale ?? getCurrentUiLocale();
  const fieldErrors: Record<string, string> = {};
  const normalizedMetadata: Record<string, DocumentMetadataValue> = {};

  const trimmedTitle = params.title.trim();
  if (trimmedTitle.length === 0) {
    fieldErrors.title = translate("documents.validation.titleRequired", undefined, locale);
  } else if (trimmedTitle.length > 255) {
    fieldErrors.title = translate("documents.validation.titleMaxLength", undefined, locale);
  }

  const trimmedIssue = params.issueDate.trim();
  const trimmedExpiration = params.expirationDate.trim();
  if (trimmedIssue.length > 0 && !isValidIsoDateString(trimmedIssue)) {
    fieldErrors.issueDate = translate("documents.validation.invalidIssueDate", undefined, locale);
  }
  if (trimmedExpiration.length > 0 && !isValidIsoDateString(trimmedExpiration)) {
    fieldErrors.expirationDate = translate(
      "documents.validation.invalidExpirationDate",
      undefined,
      locale,
    );
  }
  if (
    trimmedIssue.length > 0 &&
    trimmedExpiration.length > 0 &&
    isValidIsoDateString(trimmedIssue) &&
    isValidIsoDateString(trimmedExpiration) &&
    trimmedExpiration < trimmedIssue
  ) {
    fieldErrors.expirationDate = translate(
      "documents.validation.expirationBeforeIssue",
      undefined,
      locale,
    );
  }

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
          const num = Number(raw);
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

/**
 * Dynamic category-driven document details editor with both client-side and server-side
 * field error mapping rendered adjacent to each field.
 */
export function DocumentMetadataForm({ document, onSaved, onCancel }: DocumentMetadataFormProps) {
  const { locale, t } = useI18n();
  const initial = useMemo(() => buildInitialFieldState(document), [document]);
  const sortedFields = useMemo(
    () => [...document.category.fields].sort((a, b) => a.sortOrder - b.sortOrder),
    [document.category.fields],
  );

  const [title, setTitle] = useState(document.title);
  const [issueDate, setIssueDate] = useState(document.issueDate ?? "");
  const [expirationDate, setExpirationDate] = useState(document.expirationDate ?? "");
  const [textValues, setTextValues] = useState<Record<string, string>>(initial.textValues);
  const [booleanValues, setBooleanValues] = useState<Record<string, boolean>>(
    initial.booleanValues,
  );
  const [multiValues, setMultiValues] = useState<Record<string, string[]>>(initial.multiValues);
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [formBannerError, setFormBannerError] = useState<string | null>(null);

  const updateMutation = useUpdateDocumentMetadataMutation(document.id);

  const clearSingleFieldError = (fieldKey: string) => {
    if (fieldErrors[fieldKey] === undefined) {
      return;
    }
    const next = { ...fieldErrors };
    delete next[fieldKey];
    setFieldErrors(next);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormBannerError(null);

    const validation = validateDocumentMetadataForm({
      title,
      issueDate,
      expirationDate,
      fields: sortedFields,
      textValues,
      booleanValues,
      multiValues,
      locale,
    });

    if (!validation.valid) {
      setFieldErrors(validation.fieldErrors);
      setFormBannerError(t("documents.form.fixHighlightedFields"));
      return;
    }

    setFieldErrors({});
    try {
      await updateMutation.mutateAsync({
        expectedVersion: document.version,
        title: title.trim(),
        issueDate: issueDate.trim().length > 0 ? issueDate.trim() : null,
        expirationDate: expirationDate.trim().length > 0 ? expirationDate.trim() : null,
        metadata: validation.normalizedMetadata,
      });
      onSaved?.();
    } catch (error) {
      if (error instanceof DocumentDetailFetchError) {
        if (Object.keys(error.fieldErrors).length > 0) {
          setFieldErrors(error.fieldErrors);
        }
        setFormBannerError(error.message);
        return;
      }
      const rawMessage = error instanceof Error ? error.message : "";
      setFormBannerError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("documents.form.saveFailed"),
      );
    }
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => void handleSubmit(event)}
      aria-label={t("documents.form.ariaLabel")}
    >
      <Stack spacing={2.5}>
        {formBannerError ? (
          <Alert severity="error" role="alert">
            {formBannerError}
          </Alert>
        ) : null}

        <Grid container spacing={2}>
          <Grid size={{ xs: 12 }}>
            <TextField
              fullWidth
              required
              label={t("documents.form.titleLabel")}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                clearSingleFieldError("title");
              }}
              error={Boolean(fieldErrors.title)}
              helperText={fieldErrors.title}
              disabled={updateMutation.isPending}
              inputProps={{ maxLength: 255 }}
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              type="date"
              label={t("documents.form.issueDateLabel")}
              value={issueDate}
              onChange={(event) => {
                setIssueDate(event.target.value);
                clearSingleFieldError("issueDate");
              }}
              InputLabelProps={{ shrink: true }}
              error={Boolean(fieldErrors.issueDate)}
              helperText={fieldErrors.issueDate}
              disabled={updateMutation.isPending}
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              type="date"
              label={t("documents.form.expirationDateLabel")}
              value={expirationDate}
              onChange={(event) => {
                setExpirationDate(event.target.value);
                clearSingleFieldError("expirationDate");
              }}
              InputLabelProps={{ shrink: true }}
              error={Boolean(fieldErrors.expirationDate)}
              helperText={fieldErrors.expirationDate}
              disabled={updateMutation.isPending}
            />
          </Grid>

          {sortedFields.map((field) => {
            const errorMsg = fieldErrors[field.key];
            const helperId = `metadata-error-${field.key}`;

            switch (field.type) {
              case "TEXT":
                return (
                  <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                    <TextField
                      fullWidth
                      required={field.required}
                      label={field.label}
                      value={textValues[field.key] ?? ""}
                      onChange={(event) => {
                        setTextValues((prev) => ({ ...prev, [field.key]: event.target.value }));
                        clearSingleFieldError(field.key);
                      }}
                      error={Boolean(errorMsg)}
                      helperText={errorMsg}
                      disabled={updateMutation.isPending}
                    />
                  </Grid>
                );

              case "NUMBER":
                return (
                  <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                    <TextField
                      fullWidth
                      required={field.required}
                      type="text"
                      inputMode="decimal"
                      label={field.label}
                      value={textValues[field.key] ?? ""}
                      onChange={(event) => {
                        setTextValues((prev) => ({ ...prev, [field.key]: event.target.value }));
                        clearSingleFieldError(field.key);
                      }}
                      error={Boolean(errorMsg)}
                      helperText={errorMsg}
                      disabled={updateMutation.isPending}
                    />
                  </Grid>
                );

              case "DATE":
                return (
                  <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                    <TextField
                      fullWidth
                      required={field.required}
                      type="date"
                      label={field.label}
                      value={textValues[field.key] ?? ""}
                      onChange={(event) => {
                        setTextValues((prev) => ({ ...prev, [field.key]: event.target.value }));
                        clearSingleFieldError(field.key);
                      }}
                      InputLabelProps={{ shrink: true }}
                      error={Boolean(errorMsg)}
                      helperText={errorMsg}
                      disabled={updateMutation.isPending}
                    />
                  </Grid>
                );

              case "BOOLEAN":
                return (
                  <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                    <FormControl error={Boolean(errorMsg)} component="fieldset">
                      <FormControlLabel
                        control={
                          <Switch
                            checked={booleanValues[field.key] ?? false}
                            onChange={(event) => {
                              setBooleanValues((prev) => ({
                                ...prev,
                                [field.key]: event.target.checked,
                              }));
                              clearSingleFieldError(field.key);
                            }}
                            disabled={updateMutation.isPending}
                          />
                        }
                        label={field.required ? `${field.label} *` : field.label}
                      />
                      {errorMsg ? <FormHelperText id={helperId}>{errorMsg}</FormHelperText> : null}
                    </FormControl>
                  </Grid>
                );

              case "SINGLE_SELECT": {
                const labelId = `select-label-${field.key}`;
                return (
                  <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                    <FormControl fullWidth required={field.required} error={Boolean(errorMsg)}>
                      <InputLabel id={labelId}>{field.label}</InputLabel>
                      <Select
                        labelId={labelId}
                        label={field.label}
                        value={textValues[field.key] ?? ""}
                        onChange={(event) => {
                          setTextValues((prev) => ({
                            ...prev,
                            [field.key]: String(event.target.value),
                          }));
                          clearSingleFieldError(field.key);
                        }}
                        disabled={updateMutation.isPending}
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
                      {errorMsg ? <FormHelperText id={helperId}>{errorMsg}</FormHelperText> : null}
                    </FormControl>
                  </Grid>
                );
              }

              case "MULTI_SELECT": {
                const labelId = `multiselect-label-${field.key}`;
                const selectedValues = multiValues[field.key] ?? [];
                return (
                  <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                    <FormControl fullWidth required={field.required} error={Boolean(errorMsg)}>
                      <InputLabel id={labelId}>{field.label}</InputLabel>
                      <Select
                        multiple
                        labelId={labelId}
                        label={field.label}
                        value={selectedValues}
                        onChange={(event) => {
                          const raw = event.target.value;
                          const next = typeof raw === "string" ? raw.split(",") : Array.from(raw);
                          setMultiValues((prev) => ({ ...prev, [field.key]: next }));
                          clearSingleFieldError(field.key);
                        }}
                        renderValue={(selected) => selected.join(", ")}
                        disabled={updateMutation.isPending}
                        aria-describedby={errorMsg ? helperId : undefined}
                      >
                        {(field.options ?? []).map((option) => (
                          <MenuItem key={option} value={option}>
                            <Checkbox checked={selectedValues.includes(option)} />
                            <ListItemText primary={option} />
                          </MenuItem>
                        ))}
                      </Select>
                      {errorMsg ? <FormHelperText id={helperId}>{errorMsg}</FormHelperText> : null}
                    </FormControl>
                  </Grid>
                );
              }
            }
          })}
        </Grid>

        {sortedFields.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("documents.form.noAdditionalFields")}
          </Typography>
        ) : null}

        <Stack direction="row" spacing={1.5} justifyContent="flex-end">
          {onCancel ? (
            <Button
              type="button"
              variant="outlined"
              onClick={onCancel}
              disabled={updateMutation.isPending}
            >
              {t("documents.common.cancel")}
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="contained"
            startIcon={<SaveOutlinedIcon />}
            disabled={updateMutation.isPending}
          >
            {t("documents.form.saveDetails")}
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
