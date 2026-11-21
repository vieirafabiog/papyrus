import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentFileAvailabilityPanel,
  type DocumentFileAvailabilityPanelProps,
  canDownloadFileObject,
  canPreviewFileObject,
  sanitizeUserFacingRejectionMessage,
} from "../src/features/documents/FileProcessingStatus.js";

function renderAvailabilityPanel(props: DocumentFileAvailabilityPanelProps) {
  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <DocumentFileAvailabilityPanel {...props} />
    </ThemeProvider>,
  );
}

describe("Quarantine and rejection UI feedback", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("displays 'Em análise' and strictly blocks preview and download actions during UPLOADING and QUARANTINED", () => {
    const onPreview = vi.fn();
    const onDownload = vi.fn();

    renderAvailabilityPanel({
      fileStatus: "QUARANTINED",
      fileName: "contrato-pendente.pdf",
      onPreview,
      onDownload,
      children: <iframe title="Preview PDF" src="/api/v1/documents/1/preview" />,
    });

    expect(screen.getByText("Em análise")).toBeInTheDocument();
    expect(screen.getByText("Pré-visualização bloqueada")).toBeInTheDocument();
    expect(screen.queryByTitle("Preview PDF")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Visualizar arquivo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Baixar arquivo" })).not.toBeInTheDocument();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onDownload).not.toHaveBeenCalled();

    expect(canPreviewFileObject("UPLOADING")).toBe(false);
    expect(canPreviewFileObject("QUARANTINED")).toBe(false);
    expect(canDownloadFileObject("QUARANTINED")).toBe(false);
  });

  it("displays 'Rejeitado' without exposing technical scanner signatures, paths, URLs, hashes, or preview content", () => {
    const onPreview = vi.fn();
    const onUploadNewVersion = vi.fn();

    renderAvailabilityPanel({
      fileStatus: "REJECTED",
      fileName: "arquivo-bloqueado.pdf",
      rejectionReason:
        "ClamAV Win.Test.Eicar_HDB-1 FOUND at org/550e8400/documents/1/obj via https://s3.internal/secret",
      onPreview,
      onUploadNewVersion,
      children: <div data-testid="forbidden-preview">Conteúdo restrito</div>,
    });

    expect(screen.getByText("Rejeitado")).toBeInTheDocument();
    expect(screen.queryByTestId("forbidden-preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Visualizar arquivo" })).not.toBeInTheDocument();

    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).not.toContain("Eicar");
    expect(alertText).not.toContain("ClamAV");
    expect(alertText).not.toContain("https://");
    expect(alertText).not.toContain("org/550e8400");
    expect(alertText).toContain("O arquivo foi rejeitado na verificação de segurança");

    // Clicking "Enviar nova versão" triggers provided handler
    fireEvent.click(screen.getByRole("button", { name: "Enviar nova versão" }));
    expect(onUploadNewVersion).toHaveBeenCalledTimes(1);

    // Safe non-technical messages are preserved while hashes/magic bytes are scrubbed
    expect(
      sanitizeUserFacingRejectionMessage(
        "O formato de arquivo identificado não é permitido pela política configurada.",
      ),
    ).toBe("O formato de arquivo identificado não é permitido pela política configurada.");
    expect(sanitizeUserFacingRejectionMessage(`Mismatch SHA-256 ${"a".repeat(64)}`)).not.toContain(
      "a".repeat(64),
    );
  });

  it("displays 'Disponível' and releases preview content plus functional preview/download controls ONLY when AVAILABLE", () => {
    const onPreview = vi.fn();
    const onDownload = vi.fn();

    renderAvailabilityPanel({
      fileStatus: "AVAILABLE",
      fileName: "contrato-aprovado.pdf",
      onPreview,
      onDownload,
      children: <div data-testid="approved-preview">Visualizador PDF carregado</div>,
    });

    expect(screen.getByText("Disponível")).toBeInTheDocument();
    expect(screen.getByTestId("approved-preview")).toBeInTheDocument();
    expect(screen.queryByText("Pré-visualização bloqueada")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Visualizar arquivo" }));
    fireEvent.click(screen.getByRole("button", { name: "Baixar arquivo" }));

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(canPreviewFileObject("AVAILABLE")).toBe(true);
    expect(canDownloadFileObject("AVAILABLE")).toBe(true);
  });
});
