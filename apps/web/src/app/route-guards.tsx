import { Box, Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useSessionQuery } from "./session.js";

function SessionLoadingFallback() {
  return (
    <Box
      role="status"
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
        <Typography variant="body1">Verificando sessão...</Typography>
      </Stack>
    </Box>
  );
}

export function RequireAuth() {
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
              Não foi possível validar sua sessão
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Verifique a conexão com a API do DocuFlow e tente novamente.
            </Typography>
            <Box>
              <Button variant="contained" onClick={() => void refetch()}>
                Tentar novamente
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
