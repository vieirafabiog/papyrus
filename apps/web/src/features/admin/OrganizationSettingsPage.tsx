import CorporateFareOutlinedIcon from "@mui/icons-material/CorporateFareOutlined";
import RestartAltOutlinedIcon from "@mui/icons-material/RestartAltOutlined";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import {
  Alert,
  Box,
  Button,
  Divider,
  FormControlLabel,
  Grid,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type {
  OrganizationDateFormat,
  OrganizationLanguage,
  OrganizationListPageSize,
  OrganizationSettingsViewContract,
} from "@papyrus/contracts";
import { ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { type FormEvent, useEffect, useState } from "react";
import { type MessageKey, getStoredUiLocale, resolveUiLocale, useI18n } from "../../i18n/index.js";
import { UploadLimitsSettingsSection } from "./UploadLimitsSettingsSection.js";
import {
  useOrganizationSettingsQuery,
  useUpdateOrganizationSettingsMutation,
} from "./useOrganizationSettings.js";

const LANGUAGE_OPTION_KEYS: ReadonlyArray<{
  readonly value: OrganizationLanguage;
  readonly labelKey: MessageKey;
}> = [
  { value: "pt-BR", labelKey: "admin.organization.language.ptBR" },
  { value: "en-US", labelKey: "admin.organization.language.enUS" },
  { value: "es-ES", labelKey: "admin.organization.language.esES" },
];

const COMMON_TIMEZONES: readonly string[] = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Cuiaba",
  "America/Fortaleza",
  "America/Recife",
  "America/Belem",
  "America/Rio_Branco",
  "UTC",
  "America/New_York",
  "Europe/Lisbon",
];

const DATE_FORMAT_OPTION_KEYS: ReadonlyArray<{
  readonly value: OrganizationDateFormat;
  readonly labelKey: MessageKey;
}> = [
  { value: "DD/MM/YYYY", labelKey: "admin.organization.dateFormat.dmy" },
  { value: "YYYY-MM-DD", labelKey: "admin.organization.dateFormat.ymd" },
  { value: "MM/DD/YYYY", labelKey: "admin.organization.dateFormat.mdy" },
];

const PAGE_SIZE_OPTIONS: readonly OrganizationListPageSize[] = [10, 20, 50];

interface OrganizationFormState {
  readonly name: string;
  readonly defaultLanguage: OrganizationLanguage;
  readonly timezone: string;
  readonly defaultExpirationWindowDays: number;
  readonly trashGraceDays: number;
  readonly dateFormat: OrganizationDateFormat;
  readonly defaultListPageSize: OrganizationListPageSize;
  readonly auditDocumentViews: boolean;
  readonly auditDocumentDownloads: boolean;
}

function toFormState(view: OrganizationSettingsViewContract): OrganizationFormState {
  const { organization } = view;
  return {
    name: organization.name,
    defaultLanguage: organization.defaultLanguage,
    timezone: organization.timezone,
    defaultExpirationWindowDays: organization.preferences.defaultExpirationWindowDays,
    trashGraceDays: organization.preferences.trashGraceDays,
    dateFormat: organization.preferences.dateFormat,
    defaultListPageSize: organization.preferences.defaultListPageSize,
    auditDocumentViews: organization.preferences.auditDocumentViews,
    auditDocumentDownloads: organization.preferences.auditDocumentDownloads,
  };
}

/**
 * Administrative page for viewing and updating installation-level organization
 * identity, localization defaults, and general preferences.
 */
export function OrganizationSettingsPage() {
  const { t, setLocale } = useI18n();
  const settingsQuery = useOrganizationSettingsQuery();
  const updateMutation = useUpdateOrganizationSettingsMutation();

  const [form, setForm] = useState<OrganizationFormState | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setForm(toFormState(settingsQuery.data));
    }
  }, [settingsQuery.data]);

  if (settingsQuery.isLoading) {
    return <LoadingState message={t("admin.organization.loading")} />;
  }

  if (settingsQuery.isError) {
    return (
      <ErrorState
        title={t("admin.organization.loadErrorTitle")}
        description={settingsQuery.error.message}
        onRetry={() => void settingsQuery.refetch()}
      />
    );
  }

  if (!settingsQuery.data || !form) {
    return (
      <ErrorState
        title={t("admin.organization.unavailableTitle")}
        description={t("admin.organization.unavailableDescription")}
        onRetry={() => void settingsQuery.refetch()}
      />
    );
  }

  const { organization, canEdit } = settingsQuery.data;
  const baseline = toFormState(settingsQuery.data);
  const hasChanges =
    form.name.trim() !== baseline.name ||
    form.defaultLanguage !== baseline.defaultLanguage ||
    form.timezone !== baseline.timezone ||
    form.defaultExpirationWindowDays !== baseline.defaultExpirationWindowDays ||
    form.trashGraceDays !== baseline.trashGraceDays ||
    form.dateFormat !== baseline.dateFormat ||
    form.defaultListPageSize !== baseline.defaultListPageSize ||
    form.auditDocumentViews !== baseline.auditDocumentViews ||
    form.auditDocumentDownloads !== baseline.auditDocumentDownloads;

  const timezoneChoices = COMMON_TIMEZONES.includes(form.timezone)
    ? COMMON_TIMEZONES
    : [form.timezone, ...COMMON_TIMEZONES];

  const handleReset = (): void => {
    setForm(baseline);
    setFeedback(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canEdit || !hasChanges) {
      return;
    }

    setFeedback(null);
    const trimmedName = form.name.trim();
    if (trimmedName.length < 2) {
      setFeedback({
        severity: "error",
        message: t("admin.organization.validation.nameTooShort"),
      });
      return;
    }

    if (
      !Number.isInteger(form.defaultExpirationWindowDays) ||
      form.defaultExpirationWindowDays < 1 ||
      form.defaultExpirationWindowDays > 365
    ) {
      setFeedback({
        severity: "error",
        message: t("admin.organization.validation.expirationWindowRange"),
      });
      return;
    }

    if (
      !Number.isInteger(form.trashGraceDays) ||
      form.trashGraceDays < 1 ||
      form.trashGraceDays > 3650
    ) {
      setFeedback({
        severity: "error",
        message: t("admin.organization.validation.trashGraceRange"),
      });
      return;
    }

    const languageChanged = form.defaultLanguage !== baseline.defaultLanguage;

    try {
      const updated = await updateMutation.mutateAsync({
        name: trimmedName,
        defaultLanguage: form.defaultLanguage,
        timezone: form.timezone,
        preferences: {
          defaultExpirationWindowDays: form.defaultExpirationWindowDays,
          trashGraceDays: form.trashGraceDays,
          dateFormat: form.dateFormat,
          defaultListPageSize: form.defaultListPageSize,
          auditDocumentViews: form.auditDocumentViews,
          auditDocumentDownloads: form.auditDocumentDownloads,
        },
      });
      setForm(toFormState(updated));
      if (languageChanged && getStoredUiLocale() === null) {
        setLocale(resolveUiLocale(updated.organization.defaultLanguage));
      }
      setFeedback({
        severity: "success",
        message: t("admin.organization.feedback.saved"),
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        message: error instanceof Error ? error.message : t("admin.organization.errors.saveFailed"),
      });
    }
  };

  return (
    <Stack spacing={2.5}>
      <Paper
        variant="outlined"
        sx={{
          p: 2.5,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack direction="row" spacing={1.25} alignItems="center">
          <CorporateFareOutlinedIcon color="primary" />
          <Box>
            <Typography variant="h1">{t("admin.organization.title")}</Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
              {t("admin.organization.subtitle")}
            </Typography>
          </Box>
        </Stack>
      </Paper>

      {!canEdit ? <Alert severity="info">{t("admin.organization.readOnlyNotice")}</Alert> : null}

      {feedback ? (
        <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
          {feedback.message}
        </Alert>
      ) : null}

      <Paper
        component="form"
        onSubmit={(event) => void handleSubmit(event)}
        variant="outlined"
        sx={{
          p: 3,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" component="h2">
              {t("admin.organization.identityTitle")}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              {t("admin.organization.organizationCode", { slug: organization.slug })}
            </Typography>
          </Box>

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label={t("admin.organization.name")}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                fullWidth
                required
                disabled={!canEdit || updateMutation.isPending}
                inputProps={{ maxLength: 160 }}
              />
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                select
                label={t("admin.organization.defaultLanguage")}
                value={form.defaultLanguage}
                onChange={(event) =>
                  setForm({ ...form, defaultLanguage: event.target.value as OrganizationLanguage })
                }
                fullWidth
                disabled={!canEdit || updateMutation.isPending}
              >
                {LANGUAGE_OPTION_KEYS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                select
                label={t("admin.organization.timeZone")}
                value={form.timezone}
                onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                fullWidth
                disabled={!canEdit || updateMutation.isPending}
              >
                {timezoneChoices.map((tz) => (
                  <MenuItem key={tz} value={tz}>
                    {tz}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
          </Grid>

          <Divider />

          <Box>
            <Typography variant="h6" component="h2">
              {t("admin.organization.preferencesTitle")}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              {t("admin.organization.preferencesSubtitle")}
            </Typography>
          </Box>

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                type="number"
                label={t("admin.organization.expirationWindowDays")}
                value={form.defaultExpirationWindowDays}
                onChange={(event) =>
                  setForm({
                    ...form,
                    defaultExpirationWindowDays: Number.parseInt(event.target.value || "0", 10),
                  })
                }
                fullWidth
                disabled={!canEdit || updateMutation.isPending}
                inputProps={{ min: 1, max: 365 }}
              />
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                type="number"
                label={t("admin.organization.trashGraceDays")}
                value={form.trashGraceDays}
                onChange={(event) =>
                  setForm({
                    ...form,
                    trashGraceDays: Number.parseInt(event.target.value || "0", 10),
                  })
                }
                fullWidth
                disabled={!canEdit || updateMutation.isPending}
                inputProps={{ min: 1, max: 3650 }}
              />
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                select
                label={t("admin.organization.dateFormat")}
                value={form.dateFormat}
                onChange={(event) =>
                  setForm({ ...form, dateFormat: event.target.value as OrganizationDateFormat })
                }
                fullWidth
                disabled={!canEdit || updateMutation.isPending}
              >
                {DATE_FORMAT_OPTION_KEYS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                select
                label={t("admin.organization.defaultPageSize")}
                value={form.defaultListPageSize}
                onChange={(event) =>
                  setForm({
                    ...form,
                    defaultListPageSize: Number.parseInt(
                      event.target.value,
                      10,
                    ) as OrganizationListPageSize,
                  })
                }
                fullWidth
                disabled={!canEdit || updateMutation.isPending}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <MenuItem key={size} value={size}>
                    {t("admin.organization.pageSizeOption", { count: size })}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
          </Grid>

          <Stack spacing={1}>
            <FormControlLabel
              control={
                <Switch
                  checked={form.auditDocumentViews}
                  onChange={(event) =>
                    setForm({ ...form, auditDocumentViews: event.target.checked })
                  }
                  disabled={!canEdit || updateMutation.isPending}
                />
              }
              label={t("admin.organization.auditViews")}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={form.auditDocumentDownloads}
                  onChange={(event) =>
                    setForm({ ...form, auditDocumentDownloads: event.target.checked })
                  }
                  disabled={!canEdit || updateMutation.isPending}
                />
              }
              label={t("admin.organization.auditDownloads")}
            />
          </Stack>

          <Stack direction="row" spacing={1.5} justifyContent="flex-end">
            <Button
              type="button"
              variant="outlined"
              startIcon={<RestartAltOutlinedIcon />}
              onClick={handleReset}
              disabled={!canEdit || !hasChanges || updateMutation.isPending}
            >
              {t("admin.common.discardChanges")}
            </Button>
            <Button
              type="submit"
              variant="contained"
              startIcon={<SaveOutlinedIcon />}
              disabled={!canEdit || !hasChanges || updateMutation.isPending}
            >
              {updateMutation.isPending ? t("admin.common.saving") : t("admin.organization.submit")}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <UploadLimitsSettingsSection />
    </Stack>
  );
}
