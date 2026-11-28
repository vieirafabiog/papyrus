import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { UiLocaleProvider, papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/features/auth/LoginPage.js";
import { I18nProvider, resetUiLocaleForTests } from "../src/i18n/index.js";

function renderLoginPage(initialEntry = "/login") {
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
            <MemoryRouter initialEntries={[initialEntry]}>
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

function getRequestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("LoginPage", () => {
  afterEach(() => {
    cleanup();
    resetUiLocaleForTests();
    vi.restoreAllMocks();
  });

  it("validates email and password locally before calling login and hides Microsoft when disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { microsoft: { enabled: false } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderLoginPage();

    expect(screen.getByRole("heading", { name: "Sign in to papyrus" })).toBeInTheDocument();
    expect(screen.getByText("papyrus")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change language" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    const loginCalls = fetchSpy.mock.calls.filter(([input]) =>
      getRequestUrl(input).includes("/auth/login"),
    );
    expect(loginCalls).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Sign in with Microsoft" }),
    ).not.toBeInTheDocument();
  });

  it("prevents duplicate submissions while login request is in flight and shows localized errors", async () => {
    let resolveLoginResponse!: (value: Response) => void;
    const pendingLoginFetch = new Promise<Response>((resolve) => {
      resolveLoginResponse = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = getRequestUrl(input);
      if (url.includes("/auth/providers")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { microsoft: { enabled: false } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.includes("/auth/csrf-token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { csrfToken: "csrf-test-token" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return pendingLoginFetch;
    });

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/Work email/i), {
      target: { value: "usuario@papyrus.invalid" },
    });
    fireEvent.change(screen.getByLabelText(/^Password/i), {
      target: { value: "SenhaSegura123!" },
    });

    const submitBtn = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const loginCalls = fetchSpy.mock.calls.filter(([input]) =>
        getRequestUrl(input).includes("/auth/login"),
      );
      expect(loginCalls).toHaveLength(1);
    });
    expect(await screen.findByRole("button", { name: "Signing in..." })).toBeDisabled();

    resolveLoginResponse(
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
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = getRequestUrl(input);
      if (url.includes("/auth/providers")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { microsoft: { enabled: false } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: { authenticated: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/Work email/i), {
      target: { value: "admin@papyrus.invalid" },
    });
    fireEvent.change(screen.getByLabelText(/^Password/i), {
      target: { value: "SenhaForte123!" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Home dashboard" })).toBeInTheDocument();
    });
  });

  it("shows Sign in with Microsoft button when enabled and renders authError alerts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { microsoft: { enabled: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderLoginPage("/login?authError=user_not_found");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No papyrus user is registered with this Microsoft account email.",
    );
    expect(
      await screen.findByRole("button", { name: "Sign in with Microsoft" }),
    ).toBeInTheDocument();
  });
});
