import { Box, Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useI18n } from "../i18n/index.js";
import { useSessionQuery } from "./session.js";

function SessionLoadingFallback() {
  const { t } = useI18n();

  return (
    <Box
      component="output"
      aria-live="polite"
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 3,
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center">
        <CircularProgress size={20} aria-hidden="true" />
        <Typography variant="body1">{t("auth.session.checking")}</Typography>
      </Stack>
    </Box>
  );
}

export function RequireAuth() {
  const { t } = useI18n();
  const location = useLocation();
  const { data: session, isPending, isError, refetch } = useSessionQuery();

  if (isPending) {
    return <SessionLoadingFallback />;
  }

  if (isError) {
    return (
      <Box
        role="alert"
        sx={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          p: 3,
        }}
      >
        <Paper sx={{ maxWidth: 440, p: 3 }}>
          <Stack spacing={2}>
            <Typography variant="h3" component="h1">
              {t("auth.session.validationErrorTitle")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("auth.session.validationErrorDescription")}
            </Typography>
            <Box>
              <Button variant="contained" onClick={() => void refetch()}>
                {t("auth.session.retry")}
              </Button>
            </Box>
          </Stack>
        </Paper>
      </Box>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

export function RedirectIfAuthenticated() {
  const { data: session, isPending } = useSessionQuery();

  if (isPending) {
    return <SessionLoadingFallback />;
  }

  if (session) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
