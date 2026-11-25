import { Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useI18n } from "../i18n/index.js";

export interface RouteLoadingFallbackProps {
  readonly fullPage?: boolean | undefined;
}

/**
 * Accessible centered loading spinner displayed while lazy-loaded route chunks
 * are fetched on navigation.
 */
export function RouteLoadingFallback({ fullPage = false }: RouteLoadingFallbackProps) {
  const { t } = useI18n();
  const label = t("shell.routeLoading");

  return (
    <Box
      component="output"
      aria-live="polite"
      aria-busy="true"
      sx={{
        minHeight: fullPage ? "100vh" : 280,
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 3,
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center">
        <CircularProgress size={24} aria-label={label} />
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </Stack>
    </Box>
  );
}
