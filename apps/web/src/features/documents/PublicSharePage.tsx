import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import LinkOffOutlinedIcon from "@mui/icons-material/LinkOffOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import VerifiedUserOutlinedIcon from "@mui/icons-material/VerifiedUserOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { CONTRACTS_API_PREFIX, type PublicShareMetadata } from "@papyrus/contracts";
import { LoadingState, PAPYRUS_COLOR_TOKENS, PapyrusLogo } from "@papyrus/ui";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { extractUserErrorMessage } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";
import { DocumentPreviewPanel } from "./DocumentPreviewPanel.js";
import {
  SHARE_UNLOCK_HEADER_NAME,
  fetchPublicShareMetadata,
  unlockPublicShare,
} from "./useDocumentShareLinks.js";

/**
 * Isolated public viewer for temporary document share links (`/share/:token`).
 * Stores short-lived unlock proofs only in volatile memory, reveals zero tenant
 * or internal metadata, and delegates inline rendering to DocumentPreviewPanel.
 */
export function PublicSharePage() {
  const { token = "" } = useParams<{ token: string }>();
  const { t, formatDateTime, formatBytes, formatNumber } = useI18n();

  const [metadata, setMetadata] = useState<PublicShareMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const [unlockToken, setUnlockToken] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const previewRequestHeaders = useMemo(
    () => (unlockToken ? { [SHARE_UNLOCK_HEADER_NAME]: unlockToken } : undefined),
    [unlockToken],
  );

  const loadMetadata = useCallback(
    async (activeUnlockToken: string | null) => {
      if (!token) {
        setUnavailable(true);
        setLoading(false);
        return;
      }
      setLoading(true);
      setUnavailable(false);
      try {
        const result = await fetchPublicShareMetadata(token, activeUnlockToken);
        setMetadata(result);
        setLoading(false);
      } catch {
        setMetadata(null);
        setUnavailable(true);
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void loadMetadata(unlockToken);
  }, [loadMetadata, unlockToken]);

  const handleUnlockSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!token || passcode.length === 0) {
      return;
    }
    setUnlocking(true);
    setUnlockError(null);
    try {
      const result = await unlockPublicShare(token, passcode);
      setPasscode("");
      setUnlockToken(result.unlockToken);
    } catch (error) {
      setUnlockError(
        error instanceof Error ? error.message : t("documents.publicShare.errors.unlockFailed"),
      );
    } finally {
      setUnlocking(false);
    }
  };

  const handleDownload = async (): Promise<void> => {
    if (!token || !metadata?.allowDownload) {
      return;
    }
    setDownloading(true);
    setDownloadError(null);
    try {
      const response = await fetch(
        `${CONTRACTS_API_PREFIX}/share/${encodeURIComponent(token)}/download`,
        {
          method: "GET",
          credentials: "include",
          headers: unlockToken ? { [SHARE_UNLOCK_HEADER_NAME]: unlockToken } : {},
        },
      );
      if (!response.ok) {
        throw new Error(
          await extractUserErrorMessage(response, "documents.publicShare.errors.downloadFailed"),
        );
      }
      const blob = await response.blob();
      if (typeof URL.createObjectURL !== "function") {
        throw new Error(t("documents.preview.browserUnsupported"));
      }
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = metadata.originalFileName;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        if (typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(objectUrl);
        }
      }
    } catch (error) {
      setDownloadError(
        error instanceof Error ? error.message : t("documents.publicShare.errors.downloadFailed"),
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Box
      component="main"
      sx={{
        minHeight: "100vh",
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
        py: 4,
      }}
    >
      <Container maxWidth="lg">
        <Stack spacing={3}>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 2,
              flexWrap: "wrap",
            }}
          >
            <PapyrusLogo size="sm" />
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              icon={<VerifiedUserOutlinedIcon />}
              label={t("documents.publicShare.badge")}
            />
          </Box>

          {loading ? (
            <Paper
              variant="outlined"
              sx={{ p: 4, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}
            >
              <LoadingState message={t("documents.publicShare.loading")} />
            </Paper>
          ) : unavailable || !metadata ? (
            <Paper
              variant="outlined"
              sx={{
                p: 4,
                textAlign: "center",
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
              }}
            >
              <Stack spacing={1.5} alignItems="center" maxWidth={480} sx={{ mx: "auto" }}>
                <LinkOffOutlinedIcon color="error" fontSize="large" />
                <Typography variant="h5" component="h1">
                  {t("documents.publicShare.unavailableTitle")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("documents.publicShare.unavailableDescription")}
                </Typography>
              </Stack>
            </Paper>
          ) : metadata.requiresPasscode && !metadata.unlocked ? (
            <Paper
              variant="outlined"
              sx={{
                p: 4,
                maxWidth: 480,
                mx: "auto",
                width: "100%",
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
              }}
            >
              <Stack
                component="form"
                spacing={2}
                onSubmit={(event) => void handleUnlockSubmit(event)}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <LockOutlinedIcon color="primary" />
                  <Typography variant="h6" component="h1">
                    {t("documents.publicShare.passcodeTitle")}
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {t("documents.publicShare.passcodeDescription", { title: metadata.title })}
                </Typography>

                {unlockError ? <Alert severity="error">{unlockError}</Alert> : null}

                <TextField
                  label={t("documents.publicShare.passcodeLabel")}
                  type="password"
                  size="small"
                  fullWidth
                  autoFocus
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                  disabled={unlocking}
                />

                <Button
                  type="submit"
                  variant="contained"
                  disabled={unlocking || passcode.length === 0}
                  startIcon={
                    unlocking ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <LockOutlinedIcon />
                    )
                  }
                >
                  {unlocking
                    ? t("documents.publicShare.unlocking")
                    : t("documents.publicShare.unlockButton")}
                </Button>
              </Stack>
            </Paper>
          ) : (
            <Stack spacing={2.5}>
              <Paper
                variant="outlined"
                sx={{
                  p: 2.5,
                  bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                  borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 2,
                    flexWrap: "wrap",
                  }}
                >
                  <Stack spacing={0.75}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      <DescriptionOutlinedIcon color="primary" />
                      <Typography variant="h5" component="h1">
                        {metadata.title}
                      </Typography>
                    </Stack>
                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Typography variant="body2" color="text.secondary">
                        {metadata.originalFileName} ({formatBytes(metadata.sizeBytes)})
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={t("documents.publicShare.expiresNotice", {
                          date: formatDateTime(metadata.expiresAt),
                        })}
                      />
                      {metadata.remainingUses !== null ? (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={t("documents.publicShare.remainingUses", {
                            count: formatNumber(metadata.remainingUses),
                          })}
                        />
                      ) : null}
                    </Stack>
                  </Stack>

                  {metadata.allowDownload ? (
                    <Button
                      variant="contained"
                      startIcon={
                        downloading ? (
                          <CircularProgress size={16} color="inherit" />
                        ) : (
                          <DownloadOutlinedIcon />
                        )
                      }
                      disabled={downloading}
                      onClick={() => void handleDownload()}
                    >
                      {downloading
                        ? t("documents.publicShare.downloading")
                        : t("documents.publicShare.downloadFile")}
                    </Button>
                  ) : null}
                </Box>

                {!metadata.allowDownload ? (
                  <Alert severity="info" sx={{ mt: 2 }}>
                    {t("documents.publicShare.previewOnlyNotice")}
                  </Alert>
                ) : null}
                {downloadError ? (
                  <Alert severity="error" sx={{ mt: 2 }}>
                    {downloadError}
                  </Alert>
                ) : null}
              </Paper>

              <DocumentPreviewPanel
                previewFile={{
                  originalFileName: metadata.originalFileName,
                  detectedContentType: metadata.detectedContentType,
                  sizeBytes: metadata.sizeBytes,
                  status: "AVAILABLE",
                }}
                contentUrlOverride={`${CONTRACTS_API_PREFIX}/share/${encodeURIComponent(token)}/content`}
                requestHeaders={previewRequestHeaders}
                allowDownloadOverride={metadata.allowDownload}
                allowOpenInNewTab={metadata.allowDownload}
                onDownload={metadata.allowDownload ? handleDownload : undefined}
              />
            </Stack>
          )}
        </Stack>
      </Container>
    </Box>
  );
}
