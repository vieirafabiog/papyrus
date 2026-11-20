import ErrorOutlineOutlinedIcon from "@mui/icons-material/ErrorOutlineOutlined";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import { DOCUFLOW_COLOR_TOKENS } from "../theme/tokens.js";

export interface ErrorStateProps {
  readonly title?: string;
  readonly description: string;
  readonly retryLabel?: string;
  readonly onRetry?: () => void;
}

export function ErrorState({
  title = "Não foi possível carregar os dados",
  description,
  retryLabel = "Tentar novamente",
  onRetry,
}: ErrorStateProps) {
  return (
    <Paper
      role="alert"
      sx={{
        p: 4,
        textAlign: "center",
        bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        borderColor: DOCUFLOW_COLOR_TOKENS.semantic.errorMain,
      }}
    >
      <Stack spacing={1.5} alignItems="center" maxWidth={440} mx="auto">
        <Box sx={{ color: "error.main", display: "flex" }} aria-hidden="true">
          <ErrorOutlineOutlinedIcon fontSize="large" />
        </Box>
        <Typography variant="h3" component="h2">
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
        {onRetry ? (
          <Box pt={0.5}>
            <Button variant="outlined" color="error" onClick={onRetry}>
              {retryLabel}
            </Button>
          </Box>
        ) : null}
      </Stack>
    </Paper>
  );
}
