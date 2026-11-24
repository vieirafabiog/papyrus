import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../src/app/router.js";

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
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <LocationProbe />
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("Web main routing and session guards", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("redirects unauthenticated users from private routes to /login", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));

    renderAt("/documents");

    expect(await screen.findByRole("heading", { name: "Entrar no papyrus" })).toBeInTheDocument();
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
                  email: "usuario@docuflow.invalid",
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            user: {
              id: validUuid,
              organizationId: validUuid,
              email: "usuario@docuflow.invalid",
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

    renderAt("/login");

    expect(await screen.findByRole("heading", { name: "Visão geral" })).toBeInTheDocument();
  });

  it("displays an error alert with retry action when session check fails", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    renderAt("/");

    expect(
      await screen.findByRole("heading", { name: "Não foi possível validar sua sessão" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("heading", { name: "Entrar no papyrus" })).toBeInTheDocument();
  });
});
