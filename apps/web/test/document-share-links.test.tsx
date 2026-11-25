import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentShareLinksPanel } from "../src/features/documents/DocumentShareLinksPanel.js";
import { PublicSharePage } from "../src/features/documents/PublicSharePage.js";

const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const VER_ID = "550e8400-e29b-41d4-a716-446655440002";
const LINK_ID = "550e8400-e29b-41d4-a716-446655440020";
const USER_ID = "550e8400-e29b-41d4-a716-446655440010";
const SHARE_TOKEN = "mock-public-share-token-abcdefghijklmnopqrstuvwxyz";

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <ThemeProvider theme={papyrusTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <DocumentShareLinksPanel
          documentId={DOC_ID}
          documentStatus="APPROVED"
          hasAvailableFile
          canDownload
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function renderPublicShare(token = SHARE_TOKEN) {
  return render(
    <ThemeProvider theme={papyrusTheme}>
      <CssBaseline />
      <MemoryRouter initialEntries={[`/share/${token}`]}>
        <Routes>
          <Route path="/share/:token" element={<PublicSharePage />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("Temporary document share links UI", () => {
  beforeEach(() => {
    document.cookie = "papyrus_csrf=test-csrf-share";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("creates a passcode-protected link, reveals the one-time URL once, and revokes it", async () => {
    const linksState: Array<Record<string, unknown>> = [];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === `/api/v1/documents/${DOC_ID}/share-links` && method === "GET") {
        return new Response(JSON.stringify({ data: { items: [...linksState] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === `/api/v1/documents/${DOC_ID}/share-links` && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          expiresInMinutes: number;
          maxUses?: number | null;
          allowDownload: boolean;
          passcode?: string | null;
          label?: string | null;
        };
        const created = {
          id: LINK_ID,
          documentId: DOC_ID,
          documentVersionId: VER_ID,
          label: body.label ?? null,
          allowDownload: body.allowDownload,
          requiresPasscode: Boolean(body.passcode),
          maxUses: body.maxUses ?? null,
          useCount: 0,
          expiresAt: "2026-12-01T12:00:00.000Z",
          revokedAt: null,
          lastAccessedAt: null,
          status: "ACTIVE",
          createdBy: { id: USER_ID, fullName: "Ana Gestora" },
          createdAt: "2026-11-25T12:00:00.000Z",
        };
        linksState.push(created);
        return new Response(JSON.stringify({ data: { link: created, shareToken: SHARE_TOKEN } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === `/api/v1/documents/${DOC_ID}/share-links/${LINK_ID}` && method === "DELETE") {
        if (linksState[0]) {
          linksState[0] = {
            ...linksState[0],
            status: "REVOKED",
            revokedAt: "2026-11-25T12:05:00.000Z",
          };
        }
        return new Response(JSON.stringify({ data: { revoked: true, shareLinkId: LINK_ID } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(null, { status: 404 });
    });

    renderPanel();
    expect(
      await screen.findByText("No temporary share links created for this document yet."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create temporary link" }));
    expect(
      await screen.findByRole("heading", { name: "New temporary share link" }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Access limit (optional)"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Access passcode (optional)"), {
      target: { value: "Segredo99" },
    });
    fireEvent.change(screen.getByLabelText("Internal note (optional)"), {
      target: { value: "Auditoria Externa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate secure link" }));

    expect(await screen.findByText("Share link ready")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const urlInput = screen.getByRole("textbox", { name: "Share link ready" }) as HTMLInputElement;
    expect(urlInput.value).toContain(`/share/${SHARE_TOKEN}`);

    const postCall = fetchSpy.mock.calls.find(
      (call) => call[0] === `/api/v1/documents/${DOC_ID}/share-links` && call[1]?.method === "POST",
    );
    expect((postCall?.[1]?.headers as Record<string, string>)["x-csrf-token"]).toBe(
      "test-csrf-share",
    );

    await waitFor(() => {
      expect(screen.getByText("Auditoria Externa")).toBeInTheDocument();
      expect(screen.getByText("Passcode protected")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("heading", { name: "Revoke share link" })).toBeInTheDocument();
    const revokeBtns = screen.getAllByRole("button", { name: "Revoke" });
    fireEvent.click(revokeBtns[revokeBtns.length - 1] as HTMLElement);

    expect(await screen.findByText("Share link revoked immediately.")).toBeInTheDocument();
  });

  it("unlocks a passcode-protected PublicSharePage, loads safe preview, and shows unavailable state on 404", async () => {
    let unlockedState = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === `/api/v1/share/${SHARE_TOKEN}` && method === "GET") {
        return new Response(
          JSON.stringify({
            data: {
              title: "Contrato Público",
              originalFileName: "notas.txt",
              detectedContentType: "text/plain",
              sizeBytes: 24,
              allowDownload: false,
              requiresPasscode: true,
              unlocked: unlockedState,
              expiresAt: "2026-12-01T12:00:00.000Z",
              maxUses: 5,
              remainingUses: 4,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === `/api/v1/share/${SHARE_TOKEN}/unlock` && method === "POST") {
        unlockedState = true;
        return new Response(
          JSON.stringify({
            data: { unlockToken: "signed-unlock-proof-token", expiresInSeconds: 300 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === `/api/v1/share/${SHARE_TOKEN}/content` && method === "GET") {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers["x-share-unlock"] !== "signed-unlock-proof-token") {
          return new Response(null, { status: 401 });
        }
        return new Response("Conteúdo público autorizado.", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      return new Response(null, { status: 404 });
    });

    renderPublicShare(SHARE_TOKEN);
    expect(await screen.findByRole("heading", { name: "Protected document" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Access passcode"), {
      target: { value: "Segredo99" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock document" }));

    expect(await screen.findByRole("heading", { name: "Contrato Público" })).toBeInTheDocument();
    expect(
      await screen.findByText("This link allows read-only preview. File download is disabled."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Conteúdo público autorizado.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Download original file" }),
    ).not.toBeInTheDocument();

    cleanup();
    renderPublicShare("invalid-expired-token");
    expect(
      await screen.findByRole("heading", { name: "Link unavailable or expired" }),
    ).toBeInTheDocument();
  });
});
