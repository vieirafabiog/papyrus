import { UiLocaleProvider, createPapyrusTheme } from "@docuflow/ui";
import { Box, Button, CssBaseline, Paper, Stack, ThemeProvider, Typography } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ErrorInfo, type ReactNode, useMemo, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { I18nProvider, translate, useI18n } from "../i18n/index.js";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class GlobalErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(_error: Error, _errorInfo: ErrorInfo): void {
    // Detailed errors must not be exposed to the end user in the interface.
  }

  private readonly handleReset = (): void => {
    this.setState({ hasError: false });
  };

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Box
          role="alert"
          sx={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            p: 3,
            bgcolor: "background.default",
          }}
        >
          <Paper sx={{ maxWidth: 480, p: 4 }}>
            <Stack spacing={2}>
              <Typography variant="h2" component="h1">
                {translate("common.errorBoundary.title")}
              </Typography>
              <Typography variant="body1" color="text.secondary">
                {translate("common.errorBoundary.description")}
              </Typography>
              <Stack direction="row" spacing={1.5}>
                <Button variant="contained" onClick={this.handleReset}>
                  {translate("common.errorBoundary.retry")}
                </Button>
                <Button variant="outlined" onClick={this.handleReload}>
                  {translate("common.errorBoundary.reload")}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        </Box>
      );
    }

    return this.props.children;
  }
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

export interface AppProvidersProps {
  readonly children: ReactNode;
  readonly queryClient?: QueryClient;
}

function ThemedAppProviders({ children, queryClient }: AppProvidersProps) {
  const { locale } = useI18n();
  const [defaultQueryClient] = useState<QueryClient>(() => queryClient ?? createAppQueryClient());
  const theme = useMemo(() => createPapyrusTheme(locale), [locale]);

  return (
    <UiLocaleProvider locale={locale}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <GlobalErrorBoundary>
          <QueryClientProvider client={defaultQueryClient}>
            <BrowserRouter>{children}</BrowserRouter>
          </QueryClientProvider>
        </GlobalErrorBoundary>
      </ThemeProvider>
    </UiLocaleProvider>
  );
}

export function AppProviders({ children, queryClient }: AppProvidersProps) {
  return (
    <I18nProvider>
      <ThemedAppProviders {...(queryClient !== undefined ? { queryClient } : {})}>
        {children}
      </ThemedAppProviders>
    </I18nProvider>
  );
}
