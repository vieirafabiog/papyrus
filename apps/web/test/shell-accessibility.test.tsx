import "@testing-library/jest-dom/vitest";
import { ConfirmDialog, DOCUFLOW_COLOR_TOKENS, docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../src/app/router.js";

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
                email: "gestor@docuflow.invalid",
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
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("Shell and shared states accessibility", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("provides landmarks, skip link, accessible labels, and responsive sidebar controls", async () => {
    mockAuthenticatedFetch();
    renderAuthenticatedShell("/");

    const skipLink = await screen.findByRole("link", {
      name: "Pular para o conteúdo principal",
    });
    expect(skipLink).toHaveAttribute("href", "#main-content");

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");

    const navs = screen.getAllByRole("navigation", { name: "Navegação principal" });
    expect(navs.length).toBeGreaterThanOrEqual(1);

    const collapseBtn = screen.getByRole("button", { name: "Recolher barra lateral" });
    fireEvent.click(collapseBtn);
    expect(screen.getByRole("button", { name: "Expandir barra lateral" })).toBeInTheDocument();

    const profileBtn = screen.getByRole("button", { name: "Perfil do usuário" });
    expect(profileBtn).toHaveAttribute("aria-haspopup", "true");
    fireEvent.click(profileBtn);
    await waitFor(() => {
      expect(profileBtn).toHaveAttribute("aria-expanded", "true");
    });
    expect(screen.getByRole("menuitem", { name: "Sair" })).toBeInTheDocument();
  });

  it("supports keyboard Escape dismissal and ARIA attributes in ConfirmDialog", () => {
    const onCancel = vi.fn();
    render(
      <ThemeProvider theme={docuflowTheme}>
        <ConfirmDialog
          open={true}
          title="Excluir documento"
          description="O item será movido para a lixeira."
          onConfirm={vi.fn()}
          onCancel={onCancel}
        />
      </ThemeProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "Excluir documento" });
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(dialog).toHaveAttribute("aria-describedby");

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("meets WCAG 2.2 AA contrast (>= 4.5:1) and visible focus styling in theme tokens", () => {
    expect(
      contrastRatio(DOCUFLOW_COLOR_TOKENS.text.primary, DOCUFLOW_COLOR_TOKENS.surface.background),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(DOCUFLOW_COLOR_TOKENS.text.secondary, DOCUFLOW_COLOR_TOKENS.surface.paper),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(DOCUFLOW_COLOR_TOKENS.primary.contrastText, DOCUFLOW_COLOR_TOKENS.primary.main),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        DOCUFLOW_COLOR_TOKENS.primary.onContainer,
        DOCUFLOW_COLOR_TOKENS.primary.container,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        DOCUFLOW_COLOR_TOKENS.semantic.errorContrast,
        DOCUFLOW_COLOR_TOKENS.semantic.errorMain,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        DOCUFLOW_COLOR_TOKENS.semantic.warningContrast,
        DOCUFLOW_COLOR_TOKENS.semantic.warningMain,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        DOCUFLOW_COLOR_TOKENS.semantic.successContrast,
        DOCUFLOW_COLOR_TOKENS.semantic.successMain,
      ),
    ).toBeGreaterThanOrEqual(4.5);

    const buttonBaseOverrides = docuflowTheme.components?.MuiButtonBase?.styleOverrides?.root;
    expect(buttonBaseOverrides).toBeDefined();
    expect(JSON.stringify(buttonBaseOverrides)).toContain("Mui-focusVisible");
  });
});
