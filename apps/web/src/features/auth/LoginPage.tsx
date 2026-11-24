import {
  CONTRACTS_API_PREFIX,
  apiErrorResponseSchema,
  loginRequestSchema,
} from "@docuflow/contracts";
import { PAPYRUS_COLOR_TOKENS, PapyrusLogo } from "@docuflow/ui";
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
import { LanguageSwitcher } from "../../components/LanguageSwitcher.js";
import { getLocalizedApiErrorMessage } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";

const CSRF_COOKIE_NAME = "docuflow_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

interface FieldErrors {
  readonly email?: string;
  readonly password?: string;
}

function readCookieValue(name: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
    }
  }
  return null;
}

async function resolveLoginCsrfToken(): Promise<string | null> {
  const fromCookie = readCookieValue(CSRF_COOKIE_NAME);
  if (fromCookie) {
    return fromCookie;
  }

  try {
    const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/csrf-token`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return readCookieValue(CSRF_COOKIE_NAME);
    }
    const rawJson: unknown = await response.clone().json();
    if (
      typeof rawJson === "object" &&
      rawJson !== null &&
      "data" in rawJson &&
      typeof rawJson.data === "object" &&
      rawJson.data !== null &&
      "csrfToken" in rawJson.data &&
      typeof rawJson.data.csrfToken === "string" &&
      rawJson.data.csrfToken.length > 0
    ) {
      return rawJson.data.csrfToken;
    }
  } catch {
    // Fallback to cookie or test environment without a dedicated CSRF endpoint.
  }
  return readCookieValue(CSRF_COOKIE_NAME);
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
  const { t, locale } = useI18n();
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
          nextErrors.email = t("auth.login.invalidEmail");
        }
        if (field === "password" && !nextErrors.password) {
          nextErrors.password = t("auth.login.requiredPassword");
        }
      }
      setFieldErrors(nextErrors);
      return;
    }

    setFieldErrors({});
    submitLockRef.current = true;
    setIsSubmitting(true);

    try {
      const csrfToken = await resolveLoginCsrfToken();
      const response = await fetch(`${CONTRACTS_API_PREFIX}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
        },
        body: JSON.stringify(parsed.data),
      });

      if (!response.ok) {
        if (response.status === 401) {
          setSubmitError(t("auth.login.invalidCredentials"));
          return;
        }
        let code: string | undefined;
        let serverMessage: string | undefined;
        try {
          const rawError: unknown = await response.json();
          const parsedError = apiErrorResponseSchema.safeParse(rawError);
          if (parsedError.success) {
            code = parsedError.data.error.code;
            serverMessage = parsedError.data.error.message;
          }
        } catch {
          // Keep safe localized fallback when error body is not JSON.
        }
        if (code === "UNAUTHORIZED") {
          setSubmitError(t("auth.login.invalidCredentials"));
          return;
        }
        setSubmitError(
          code !== undefined || response.status === 403 || response.status === 429
            ? getLocalizedApiErrorMessage(code, response.status, serverMessage, locale)
            : t("auth.login.invalidCredentials"),
        );
        return;
      }

      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      const targetPath = resolveSafeRedirectPath(location.state);
      navigate(targetPath, { replace: true });
    } catch {
      setSubmitError(t("common.errors.network"));
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
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack spacing={3}>
          <Stack spacing={1.5} alignItems="stretch">
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="flex-start"
              spacing={2}
            >
              <PapyrusLogo size="md" />
              <LanguageSwitcher />
            </Stack>
            <Box>
              <Typography variant="h1" component="h1">
                {t("auth.login.title")}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {t("auth.login.subtitle")}
              </Typography>
            </Box>
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
                label={t("auth.login.emailLabel")}
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
                label={t("auth.login.passwordLabel")}
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
                          aria-label={
                            showPassword
                              ? t("auth.login.hidePassword")
                              : t("auth.login.showPassword")
                          }
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
                <Link component={RouterLink} to="/forgot-password" variant="body2">
                  {t("auth.login.forgotPassword")}
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
                {isSubmitting ? t("auth.login.submitting") : t("auth.login.submit")}
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Paper>
    </Box>
  );
}
