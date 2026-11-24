import "@testing-library/jest-dom/vitest";
import { ThemeProvider } from "@mui/material";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PapyrusLogo, PapyrusMark, papyrusTheme } from "../src/index.js";

describe("PapyrusLogo and PapyrusMark", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders lowercase papyrus wordmark and decorative SVG mark by default", () => {
    const { container } = render(
      <ThemeProvider theme={papyrusTheme}>
        <PapyrusLogo size="md" showTagline />
      </ThemeProvider>,
    );

    expect(screen.getByText("papyrus")).toBeInTheDocument();
    expect(screen.getByText("Gestão Eletrônica de Documentos")).toBeInTheDocument();
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("viewBox", "0 0 48 48");
  });

  it("exposes accessible img role and title when PapyrusMark is used standalone", () => {
    render(
      <ThemeProvider theme={papyrusTheme}>
        <PapyrusMark size={32} title="Logo papyrus" />
      </ThemeProvider>,
    );

    expect(screen.getByRole("img", { name: "Logo papyrus" })).toBeInTheDocument();
  });
});
