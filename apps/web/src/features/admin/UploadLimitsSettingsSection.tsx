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
import { MIN_UPLOAD_MAX_BYTES, type UploadLimitsViewContract } from "@papyrus/contracts";
import { ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import { useUpdateUploadLimitsMutation, useUploadLimitsQuery } from "./useUploadLimitsSettings.js";

const BYTES_PER_MIB = 1024 * 1024;

const FORMAT_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  ".pdf": "admin.uploadLimits.formats.pdf",
  ".png": "admin.uploadLimits.formats.png",
  ".jpg": "admin.uploadLimits.formats.jpg",
  ".jpeg": "admin.uploadLimits.formats.jpeg",
  ".webp": "admin.uploadLimits.formats.webp",
  ".gif": "admin.uploadLimits.formats.gif",
  ".tif": "admin.uploadLimits.formats.tif",
  ".tiff": "admin.uploadLimits.formats.tiff",
  ".bmp": "admin.uploadLimits.formats.bmp",
  ".txt": "admin.uploadLimits.formats.txt",
  ".log": "admin.uploadLimits.formats.log",
  ".md": "admin.uploadLimits.formats.md",
  ".csv": "admin.uploadLimits.formats.csv",
  ".json": "admin.uploadLimits.formats.json",
  ".docx": "admin.uploadLimits.formats.docx",
  ".xlsx": "admin.uploadLimits.formats.xlsx",
  ".pptx": "admin.uploadLimits.formats.pptx",
  ".doc": "admin.uploadLimits.formats.doc",
  ".xls": "admin.uploadLimits.formats.xls",
  ".ppt": "admin.uploadLimits.formats.ppt",
};

interface UploadLimitsFormState {
  readonly maxFileSizeMbInput: string;
  readonly allowedExtensions: readonly string[];
  readonly enforceDeclaredExtensionMatch: boolean;
}

function bytesToMegabytesText(bytes: number): string {
  const mb = bytes / BYTES_PER_MIB;
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(2);
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
 * allowed extensions.
 */
export function UploadLimitsSettingsSection() {
  const { t, formatBytes } = useI18n();
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
    return <LoadingState message={t("admin.uploadLimits.loading")} minHeight={120} />;
  }

  if (limitsQuery.isError) {
    return (
      <ErrorState
        title={t("admin.uploadLimits.loadErrorTitle")}
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
        message: t("admin.uploadLimits.validation.minSize"),
      });
      return;
    }

    if (parsedSizeBytes > ceilingBytes) {
      setFeedback({
        severity: "error",
        message: t("admin.uploadLimits.validation.exceedsServerLimit", {
          requested: formatBytes(parsedSizeBytes),
          limit: formatBytes(ceilingBytes),
        }),
      });
      return;
    }

    if (form.allowedExtensions.length === 0) {
      setFeedback({
        severity: "error",
        message: t("admin.uploadLimits.validation.selectExtension"),
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
        message: t("admin.uploadLimits.feedback.saved"),
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        message: error instanceof Error ? error.message : t("admin.uploadLimits.errors.saveFailed"),
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
        borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        backgroundColor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Stack spacing={2.5}>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <CloudUploadOutlinedIcon color="primary" />
          <Box>
            <Typography variant="h6" fontWeight={600}>
              {t("admin.uploadLimits.title")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("admin.uploadLimits.subtitle")}
            </Typography>
          </Box>
        </Stack>

        {feedback ? (
          <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
            {feedback.message}
          </Alert>
        ) : null}

        <Alert severity="info">
          {t("admin.uploadLimits.serverLimitAlert", {
            limit: formatBytes(data.effective.effectiveMaxWithProxyBytes),
          })}
        </Alert>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label={t("admin.uploadLimits.maxFileSizeLabel")}
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
                  ? t("admin.uploadLimits.maxFileSizeHelper", {
                      size: formatBytes(parsedSizeBytes),
                    })
                  : t("admin.uploadLimits.maxFileSizeInvalidHelper")
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
              label={t("admin.uploadLimits.verifyContentSwitch")}
            />
          </Grid>
        </Grid>

        <Divider />

        <Stack spacing={1.25}>
          <Typography variant="subtitle2" fontWeight={600}>
            {t("admin.uploadLimits.allowedExtensionsCount", {
              count: form.allowedExtensions.length,
            })}
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {data.supportedCatalog.map((entry) => {
              const selected = form.allowedExtensions.includes(entry.extension);
              const labelKey = FORMAT_LABEL_KEYS[entry.extension.toLowerCase()];
              return (
                <Chip
                  key={entry.extension}
                  label={labelKey ? t(labelKey) : entry.label}
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
            {t("admin.common.discardChanges")}
          </Button>
          <Button
            type="submit"
            variant="contained"
            startIcon={<SaveOutlinedIcon />}
            disabled={!data.canEdit || !hasChanges || updateMutation.isPending}
          >
            {updateMutation.isPending ? t("admin.common.saving") : t("admin.uploadLimits.submit")}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
