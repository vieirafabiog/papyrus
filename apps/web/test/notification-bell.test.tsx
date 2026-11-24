import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { UiLocaleProvider, papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "../src/components/NotificationBell.js";
import { I18nProvider, resetUiLocaleForTests } from "../src/i18n/index.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440001";
const NOTIF_1_ID = "550e8400-e29b-41d4-a716-446655440011";
const NOTIF_2_ID = "550e8400-e29b-41d4-a716-446655440012";
const TASK_1_ID = "550e8400-e29b-41d4-a716-446655440021";
const DOC_1_ID = "550e8400-e29b-41d4-a716-446655440031";

function renderNotificationBell() {
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
            <MemoryRouter initialEntries={["/"]}>
              <Routes>
                <Route path="/" element={<NotificationBell />} />
                <Route path="/tasks/:id" element={<h1>Task Details</h1>} />
                <Route path="/documents/:id" element={<h1>Document Details</h1>} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("NotificationBell", () => {
  afterEach(() => {
    cleanup();
    resetUiLocaleForTests();
    vi.restoreAllMocks();
  });

  it("displays unread badge count, marks a single notification read on API confirmation, and navigates", async () => {
    let itemsState = [
      {
        id: NOTIF_1_ID,
        recipientUserId: USER_ID,
        channel: "INTERNAL" as const,
        kind: "TASK_ASSIGNED" as const,
        title: "Nova tarefa: Revisão Jurídica",
        body: "Você recebeu uma tarefa no documento Contrato Sigma.",
        resourceType: "WORKFLOW_TASK",
        resourceId: TASK_1_ID,
        readAt: null as string | null,
        createdAt: "2026-11-21T10:00:00Z",
      },
      {
        id: NOTIF_2_ID,
        recipientUserId: USER_ID,
        channel: "INTERNAL" as const,
        kind: "DOCUMENT_EXPIRATION" as const,
        title: "Vencimento próximo: Laudo Técnico",
        body: "O documento vencerá em 30/11/2026.",
        resourceType: "DOCUMENT",
        resourceId: DOC_1_ID,
        readAt: "2026-11-20T09:00:00Z" as string | null,
        createdAt: "2026-11-20T08:00:00Z",
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.startsWith("/api/v1/notifications?")) {
        const parsed = new URL(url, "http://localhost");
        const unreadOnly = parsed.searchParams.get("unreadOnly") === "true";
        const unreadCount = itemsState.filter((item) => item.readAt === null).length;
        const filtered = unreadOnly
          ? itemsState.filter((item) => item.readAt === null)
          : itemsState;
        return new Response(
          JSON.stringify({
            data: {
              items: filtered,
              unreadCount,
              pagination: { page: 1, pageSize: 20, totalItems: filtered.length, totalPages: 1 },
            },
          }),
          { status: 200 },
        );
      }

      if (url === "/api/v1/auth/csrf-token") {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-notif" } }), { status: 200 });
      }

      if (url === `/api/v1/notifications/${NOTIF_1_ID}/read`) {
        itemsState = itemsState.map((item) =>
          item.id === NOTIF_1_ID ? { ...item, readAt: "2026-11-21T11:00:00Z" } : item,
        );
        return new Response(JSON.stringify({ data: itemsState[0] }), { status: 200 });
      }

      return new Response(null, { status: 404 });
    });

    renderNotificationBell();

    const trigger = await screen.findByRole("button", { name: "Notifications (1 unread)" });
    fireEvent.click(trigger);

    expect(await screen.findByText("Nova tarefa: Revisão Jurídica")).toBeInTheDocument();
    expect(screen.getByText("Vencimento próximo: Laudo Técnico")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Mark as read: Nova tarefa: Revisão Jurídica" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Unread (0)" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Notifications", hidden: true })).toBeInTheDocument();
    expect(screen.getAllByText("Read")).toHaveLength(2);

    const openButtons = screen.getAllByRole("button", { name: "Open" });
    expect(openButtons.length).toBeGreaterThanOrEqual(1);
    const firstOpenButton = openButtons[0];
    if (firstOpenButton) {
      fireEvent.click(firstOpenButton);
    }
    expect(await screen.findByRole("heading", { name: "Task Details" })).toBeInTheDocument();
  });
});
