import { MIN_UPLOAD_MAX_BYTES, type UploadLimitsViewContract } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, ErrorState, LoadingState } from "@docuflow/ui";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import RestartAltOutlinedIcon from "@mui/icons-material/RestartAltOutlined";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControlLabel,
  Grid,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useUpdateUploadLimitsMutation, useUploadLimitsQuery } from "./useUploadLimitsSettings.js";

const BYTES_PER_MIB = 1024 * 1024;

interface UploadLimitsFormState {
  readonly maxFileSizeMbInput: string;
  readonly allowedExtensions: readonly string[];
  readonly enforceDeclaredExtensionMatch: boolean;
}

function bytesToMegabytesText(bytes: number): string {
  const mb = bytes / BYTES_PER_MIB;
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(2);
}

function formatBytesSummary(bytes: number): string {
  if (bytes >= BYTES_PER_MIB) {
    const mb = bytes / BYTES_PER_MIB;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(2)} MB (${bytes.toLocaleString("pt-BR")} bytes)`;
  }
  const kb = bytes / 1024;
  return `${kb.toFixed(1)} KB (${bytes.toLocaleString("pt-BR")} bytes)`;
}

function toFormState(view: UploadLimitsViewContract): UploadLimitsFormState {
  return {
    maxFileSizeMbInput: bytesToMegabytesText(view.configured.maxFileSizeBytes),
    allowedExtensions: [...view.configured.allowedExtensions],
    enforceDeclaredExtensionMatch: view.configured.enforceDeclaredExtensionMatch,
  };
}

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  return b.every((item) => setA.has(item));
}

/**
 * Administrative configuration panel for upload file size ceilings and safe
 * allowed extensions enforced consistently across proxy, API, and worker.
 */
export function UploadLimitsSettingsSection() {
  const limitsQuery = useUploadLimitsQuery();
  const updateMutation = useUpdateUploadLimitsMutation();

  const [form, setForm] = useState<UploadLimitsFormState | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  useEffect(() => {
    if (limitsQuery.data) {
      setForm(toFormState(limitsQuery.data));
    }
  }, [limitsQuery.data]);

  const parsedSizeBytes = useMemo(() => {
    if (!form) {
      return Number.NaN;
    }
    const mbValue = Number(form.maxFileSizeMbInput.replace(",", "."));
    if (!Number.isFinite(mbValue) || mbValue <= 0) {
      return Number.NaN;
    }
    return Math.round(mbValue * BYTES_PER_MIB);
  }, [form]);

  if (limitsQuery.isLoading) {
    return <LoadingState message="Carregando limites e extensões de upload..." minHeight={120} />;
  }

  if (limitsQuery.isError) {
    return (
      <ErrorState
        title="Não foi possível carregar os limites de upload"
        description={limitsQuery.error.message}
        onRetry={() => void limitsQuery.refetch()}
      />
    );
  }

  // Gracefully omit when endpoint is absent in minimal mocks.
  if (!limitsQuery.data || !form) {
    return null;
  }

  const data = limitsQuery.data;
  const baseline = toFormState(data);
  const ceilingBytes = Math.min(
    data.effective.systemMaxUploadBytes,
    data.effective.proxyMaxBodyBytes,
  );
  const hasChanges =
    form.maxFileSizeMbInput !== baseline.maxFileSizeMbInput ||
    form.enforceDeclaredExtensionMatch !== baseline.enforceDeclaredExtensionMatch ||
    !sameStringArrays(form.allowedExtensions, baseline.allowedExtensions);

  function handleToggleExtension(ext: string) {
    if (!data.canEdit || updateMutation.isPending) {
      return;
    }
    setFeedback(null);
    setForm((prev) => {
      if (!prev) {
        return prev;
      }
      const exists = prev.allowedExtensions.includes(ext);
      return {
        ...prev,
        allowedExtensions: exists
          ? prev.allowedExtensions.filter((item) => item !== ext)
          : [...prev.allowedExtensions, ext],
      };
    });
  }

  function handleReset() {
    setForm(baseline);
    setFeedback(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !data.canEdit || !hasChanges) {
      return;
    }
    setFeedback(null);

    if (!Number.isInteger(parsedSizeBytes) || parsedSizeBytes < MIN_UPLOAD_MAX_BYTES) {
      setFeedback({
        severity: "error",
        message: "Informe um tamanho máximo válido de pelo menos 1 KB (0,001 MB).",
      });
      return;
    }

    if (parsedSizeBytes > ceilingBytes) {
      setFeedback({
        severity: "error",
        message: `O limite solicitado (${formatBytesSummary(parsedSizeBytes)}) ultrapassa o teto permitido pelo servidor e proxy (${formatBytesSummary(ceilingBytes)}).`,
      });
      return;
    }

    if (form.allowedExtensions.length === 0) {
      setFeedback({
        severity: "error",
        message: "Selecione ao menos uma extensão de arquivo permitida.",
      });
      return;
    }

    try {
      const updated = await updateMutation.mutateAsync({
        maxFileSizeBytes: parsedSizeBytes,
        allowedExtensions: [...form.allowedExtensions],
        enforceDeclaredExtensionMatch: form.enforceDeclaredExtensionMatch,
      });
      setForm(toFormState(updated));
      setFeedback({
        severity: "success",
        message: "Limites de tamanho e extensões permitidas atualizados para API, proxy e worker.",
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        message:
          error instanceof Error ? error.message : "Falha ao atualizar configurações de upload.",
      });
    }
  }

  return (
    <Paper
      variant="outlined"
      component="form"
      onSubmit={handleSubmit}
      noValidate
      sx={{
        p: 3,
        borderRadius: 3,
        borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
        backgroundColor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Stack spacing={2.5}>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <CloudUploadOutlinedIcon color="primary" />
          <Box>
            <Typography variant="h6" fontWeight={600}>
              Limites e formatos de upload
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Configure o tamanho máximo por arquivo e as extensões aceitas com validação
              consistente entre proxy, API e worker de processamento.
            </Typography>
          </Box>
        </Stack>

        {feedback ? (
          <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
            {feedback.message}
          </Alert>
        ) : null}

        <Alert severity="info">
          Teto efetivo atual considerando API e proxy:{" "}
          <strong>{formatBytesSummary(data.effective.effectiveMaxWithProxyBytes)}</strong> (teto de
          ambiente API: {formatBytesSummary(data.effective.systemMaxUploadBytes)}; teto do proxy:{" "}
          {formatBytesSummary(data.effective.proxyMaxBodyBytes)}). Extensões executáveis (.exe, .sh,
          .svg, .html, .js) permanecem bloqueadas em todas as camadas.
        </Alert>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Tamanho máximo por arquivo (MB)"
              type="number"
              fullWidth
              inputProps={{ min: 0.001, step: "any" }}
              value={form.maxFileSizeMbInput}
              onChange={(event) => {
                setFeedback(null);
                setForm({ ...form, maxFileSizeMbInput: event.target.value });
              }}
              helperText={
                Number.isInteger(parsedSizeBytes) && parsedSizeBytes >= MIN_UPLOAD_MAX_BYTES
                  ? `Equivalente a ${formatBytesSummary(parsedSizeBytes)}`
                  : "Informe um valor numérico positivo."
              }
              disabled={!data.canEdit || updateMutation.isPending}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }} sx={{ display: "flex", alignItems: "center" }}>
            <FormControlLabel
              control={
                <Switch
                  checked={form.enforceDeclaredExtensionMatch}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      enforceDeclaredExtensionMatch: event.target.checked,
                    })
                  }
                  disabled={!data.canEdit || updateMutation.isPending}
                />
              }
              label="Exigir correspondência entre extensão, tipo MIME declarado e assinatura real"
            />
          </Grid>
        </Grid>

        <Divider />

        <Stack spacing={1.25}>
          <Typography variant="subtitle2" fontWeight={600}>
            Extensões permitidas ({form.allowedExtensions.length} selecionadas)
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {data.supportedCatalog.map((entry) => {
              const selected = form.allowedExtensions.includes(entry.extension);
              return (
                <Chip
                  key={entry.extension}
                  label={entry.label}
                  color={selected ? "primary" : "default"}
                  variant={selected ? "filled" : "outlined"}
                  clickable={data.canEdit && !updateMutation.isPending}
                  onClick={() => handleToggleExtension(entry.extension)}
                  aria-pressed={selected}
                />
              );
            })}
          </Stack>
        </Stack>

        <Stack direction="row" spacing={1.5} justifyContent="flex-end">
          <Button
            type="button"
            variant="outlined"
            startIcon={<RestartAltOutlinedIcon />}
            onClick={handleReset}
            disabled={!data.canEdit || !hasChanges || updateMutation.isPending}
          >
            Descartar alterações
          </Button>
          <Button
            type="submit"
            variant="contained"
            startIcon={<SaveOutlinedIcon />}
            disabled={!data.canEdit || !hasChanges || updateMutation.isPending}
          >
            {updateMutation.isPending ? "Salvando..." : "Salvar limites de upload"}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
