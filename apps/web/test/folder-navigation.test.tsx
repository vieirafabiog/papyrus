import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FoldersPage } from "../src/features/folders/FoldersPage.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_FOLDER_ID = "22222222-2222-4222-8222-222222222222";
const CHILD_FOLDER_ID = "33333333-3333-4333-8333-333333333333";
const FORBIDDEN_FOLDER_ID = "44444444-4444-4444-8444-444444444444";
const REMOVED_FOLDER_ID = "55555555-5555-4555-8555-555555555555";
const ARCHIVED_FOLDER_ID = "66666666-6666-4666-8666-666666666666";
const DOC_ID = "77777777-7777-4777-8777-777777777777";
const CAT_ID = "88888888-8888-4888-8888-888888888888";
const OWNER_ID = "99999999-9999-4999-8999-999999999999";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderFoldersPage(initialPath = "/folders") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <ThemeProvider theme={papyrusTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/folders" element={<FoldersPage />} />
            <Route path="/folders/:folderId" element={<FoldersPage />} />
            <Route path="/documents/:id" element={<h1>Document Details</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("FoldersPage — hierarchical breadcrumbs, navigation authorization and removed/archived handling", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("navigates folder hierarchy, validates server authorization per breadcrumb level, and opens documents", async () => {
    const requestedUrls: string[] = [];

    const rootFolder = {
      id: ROOT_FOLDER_ID,
      organizationId: ORG_ID,
      parentId: null,
      name: "Jurídico",
      materializedPath: "/Jurídico",
      status: "ACTIVE",
      createdAt: "2026-11-20T10:00:00.000Z",
      updatedAt: "2026-11-20T10:00:00.000Z",
    };

    const childFolder = {
      id: CHILD_FOLDER_ID,
      organizationId: ORG_ID,
      parentId: ROOT_FOLDER_ID,
      name: "Contratos 2026",
      materializedPath: "/Jurídico/Contratos 2026",
      status: "ACTIVE",
      createdAt: "2026-11-20T10:05:00.000Z",
      updatedAt: "2026-11-20T10:05:00.000Z",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.includes("/folders?page=1") && url.includes("rootOnly=true")) {
        return jsonResponse({
          data: {
            items: [rootFolder],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
          },
        });
      }

      if (url.endsWith(`/folders/${ROOT_FOLDER_ID}`)) {
        return jsonResponse({ data: rootFolder });
      }

      if (url.endsWith(`/folders/${CHILD_FOLDER_ID}`)) {
        return jsonResponse({ data: childFolder });
      }

      if (url.includes(`parentId=${ROOT_FOLDER_ID}`)) {
        return jsonResponse({
          data: {
            items: [childFolder],
            pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
          },
        });
      }

      if (url.includes(`parentId=${CHILD_FOLDER_ID}`)) {
        return jsonResponse({
          data: {
            items: [],
            pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
          },
        });
      }

      if (url.includes("/documents/search?rootOnly=true")) {
        return jsonResponse({
          items: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              title: "Documento na Raiz",
              categoryId: CAT_ID,
              folderId: null,
              status: "DRAFT",
              currentVersionId: null,
              ownerUserId: OWNER_ID,
              issueDate: null,
              expirationDate: null,
              version: 1,
              createdAt: "2026-11-20T10:00:00.000Z",
              updatedAt: "2026-11-20T10:00:00.000Z",
            },
          ],
          pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
        });
      }

      if (url.includes(`/documents/search?folderId=${ROOT_FOLDER_ID}`)) {
        return jsonResponse({
          items: [],
          pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        });
      }

      if (url.includes(`/documents/search?folderId=${CHILD_FOLDER_ID}`)) {
        return jsonResponse({
          items: [
            {
              id: DOC_ID,
              title: "Aditivo Fornecedor Alpha",
              categoryId: CAT_ID,
              folderId: CHILD_FOLDER_ID,
              status: "APPROVED",
              currentVersionId: null,
              ownerUserId: OWNER_ID,
              issueDate: "2026-11-01",
              expirationDate: "2027-11-01",
              version: 1,
              createdAt: "2026-11-20T10:10:00.000Z",
              updatedAt: "2026-11-20T10:10:00.000Z",
            },
          ],
          pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
        });
      }

      return jsonResponse(
        { error: { code: "NOT_FOUND", message: "Não encontrado", requestId: "req" } },
        404,
      );
    });

    renderFoldersPage("/folders");

    expect(await screen.findByText("Jurídico")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Documents in root" })).toBeInTheDocument();
    expect(screen.getByText("Documento na Raiz")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Jurídico"));

    expect(await screen.findByText("Contratos 2026")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Contratos 2026"));

    expect(await screen.findByText("Aditivo Fornecedor Alpha")).toBeInTheDocument();

    const breadcrumbs = screen.getByRole("navigation", {
      name: "Folder hierarchy",
    });
    expect(breadcrumbs).toHaveTextContent("Root");
    expect(breadcrumbs).toHaveTextContent("Jurídico");
    expect(breadcrumbs).toHaveTextContent("Contratos 2026");

    // Re-verifies authorization on ancestor breadcrumb click
    fireEvent.click(screen.getByRole("button", { name: "Jurídico" }));
    await waitFor(() => {
      expect(
        requestedUrls.filter((u) => u.endsWith(`/folders/${ROOT_FOLDER_ID}`)).length,
      ).toBeGreaterThanOrEqual(2);
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Jurídico" })).toBeInTheDocument();
  });

  it("displays explicit access denied notice on 403 and restricted ancestor breadcrumb safely", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith(`/folders/${FORBIDDEN_FOLDER_ID}`)) {
        return jsonResponse(
          {
            error: {
              code: "FORBIDDEN",
              message: "Você não possui permissão para acessar esta pasta.",
              requestId: "req-403",
            },
          },
          403,
        );
      }

      if (url.endsWith(`/folders/${CHILD_FOLDER_ID}`)) {
        return jsonResponse({
          data: {
            id: CHILD_FOLDER_ID,
            organizationId: ORG_ID,
            parentId: FORBIDDEN_FOLDER_ID,
            name: "Subpasta Autorizada",
            materializedPath: "/Restrita/Subpasta Autorizada",
            status: "ACTIVE",
            createdAt: "2026-11-20T10:00:00.000Z",
            updatedAt: "2026-11-20T10:00:00.000Z",
          },
        });
      }

      if (url.includes(`parentId=${CHILD_FOLDER_ID}`)) {
        return jsonResponse({
          data: { items: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
        });
      }

      if (url.includes(`/documents/search?folderId=${CHILD_FOLDER_ID}`)) {
        return jsonResponse({
          items: [],
          pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        });
      }

      if (url.includes("/documents/search?rootOnly=true")) {
        return jsonResponse({
          items: [],
          pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        });
      }

      if (url.includes("rootOnly=true")) {
        return jsonResponse({
          data: { items: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
        });
      }

      return jsonResponse({}, 404);
    });

    // Subfolder authorized while parent is 403 -> shows restricted ancestor marker without leaking parent name
    const firstRender = renderFoldersPage(`/folders/${CHILD_FOLDER_ID}`);
    expect(await screen.findByText("Restricted parent folder")).toBeInTheDocument();
    firstRender.unmount();

    // Direct access to forbidden folder -> 403 warning with escape back to root
    renderFoldersPage(`/folders/${FORBIDDEN_FOLDER_ID}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Access denied: You do not have permission to perform this action.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to root" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Folders" })).toBeInTheDocument();
  });

  it("handles removed (404) and archived folders explicitly with recovery and disabled mutation actions", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith(`/folders/${REMOVED_FOLDER_ID}`)) {
        return jsonResponse(
          { error: { code: "NOT_FOUND", message: "Pasta não encontrada.", requestId: "req-404" } },
          404,
        );
      }

      if (url.endsWith(`/folders/${ARCHIVED_FOLDER_ID}`)) {
        return jsonResponse({
          data: {
            id: ARCHIVED_FOLDER_ID,
            organizationId: ORG_ID,
            parentId: null,
            name: "Arquivo Morto 2024",
            materializedPath: "/Arquivo Morto 2024",
            status: "ARCHIVED",
            createdAt: "2026-11-20T10:00:00.000Z",
            updatedAt: "2026-11-20T10:00:00.000Z",
          },
        });
      }

      if (url.includes(`parentId=${ARCHIVED_FOLDER_ID}`)) {
        return jsonResponse({
          data: { items: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
        });
      }

      if (url.includes(`/documents/search?folderId=${ARCHIVED_FOLDER_ID}`)) {
        return jsonResponse({
          items: [],
          pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        });
      }

      if (url.includes("/documents/search?rootOnly=true")) {
        return jsonResponse({
          items: [],
          pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
        });
      }

      if (url.includes("rootOnly=true")) {
        return jsonResponse({
          data: { items: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
        });
      }

      return jsonResponse({}, 404);
    });

    const removedView = renderFoldersPage(`/folders/${REMOVED_FOLDER_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Folder removed or not found" }),
    ).toBeInTheDocument();
    removedView.unmount();

    renderFoldersPage(`/folders/${ARCHIVED_FOLDER_ID}`);
    expect(
      await screen.findByText(
        "This folder is archived. You cannot create subfolders or upload new documents here.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New folder" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive folder" })).toBeDisabled();
  });
});
