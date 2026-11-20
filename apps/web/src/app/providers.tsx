import { docuflowTheme } from "@docuflow/ui";
import { Box, Button, CssBaseline, Paper, Stack, ThemeProvider, Typography } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ErrorInfo, type ReactNode, useState } from "react";
import { BrowserRouter } from "react-router-dom";

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
    // Erros detalhados não devem ser exibidos ao usuário final na interface.
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
                Ocorreu um erro inesperado
              </Typography>
              <Typography variant="body1" color="text.secondary">
                Não foi possível concluir a exibição desta página. Você pode tentar novamente ou
                recarregar a aplicação.
              </Typography>
              <Stack direction="row" spacing={1.5}>
                <Button variant="contained" onClick={this.handleReset}>
                  Tentar novamente
                </Button>
                <Button variant="outlined" onClick={this.handleReload}>
                  Recarregar página
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

export function AppProviders({ children, queryClient }: AppProvidersProps) {
  const [defaultQueryClient] = useState<QueryClient>(() => queryClient ?? createAppQueryClient());

  return (
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <GlobalErrorBoundary>
        <QueryClientProvider client={defaultQueryClient}>
          <BrowserRouter>{children}</BrowserRouter>
        </QueryClientProvider>
      </GlobalErrorBoundary>
    </ThemeProvider>
  );
}
