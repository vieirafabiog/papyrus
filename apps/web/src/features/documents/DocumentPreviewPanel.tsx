import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";
import DataObjectOutlinedIcon from "@mui/icons-material/DataObjectOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import OpenInFullOutlinedIcon from "@mui/icons-material/OpenInFullOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  Dialog,
  Divider,
  IconButton,
  Paper,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import {
  CONTRACTS_API_PREFIX,
  type DocumentDetail,
  type DocumentDetailVersion,
  type DocumentVersionHistoryItem,
  apiErrorResponseSchema,
} from "@papyrus/contracts";
import { ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { Suspense, lazy, useEffect, useState } from "react";
import { containsTechnicalJargon, getLocalizedApiErrorMessage } from "../../i18n/api-errors.js";
import { type UiLocale, getCurrentUiLocale, translate, useI18n } from "../../i18n/index.js";
import { requestVersionDownloadTarget } from "./useDocumentDetails.js";
import { CsvPreviewViewer } from "./viewers/CsvPreviewViewer.js";
import { ImagePreviewViewer } from "./viewers/ImagePreviewViewer.js";
import { JsonPreviewViewer } from "./viewers/JsonPreviewViewer.js";
import { MarkdownPreviewViewer } from "./viewers/MarkdownPreviewViewer.js";
import { TextPreviewViewer } from "./viewers/TextPreviewViewer.js";
import {
  ALLOWED_IMAGE_PREVIEW_MIME_TYPES,
  ALLOWED_OFFICE_PDF_PREVIEW_MIME_TYPES,
  ALLOWED_SPREADSHEET_PREVIEW_MIME_TYPES,
  ALLOWED_TEXT_PREVIEW_MIME_TYPES,
  DEFAULT_MAX_IMAGE_PREVIEW_BYTES,
  DEFAULT_MAX_OFFICE_PREVIEW_BYTES,
  DEFAULT_MAX_SPREADSHEET_PREVIEW_BYTES,
  DEFAULT_MAX_TEXT_PREVIEW_BYTES,
  type DocumentPreviewKind,
  isBinaryBufferPreviewKind,
  isPdfPreviewKind,
  isTextPreviewKind,
  resolveDocumentPreviewKind,
} from "./viewers/preview-formats.js";

const LazyXlsxPreviewViewer = lazy(() => import("./viewers/XlsxPreviewViewer.js"));
const LazyTiffPreviewViewer = lazy(() => import("./viewers/TiffPreviewViewer.js"));

export {
  ALLOWED_IMAGE_PREVIEW_MIME_TYPES,
  ALLOWED_OFFICE_PDF_PREVIEW_MIME_TYPES,
  ALLOWED_SPREADSHEET_PREVIEW_MIME_TYPES,
  ALLOWED_TEXT_PREVIEW_MIME_TYPES,
  DEFAULT_MAX_IMAGE_PREVIEW_BYTES,
  DEFAULT_MAX_OFFICE_PREVIEW_BYTES,
  DEFAULT_MAX_SPREADSHEET_PREVIEW_BYTES,
  DEFAULT_MAX_TEXT_PREVIEW_BYTES,
  resolveDocumentPreviewKind,
  type DocumentPreviewKind,
};

export interface PreviewFileDescriptor {
  readonly originalFileName: string;
  readonly detectedContentType: string;
  readonly sizeBytes: number;
  readonly status:
    | "UPLOADING"
    | "QUARANTINED"
    | "AVAILABLE"
    | "REJECTED"
    | "MISSING"
    | "DELETE_PENDING";
}

export interface DocumentPreviewPanelProps {
  readonly document?: DocumentDetail | undefined;
  readonly previewFile?: PreviewFileDescriptor | undefined;
  readonly versionId?: string | undefined;
  readonly targetVersion?: DocumentDetailVersion | DocumentVersionHistoryItem | null | undefined;
  readonly onResetToCurrentVersion?: (() => void) | undefined;
  readonly maxImageBytes?: number | undefined;
  readonly maxTextBytes?: number | undefined;
  readonly maxSpreadsheetBytes?: number | undefined;
  readonly maxOfficeBytes?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly contentUrlOverride?: string | undefined;
  readonly requestHeaders?: Readonly<Record<string, string>> | undefined;
  readonly allowDownloadOverride?: boolean | undefined;
  readonly allowOpenInNewTab?: boolean | undefined;
  readonly onDownload?: (() => Promise<void> | void) | undefined;
}

async function extractPreviewErrorMessage(
  response: Response,
  previewKind: DocumentPreviewKind,
  locale: UiLocale = getCurrentUiLocale(),
): Promise<string> {
  const tooLargeKey =
    previewKind === "image" || previewKind === "tiff"
      ? "documents.preview.imageTooLargeError"
      : "documents.preview.fileTooLargeError";

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
        return translate(tooLargeKey, undefined, locale);
      }
      if (parsed.data.error.code === "PREVIEW_CONVERTER_UNAVAILABLE") {
        return translate("documents.preview.officeConverterUnavailable", undefined, locale);
      }
      if (parsed.data.error.code === "PREVIEW_CONVERSION_FAILED") {
        return translate("documents.preview.officeConversionFailed", undefined, locale);
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
    return translate(tooLargeKey, undefined, locale);
  }
  return translate("documents.preview.loadFailed", undefined, locale);
}

/**
 * Unified authorized preview viewer supporting PDFs, Word/PowerPoint (converted to read-only PDF),
 * raster images with zoom/rotation (PNG, JPEG, WebP, GIF, BMP, multi-page TIFF), native read-only
 * Excel spreadsheets (.xlsx), CSV tables, formatted JSON, plain text/logs, and safe Markdown,
 * with a universal fullscreen expand modal across all formats.
 */
export function DocumentPreviewPanel({
  document,
  previewFile,
  versionId,
  targetVersion,
  onResetToCurrentVersion,
  maxImageBytes = DEFAULT_MAX_IMAGE_PREVIEW_BYTES,
  maxTextBytes = DEFAULT_MAX_TEXT_PREVIEW_BYTES,
  maxSpreadsheetBytes = DEFAULT_MAX_SPREADSHEET_PREVIEW_BYTES,
  maxOfficeBytes = DEFAULT_MAX_OFFICE_PREVIEW_BYTES,
  fetchFn,
  contentUrlOverride,
  requestHeaders,
  allowDownloadOverride,
  allowOpenInNewTab = true,
  onDownload,
}: DocumentPreviewPanelProps) {
  const { locale, t, formatBytes } = useI18n();
  const effectiveVersion = targetVersion ?? document?.currentVersion ?? null;
  const fileObject = previewFile ?? effectiveVersion?.fileObject ?? null;
  const canDownloadEffectiveVersion =
    allowDownloadOverride ??
    (targetVersion && "permissions" in targetVersion
      ? targetVersion.permissions.canDownload
      : (document?.permissions.canDownload ?? false));
  const isViewingHistoricalVersion = Boolean(
    effectiveVersion &&
      document?.currentVersionId &&
      effectiveVersion.id !== document.currentVersionId,
  );
  const explicitQueryVersionId =
    versionId ?? (isViewingHistoricalVersion ? effectiveVersion?.id : undefined);
  const detectedMime = fileObject?.detectedContentType.toLowerCase() ?? "";
  const isAvailable = fileObject?.status === "AVAILABLE";
  const previewKind = fileObject
    ? resolveDocumentPreviewKind(detectedMime, fileObject.originalFileName)
    : "unsupported";

  const isPdfLike = isPdfPreviewKind(previewKind);
  const isImage = previewKind === "image";
  const isTiff = previewKind === "tiff";
  const isXlsx = previewKind === "xlsx";
  const isTextLike = isTextPreviewKind(previewKind);
  const isBinaryBuffer = isBinaryBufferPreviewKind(previewKind);

  const isOversizedImage = Boolean(
    fileObject && (isImage || isTiff) && fileObject.sizeBytes > maxImageBytes,
  );
  const isOversizedText = Boolean(fileObject && isTextLike && fileObject.sizeBytes > maxTextBytes);
  const isOversizedSpreadsheet = Boolean(
    fileObject && isXlsx && fileObject.sizeBytes > maxSpreadsheetBytes,
  );
  const isOversizedOffice = Boolean(
    fileObject && previewKind === "office-pdf" && fileObject.sizeBytes > maxOfficeBytes,
  );

  const isOversized =
    isOversizedImage || isOversizedText || isOversizedSpreadsheet || isOversizedOffice;

  const canFetchPreview = Boolean(
    fileObject && isAvailable && previewKind !== "unsupported" && !isOversized,
  );

  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [binaryBuffer, setBinaryBuffer] = useState<ArrayBuffer | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const fetchImpl = fetchFn ?? globalThis.fetch;

  useEffect(() => {
    if (!canFetchPreview || reloadToken < 0) {
      setLoading(false);
      setErrorMessage(null);
      setBlobUrl(null);
      setTextContent(null);
      setBinaryBuffer(null);
      return;
    }

    const controller = new AbortController();
    let activeObjectUrl: string | null = null;
    let cancelled = false;

    setLoading(true);
    setErrorMessage(null);
    setBlobUrl(null);
    setTextContent(null);
    setBinaryBuffer(null);

    const endpoint = isPdfLike ? "preview" : "content";
    const querySuffix = explicitQueryVersionId
      ? `?versionId=${encodeURIComponent(explicitQueryVersionId)}`
      : "";
    const url =
      contentUrlOverride ??
      `${CONTRACTS_API_PREFIX}/documents/${document?.id ?? ""}/${endpoint}${querySuffix}`;

    void fetchImpl(url, {
      method: "GET",
      credentials: "include",
      ...(requestHeaders ? { headers: requestHeaders } : {}),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await extractPreviewErrorMessage(response, previewKind, locale));
        }

        if (isTextLike) {
          const decoded = await response.text();
          if (cancelled) {
            return;
          }
          setTextContent(decoded);
          setLoading(false);
          return;
        }

        if (isBinaryBuffer) {
          const arrayBuffer = await response.arrayBuffer();
          if (cancelled) {
            return;
          }
          setBinaryBuffer(arrayBuffer);
          setLoading(false);
          return;
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
        setTextContent(null);
        setBinaryBuffer(null);
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
  }, [
    canFetchPreview,
    isPdfLike,
    isTextLike,
    isBinaryBuffer,
    previewKind,
    document?.id,
    contentUrlOverride,
    requestHeaders,
    explicitQueryVersionId,
    reloadToken,
    fetchImpl,
    locale,
  ]);

  if (!fileObject) {
    return null;
  }

  const handleFallbackDownload = async (): Promise<void> => {
    const downloadVersionId = effectiveVersion?.id ?? document?.currentVersion?.id;
    if (!onDownload && (!document?.id || !downloadVersionId)) {
      return;
    }
    setDownloading(true);
    setDownloadError(null);
    try {
      if (onDownload) {
        await onDownload();
      } else if (document?.id && downloadVersionId) {
        const result = await requestVersionDownloadTarget(document.id, downloadVersionId);
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

        {canDownloadEffectiveVersion ? (
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

  const headerIcon = isPdfLike ? (
    <PictureAsPdfOutlinedIcon color="primary" fontSize="small" />
  ) : isImage || isTiff ? (
    <ImageOutlinedIcon color="primary" fontSize="small" />
  ) : previewKind === "csv" || isXlsx ? (
    <TableChartOutlinedIcon color="primary" fontSize="small" />
  ) : previewKind === "json" ? (
    <DataObjectOutlinedIcon color="primary" fontSize="small" />
  ) : previewKind === "markdown" ? (
    <ArticleOutlinedIcon color="primary" fontSize="small" />
  ) : previewKind === "text" ? (
    <DescriptionOutlinedIcon color="primary" fontSize="small" />
  ) : (
    <InsertDriveFileOutlinedIcon color="primary" fontSize="small" />
  );

  const loadingMessage =
    previewKind === "office-pdf"
      ? t("documents.preview.convertingOfficePdf")
      : isPdfLike
        ? t("documents.preview.loadingPdf")
        : isImage || isTiff
          ? t("documents.preview.loadingImage")
          : isXlsx
            ? t("documents.preview.loadingSpreadsheet")
            : t("documents.preview.loadingText");

  const errorTitle = isPdfLike
    ? t("documents.preview.pdfErrorTitle")
    : isImage || isTiff
      ? t("documents.preview.imageErrorTitle")
      : t("documents.preview.textErrorTitle");

  const hasLoadedPreview = Boolean(
    !loading &&
      !errorMessage &&
      ((isTextLike && textContent !== null) ||
        (isBinaryBuffer && binaryBuffer !== null) ||
        blobUrl !== null),
  );

  const renderViewerBody = (isExpanded: boolean) => {
    if (isTextLike && textContent !== null) {
      if (previewKind === "csv") {
        return <CsvPreviewViewer content={textContent} expanded={isExpanded} />;
      }
      if (previewKind === "json") {
        return <JsonPreviewViewer content={textContent} expanded={isExpanded} />;
      }
      if (previewKind === "markdown") {
        return <MarkdownPreviewViewer content={textContent} expanded={isExpanded} />;
      }
      return <TextPreviewViewer content={textContent} expanded={isExpanded} />;
    }

    if (isXlsx && binaryBuffer !== null) {
      return (
        <Suspense fallback={<LoadingState message={t("documents.preview.loadingSpreadsheet")} />}>
          <LazyXlsxPreviewViewer buffer={binaryBuffer} expanded={isExpanded} />
        </Suspense>
      );
    }

    if (isTiff && binaryBuffer !== null) {
      return (
        <Suspense fallback={<LoadingState message={t("documents.preview.loadingImage")} />}>
          <LazyTiffPreviewViewer
            buffer={binaryBuffer}
            fileName={fileObject.originalFileName}
            expanded={isExpanded}
          />
        </Suspense>
      );
    }

    if (blobUrl) {
      if (isPdfLike) {
        return (
          <Box
            component="iframe"
            title={t("documents.preview.pdfFrameTitle", {
              fileName: fileObject.originalFileName,
            })}
            src={blobUrl}
            sx={{
              width: "100%",
              height: isExpanded ? "calc(100vh - 108px)" : 560,
              border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
              borderRadius: 1,
              bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
            }}
          />
        );
      }

      return (
        <ImagePreviewViewer
          src={blobUrl}
          alt={t("documents.preview.imageAlt", {
            fileName: fileObject.originalFileName,
          })}
          expanded={isExpanded}
        />
      );
    }

    return null;
  };

  return (
    <>
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
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              {headerIcon}
              <Box>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Typography variant="h6" component="h2">
                    {t("documents.preview.title")}
                  </Typography>
                  {isViewingHistoricalVersion && effectiveVersion ? (
                    <Chip
                      size="small"
                      color="secondary"
                      variant="outlined"
                      label={t("documents.details.versionBadge", {
                        version: effectiveVersion.versionNumber,
                      })}
                    />
                  ) : null}
                  {previewKind === "office-pdf" ? (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={t("documents.preview.convertedPdfBadge")}
                    />
                  ) : null}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {t("documents.preview.subtitle")}
                </Typography>
              </Box>
            </Stack>

            {canFetchPreview ? (
              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<RefreshOutlinedIcon />}
                  disabled={loading}
                  onClick={() => setReloadToken((prev) => prev + 1)}
                >
                  {t("documents.preview.refresh")}
                </Button>
                {hasLoadedPreview ? (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<OpenInFullOutlinedIcon />}
                    onClick={() => setExpanded(true)}
                  >
                    {t("documents.preview.expand")}
                  </Button>
                ) : null}
                {blobUrl && allowOpenInNewTab ? (
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

          {isViewingHistoricalVersion && effectiveVersion ? (
            <Alert
              severity="info"
              action={
                onResetToCurrentVersion ? (
                  <Button size="small" color="inherit" onClick={onResetToCurrentVersion}>
                    {t("documents.preview.backToCurrentVersion")}
                  </Button>
                ) : null
              }
            >
              {t("documents.preview.viewingHistoricalVersion", {
                version: effectiveVersion.versionNumber,
                fileName: fileObject.originalFileName,
              })}
            </Alert>
          ) : null}

          {!isAvailable ? (
            <Alert severity="info">{t("documents.preview.pendingSecurity")}</Alert>
          ) : isOversizedImage ? (
            renderDownloadOffer(
              t("documents.preview.oversizedImage", {
                size: formatBytes(fileObject.sizeBytes),
                maxSize: formatBytes(maxImageBytes),
              }),
            )
          ) : isOversizedText ? (
            renderDownloadOffer(
              t("documents.preview.oversizedFile", {
                size: formatBytes(fileObject.sizeBytes),
                maxSize: formatBytes(maxTextBytes),
              }),
            )
          ) : isOversizedSpreadsheet ? (
            renderDownloadOffer(
              t("documents.preview.oversizedFile", {
                size: formatBytes(fileObject.sizeBytes),
                maxSize: formatBytes(maxSpreadsheetBytes),
              }),
            )
          ) : isOversizedOffice ? (
            renderDownloadOffer(
              t("documents.preview.oversizedFile", {
                size: formatBytes(fileObject.sizeBytes),
                maxSize: formatBytes(maxOfficeBytes),
              }),
            )
          ) : previewKind === "unsupported" ? (
            renderDownloadOffer(
              t("documents.preview.unsupportedFormat", {
                fileType: fileObject.detectedContentType,
              }),
            )
          ) : loading ? (
            <LoadingState message={loadingMessage} />
          ) : errorMessage ? (
            <ErrorState
              title={errorTitle}
              description={errorMessage}
              onRetry={() => setReloadToken((prev) => prev + 1)}
            />
          ) : (
            renderViewerBody(false)
          )}
        </Stack>
      </Paper>

      <Dialog
        fullScreen
        open={expanded && hasLoadedPreview}
        onClose={() => setExpanded(false)}
        aria-labelledby="papyrus-preview-expanded-title"
      >
        <AppBar
          position="sticky"
          color="default"
          elevation={0}
          sx={{
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
            borderBottom: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
          }}
        >
          <Toolbar sx={{ gap: 1.5, justifyContent: "space-between" }}>
            <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
              {headerIcon}
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  id="papyrus-preview-expanded-title"
                  variant="subtitle1"
                  fontWeight={600}
                  noWrap
                >
                  {document?.title ?? fileObject.originalFileName}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap display="block">
                  {effectiveVersion
                    ? `${t("documents.details.versionBadge", { version: effectiveVersion.versionNumber })} · `
                    : ""}
                  {fileObject.originalFileName} · {formatBytes(fileObject.sizeBytes)}
                </Typography>
              </Box>
            </Stack>

            <Stack direction="row" spacing={1} alignItems="center">
              {blobUrl && allowOpenInNewTab ? (
                <Button
                  size="small"
                  variant="outlined"
                  endIcon={<OpenInNewOutlinedIcon />}
                  onClick={() => window.open(blobUrl, "_blank", "noopener,noreferrer")}
                >
                  {t("documents.preview.openInNewTab")}
                </Button>
              ) : null}
              <IconButton
                edge="end"
                aria-label={t("documents.preview.closeExpanded")}
                onClick={() => setExpanded(false)}
              >
                <CloseOutlinedIcon />
              </IconButton>
            </Stack>
          </Toolbar>
        </AppBar>

        <Box
          sx={{
            p: 2.5,
            flex: 1,
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.background,
            overflow: "auto",
          }}
        >
          {renderViewerBody(true)}
        </Box>
      </Dialog>
    </>
  );
}
