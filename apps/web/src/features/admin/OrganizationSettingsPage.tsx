import type {
  OrganizationDateFormat,
  OrganizationLanguage,
  OrganizationListPageSize,
  OrganizationSettingsViewContract,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, ErrorState, LoadingState } from "@docuflow/ui";
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
import { type FormEvent, useEffect, useState } from "react";
import { UploadLimitsSettingsSection } from "./UploadLimitsSettingsSection.js";
import {
  useOrganizationSettingsQuery,
  useUpdateOrganizationSettingsMutation,
} from "./useOrganizationSettings.js";

const LANGUAGE_OPTIONS: ReadonlyArray<{
  readonly value: OrganizationLanguage;
  readonly label: string;
}> = [
  { value: "pt-BR", label: "Português (Brasil) — pt-BR" },
  { value: "en-US", label: "Inglês (EUA) — en-US" },
  { value: "es-ES", label: "Espanhol (Espanha) — es-ES" },
];

const COMMON_IANA_TIMEZONES: readonly string[] = [
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

const DATE_FORMAT_OPTIONS: ReadonlyArray<{
  readonly value: OrganizationDateFormat;
  readonly label: string;
}> = [
  { value: "DD/MM/YYYY", label: "DD/MM/AAAA (31/12/2026)" },
  { value: "YYYY-MM-DD", label: "AAAA-MM-DD (2026-12-31)" },
  { value: "MM/DD/YYYY", label: "MM/DD/AAAA (12/31/2026)" },
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
 * identity, localization defaults, and strictly allowlisted installation preferences.
 */
export function OrganizationSettingsPage() {
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
    return <LoadingState message="Carregando dados e preferências da organização..." />;
  }

  if (settingsQuery.isError) {
    return (
      <ErrorState
        title="Não foi possível carregar as configurações da organização"
        description={settingsQuery.error.message}
        onRetry={() => void settingsQuery.refetch()}
      />
    );
  }

  if (!settingsQuery.data || !form) {
    return (
      <ErrorState
        title="Dados da organização indisponíveis"
        description="Tente recarregar a página para consultar os dados atualizados."
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

  const timezoneChoices = COMMON_IANA_TIMEZONES.includes(form.timezone)
    ? COMMON_IANA_TIMEZONES
    : [form.timezone, ...COMMON_IANA_TIMEZONES];

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
        message: "O nome da organização deve ter pelo menos 2 caracteres.",
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
        message: "A janela padrão de vencimentos deve estar entre 1 e 365 dias.",
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
        message: "O prazo de carência da lixeira deve estar entre 1 e 3650 dias.",
      });
      return;
    }

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
      setFeedback({
        severity: "success",
        message: "Dados e preferências da organização salvos com sucesso.",
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        message:
          error instanceof Error
            ? error.message
            : "Falha ao atualizar as configurações da organização.",
      });
    }
  };

  return (
    <Stack spacing={2.5}>
      <Paper
        variant="outlined"
        sx={{
          p: 2.5,
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
          borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack direction="row" spacing={1.25} alignItems="center">
          <CorporateFareOutlinedIcon color="primary" />
          <Box>
            <Typography variant="h1">Dados e preferências da organização</Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
              Configure nome institucional, idioma padrão, fuso horário e preferências operacionais
              permitidas para esta instalação self-hosted.
            </Typography>
          </Box>
        </Stack>
      </Paper>

      {!canEdit ? (
        <Alert severity="info">
          Seu perfil possui acesso somente de leitura às configurações da organização.
        </Alert>
      ) : null}

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
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
          borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6" component="h2">
              Identidade e localização
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              Identificador técnico da instalação: <strong>{organization.slug}</strong>
            </Typography>
          </Box>

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Nome da organização"
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
                label="Idioma padrão"
                value={form.defaultLanguage}
                onChange={(event) =>
                  setForm({ ...form, defaultLanguage: event.target.value as OrganizationLanguage })
                }
                fullWidth
                disabled={!canEdit || updateMutation.isPending}
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                select
                label="Fuso horário (IANA)"
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
              Preferências operacionais permitidas
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              Parâmetros não sensíveis utilizados na apresentação de datas, paginação, auditoria e
              prazos padrão.
            </Typography>
          </Box>

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                type="number"
                label="Janela padrão de vencimentos (dias)"
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
                label="Carência padrão da lixeira (dias)"
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
                label="Formato de data"
                value={form.dateFormat}
                onChange={(event) =>
                  setForm({ ...form, dateFormat: event.target.value as OrganizationDateFormat })
                }
                fullWidth
                disabled={!canEdit || updateMutation.isPending}
              >
                {DATE_FORMAT_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                select
                label="Itens por página padrão"
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
                    {size} itens
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
              label="Registrar eventos de visualização de documentos na auditoria"
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
              label="Registrar eventos de download de arquivos na auditoria"
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
              Descartar alterações
            </Button>
            <Button
              type="submit"
              variant="contained"
              startIcon={<SaveOutlinedIcon />}
              disabled={!canEdit || !hasChanges || updateMutation.isPending}
            >
              {updateMutation.isPending ? "Salvando..." : "Salvar configurações"}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <UploadLimitsSettingsSection />
    </Stack>
  );
}
