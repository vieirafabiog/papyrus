import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { ConfirmDialog, PAPYRUS_COLOR_TOKENS, UiLocaleProvider, papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../src/app/router.js";
import { I18nProvider, resetUiLocaleForTests } from "../src/i18n/index.js";

function hexToRelativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;

  const linearize = (channel: number): number =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const l1 = hexToRelativeLuminance(foregroundHex);
  const l2 = hexToRelativeLuminance(backgroundHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function mockAuthenticatedFetch() {
  const validUuid = "550e8400-e29b-41d4-a716-446655440000";
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              user: {
                id: validUuid,
                organizationId: validUuid,
                email: "gestor@papyrus.invalid",
                fullName: "Gestor Documental",
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
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

function renderAuthenticatedShell(initialPath = "/") {
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
              <AppRoutes />
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("Shell and shared states accessibility", () => {
  afterEach(() => {
    cleanup();
    resetUiLocaleForTests();
    vi.restoreAllMocks();
  });

  it("provides landmarks, skip link, accessible labels, language switcher, and responsive sidebar controls", async () => {
    mockAuthenticatedFetch();
    renderAuthenticatedShell("/");

    const skipLink = await screen.findByRole("link", {
      name: "Skip to main content",
    });
    expect(skipLink).toHaveAttribute("href", "#main-content");

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");

    const navs = screen.getAllByRole("navigation", { name: "Main navigation" });
    expect(navs.length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText("Document Management")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change language" })).toBeInTheDocument();

    const collapseBtn = screen.getByRole("button", { name: "Collapse sidebar" });
    fireEvent.click(collapseBtn);
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();

    const profileBtn = screen.getByRole("button", { name: "User profile" });
    expect(profileBtn).toHaveAttribute("aria-haspopup", "true");
    fireEvent.click(profileBtn);
    await waitFor(() => {
      expect(profileBtn).toHaveAttribute("aria-expanded", "true");
    });
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("sends x-csrf-token when signing out and redirects to /login", async () => {
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    let logoutCsrfHeader: string | null = null;
    let isLoggedOut = false;

    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/auth/me")) {
        if (isLoggedOut) {
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                user: {
                  id: validUuid,
                  organizationId: validUuid,
                  email: "admin@papyrus.local",
                  fullName: "Administrator",
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
      if (url.endsWith("/auth/csrf-token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { csrfToken: "csrf-logout-token" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/auth/logout")) {
        const headers = new Headers(init?.headers);
        logoutCsrfHeader = headers.get("x-csrf-token");
        isLoggedOut = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    renderAuthenticatedShell("/");

    const profileBtn = await screen.findByRole("button", { name: "User profile" });
    fireEvent.click(profileBtn);
    const signOutItem = await screen.findByRole("menuitem", { name: "Sign out" });
    fireEvent.click(signOutItem);

    expect(await screen.findByRole("heading", { name: "Sign in to papyrus" })).toBeInTheDocument();
    expect(logoutCsrfHeader).toBe("csrf-logout-token");
  });

  it("supports keyboard Escape dismissal and ARIA attributes in ConfirmDialog", () => {
    const onCancel = vi.fn();
    render(
      <UiLocaleProvider locale="en-US">
        <ThemeProvider theme={papyrusTheme}>
          <ConfirmDialog
            open={true}
            title="Delete document"
            description="The item will be moved to trash."
            onConfirm={vi.fn()}
            onCancel={onCancel}
          />
        </ThemeProvider>
      </UiLocaleProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "Delete document" });
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(dialog).toHaveAttribute("aria-describedby");

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("meets WCAG 2.2 AA contrast (>= 4.5:1) and visible focus styling in theme tokens", () => {
    expect(
      contrastRatio(PAPYRUS_COLOR_TOKENS.text.primary, PAPYRUS_COLOR_TOKENS.surface.background),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(PAPYRUS_COLOR_TOKENS.text.secondary, PAPYRUS_COLOR_TOKENS.surface.paper),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(PAPYRUS_COLOR_TOKENS.primary.contrastText, PAPYRUS_COLOR_TOKENS.primary.main),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        PAPYRUS_COLOR_TOKENS.primary.onContainer,
        PAPYRUS_COLOR_TOKENS.primary.container,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        PAPYRUS_COLOR_TOKENS.semantic.errorContrast,
        PAPYRUS_COLOR_TOKENS.semantic.errorMain,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        PAPYRUS_COLOR_TOKENS.semantic.warningContrast,
        PAPYRUS_COLOR_TOKENS.semantic.warningMain,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        PAPYRUS_COLOR_TOKENS.semantic.successContrast,
        PAPYRUS_COLOR_TOKENS.semantic.successMain,
      ),
    ).toBeGreaterThanOrEqual(4.5);

    const buttonBaseOverrides = papyrusTheme.components?.MuiButtonBase?.styleOverrides?.root;
    expect(buttonBaseOverrides).toBeDefined();
    expect(JSON.stringify(buttonBaseOverrides)).toContain("Mui-focusVisible");
  });
});
