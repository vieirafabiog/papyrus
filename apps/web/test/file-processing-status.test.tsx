import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { papyrusTheme } from "@papyrus/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentFileAvailabilityPanel,
  type DocumentFileAvailabilityPanelProps,
  canDownloadFileObject,
  canPreviewFileObject,
  sanitizeUserFacingRejectionMessage,
} from "../src/features/documents/FileProcessingStatus.js";
import { I18nProvider } from "../src/i18n/index.js";

function renderAvailabilityPanel(
  props: DocumentFileAvailabilityPanelProps,
  initialLocale: "en-US" | "pt-BR" = "en-US",
) {
  return render(
    <I18nProvider initialLocale={initialLocale}>
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <DocumentFileAvailabilityPanel {...props} />
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe("Quarantine and rejection UI feedback", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("displays 'Under review' and strictly blocks preview and download actions during UPLOADING and QUARANTINED", () => {
    const onPreview = vi.fn();
    const onDownload = vi.fn();

    renderAvailabilityPanel({
      fileStatus: "QUARANTINED",
      fileName: "contrato-pendente.pdf",
      onPreview,
      onDownload,
      children: <iframe title="Preview PDF" src="/api/v1/documents/1/preview" />,
    });

    expect(screen.getByText("Under review")).toBeInTheDocument();
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
    expect(screen.queryByTitle("Preview PDF")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download file" })).not.toBeInTheDocument();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onDownload).not.toHaveBeenCalled();

    expect(canPreviewFileObject("UPLOADING")).toBe(false);
    expect(canPreviewFileObject("QUARANTINED")).toBe(false);
    expect(canDownloadFileObject("QUARANTINED")).toBe(false);
  });

  it("displays 'Rejected' without exposing technical scanner signatures, paths, URLs, hashes, or preview content", () => {
    const onPreview = vi.fn();
    const onUploadNewVersion = vi.fn();

    renderAvailabilityPanel({
      fileStatus: "REJECTED",
      fileName: "arquivo-bloqueado.pdf",
      rejectionReason:
        "ClamAV Win.Test.Eicar_HDB-1 FOUND at org/550e8400/documents/1/obj via https://s3.internal/secret",
      onPreview,
      onUploadNewVersion,
      children: <div data-testid="forbidden-preview">Restricted content</div>,
    });

    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.queryByTestId("forbidden-preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview file" })).not.toBeInTheDocument();

    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).not.toContain("Eicar");
    expect(alertText).not.toContain("ClamAV");
    expect(alertText).not.toContain("https://");
    expect(alertText).not.toContain("org/550e8400");
    expect(alertText).toContain("The file was rejected during security or integrity verification");

    fireEvent.click(screen.getByRole("button", { name: "Upload new version" }));
    expect(onUploadNewVersion).toHaveBeenCalledTimes(1);

    expect(
      sanitizeUserFacingRejectionMessage(
        "The detected file format is not permitted by organization policy.",
      ),
    ).toBe("The detected file format is not permitted by organization policy.");
    expect(sanitizeUserFacingRejectionMessage(`Mismatch SHA-256 ${"a".repeat(64)}`)).not.toContain(
      "a".repeat(64),
    );
  });

  it("displays 'Available' and releases preview content plus functional preview/download controls ONLY when AVAILABLE", () => {
    const onPreview = vi.fn();
    const onDownload = vi.fn();

    renderAvailabilityPanel({
      fileStatus: "AVAILABLE",
      fileName: "contrato-aprovado.pdf",
      onPreview,
      onDownload,
      children: <div data-testid="approved-preview">PDF viewer loaded</div>,
    });

    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByTestId("approved-preview")).toBeInTheDocument();
    expect(screen.queryByText("Preview unavailable")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    fireEvent.click(screen.getByRole("button", { name: "Download file" }));

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(canPreviewFileObject("AVAILABLE")).toBe(true);
    expect(canDownloadFileObject("AVAILABLE")).toBe(true);
  });

  it("supports pt-BR locale dynamically via I18nProvider", () => {
    renderAvailabilityPanel(
      {
        fileStatus: "QUARANTINED",
        fileName: "contrato-pendente.pdf",
      },
      "pt-BR",
    );

    expect(screen.getByText("Em análise")).toBeInTheDocument();
    expect(screen.getByText("Pré-visualização indisponível")).toBeInTheDocument();
  });
});
