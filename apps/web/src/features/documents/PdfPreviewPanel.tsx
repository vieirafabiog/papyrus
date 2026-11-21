import {
  CONTRACTS_API_PREFIX,
  type DocumentDetail,
  apiErrorResponseSchema,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, ErrorState, LoadingState } from "@docuflow/ui";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import { Alert, Box, Button, Divider, Paper, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";

export interface PdfPreviewPanelProps {
  readonly document: DocumentDetail;
  readonly versionId?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
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
  return `Não foi possível carregar a pré-visualização do PDF (${response.status}).`;
}

/**
 * Authorized PDF preview viewer that fetches authenticated stream responses into
 * short-lived object URLs, enforces quarantine gates, and cleans up memory on unmount.
 */
export function PdfPreviewPanel({ document, versionId, fetchFn }: PdfPreviewPanelProps) {
  const fileObject = document.currentVersion?.fileObject ?? null;
  const isAvailable = fileObject?.status === "AVAILABLE";
  const isPdf = fileObject?.detectedContentType.toLowerCase() === "application/pdf";
  const canFetchPdf = Boolean(fileObject && isAvailable && isPdf);

  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const fetchImpl = fetchFn ?? globalThis.fetch;

  useEffect(() => {
    if (!canFetchPdf || reloadToken < 0) {
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

    const querySuffix = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
    const url = `${CONTRACTS_API_PREFIX}/documents/${document.id}/preview${querySuffix}`;

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
          error instanceof Error ? error.message : "Erro ao carregar a pré-visualização do PDF.",
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
  }, [canFetchPdf, document.id, versionId, reloadToken, fetchImpl]);

  if (!fileObject) {
    return null;
  }

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
            <PictureAsPdfOutlinedIcon color="primary" fontSize="small" />
            <Box>
              <Typography variant="h6" component="h2">
                Pré-visualização do documento
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Entrega privada autenticada com bloqueio de cache público.
              </Typography>
            </Box>
          </Stack>

          {canFetchPdf ? (
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
        ) : !isPdf ? (
          <Alert severity="info">
            A pré-visualização inline em PDF está disponível apenas para documentos com tipo{" "}
            <strong>application/pdf</strong>. Tipo atual:{" "}
            <strong>{fileObject.detectedContentType}</strong>.
          </Alert>
        ) : loading ? (
          <LoadingState message="Carregando pré-visualização segura do PDF..." />
        ) : errorMessage ? (
          <ErrorState
            title="Não foi possível carregar o PDF"
            description={errorMessage}
            onRetry={() => setReloadToken((prev) => prev + 1)}
          />
        ) : blobUrl ? (
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
        ) : null}
      </Stack>
    </Paper>
  );
}
