import "@testing-library/jest-dom/vitest";
import { papyrusTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentTagsField } from "../src/features/tags/DocumentTagsField.js";
import { TagsPage } from "../src/features/tags/TagsPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const TAG_1_ID = "550e8400-e29b-41d4-a716-446655440010";
const TAG_2_ID = "550e8400-e29b-41d4-a716-446655440011";
const REQ_ID = "550e8400-e29b-41d4-a716-446655440099";

function renderWithProviders(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={papyrusTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("Tags management and document association UI", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists tags, creates a new tag and surfaces uniqueness conflict errors", async () => {
    let tags = [
      {
        id: TAG_1_ID,
        organizationId: ORG_ID,
        name: "Urgente",
        normalizedName: "urgente",
        color: "#C62828",
        createdAt: "2026-11-20T10:00:00Z",
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-123" } }), { status: 200 });
      }
      if (url.startsWith("/api/v1/tags") && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            data: {
              items: tags,
              pagination: { page: 1, pageSize: 20, totalItems: tags.length, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/v1/tags" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string; color?: string | null };
        if (body.name.toLowerCase() === "urgente") {
          return new Response(
            JSON.stringify({
              error: {
                code: "CONFLICT",
                message: "Já existe uma etiqueta cadastrada com este nome.",
                requestId: REQ_ID,
              },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }
        const created = {
          id: TAG_2_ID,
          organizationId: ORG_ID,
          name: body.name,
          normalizedName: body.name.toLowerCase(),
          color: body.color ?? null,
          createdAt: "2026-11-21T09:00:00Z",
        };
        tags = [...tags, created];
        return new Response(JSON.stringify({ data: created }), { status: 201 });
      }
      return new Response(null, { status: 404 });
    });

    renderWithProviders(<TagsPage />);

    expect(await screen.findByText("Urgente")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New tag" }));
    fireEvent.change(screen.getByLabelText(/Tag name/i), {
      target: { value: "Urgente" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tag" }));

    expect(
      await screen.findByText("This action conflicts with the current record state."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Tag name/i), {
      target: { value: "Revisão Fiscal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tag" }));

    expect(await screen.findByText("Revisão Fiscal")).toBeInTheDocument();
  });

  it("displays, creates, attaches and detaches tags on a document", async () => {
    let attached = [
      {
        id: TAG_1_ID,
        organizationId: ORG_ID,
        name: "Urgente",
        normalizedName: "urgente",
        color: "#C62828",
        createdAt: "2026-11-20T10:00:00Z",
      },
    ];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-123" } }), { status: 200 });
      }
      if (url === `/api/v1/documents/${DOC_ID}/tags` && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ data: attached }), { status: 200 });
      }
      if (url.startsWith("/api/v1/tags") && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            data: {
              items: attached,
              pagination: { page: 1, pageSize: 50, totalItems: attached.length, totalPages: 1 },
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/v1/tags" && init?.method === "POST") {
        const created = {
          id: TAG_2_ID,
          organizationId: ORG_ID,
          name: "Contratual",
          normalizedName: "contratual",
          color: null,
          createdAt: "2026-11-21T09:00:00Z",
        };
        return new Response(JSON.stringify({ data: created }), { status: 201 });
      }
      if (url === `/api/v1/documents/${DOC_ID}/tags` && init?.method === "POST") {
        attached = [
          ...attached,
          {
            id: TAG_2_ID,
            organizationId: ORG_ID,
            name: "Contratual",
            normalizedName: "contratual",
            color: null,
            createdAt: "2026-11-21T09:00:00Z",
          },
        ];
        return new Response(JSON.stringify({ data: attached }), { status: 201 });
      }
      if (url === `/api/v1/documents/${DOC_ID}/tags/${TAG_1_ID}` && init?.method === "DELETE") {
        attached = attached.filter((item) => item.id !== TAG_1_ID);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });

    renderWithProviders(<DocumentTagsField documentId={DOC_ID} canEdit />);

    expect(await screen.findByText("Urgente")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Create and attach tag"), {
      target: { value: "Contratual" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create tag" }));

    expect(await screen.findByText("Contratual")).toBeInTheDocument();

    const deleteButtons = screen.getAllByTestId("CancelIcon");
    const firstDeleteButton = deleteButtons[0];
    if (!firstDeleteButton) {
      throw new Error("Expected chip delete icon button");
    }
    fireEvent.click(firstDeleteButton);

    await waitFor(() => {
      expect(screen.queryByText("Urgente")).not.toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/documents/${DOC_ID}/tags/${TAG_1_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
