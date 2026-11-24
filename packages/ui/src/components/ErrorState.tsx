import ErrorOutlineOutlinedIcon from "@mui/icons-material/ErrorOutlineOutlined";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import { useUiLocale } from "../locale.js";
import { PAPYRUS_COLOR_TOKENS } from "../theme/tokens.js";

export interface ErrorStateProps {
  readonly title?: string | undefined;
  readonly description: string;
  readonly retryLabel?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
}

export function ErrorState({ title, description, retryLabel, onRetry }: ErrorStateProps) {
  const { messages } = useUiLocale();
  const resolvedTitle = title ?? messages.errorState.defaultTitle;
  const resolvedRetryLabel = retryLabel ?? messages.errorState.retry;

  return (
    <Paper
      role="alert"
      sx={{
        p: 4,
        textAlign: "center",
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        borderColor: PAPYRUS_COLOR_TOKENS.semantic.errorMain,
      }}
    >
      <Stack spacing={1.5} alignItems="center" maxWidth={440} mx="auto">
        <Box sx={{ color: "error.main", display: "flex" }} aria-hidden="true">
          <ErrorOutlineOutlinedIcon fontSize="large" />
        </Box>
        <Typography variant="h3" component="h2">
          {resolvedTitle}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
        {onRetry ? (
          <Box pt={0.5}>
            <Button variant="outlined" color="error" onClick={onRetry}>
              {resolvedRetryLabel}
            </Button>
          </Box>
        ) : null}
      </Stack>
    </Paper>
  );
}
