import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "../src/layout/AppHeader.js";
import { registerServiceWorker } from "../src/pwa/registerServiceWorker.js";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "..", "public");

describe("PWA manifest, icons, security-first service worker, and install prompt", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("provides a valid Web App Manifest and real PNG icons matching the papyrus palette", () => {
    const manifestRaw = readFileSync(path.join(PUBLIC_DIR, "manifest.webmanifest"), "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      readonly name: string;
      readonly short_name: string;
      readonly start_url: string;
      readonly display: string;
      readonly theme_color: string;
      readonly background_color: string;
      readonly icons: readonly {
        readonly src: string;
        readonly sizes: string;
        readonly type: string;
        readonly purpose?: string;
      }[];
    };

    expect(manifest.name).toBe("papyrus");
    expect(manifest.short_name).toBe("papyrus");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe("#1F5C4D");
    expect(manifest.background_color).toBe("#FAF8F4");

    const pngIcons = manifest.icons.filter((icon) => icon.type === "image/png");
    expect(pngIcons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512", "512x512"]);
    expect(pngIcons.some((icon) => icon.purpose === "maskable")).toBe(true);

    // Verify every PNG icon on disk has a valid PNG signature and expected IHDR dimensions.
    for (const [relPath, expectedSize] of [
      ["icons/icon-192.png", 192],
      ["icons/icon-512.png", 512],
      ["icons/icon-maskable-512.png", 512],
      ["icons/apple-touch-icon.png", 180],
    ] as const) {
      const buf = readFileSync(path.join(PUBLIC_DIR, relPath));
      expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(buf.readUInt32BE(16)).toBe(expectedSize);
      expect(buf.readUInt32BE(20)).toBe(expectedSize);
    }
  });

  it("enforces zero API caching in sw.js and provides a branded offline fallback", () => {
    const swSource = readFileSync(path.join(PUBLIC_DIR, "sw.js"), "utf8");
    expect(swSource).toContain('url.pathname.startsWith("/api/")');
    expect(swSource).toContain("/offline.html");

    const offlineHtml = readFileSync(path.join(PUBLIC_DIR, "offline.html"), "utf8");
    expect(offlineHtml).toContain("papyrus");
    expect(offlineHtml).toContain("You are offline");
    expect(offlineHtml).toContain("Você está sem conexão");
  });

  it("registers /sw.js cleanly when serviceWorker is available", async () => {
    const mockRegistration = { scope: "/" } as ServiceWorkerRegistration;
    const registerMock = vi.fn().mockResolvedValue(mockRegistration);
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerMock },
      configurable: true,
    });

    const result = await registerServiceWorker();
    expect(registerMock).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(result).toBe(mockRegistration);
  });

  it("shows the Install app button in AppHeader on beforeinstallprompt and hides after acceptance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AppHeader
              desktopCollapsed={false}
              onToggleMobileMenu={vi.fn()}
              onToggleDesktopSidebar={vi.fn()}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument();

    const promptSpy = vi.fn().mockResolvedValue(undefined);
    const installEvent = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
      platforms: readonly string[];
    };
    installEvent.platforms = ["web"];
    installEvent.prompt = promptSpy;
    installEvent.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });

    act(() => {
      window.dispatchEvent(installEvent);
    });

    const installBtn = await screen.findByRole("button", { name: "Install app" });
    expect(installBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(installBtn);
      await installEvent.userChoice;
    });

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument();
  });
});
