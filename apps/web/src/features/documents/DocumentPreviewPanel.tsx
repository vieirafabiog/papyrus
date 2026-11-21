import {
  CONTRACTS_API_PREFIX,
  type DocumentDetail,
  apiErrorResponseSchema,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, ErrorState, LoadingState } from "@docuflow/ui";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import { Alert, Box, Button, Divider, Paper, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
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

function formatFileSizePtBr(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function extractPreviewErrorMessage(response: Response): Promise<string> {
  try {
    const raw: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.error.message;
    }
  } catch {
    // Fallback to HTTP status message.
  }
  if (response.status === 403) {
    return "Você não possui permissão para pré-visualizar este documento.";
  }
  if (response.status === 409) {
    return "Pré-visualização indisponível até a conclusão da análise de segurança do arquivo.";
  }
  if (response.status === 413) {
    return "A imagem excede o tamanho máximo suportado para pré-visualização no navegador.";
  }
  return `Não foi possível carregar a pré-visualização do documento (${response.status}).`;
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
          throw new Error(await extractPreviewErrorMessage(response));
        }

        const blob = await response.blob();
        if (cancelled) {
          return;
        }
        if (typeof URL.createObjectURL !== "function") {
          throw new Error("Seu navegador não suporta pré-visualização inline via Blob URL.");
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
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Erro ao carregar a pré-visualização do arquivo.",
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
  }, [canFetchPreview, isPdf, document.id, versionId, reloadToken, fetchImpl]);

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
      setDownloadError(
        error instanceof Error
          ? error.message
          : "Não foi possível iniciar o download autorizado do arquivo.",
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
          Arquivo: <strong>{fileObject.originalFileName}</strong> (
          {formatFileSizePtBr(fileObject.sizeBytes)} — {fileObject.detectedContentType})
        </Typography>

        {document.permissions.canDownload ? (
          <Button
            variant="contained"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            disabled={downloading}
            onClick={() => void handleFallbackDownload()}
          >
            {downloading ? "Preparando download..." : "Baixar arquivo"}
          </Button>
        ) : (
          <Typography variant="caption" color="text.secondary">
            Você possui permissão apenas de leitura para este documento.
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
        bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
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
                Pré-visualização do documento
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Entrega privada autenticada com bloqueio de cache público.
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
                Atualizar visualização
              </Button>
              {blobUrl ? (
                <Button
                  size="small"
                  variant="outlined"
                  endIcon={<OpenInNewOutlinedIcon />}
                  onClick={() => window.open(blobUrl, "_blank", "noopener,noreferrer")}
                >
                  Abrir em nova guia
                </Button>
              ) : null}
            </Stack>
          ) : null}
        </Box>

        <Divider />

        {!isAvailable ? (
          <Alert severity="info">
            Pré-visualização indisponível até que a análise de segurança do arquivo seja concluída
            com status disponível.
          </Alert>
        ) : isOversizedImage ? (
          renderDownloadOffer(
            `Esta imagem (${formatFileSizePtBr(fileObject.sizeBytes)}) ultrapassa o limite máximo de ${formatFileSizePtBr(maxImageBytes)} para pré-visualização inline.`,
          )
        ) : !isPdf && !isAllowedImage ? (
          renderDownloadOffer(
            `Pré-visualização inline não disponível para o formato "${fileObject.detectedContentType}". Utilize o download autorizado para consultar o conteúdo.`,
          )
        ) : loading ? (
          <LoadingState
            message={
              isPdf
                ? "Carregando pré-visualização segura do PDF..."
                : "Carregando pré-visualização segura da imagem..."
            }
          />
        ) : errorMessage ? (
          <ErrorState
            title={isPdf ? "Não foi possível carregar o PDF" : "Não foi possível carregar a imagem"}
            description={errorMessage}
            onRetry={() => setReloadToken((prev) => prev + 1)}
          />
        ) : blobUrl ? (
          isPdf ? (
            <Box
              component="iframe"
              title={`Pré-visualização do PDF: ${fileObject.originalFileName}`}
              src={blobUrl}
              sx={{
                width: "100%",
                height: 520,
                border: `1px solid ${DOCUFLOW_COLOR_TOKENS.surface.outlineVariant}`,
                borderRadius: 1,
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow,
              }}
            />
          ) : (
            <Box
              sx={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                p: 2,
                border: `1px solid ${DOCUFLOW_COLOR_TOKENS.surface.outlineVariant}`,
                borderRadius: 1,
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow,
              }}
            >
              <Box
                component="img"
                src={blobUrl}
                alt={`Pré-visualização da imagem: ${fileObject.originalFileName}`}
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
