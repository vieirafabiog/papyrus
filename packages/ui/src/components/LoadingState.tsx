import { Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useUiLocale } from "../locale.js";

export interface LoadingStateProps {
  readonly message?: string | undefined;
  readonly minHeight?: number | undefined;
}

export function LoadingState({ message, minHeight = 160 }: LoadingStateProps) {
  const { messages } = useUiLocale();
  const resolvedMessage = message ?? messages.loadingState.defaultMessage;

  return (
    <Box
      component="output"
      aria-live="polite"
      sx={{
        minHeight,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 3,
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center">
        <CircularProgress size={20} aria-hidden="true" />
        <Typography variant="body2" color="text.secondary">
          {resolvedMessage}
        </Typography>
      </Stack>
    </Box>
  );
}
