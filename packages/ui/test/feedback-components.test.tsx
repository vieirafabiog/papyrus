import "@testing-library/jest-dom/vitest";
import { ThemeProvider } from "@mui/material/styles";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  type PapyrusLocale,
  UiLocaleProvider,
  createPapyrusTheme,
  papyrusTheme,
} from "../src/index.js";

function renderWithTheme(ui: ReactNode, locale?: PapyrusLocale) {
  if (!locale) {
    return render(<ThemeProvider theme={papyrusTheme}>{ui}</ThemeProvider>);
  }
  return render(
    <UiLocaleProvider locale={locale}>
      <ThemeProvider theme={createPapyrusTheme(locale)}>{ui}</ThemeProvider>
    </UiLocaleProvider>,
  );
}

describe("Shared feedback components", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders accessible LoadingState in en-US by default and pt-BR when configured", () => {
    const { rerender } = renderWithTheme(<LoadingState />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");

    rerender(
      <UiLocaleProvider locale="pt-BR">
        <ThemeProvider theme={createPapyrusTheme("pt-BR")}>
          <LoadingState />
        </ThemeProvider>
      </UiLocaleProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Carregando...");
  });

  it("renders EmptyState with actionable callback", () => {
    const onAction = vi.fn();
    renderWithTheme(
      <EmptyState
        title="No documents found"
        description="Upload your first document to get started."
        actionLabel="Upload document"
        onAction={onAction}
      />,
    );

    expect(screen.getByRole("heading", { name: "No documents found" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("renders ErrorState with default en-US labels and pt-BR override", () => {
    const onRetry = vi.fn();
    const { rerender } = renderWithTheme(
      <ErrorState description="Temporary connection issue." onRetry={onRetry} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load data");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <UiLocaleProvider locale="pt-BR">
        <ThemeProvider theme={createPapyrusTheme("pt-BR")}>
          <ErrorState description="Falha temporária de conexão." onRetry={onRetry} />
        </ThemeProvider>
      </UiLocaleProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar os dados");
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
  });

  it("renders ConfirmDialog with confirm/cancel callbacks and loading state", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    const { rerender } = renderWithTheme(
      <ConfirmDialog
        open={true}
        title="Archive document"
        description="This document will be archived."
        confirmLabel="Archive"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Archive document" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <ThemeProvider theme={papyrusTheme}>
        <ConfirmDialog
          open={true}
          title="Archive document"
          description="This document will be archived."
          loading={true}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: "Processing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
