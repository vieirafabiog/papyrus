import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentCommentsPanel } from "../src/features/documents/DocumentCommentsPanel.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const USER_1_ID = "550e8400-e29b-41d4-a716-446655440010";
const USER_2_ID = "550e8400-e29b-41d4-a716-446655440011";
const COMMENT_1_ID = "550e8400-e29b-41d4-a716-446655440021";

function renderPanel(status: "APPROVED" | "DELETED" = "APPROVED") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={papyrusTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <DocumentCommentsPanel documentId={DOC_ID} documentStatus={status} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("DocumentCommentsPanel", () => {
  beforeEach(() => {
    document.cookie = "papyrus_csrf=test-csrf-comments";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("autocompletes @mentions, posts a comment with CSRF token and mentionedUserIds, highlights mentions, and deletes own comment", async () => {
    const commentsState = [
      {
        id: COMMENT_1_ID,
        organizationId: ORG_ID,
        documentId: DOC_ID,
        author: { id: USER_1_ID, fullName: "Ana Gestora", email: "ana@papyrus.local" },
        body: "Revisão inicial concluída.",
        mentions: [],
        canDelete: true,
        createdAt: "2026-11-25T09:00:00.000Z",
        updatedAt: "2026-11-25T09:00:00.000Z",
      },
    ];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url.startsWith(`/api/v1/documents/${DOC_ID}/comments`) && method === "GET") {
        return new Response(
          JSON.stringify({
            data: {
              items: [...commentsState],
              pagination: {
                page: 1,
                pageSize: 20,
                totalItems: commentsState.length,
                totalPages: 1,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.startsWith(`/api/v1/documents/${DOC_ID}/mention-candidates`) && method === "GET") {
        return new Response(
          JSON.stringify({
            data: {
              items: [{ id: USER_2_ID, fullName: "Maria Silva", email: "maria@papyrus.local" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === `/api/v1/documents/${DOC_ID}/comments` && method === "POST") {
        const parsedBody = JSON.parse(String(init?.body)) as {
          body: string;
          mentionedUserIds: string[];
        };
        const created = {
          id: "550e8400-e29b-41d4-a716-446655440099",
          organizationId: ORG_ID,
          documentId: DOC_ID,
          author: { id: USER_1_ID, fullName: "Ana Gestora", email: "ana@papyrus.local" },
          body: parsedBody.body,
          mentions: [{ userId: USER_2_ID, fullName: "Maria Silva", email: "maria@papyrus.local" }],
          canDelete: true,
          createdAt: "2026-11-25T10:30:00.000Z",
          updatedAt: "2026-11-25T10:30:00.000Z",
        };
        commentsState.push(created);
        return new Response(JSON.stringify({ data: created }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === `/api/v1/documents/${DOC_ID}/comments/${COMMENT_1_ID}` && method === "DELETE") {
        const idx = commentsState.findIndex((item) => item.id === COMMENT_1_ID);
        if (idx >= 0) {
          commentsState.splice(idx, 1);
        }
        return new Response(JSON.stringify({ data: { deleted: true, commentId: COMMENT_1_ID } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(null, { status: 404 });
    });

    renderPanel("APPROVED");
    expect(await screen.findByText("Revisão inicial concluída.")).toBeInTheDocument();

    const textarea = screen.getByLabelText("Write a comment");
    fireEvent.change(textarea, {
      target: { value: "Por favor valide @mar", selectionStart: 21 },
    });

    const option = await screen.findByRole("button", { name: /Maria Silva/i });
    fireEvent.mouseDown(option);

    expect(textarea).toHaveValue("Por favor valide @Maria Silva ");
    expect(screen.getByText("@Maria Silva")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect(await screen.findByText("Comment posted.")).toBeInTheDocument();

    const postCall = fetchSpy.mock.calls.find(
      (call) => call[0] === `/api/v1/documents/${DOC_ID}/comments` && call[1]?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect((postCall?.[1]?.headers as Record<string, string>)["x-csrf-token"]).toBe(
      "test-csrf-comments",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      body: "Por favor valide @Maria Silva",
      mentionedUserIds: [USER_2_ID],
    });

    // Delete first comment via ConfirmDialog
    const deleteButtons = screen.getAllByRole("button", { name: "Delete comment" });
    expect(deleteButtons.length).toBeGreaterThan(0);
    fireEvent.click(deleteButtons[0] as HTMLElement);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const confirmDeleteButton = screen.getAllByRole("button", { name: "Delete comment" }).pop();
    expect(confirmDeleteButton).toBeDefined();
    fireEvent.click(confirmDeleteButton as HTMLElement);

    expect(await screen.findByText("Comment removed.")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Revisão inicial concluída.")).not.toBeInTheDocument();
    });
  });

  it("disables new comments when the document is in trash", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            items: [],
            pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderPanel("DELETED");
    expect(
      await screen.findByText("Comments are disabled while this document is in the trash."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Write a comment")).not.toBeInTheDocument();
  });
});
