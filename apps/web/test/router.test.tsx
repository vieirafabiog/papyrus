import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { UiLocaleProvider, papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type JSX, Suspense, lazy } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteLoadingFallback } from "../src/app/RouteLoadingFallback.js";
import { AppRoutes } from "../src/app/router.js";
import { I18nProvider, resetUiLocaleForTests } from "../src/i18n/index.js";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>;
}

function renderAt(initialPath: string) {
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
            <MemoryRouter initialEntries={[initialPath]}>
              <LocationProbe />
              <AppRoutes />
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("Web main routing and session guards", () => {
  afterEach(() => {
    cleanup();
    resetUiLocaleForTests();
    vi.restoreAllMocks();
  });

  it("redirects unauthenticated users from private routes to /login", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));

    renderAt("/documents");

    expect(await screen.findByRole("heading", { name: "Sign in to papyrus" })).toBeInTheDocument();
  });

  it("localizes public /forgot-password route view", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));

    renderAt("/forgot-password");

    expect(await screen.findByRole("heading", { name: "Password recovery" })).toBeInTheDocument();
  });

  it("redirects legacy Portuguese URLs to canonical English routes preserving params and query", async () => {
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                user: {
                  id: validUuid,
                  organizationId: validUuid,
                  email: "usuario@papyrus.invalid",
                  fullName: "Usuário Teste",
                  status: "ACTIVE",
                  createdAt: "2026-11-20T10:00:00Z",
                  updatedAt: "2026-11-20T10:00:00Z",
                },
                groups: [],
                roles: [],
                permissions: [],
                sessionExpiresAt: "2026-11-21T10:00:00Z",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    });

    renderAt(`/documentos/${validUuid}?versionId=v2`);

    await waitFor(() => {
      expect(screen.getByTestId("location-probe")).toHaveTextContent(
        `/documents/${validUuid}?versionId=v2`,
      );
    });
  });

  it("redirects authenticated users away from /login to private dashboard route", async () => {
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({
            data: {
              user: {
                id: validUuid,
                organizationId: validUuid,
                email: "usuario@papyrus.invalid",
                fullName: "Usuário Teste",
                status: "ACTIVE",
                createdAt: "2026-11-20T10:00:00Z",
                updatedAt: "2026-11-20T10:00:00Z",
              },
              groups: [],
              roles: [],
              permissions: [],
              sessionExpiresAt: "2026-11-21T10:00:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderAt("/login");

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  });

  it("displays an error alert with retry action when session check fails", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    renderAt("/");

    expect(
      await screen.findByRole("heading", { name: "Unable to validate your session" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Check your connection and try again.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("heading", { name: "Sign in to papyrus" })).toBeInTheDocument();
  });

  it("renders accessible loading spinner in RouteLoadingFallback while lazy route chunks load", async () => {
    let resolveChunk: ((mod: { default: () => JSX.Element }) => void) | undefined;
    const LazyStub = lazy(
      () =>
        new Promise<{ default: () => JSX.Element }>((resolve) => {
          resolveChunk = resolve;
        }),
    );

    render(
      <I18nProvider initialLocale="en-US">
        <UiLocaleProvider locale="en-US">
          <ThemeProvider theme={papyrusTheme}>
            <CssBaseline />
            <Suspense fallback={<RouteLoadingFallback />}>
              <LazyStub />
            </Suspense>
          </ThemeProvider>
        </UiLocaleProvider>
      </I18nProvider>,
    );

    expect(screen.getByRole("progressbar", { name: "Loading page..." })).toBeInTheDocument();
    expect(screen.getByText("Loading page...")).toBeInTheDocument();

    resolveChunk?.({ default: () => <h1>Loaded route chunk</h1> });
    expect(await screen.findByRole("heading", { name: "Loaded route chunk" })).toBeInTheDocument();
  });
});
