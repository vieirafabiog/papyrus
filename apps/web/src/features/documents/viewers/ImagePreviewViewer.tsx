import FitScreenOutlinedIcon from "@mui/icons-material/FitScreenOutlined";
import RotateLeftOutlinedIcon from "@mui/icons-material/RotateLeftOutlined";
import RotateRightOutlinedIcon from "@mui/icons-material/RotateRightOutlined";
import ZoomInOutlinedIcon from "@mui/icons-material/ZoomInOutlined";
import ZoomOutOutlinedIcon from "@mui/icons-material/ZoomOutOutlined";
import { Box, Button, Chip, IconButton, Stack, Tooltip } from "@mui/material";
import { PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useState } from "react";
import { useI18n } from "../../../i18n/index.js";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

export interface ImagePreviewViewerProps {
  readonly src: string;
  readonly alt: string;
  readonly expanded?: boolean | undefined;
}

export function ImagePreviewViewer({ src, alt, expanded = false }: ImagePreviewViewerProps) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState<number>(1);
  const [fitMode, setFitMode] = useState<boolean>(true);
  const [rotationDeg, setRotationDeg] = useState<number>(0);

  const handleZoomOut = (): void => {
    setFitMode(false);
    setZoom((prev) => Math.max(MIN_ZOOM, Number((prev - ZOOM_STEP).toFixed(2))));
  };

  const handleZoomIn = (): void => {
    setFitMode(false);
    setZoom((prev) => Math.min(MAX_ZOOM, Number((prev + ZOOM_STEP).toFixed(2))));
  };

  const handleFit = (): void => {
    setFitMode(true);
    setZoom(1);
  };

  const handleRotateLeft = (): void => {
    setRotationDeg((prev) => (prev + 270) % 360);
  };

  const handleRotateRight = (): void => {
    setRotationDeg((prev) => (prev + 90) % 360);
  };

  const zoomPercent = Math.round(zoom * 100);
  const stageMaxHeight = expanded ? "calc(100vh - 180px)" : 520;

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
          <Tooltip title={t("documents.preview.zoomOut")}>
            <span>
              <IconButton
                size="small"
                aria-label={t("documents.preview.zoomOut")}
                disabled={!fitMode && zoom <= MIN_ZOOM}
                onClick={handleZoomOut}
              >
                <ZoomOutOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Chip
            size="small"
            variant="outlined"
            label={fitMode ? t("documents.preview.fitZoom") : `${zoomPercent}%`}
            onClick={handleFit}
          />
          <Tooltip title={t("documents.preview.zoomIn")}>
            <span>
              <IconButton
                size="small"
                aria-label={t("documents.preview.zoomIn")}
                disabled={!fitMode && zoom >= MAX_ZOOM}
                onClick={handleZoomIn}
              >
                <ZoomInOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Button
            size="small"
            variant={fitMode ? "contained" : "outlined"}
            startIcon={<FitScreenOutlinedIcon />}
            onClick={handleFit}
          >
            {t("documents.preview.fitToView")}
          </Button>
        </Stack>

        <Stack direction="row" spacing={0.75} alignItems="center">
          {rotationDeg !== 0 ? (
            <Chip size="small" variant="outlined" label={`${rotationDeg}°`} />
          ) : null}
          <Tooltip title={t("documents.preview.rotateLeft")}>
            <IconButton
              size="small"
              aria-label={t("documents.preview.rotateLeft")}
              onClick={handleRotateLeft}
            >
              <RotateLeftOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("documents.preview.rotateRight")}>
            <IconButton
              size="small"
              aria-label={t("documents.preview.rotateRight")}
              onClick={handleRotateRight}
            >
              <RotateRightOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>

      <Box
        component="section"
        aria-label={alt}
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          overflow: "auto",
          p: 2,
          minHeight: expanded ? "calc(100vh - 180px)" : 280,
          maxHeight: stageMaxHeight,
          border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
          borderRadius: 1,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
        }}
      >
        <Box
          component="img"
          src={src}
          alt={alt}
          sx={{
            maxWidth: fitMode ? "100%" : "none",
            maxHeight: fitMode ? (expanded ? "calc(100vh - 220px)" : 480) : "none",
            width: fitMode ? "auto" : `${zoomPercent}%`,
            objectFit: "contain",
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
