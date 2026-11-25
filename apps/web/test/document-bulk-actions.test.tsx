import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentListPage } from "../src/features/documents/DocumentListPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_1_ID = "550e8400-e29b-41d4-a716-446655440001";
const DOC_2_ID = "550e8400-e29b-41d4-a716-446655440002";
const CAT_1_ID = "550e8400-e29b-41d4-a716-446655440011";
const FOLDER_1_ID = "550e8400-e29b-41d4-a716-446655440021";
const OWNER_1_ID = "550e8400-e29b-41d4-a716-446655440031";
const TAG_1_ID = "550e8400-e29b-41d4-a716-446655440051";

function renderDocumentListPage() {
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
        <MemoryRouter initialEntries={["/documents"]}>
          <Routes>
            <Route path="/documents" element={<DocumentListPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function createFetchMock(
  onBulkAction?: (payload: Record<string, unknown>) => Response | Promise<Response>,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }

    if (url.startsWith("/api/v1/tags") && (!init?.method || init.method === "GET")) {
      return new Response(
        JSON.stringify({
          data: {
            items: [
              {
                id: TAG_1_ID,
                organizationId: ORG_ID,
                name: "Urgente",
                normalizedName: "urgente",
                color: "#B3261E",
                createdByUserId: OWNER_1_ID,
                createdAt: "2026-01-01T10:00:00Z",
                updatedAt: "2026-01-01T10:00:00Z",
              },
            ],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.startsWith("/api/v1/documents/search")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: DOC_1_ID,
              title: "Contrato ACME",
              categoryId: CAT_1_ID,
              folderId: null,
              status: "APPROVED",
              currentVersionId: null,
              ownerUserId: OWNER_1_ID,
              issueDate: "2026-01-10",
              expirationDate: null,
              version: 1,
              createdAt: "2026-01-10T10:00:00Z",
              updatedAt: "2026-01-12T10:00:00Z",
            },
            {
              id: DOC_2_ID,
              title: "Política Interna",
              categoryId: CAT_1_ID,
              folderId: null,
              status: "DRAFT",
              currentVersionId: null,
              ownerUserId: OWNER_1_ID,
              issueDate: "2026-01-11",
              expirationDate: null,
              version: 1,
              createdAt: "2026-01-11T10:00:00Z",
              updatedAt: "2026-01-12T10:00:00Z",
            },
          ],
          pagination: { page: 1, pageSize: 20, totalItems: 2, totalPages: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "/api/v1/documents/bulk-actions" && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (onBulkAction) {
        return onBulkAction(payload);
      }
      const docIds = (payload.documentIds as string[]) ?? [];
      return new Response(
        JSON.stringify({
          data: {
            action: payload.action,
            totalRequested: docIds.length,
            succeededCount: docIds.length,
            failedCount: 0,
            results: docIds.map((documentId) => ({ documentId, status: "SUCCEEDED" })),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "/api/v1/documents/bulk-download" && init?.method === "POST") {
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    }

    return new Response(null, { status: 404 });
  });
}

describe("Document bulk actions UI", () => {
  beforeEach(() => {
    document.cookie = "papyrus_csrf=test-csrf-token";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("allows selecting multiple documents, moving folders, archiving, and clearing selection", async () => {
    const fetchSpy = createFetchMock();
    renderDocumentListPage();

    expect(await screen.findByText("Contrato ACME")).toBeInTheDocument();
    expect(screen.getByText("Política Interna")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Contrato ACME" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Política Interna" }));

    expect(await screen.findByText("2 selected")).toBeInTheDocument();

    // Move folder
    fireEvent.click(screen.getByRole("button", { name: "Move folder" }));
    expect(
      await screen.findByRole("heading", { name: "Move selected documents" }),
    ).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByLabelText("Destination folder"));
    fireEvent.click(await screen.findByRole("option", { name: "Jurídico" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));

    expect(await screen.findByText("2 document(s) moved successfully.")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    const moveCall = fetchSpy.mock.calls.find(
      (call) => call[0] === "/api/v1/documents/bulk-actions",
    );
    expect(moveCall).toBeDefined();
    expect((moveCall?.[1]?.headers as Record<string, string>)["x-csrf-token"]).toBe(
      "test-csrf-token",
    );
    expect(JSON.parse(String(moveCall?.[1]?.body))).toEqual({
      action: "MOVE",
      documentIds: [DOC_1_ID, DOC_2_ID],
      targetFolderId: FOLDER_1_ID,
    });

    // Selection cleared on full success -> select all via header checkbox and clear manually
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all items on this page" }));
    expect(await screen.findByText("2 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(
      await screen.findByRole("heading", { name: "Archive selected documents" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Archive reason (optional)"), {
      target: { value: "Encerramento anual" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    expect(await screen.findByText("2 document(s) archived successfully.")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Select one row and click Clear selection
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Contrato ACME" }));
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });

  it("applies tags, downloads a ZIP bundle with CSRF header, and displays partial failure warning on trash", async () => {
    const createObjectUrlSpy = vi.fn(() => "blob:mock-zip-url");
    const revokeObjectUrlSpy = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrlSpy,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrlSpy,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const fetchSpy = createFetchMock((payload) => {
      if (payload.action === "TRASH") {
        return new Response(
          JSON.stringify({
            data: {
              action: "TRASH",
              totalRequested: 2,
              succeededCount: 1,
              failedCount: 1,
              results: [
                { documentId: DOC_1_ID, status: "SUCCEEDED" },
                {
                  documentId: DOC_2_ID,
                  status: "FAILED",
                  errorCode: "DOCUMENT_TRASH_BLOCKED_BY_RETENTION",
                  message: "Documento protegido por retenção legal.",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const docIds = (payload.documentIds as string[]) ?? [];
      return new Response(
        JSON.stringify({
          data: {
            action: payload.action,
            totalRequested: docIds.length,
            succeededCount: docIds.length,
            failedCount: 0,
            results: docIds.map((documentId) => ({ documentId, status: "SUCCEEDED" })),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    renderDocumentListPage();
    expect(await screen.findByText("Contrato ACME")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all items on this page" }));
    expect(await screen.findByText("2 selected")).toBeInTheDocument();

    // Apply existing tag
    fireEvent.click(screen.getByRole("button", { name: "Apply tag" }));
    expect(
      await screen.findByRole("heading", { name: "Apply tag to selected documents" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Attach existing tag")).toBeEnabled();
    });
    fireEvent.mouseDown(screen.getByLabelText("Attach existing tag"));
    fireEvent.click(await screen.findByRole("option", { name: "Urgente" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply tag" }));
    expect(await screen.findByText("Tag applied to 2 document(s).")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Download ZIP
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Contrato ACME" }));
    fireEvent.click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(
      await screen.findByText("ZIP download started for 1 selected document(s)."),
    ).toBeInTheDocument();
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    const zipCall = fetchSpy.mock.calls.find(
      (call) => call[0] === "/api/v1/documents/bulk-download",
    );
    expect(zipCall).toBeDefined();
    expect((zipCall?.[1]?.headers as Record<string, string>)["x-csrf-token"]).toBe(
      "test-csrf-token",
    );

    // Move to trash with partial failure
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all items on this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    expect(
      await screen.findByRole("heading", { name: "Move selected documents to trash" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm move to trash" }));

    expect(
      await screen.findByText(/1 document\(s\) processed and 1 could not be updated/i),
    ).toBeInTheDocument();
  });
});
