import "@testing-library/jest-dom/vitest";
import { UiLocaleProvider, papyrusTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/features/auth/LoginPage.js";
import { I18nProvider, resetUiLocaleForTests } from "../src/i18n/index.js";

function renderLoginPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <I18nProvider initialLocale="en-US">
      <UiLocaleProvider locale="en-US">
        <ThemeProvider theme={papyrusTheme}>
          <CssBaseline />
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={["/login"]}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/" element={<h1>Home dashboard</h1>} />
                <Route path="/forgot-password" element={<h1>Password recovery</h1>} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("LoginPage", () => {
  afterEach(() => {
    cleanup();
    resetUiLocaleForTests();
    vi.restoreAllMocks();
  });

  it("validates email and password locally before calling the API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderLoginPage();

    expect(screen.getByRole("heading", { name: "Sign in to papyrus" })).toBeInTheDocument();
    expect(screen.getByText("papyrus")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change language" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prevents duplicate submissions while login request is in flight and shows localized errors", async () => {
    let resolveResponse!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(pendingFetch);

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/Work email/i), {
      target: { value: "usuario@docuflow.invalid" },
    });
    fireEvent.change(screen.getByLabelText(/^Password/i), {
      target: { value: "SenhaSegura123!" },
    });

    const submitBtn = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Signing in..." })).toBeDisabled();

    resolveResponse(
      new Response(
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid credentials.",
            requestId: "550e8400-e29b-41d4-a716-446655440000",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid credentials or access temporarily unavailable.",
    );
  });

  it("navigates to home after successful login", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { authenticated: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/Work email/i), {
      target: { value: "admin@docuflow.invalid" },
    });
    fireEvent.change(screen.getByLabelText(/^Password/i), {
      target: { value: "SenhaForte123!" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Home dashboard" })).toBeInTheDocument();
    });
  });
});
