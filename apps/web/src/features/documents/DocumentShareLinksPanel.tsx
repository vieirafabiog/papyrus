import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import LinkOffOutlinedIcon from "@mui/icons-material/LinkOffOutlined";
import LinkOutlinedIcon from "@mui/icons-material/LinkOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import ShareOutlinedIcon from "@mui/icons-material/ShareOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  type DocumentShareLinkRecord,
  type DocumentShareLinkStatus,
  type DocumentStatus,
  MAX_SHARE_LINK_MAX_USES,
  MIN_SHARE_PASSCODE_LENGTH,
} from "@papyrus/contracts";
import { ConfirmDialog, ErrorState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { type FormEvent, useId, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import {
  useCreateDocumentShareLinkMutation,
  useDocumentShareLinksQuery,
  useRevokeDocumentShareLinkMutation,
} from "./useDocumentShareLinks.js";

export interface DocumentShareLinksPanelProps {
  readonly documentId: string;
  readonly documentStatus: DocumentStatus;
  readonly hasAvailableFile: boolean;
  readonly canDownload: boolean;
}

const SHARE_STATUS_COLOR: Readonly<
  Record<DocumentShareLinkStatus, "success" | "warning" | "error" | "default">
> = {
  ACTIVE: "success",
  EXPIRED: "warning",
  REVOKED: "error",
  EXHAUSTED: "default",
};

const TTL_PRESETS = [
  { minutes: 15, labelKey: "documents.share.ttl15m" },
  { minutes: 60, labelKey: "documents.share.ttl1h" },
  { minutes: 1440, labelKey: "documents.share.ttl24h" },
  { minutes: 10080, labelKey: "documents.share.ttl7d" },
  { minutes: 43200, labelKey: "documents.share.ttl30d" },
] as const;

function buildSharePublicUrl(shareToken: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "";
  return `${origin}/share/${encodeURIComponent(shareToken)}`;
}

/**
 * Manages temporary cryptographic share links on a document: creation with
 * bounded expiration, max-use limits, optional Argon2id passcode, download gating,
 * one-time URL reveal, and instant revocation.
 */
export function DocumentShareLinksPanel({
  documentId,
  documentStatus,
  hasAvailableFile,
  canDownload,
}: DocumentShareLinksPanelProps) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const ttlLabelId = useId();

  const [createOpen, setCreateOpen] = useState(false);
  const [expiresInMinutes, setExpiresInMinutes] = useState<number>(1440);
  const [maxUsesInput, setMaxUsesInput] = useState("");
  const [label, setLabel] = useState("");
  const [passcode, setPasscode] = useState("");
  const [allowDownload, setAllowDownload] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const [oneTimeUrl, setOneTimeUrl] = useState<string | null>(null);
  const [copiedOneTime, setCopiedOneTime] = useState(false);
  const [linkToRevoke, setLinkToRevoke] = useState<DocumentShareLinkRecord | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const isDeleted = documentStatus === "DELETED";
  const canManageShareLinks = canDownload && !isDeleted;

  const listQuery = useDocumentShareLinksQuery(documentId, canManageShareLinks);
  const createMutation = useCreateDocumentShareLinkMutation(documentId);
  const revokeMutation = useRevokeDocumentShareLinkMutation(documentId);

  if (!canDownload) {
    return null;
  }

  const openCreateDialog = (): void => {
    setFormError(null);
    setExpiresInMinutes(1440);
    setMaxUsesInput("");
    setLabel("");
    setPasscode("");
    setAllowDownload(true);
    setCreateOpen(true);
  };

  const handleSubmitCreate = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFormError(null);

    let parsedMaxUses: number | null = null;
    if (maxUsesInput.trim().length > 0) {
      const numeric = Number(maxUsesInput.trim());
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_SHARE_LINK_MAX_USES) {
        setFormError(t("documents.share.maxUsesHelper"));
        return;
      }
      parsedMaxUses = numeric;
    }

    if (passcode.length > 0 && passcode.length < MIN_SHARE_PASSCODE_LENGTH) {
      setFormError(t("documents.share.passcodeHelper"));
      return;
    }

    try {
      const result = await createMutation.mutateAsync({
        expiresInMinutes,
        maxUses: parsedMaxUses,
        allowDownload,
        passcode: passcode.length > 0 ? passcode : null,
        label: label.trim().length > 0 ? label.trim() : null,
      });
      setCreateOpen(false);
      setOneTimeUrl(buildSharePublicUrl(result.shareToken));
      setCopiedOneTime(false);
      setFeedback(null);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : t("documents.share.errors.createFailed"),
      );
    }
  };

  const handleCopyOneTime = async (): Promise<void> => {
    if (!oneTimeUrl) {
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(oneTimeUrl);
      setCopiedOneTime(true);
    }
  };

  const handleConfirmRevoke = async (): Promise<void> => {
    if (!linkToRevoke) {
      return;
    }
    try {
      await revokeMutation.mutateAsync(linkToRevoke.id);
      setLinkToRevoke(null);
      setFeedback({
        severity: "success",
        message: t("documents.share.revokeSuccess"),
      });
    } catch (error) {
      setLinkToRevoke(null);
      setFeedback({
        severity: "error",
        message: error instanceof Error ? error.message : t("documents.share.errors.revokeFailed"),
      });
    }
  };

  const links = listQuery.data ?? [];

  return (
    <Paper
      component="section"
      aria-label={t("documents.share.heading")}
      variant="outlined"
      sx={{
        p: 2.5,
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
      }}
    >
      <Stack spacing={2}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1.5,
            flexWrap: "wrap",
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <ShareOutlinedIcon color="primary" fontSize="small" />
            <Box>
              <Typography variant="h6" component="h2">
                {t("documents.share.heading")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("documents.share.subtitle")}
              </Typography>
            </Box>
          </Stack>

          <Button
            size="small"
            variant="outlined"
            startIcon={<LinkOutlinedIcon />}
            onClick={openCreateDialog}
            disabled={isDeleted || !hasAvailableFile}
          >
            {t("documents.share.createButton")}
          </Button>
        </Box>

        <Divider />

        {isDeleted ? (
          <Alert severity="info">{t("documents.share.disabledDeleted")}</Alert>
        ) : !hasAvailableFile ? (
          <Alert severity="info">{t("documents.share.disabledNoFile")}</Alert>
        ) : null}

        {feedback ? (
          <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
            {feedback.message}
          </Alert>
        ) : null}

        {oneTimeUrl ? (
          <Alert
            severity="warning"
            sx={{
              bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
              border: `1px solid ${PAPYRUS_COLOR_TOKENS.primary.main}`,
            }}
          >
            <Stack spacing={1.25}>
              <Typography variant="subtitle2" fontWeight={600}>
                {t("documents.share.oneTimeTitle")}
              </Typography>
              <Typography variant="body2">{t("documents.share.oneTimeWarning")}</Typography>
              <TextField
                value={oneTimeUrl}
                size="small"
                fullWidth
                slotProps={{
                  input: { readOnly: true },
                  htmlInput: { "aria-label": t("documents.share.oneTimeTitle") },
                }}
              />
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<ContentCopyOutlinedIcon />}
                  onClick={() => void handleCopyOneTime()}
                >
                  {copiedOneTime ? t("documents.share.copiedLink") : t("documents.share.copyLink")}
                </Button>
                <Button
                  size="small"
                  variant="text"
                  onClick={() => {
                    setOneTimeUrl(null);
                    setCopiedOneTime(false);
                  }}
                >
                  {t("documents.share.dismissOneTime")}
                </Button>
              </Stack>
            </Stack>
          </Alert>
        ) : null}

        {!canManageShareLinks ? null : listQuery.isLoading ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">
              {t("documents.share.loading")}
            </Typography>
          </Stack>
        ) : listQuery.isError ? (
          <ErrorState
            title={t("documents.share.errors.loadFailed")}
            description={listQuery.error.message}
            onRetry={() => void listQuery.refetch()}
          />
        ) : links.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("documents.share.empty")}
          </Typography>
        ) : (
          <Stack spacing={1.25}>
            {links.map((link) => (
              <Paper
                key={link.id}
                variant="outlined"
                sx={{
                  p: 1.5,
                  bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                  borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 1.5,
                    flexWrap: "wrap",
                  }}
                >
                  <Stack spacing={0.75} sx={{ minWidth: 0 }}>
                    <Stack
                      direction="row"
                      spacing={0.75}
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Typography variant="body2" fontWeight={600}>
                        {link.label ||
                          t("documents.share.expiresAt", { date: formatDateTime(link.expiresAt) })}
                      </Typography>
                      <Chip
                        size="small"
                        color={SHARE_STATUS_COLOR[link.status]}
                        label={t(`documents.share.status.${link.status}`)}
                      />
                      <Chip
                        size="small"
                        variant="outlined"
                        icon={link.requiresPasscode ? <LockOutlinedIcon /> : undefined}
                        label={
                          link.requiresPasscode
                            ? t("documents.share.badge.passcode")
                            : t("documents.share.badge.noPasscode")
                        }
                      />
                      <Chip
                        size="small"
                        variant="outlined"
                        icon={!link.allowDownload ? <VisibilityOutlinedIcon /> : undefined}
                        label={
                          link.allowDownload
                            ? t("documents.share.badge.downloadAllowed")
                            : t("documents.share.badge.previewOnly")
                        }
                      />
                    </Stack>

                    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" color="text.secondary">
                        {link.maxUses !== null
                          ? t("documents.share.usesLabel", {
                              used: formatNumber(link.useCount),
                              max: formatNumber(link.maxUses),
                            })
                          : t("documents.share.usesUnlimited", {
                              used: formatNumber(link.useCount),
                            })}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {t("documents.share.expiresAt", { date: formatDateTime(link.expiresAt) })}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {link.lastAccessedAt
                          ? t("documents.share.lastAccess", {
                              date: formatDateTime(link.lastAccessedAt),
                            })
                          : t("documents.share.neverAccessed")}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {t("documents.share.createdBy", { name: link.createdBy.fullName })}
                      </Typography>
                    </Stack>
                  </Stack>

                  {link.status === "ACTIVE" ? (
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<LinkOffOutlinedIcon />}
                      disabled={revokeMutation.isPending}
                      onClick={() => setLinkToRevoke(link)}
                    >
                      {t("documents.share.revokeAction")}
                    </Button>
                  ) : null}
                </Box>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>

      <Dialog
        open={createOpen}
        onClose={createMutation.isPending ? undefined : () => setCreateOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <form onSubmit={(event) => void handleSubmitCreate(event)}>
          <DialogTitle>{t("documents.share.dialogTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 0.5 }}>
              <DialogContentText>{t("documents.share.dialogDescription")}</DialogContentText>

              {formError ? <Alert severity="error">{formError}</Alert> : null}

              <FormControl fullWidth size="small">
                <InputLabel id={ttlLabelId}>{t("documents.share.ttlLabel")}</InputLabel>
                <Select
                  labelId={ttlLabelId}
                  label={t("documents.share.ttlLabel")}
                  value={expiresInMinutes}
                  onChange={(event) => setExpiresInMinutes(Number(event.target.value))}
                  disabled={createMutation.isPending}
                >
                  {TTL_PRESETS.map((preset) => (
                    <MenuItem key={preset.minutes} value={preset.minutes}>
                      {t(preset.labelKey)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                label={t("documents.share.maxUsesLabel")}
                helperText={t("documents.share.maxUsesHelper")}
                type="number"
                size="small"
                fullWidth
                value={maxUsesInput}
                onChange={(event) => setMaxUsesInput(event.target.value)}
                disabled={createMutation.isPending}
                inputProps={{ min: 1, max: MAX_SHARE_LINK_MAX_USES }}
              />

              <TextField
                label={t("documents.share.passcodeField")}
                helperText={t("documents.share.passcodeHelper")}
                type="password"
                size="small"
                fullWidth
                value={passcode}
                onChange={(event) => setPasscode(event.target.value)}
                disabled={createMutation.isPending}
              />

              <TextField
                label={t("documents.share.labelField")}
                placeholder={t("documents.share.labelPlaceholder")}
                size="small"
                fullWidth
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                disabled={createMutation.isPending}
                inputProps={{ maxLength: 120 }}
              />

              <FormControlLabel
                control={
                  <Switch
                    checked={allowDownload}
                    onChange={(event) => setAllowDownload(event.target.checked)}
                    disabled={createMutation.isPending}
                  />
                }
                label={t("documents.share.allowDownloadSwitch")}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={createMutation.isPending}
            >
              {t("documents.common.cancel")}
            </Button>
            <Button type="submit" variant="contained" disabled={createMutation.isPending}>
              {createMutation.isPending
                ? t("documents.share.submitting")
                : t("documents.share.submit")}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <ConfirmDialog
        open={linkToRevoke !== null}
        title={t("documents.share.revokeDialogTitle")}
        description={t("documents.share.revokeDialogDescription")}
        confirmLabel={t("documents.share.revokeAction")}
        confirmColor="error"
        loading={revokeMutation.isPending}
        onCancel={() => setLinkToRevoke(null)}
        onConfirm={() => void handleConfirmRevoke()}
      />
    </Paper>
  );
}
