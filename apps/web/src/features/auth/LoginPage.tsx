import {
  apiErrorResponseSchema,
  CONTRACTS_API_PREFIX,
  loginRequestSchema,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS } from "@docuflow/ui";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import VisibilityOffOutlinedIcon from "@mui/icons-material/VisibilityOffOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import { SESSION_QUERY_KEY } from "../../app/session.js";

interface FieldErrors {
  readonly email?: string;
  readonly password?: string;
}

function resolveSafeRedirectPath(state: unknown): string {
  if (
    typeof state === "object" &&
    state !== null &&
    "from" in state &&
    typeof state.from === "string" &&
    state.from.startsWith("/") &&
    !state.from.startsWith("//")
  ) {
    return state.from;
  }
  return "/";
}

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const submitLockRef = useRef(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitLockRef.current || isSubmitting) {
      return;
    }

    setSubmitError(null);
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      const nextErrors: { email?: string; password?: string } = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "email" && !nextErrors.email) {
          nextErrors.email = "Informe um endereço de e-mail válido.";
        }
        if (field === "password" && !nextErrors.password) {
          nextErrors.password = "Informe sua senha.";
        }
      }
      setFieldErrors(nextErrors);
      return;
    }

    setFieldErrors({});
    submitLockRef.current = true;
    setIsSubmitting(true);

    try {
      const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(parsed.data),
      });

      if (!response.ok) {
        let errorMessage = "Credenciais inválidas ou acesso temporariamente indisponível.";
        try {
          const rawError: unknown = await response.json();
          const parsedError = apiErrorResponseSchema.safeParse(rawError);
          if (parsedError.success) {
            errorMessage = parsedError.data.error.message;
          }
        } catch {
          // Mantém mensagem padrão segura caso o corpo não seja JSON.
        }
        setSubmitError(errorMessage);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      const targetPath = resolveSafeRedirectPath(location.state);
      navigate(targetPath, { replace: true });
    } catch {
      setSubmitError("Não foi possível conectar ao servidor. Tente novamente.");
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <Box
      component="main"
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 2,
        py: 4,
        bgcolor: "background.default",
      }}
    >
      <Paper
        sx={{
          width: "100%",
          maxWidth: 420,
          p: { xs: 3, sm: 4 },
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack spacing={3}>
          <Stack spacing={1} alignItems="flex-start">
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: 2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                bgcolor: DOCUFLOW_COLOR_TOKENS.primary.container,
                color: DOCUFLOW_COLOR_TOKENS.primary.onContainer,
              }}
              aria-hidden="true"
            >
              <LockOutlinedIcon fontSize="small" />
            </Box>
            <Typography variant="h1" component="h1">
              Entrar no DocuFlow
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Acesse o repositório documental da sua organização.
            </Typography>
          </Stack>

          {submitError ? (
            <Alert severity="error" role="alert">
              {submitError}
            </Alert>
          ) : null}

          <Box component="form" noValidate onSubmit={(event) => void handleSubmit(event)}>
            <Stack spacing={2}>
              <TextField
                id="login-email"
                label="E-mail corporativo"
                type="email"
                name="email"
                autoComplete="email"
                fullWidth
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                error={Boolean(fieldErrors.email)}
                helperText={fieldErrors.email}
                disabled={isSubmitting}
              />

              <TextField
                id="login-password"
                label="Senha"
                type={showPassword ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                fullWidth
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                error={Boolean(fieldErrors.password)}
                helperText={fieldErrors.password}
                disabled={isSubmitting}
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                          onClick={() => setShowPassword((prev) => !prev)}
                          edge="end"
                          disabled={isSubmitting}
                        >
                          {showPassword ? (
                            <VisibilityOffOutlinedIcon fontSize="small" />
                          ) : (
                            <VisibilityOutlinedIcon fontSize="small" />
                          )}
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />

              <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
                <Link component={RouterLink} to="/recuperar-senha" variant="body2">
                  Esqueci minha senha
                </Link>
              </Box>

              <Button
                type="submit"
                variant="contained"
                fullWidth
                disabled={isSubmitting}
                startIcon={
                  isSubmitting ? <CircularProgress size={16} color="inherit" /> : undefined
                }
              >
                {isSubmitting ? "Entrando..." : "Entrar"}
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Paper>
    </Box>
  );
}
