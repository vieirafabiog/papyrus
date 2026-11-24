import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/features/auth/LoginPage.js";

function renderLoginPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<h1>Painel inicial</h1>} />
            <Route path="/recuperar-senha" element={<h1>Recuperação</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("LoginPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("validates email and password locally before calling the API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderLoginPage();

    expect(screen.getByRole("heading", { name: "Entrar no papyrus" })).toBeInTheDocument();
    expect(screen.getByText("papyrus")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByText("Informe um endereço de e-mail válido.")).toBeInTheDocument();
    expect(screen.getByText("Informe sua senha.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prevents duplicate submissions while login request is in flight and shows API errors", async () => {
    let resolveResponse!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(pendingFetch);

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/E-mail corporativo/i), {
      target: { value: "usuario@docuflow.invalid" },
    });
    fireEvent.change(screen.getByLabelText(/^Senha/i), {
      target: { value: "SenhaSegura123!" },
    });

    const submitBtn = screen.getByRole("button", { name: "Entrar" });
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Entrando..." })).toBeDisabled();

    resolveResponse(
      new Response(
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "E-mail ou senha incorretos.",
            requestId: "550e8400-e29b-41d4-a716-446655440000",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("E-mail ou senha incorretos.");
  });

  it("navigates to home after successful login", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { authenticated: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/E-mail corporativo/i), {
      target: { value: "admin@docuflow.invalid" },
    });
    fireEvent.change(screen.getByLabelText(/^Senha/i), {
      target: { value: "SenhaForte123!" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Painel inicial" })).toBeInTheDocument();
    });
  });
});
