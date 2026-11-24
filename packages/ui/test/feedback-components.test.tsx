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
  docuflowTheme,
} from "../src/index.js";

function renderWithTheme(ui: ReactNode) {
  return render(<ThemeProvider theme={docuflowTheme}>{ui}</ThemeProvider>);
}

describe("Shared feedback components", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders accessible LoadingState in pt-BR", () => {
    renderWithTheme(<LoadingState message="Carregando documentos..." />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Carregando documentos...");
  });

  it("renders EmptyState with actionable callback", () => {
    const onAction = vi.fn();
    renderWithTheme(
      <EmptyState
        title="Nenhum documento encontrado"
        description="Envie o primeiro documento para iniciar o repositório."
        actionLabel="Enviar documento"
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Nenhum documento encontrado" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enviar documento" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("renders ErrorState with accessible alert role and retry action", () => {
    const onRetry = vi.fn();
    renderWithTheme(
      <ErrorState
        description="Falha temporária de comunicação com o servidor."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar os dados");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders ConfirmDialog with confirm/cancel callbacks and loading state", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    const { rerender } = renderWithTheme(
      <ConfirmDialog
        open={true}
        title="Arquivar documento"
        description="O documento será movido para o estado arquivado."
        confirmLabel="Arquivar"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Arquivar documento" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <ThemeProvider theme={docuflowTheme}>
        <ConfirmDialog
          open={true}
          title="Arquivar documento"
          description="O documento será movido para o estado arquivado."
          loading={true}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: "Processando..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
  });
});
