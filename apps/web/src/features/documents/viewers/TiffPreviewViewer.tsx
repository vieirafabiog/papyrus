import ChevronLeftOutlinedIcon from "@mui/icons-material/ChevronLeftOutlined";
import ChevronRightOutlinedIcon from "@mui/icons-material/ChevronRightOutlined";
import FitScreenOutlinedIcon from "@mui/icons-material/FitScreenOutlined";
import RotateLeftOutlinedIcon from "@mui/icons-material/RotateLeftOutlined";
import RotateRightOutlinedIcon from "@mui/icons-material/RotateRightOutlined";
import ZoomInOutlinedIcon from "@mui/icons-material/ZoomInOutlined";
import ZoomOutOutlinedIcon from "@mui/icons-material/ZoomOutOutlined";
import { Alert, Box, Button, Chip, IconButton, Stack, Tooltip } from "@mui/material";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { type TiffIfd, decode } from "tiff";
import { useI18n } from "../../../i18n/index.js";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

function toRgbaPixels(page: TiffIfd): Uint8ClampedArray {
  const pixelCount = page.width * page.height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const raw = page.data;
  const components = page.components || 1;
  const bitsPerSample = page.bitsPerSample || 8;
  const maxSample = bitsPerSample === 16 ? 65535 : bitsPerSample === 1 ? 1 : 255;
  const scale = maxSample === 255 ? 1 : 255 / maxSample;
  const photometric = page.fields.get(262); // 0 = WhiteIsZero, 1 = BlackIsZero, 2 = RGB, 3 = Palette
  const palette = page.palette;

  for (let i = 0; i < pixelCount; i += 1) {
    const out = i * 4;
    if (photometric === 3 && palette) {
      const idx = Number(raw[i] ?? 0);
      const entry = palette[idx];
      rgba[out] = entry ? Math.round((entry[0] / 65535) * 255) : 0;
      rgba[out + 1] = entry ? Math.round((entry[1] / 65535) * 255) : 0;
      rgba[out + 2] = entry ? Math.round((entry[2] / 65535) * 255) : 0;
      rgba[out + 3] = 255;
      continue;
    }

    if (components === 1) {
      const val = Math.round(Number(raw[i] ?? 0) * scale);
      const gray = photometric === 0 ? 255 - val : val;
      rgba[out] = gray;
      rgba[out + 1] = gray;
      rgba[out + 2] = gray;
      rgba[out + 3] = 255;
    } else if (components === 2) {
      const val = Math.round(Number(raw[i * 2] ?? 0) * scale);
      const gray = photometric === 0 ? 255 - val : val;
      rgba[out] = gray;
      rgba[out + 1] = gray;
      rgba[out + 2] = gray;
      rgba[out + 3] = Math.round(Number(raw[i * 2 + 1] ?? maxSample) * scale);
    } else if (components === 3) {
      rgba[out] = Math.round(Number(raw[i * 3] ?? 0) * scale);
      rgba[out + 1] = Math.round(Number(raw[i * 3 + 1] ?? 0) * scale);
      rgba[out + 2] = Math.round(Number(raw[i * 3 + 2] ?? 0) * scale);
      rgba[out + 3] = 255;
    } else {
      rgba[out] = Math.round(Number(raw[i * components] ?? 0) * scale);
      rgba[out + 1] = Math.round(Number(raw[i * components + 1] ?? 0) * scale);
      rgba[out + 2] = Math.round(Number(raw[i * components + 2] ?? 0) * scale);
      rgba[out + 3] = Math.round(Number(raw[i * components + 3] ?? maxSample) * scale);
    }
  }
  return rgba;
}

export interface TiffPreviewViewerProps {
  readonly buffer: ArrayBuffer;
  readonly fileName: string;
  readonly expanded?: boolean | undefined;
}

export function TiffPreviewViewer({ buffer, fileName, expanded = false }: TiffPreviewViewerProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [rotationDeg, setRotationDeg] = useState(0);

  const decoded = useMemo(() => {
    try {
      const pages = decode(buffer);
      return { ok: true as const, pages };
    } catch {
      return { ok: false as const };
    }
  }, [buffer]);

  const safePageIndex =
    decoded.ok && decoded.pages.length > 0 ? Math.min(pageIndex, decoded.pages.length - 1) : 0;
  const activePage = decoded.ok ? (decoded.pages[safePageIndex] ?? null) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activePage) {
      return;
    }
    canvas.width = activePage.width;
    canvas.height = activePage.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const rgba = toRgbaPixels(activePage);
    const imageData = ctx.createImageData(activePage.width, activePage.height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
  }, [activePage]);

  if (!decoded.ok || !activePage) {
    return <Alert severity="error">{t("documents.preview.tiff.parseError")}</Alert>;
  }

  const totalPages = decoded.pages.length;
  const zoomPercent = Math.round(zoom * 100);

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1.5,
          flexWrap: "wrap",
        }}
      >
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
          {totalPages > 1 ? (
            <>
              <Tooltip title={t("documents.preview.tiff.previousPage")}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={t("documents.preview.tiff.previousPage")}
                    disabled={safePageIndex <= 0}
                    onClick={() => setPageIndex((prev) => Math.max(0, prev - 1))}
                  >
                    <ChevronLeftOutlinedIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Chip
                size="small"
                variant="outlined"
                label={t("documents.preview.tiff.pageIndicator", {
                  current: safePageIndex + 1,
                  total: totalPages,
                })}
              />
              <Tooltip title={t("documents.preview.tiff.nextPage")}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={t("documents.preview.tiff.nextPage")}
                    disabled={safePageIndex >= totalPages - 1}
                    onClick={() => setPageIndex((prev) => Math.min(totalPages - 1, prev + 1))}
                  >
                    <ChevronRightOutlinedIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          ) : null}

          <Chip
            size="small"
            variant="outlined"
            label={`${activePage.width} × ${activePage.height} px`}
          />
        </Stack>

        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
          <Tooltip title={t("documents.preview.zoomOut")}>
            <span>
              <IconButton
                size="small"
                aria-label={t("documents.preview.zoomOut")}
                disabled={!fitMode && zoom <= MIN_ZOOM}
                onClick={() => {
                  setFitMode(false);
                  setZoom((prev) => Math.max(MIN_ZOOM, Number((prev - ZOOM_STEP).toFixed(2))));
                }}
              >
                <ZoomOutOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Chip
            size="small"
            variant="outlined"
            label={fitMode ? t("documents.preview.fitZoom") : `${zoomPercent}%`}
            onClick={() => {
              setFitMode(true);
              setZoom(1);
            }}
          />
          <Tooltip title={t("documents.preview.zoomIn")}>
            <span>
              <IconButton
                size="small"
                aria-label={t("documents.preview.zoomIn")}
                disabled={!fitMode && zoom >= MAX_ZOOM}
                onClick={() => {
                  setFitMode(false);
                  setZoom((prev) => Math.min(MAX_ZOOM, Number((prev + ZOOM_STEP).toFixed(2))));
                }}
              >
                <ZoomInOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Button
            size="small"
            variant={fitMode ? "contained" : "outlined"}
            startIcon={<FitScreenOutlinedIcon />}
            onClick={() => {
              setFitMode(true);
              setZoom(1);
            }}
          >
            {t("documents.preview.fitToView")}
          </Button>

          {rotationDeg !== 0 ? (
            <Chip size="small" variant="outlined" label={`${rotationDeg}°`} />
          ) : null}
          <Tooltip title={t("documents.preview.rotateLeft")}>
            <IconButton
              size="small"
              aria-label={t("documents.preview.rotateLeft")}
              onClick={() => setRotationDeg((prev) => (prev + 270) % 360)}
            >
              <RotateLeftOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("documents.preview.rotateRight")}>
            <IconButton
              size="small"
              aria-label={t("documents.preview.rotateRight")}
              onClick={() => setRotationDeg((prev) => (prev + 90) % 360)}
            >
              <RotateRightOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>

      <Box
        component="section"
        aria-label={t("documents.preview.imageAlt", { fileName })}
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          overflow: "auto",
          p: 2,
          minHeight: expanded ? "calc(100vh - 190px)" : 280,
          maxHeight: expanded ? "calc(100vh - 190px)" : 520,
          border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
          borderRadius: 1,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
        }}
      >
        <Box
          component="canvas"
          ref={canvasRef}
          sx={{
            maxWidth: fitMode ? "100%" : "none",
            maxHeight: fitMode ? (expanded ? "calc(100vh - 230px)" : 480) : "none",
            width: fitMode ? "auto" : `${Math.round(activePage.width * zoom)}px`,
            height: fitMode ? "auto" : `${Math.round(activePage.height * zoom)}px`,
            display: "block",
            transform: rotationDeg !== 0 ? `rotate(${rotationDeg}deg)` : undefined,
            transformOrigin: "center center",
            transition: "transform 140ms ease",
          }}
        />
      </Box>
    </Stack>
  );
}

export default TiffPreviewViewer;
