import {
  CONTRACTS_API_PREFIX,
  type DocumentDetail,
  apiErrorResponseSchema,
} from "@docuflow/contracts";
import { ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@docuflow/ui";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import { Alert, Box, Button, Divider, Paper, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { containsTechnicalJargon, getLocalizedApiErrorMessage } from "../../i18n/api-errors.js";
import { type UiLocale, getCurrentUiLocale, translate, useI18n } from "../../i18n/index.js";
import { requestVersionDownloadTarget } from "./useDocumentDetails.js";

export const DEFAULT_MAX_IMAGE_PREVIEW_BYTES = 15 * 1024 * 1024;

export const ALLOWED_IMAGE_PREVIEW_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface DocumentPreviewPanelProps {
  readonly document: DocumentDetail;
  readonly versionId?: string | undefined;
  readonly maxImageBytes?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly onDownload?: (() => Promise<void> | void) | undefined;
}

async function extractPreviewErrorMessage(
  response: Response,
  locale: UiLocale = getCurrentUiLocale(),
): Promise<string> {
  try {
    const raw: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(raw);
    if (parsed.success) {
      if (parsed.data.error.code === "FORBIDDEN" || response.status === 403) {
        return translate("documents.preview.forbidden", undefined, locale);
      }
      if (response.status === 409) {
        return translate("documents.preview.pendingSecurity", undefined, locale);
      }
      if (response.status === 413) {
        return translate("documents.preview.imageTooLargeError", undefined, locale);
      }
      return getLocalizedApiErrorMessage(
        parsed.data.error.code,
        response.status,
        parsed.data.error.message,
        locale,
      );
    }
  } catch {
    // Non-JSON response falls through to localized status messages below.
  }

  if (response.status === 403) {
    return translate("documents.preview.forbidden", undefined, locale);
  }
  if (response.status === 409) {
    return translate("documents.preview.pendingSecurity", undefined, locale);
  }
  if (response.status === 413) {
    return translate("documents.preview.imageTooLargeError", undefined, locale);
  }
  return translate("documents.preview.loadFailed", undefined, locale);
}

/**
 * Unified authorized preview viewer supporting PDF documents and safe raster images
 * within size constraints, offering authorized download fallback for oversized or other formats.
 */
export function DocumentPreviewPanel({
  document,
  versionId,
  maxImageBytes = DEFAULT_MAX_IMAGE_PREVIEW_BYTES,
  fetchFn,
  onDownload,
}: DocumentPreviewPanelProps) {
  const { locale, t, formatBytes } = useI18n();
  const fileObject = document.currentVersion?.fileObject ?? null;
  const detectedMime = fileObject?.detectedContentType.toLowerCase() ?? "";
  const isAvailable = fileObject?.status === "AVAILABLE";
  const isPdf = detectedMime === "application/pdf";
  const isAllowedImage = ALLOWED_IMAGE_PREVIEW_MIME_TYPES.has(detectedMime);
  const isOversizedImage = Boolean(
    fileObject && isAllowedImage && fileObject.sizeBytes > maxImageBytes,
  );

  const canFetchPreview = Boolean(
    fileObject && isAvailable && (isPdf || (isAllowedImage && !isOversizedImage)),
  );

  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const fetchImpl = fetchFn ?? globalThis.fetch;

  useEffect(() => {
    if (!canFetchPreview || reloadToken < 0) {
      setLoading(false);
      setErrorMessage(null);
      setBlobUrl(null);
      return;
    }

    const controller = new AbortController();
    let activeObjectUrl: string | null = null;
    let cancelled = false;

    setLoading(true);
    setErrorMessage(null);

    const endpoint = isPdf ? "preview" : "content";
    const querySuffix = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
    const url = `${CONTRACTS_API_PREFIX}/documents/${document.id}/${endpoint}${querySuffix}`;

    void fetchImpl(url, {
      method: "GET",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await extractPreviewErrorMessage(response, locale));
        }

        const blob = await response.blob();
        if (cancelled) {
          return;
        }
        if (typeof URL.createObjectURL !== "function") {
          throw new Error(translate("documents.preview.browserUnsupported", undefined, locale));
        }

        activeObjectUrl = URL.createObjectURL(blob);
        setBlobUrl(activeObjectUrl);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof Error && error.name === "AbortError") ||
          cancelled
        ) {
          return;
        }
        setBlobUrl(null);
        const rawMessage = error instanceof Error ? error.message.trim() : "";
        setErrorMessage(
          rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
            ? rawMessage
            : translate("documents.preview.loadFailed", undefined, locale),
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (activeObjectUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(activeObjectUrl);
      }
    };
  }, [canFetchPreview, isPdf, document.id, versionId, reloadToken, fetchImpl, locale]);

  if (!fileObject) {
    return null;
  }

  const handleFallbackDownload = async (): Promise<void> => {
    if (!document.currentVersion) {
      return;
    }
    setDownloading(true);
    setDownloadError(null);
    try {
      if (onDownload) {
        await onDownload();
      } else {
        const result = await requestVersionDownloadTarget(document.id, document.currentVersion.id);
        if (result.url) {
          window.open(result.url, "_blank", "noopener,noreferrer");
        }
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setDownloadError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("documents.preview.downloadFailed"),
      );
    } finally {
      setDownloading(false);
    }
  };

  const renderDownloadOffer = (description: string) => (
    <Stack spacing={1.5}>
      <Alert severity="info" icon={<InsertDriveFileOutlinedIcon fontSize="inherit" />}>
        {description}
      </Alert>

      {downloadError ? (
        <Alert severity="error" role="alert" onClose={() => setDownloadError(null)}>
          {downloadError}
        </Alert>
      ) : null}

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {t("documents.preview.fileInfoPrefix")} <strong>{fileObject.originalFileName}</strong> (
          {formatBytes(fileObject.sizeBytes)} — {fileObject.detectedContentType})
        </Typography>

        {document.permissions.canDownload ? (
          <Button
            variant="contained"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            disabled={downloading}
            onClick={() => void handleFallbackDownload()}
          >
            {downloading
              ? t("documents.preview.preparingDownload")
              : t("documents.fileStatus.downloadFile")}
          </Button>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {t("documents.preview.readOnlyNotice")}
          </Typography>
        )}
      </Box>
    </Stack>
  );

  const headerIcon = isPdf ? (
    <PictureAsPdfOutlinedIcon color="primary" fontSize="small" />
  ) : isAllowedImage ? (
    <ImageOutlinedIcon color="primary" fontSize="small" />
  ) : (
    <InsertDriveFileOutlinedIcon color="primary" fontSize="small" />
  );

  return (
    <Paper
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
            {headerIcon}
            <Box>
              <Typography variant="h6" component="h2">
                {t("documents.preview.title")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("documents.preview.subtitle")}
              </Typography>
            </Box>
          </Stack>

          {canFetchPreview ? (
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<RefreshOutlinedIcon />}
                disabled={loading}
                onClick={() => setReloadToken((prev) => prev + 1)}
              >
                {t("documents.preview.refresh")}
              </Button>
              {blobUrl ? (
                <Button
                  size="small"
                  variant="outlined"
                  endIcon={<OpenInNewOutlinedIcon />}
                  onClick={() => window.open(blobUrl, "_blank", "noopener,noreferrer")}
                >
                  {t("documents.preview.openInNewTab")}
                </Button>
              ) : null}
            </Stack>
          ) : null}
        </Box>

        <Divider />

        {!isAvailable ? (
          <Alert severity="info">{t("documents.preview.pendingSecurity")}</Alert>
        ) : isOversizedImage ? (
          renderDownloadOffer(
            t("documents.preview.oversizedImage", {
              size: formatBytes(fileObject.sizeBytes),
              maxSize: formatBytes(maxImageBytes),
            }),
          )
        ) : !isPdf && !isAllowedImage ? (
          renderDownloadOffer(
            t("documents.preview.unsupportedFormat", {
              fileType: fileObject.detectedContentType,
            }),
          )
        ) : loading ? (
          <LoadingState
            message={
              isPdf ? t("documents.preview.loadingPdf") : t("documents.preview.loadingImage")
            }
          />
        ) : errorMessage ? (
          <ErrorState
            title={
              isPdf ? t("documents.preview.pdfErrorTitle") : t("documents.preview.imageErrorTitle")
            }
            description={errorMessage}
            onRetry={() => setReloadToken((prev) => prev + 1)}
          />
        ) : blobUrl ? (
          isPdf ? (
            <Box
              component="iframe"
              title={t("documents.preview.pdfFrameTitle", {
                fileName: fileObject.originalFileName,
              })}
              src={blobUrl}
              sx={{
                width: "100%",
                height: 520,
                border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                borderRadius: 1,
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
              }}
            />
          ) : (
            <Box
              sx={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                p: 2,
                border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                borderRadius: 1,
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
              }}
            >
              <Box
                component="img"
                src={blobUrl}
                alt={t("documents.preview.imageAlt", {
                  fileName: fileObject.originalFileName,
                })}
                sx={{
                  maxWidth: "100%",
                  maxHeight: 520,
                  objectFit: "contain",
                  display: "block",
                }}
              />
            </Box>
          )
        ) : null}
      </Stack>
    </Paper>
  );
}
