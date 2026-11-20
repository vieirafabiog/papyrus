import { Box, CircularProgress, Stack, Typography } from "@mui/material";

export interface LoadingStateProps {
  readonly message?: string;
  readonly minHeight?: number;
}

export function LoadingState({
  message = "Carregando...",
  minHeight = 160,
}: LoadingStateProps) {
  return (
    <Box
      role="status"
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
          {message}
        </Typography>
      </Stack>
    </Box>
  );
}
