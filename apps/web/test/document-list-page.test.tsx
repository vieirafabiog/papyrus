import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentListPage } from "../src/features/documents/DocumentListPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_1_ID = "550e8400-e29b-41d4-a716-446655440001";
const DOC_2_ID = "550e8400-e29b-41d4-a716-446655440002";
const CAT_1_ID = "550e8400-e29b-41d4-a716-446655440011";
const FOLDER_1_ID = "550e8400-e29b-41d4-a716-446655440021";
const OWNER_1_ID = "550e8400-e29b-41d4-a716-446655440031";

function renderDocumentListPage(initialPath = "/documents") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={papyrusTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/documents" element={<DocumentListPage />} />
            <Route path="/documents/:id" element={<h1>Document Details</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function mockDocumentListFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/auth/me")) {
      return new Response(
        JSON.stringify({
          data: {
            user: {
              id: OWNER_1_ID,
              organizationId: ORG_ID,
              email: "admin@papyrus.local",
              fullName: "Ana Gestora",
              status: "ACTIVE",
              createdAt: "2026-01-01T10:00:00Z",
              updatedAt: "2026-01-01T10:00:00Z",
            },
            groups: [],
            roles: [
              {
                id: "550e8400-e29b-41d4-a716-446655440041",
                key: "admin",
                name: "Administrator",
                description: null,
                isSystem: true,
              },
            ],
            permissions: [],
            sessionExpiresAt: "2026-12-31T10:00:00Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.startsWith("/api/v1/categories")) {
      return new Response(
        JSON.stringify({
          data: {
            items: [
              {
                id: CAT_1_ID,
                organizationId: ORG_ID,
                name: "Contratos",
                description: null,
                color: "#00639B",
                icon: null,
                isActive: true,
                createdAt: "2026-01-01T10:00:00Z",
                updatedAt: "2026-01-01T10:00:00Z",
              },
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
          },
        }),
        { status: 200 },
      );
    }

    if (url.startsWith("/api/v1/folders")) {
      return new Response(
        JSON.stringify({
          data: {
            items: [
              {
                id: FOLDER_1_ID,
                organizationId: ORG_ID,
                parentId: null,
                name: "Jurídico",
                materializedPath: `/${FOLDER_1_ID}`,
                status: "ACTIVE",
                createdAt: "2026-01-01T10:00:00Z",
                updatedAt: "2026-01-01T10:00:00Z",
              },
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
          },
        }),
        { status: 200 },
      );
    }

    if (url === "/api/v1/admin/users") {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: OWNER_1_ID,
              organizationId: ORG_ID,
              email: "admin@papyrus.local",
              fullName: "Ana Gestora",
              status: "ACTIVE",
              createdAt: "2026-01-01T10:00:00Z",
              updatedAt: "2026-01-01T10:00:00Z",
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.startsWith("/api/v1/documents/search")) {
      const parsedUrl = new URL(url, "http://localhost");
      const page = Number(parsedUrl.searchParams.get("page") ?? "1");
      const items =
        page === 2
          ? [
              {
                id: DOC_2_ID,
                title: "Aditivo Página 2",
                categoryId: CAT_1_ID,
                folderId: null,
                status: "DRAFT",
                currentVersionId: null,
                ownerUserId: OWNER_1_ID,
                issueDate: null,
                expirationDate: "2026-10-15",
                version: 1,
                createdAt: "2026-01-05T10:00:00Z",
                updatedAt: "2026-01-06T10:00:00Z",
              },
            ]
          : [
              {
                id: DOC_1_ID,
                title: "Contrato ACME Principal",
                categoryId: CAT_1_ID,
                folderId: FOLDER_1_ID,
                status: "APPROVED",
                currentVersionId: null,
                ownerUserId: OWNER_1_ID,
                issueDate: "2026-01-10",
                expirationDate: "2026-12-31",
                version: 1,
                createdAt: "2026-01-10T10:00:00Z",
                updatedAt: "2026-01-12T10:00:00Z",
              },
            ];

      return new Response(
        JSON.stringify({
          items,
          pagination: {
            page,
            pageSize: 20,
            totalItems: 25,
            totalPages: 2,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(null, { status: 404 });
  });
}

describe("DocumentListPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders server-paginated documents, passes category/folder/status/owner/expiration filters and sorting to backend, and navigates to details", async () => {
    const fetchSpy = mockDocumentListFetch();
    renderDocumentListPage();

    expect(await screen.findByText("Contrato ACME Principal")).toBeInTheDocument();
    expect(screen.getByText("Contratos")).toBeInTheDocument();
    expect(screen.getByText("Jurídico")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("12/31/26")).toBeInTheDocument();

    // Filter by category
    fireEvent.mouseDown(screen.getByLabelText("Category"));
    fireEvent.click(await screen.findByRole("option", { name: "Contratos" }));

    // Filter by status
    fireEvent.mouseDown(screen.getByLabelText("Status"));
    fireEvent.click(await screen.findByRole("option", { name: "Approved" }));

    // Filter by folder
    fireEvent.mouseDown(screen.getByLabelText("Folder"));
    fireEvent.click(await screen.findByRole("option", { name: "Jurídico" }));

    // Filter by owner
    fireEvent.mouseDown(screen.getByLabelText("Owner"));
    fireEvent.click(await screen.findByRole("option", { name: "Ana Gestora" }));

    // Filter by expiration dates
    fireEvent.change(screen.getByLabelText("Expiration from"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText("Expiration to"), {
      target: { value: "2026-12-31" },
    });

    await waitFor(() => {
      const searchCalls = fetchSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/v1/documents/search"));
      const last = searchCalls[searchCalls.length - 1] ?? "";
      expect(last).toContain(`categoryId=${CAT_1_ID}`);
      expect(last).toContain(`folderId=${FOLDER_1_ID}`);
      expect(last).toContain("status=APPROVED");
      expect(last).toContain(`ownerUserId=${OWNER_1_ID}`);
      expect(last).toContain("expirationFrom=2026-01-01");
      expect(last).toContain("expirationTo=2026-12-31");
    });

    // Server-side sort change on Title
    fireEvent.click(screen.getByRole("button", { name: "Title" }));
    await waitFor(() => {
      const searchCalls = fetchSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith("/api/v1/documents/search"));
      const last = searchCalls[searchCalls.length - 1] ?? "";
      expect(last).toContain("sortBy=title");
      expect(last).toContain("sortDirection=asc");
    });

    // Server-side pagination next page
    fireEvent.click(screen.getByRole("button", { name: /Next page/i }));
    expect(await screen.findByText("Aditivo Página 2")).toBeInTheDocument();

    // Navigate to document detail
    fireEvent.click(screen.getByRole("button", { name: "Open Aditivo Página 2" }));
    expect(await screen.findByRole("heading", { name: "Document Details" })).toBeInTheDocument();
  });

  it("validates inverted expiration range locally without sending invalid queries to the backend", async () => {
    const fetchSpy = mockDocumentListFetch();
    renderDocumentListPage();

    expect(await screen.findByText("Contrato ACME Principal")).toBeInTheDocument();
    const initialSearchCount = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("/api/v1/documents/search"),
    ).length;

    fireEvent.change(screen.getByLabelText("Expiration from"), {
      target: { value: "2026-12-31" },
    });
    fireEvent.change(screen.getByLabelText("Expiration to"), {
      target: { value: "2026-01-01" },
    });

    expect(
      await screen.findByText("The end expiration date must be on or after the start date."),
    ).toBeInTheDocument();

    const afterInvalidCount = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("/api/v1/documents/search"),
    ).length;
    expect(afterInvalidCount).toBe(initialSearchCount + 1);
  });
});
