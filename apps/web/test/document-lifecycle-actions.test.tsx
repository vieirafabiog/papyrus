import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { DocumentDetail } from "@papyrus/contracts";
import { papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentLifecycleActions } from "../src/features/documents/DocumentLifecycleActions.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const FOLDER_A_ID = "550e8400-e29b-41d4-a716-446655440003";
const FOLDER_B_ID = "550e8400-e29b-41d4-a716-446655440013";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440004";

function createDoc(overrides?: Partial<DocumentDetail>): DocumentDetail {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato ACME 2026",
    categoryId: CAT_ID,
    folderId: FOLDER_A_ID,
    status: "APPROVED",
    currentVersionId: null,
    ownerUserId: OWNER_ID,
    issueDate: null,
    expirationDate: null,
    metadata: {},
    version: 2,
    createdAt: "2026-01-10T12:00:00Z",
    updatedAt: "2026-01-11T15:30:00Z",
    category: {
      id: CAT_ID,
      name: "Contratos",
      color: null,
      icon: null,
      fields: [],
    },
    folder: {
      id: FOLDER_A_ID,
      name: "Origem",
      materializedPath: `/${FOLDER_A_ID}`,
    },
    owner: {
      id: OWNER_ID,
      fullName: "Ana Souza",
      email: "ana.souza@papyrus.local",
    },
    currentVersion: null,
    tags: [],
    permissions: {
      canUpdate: true,
      canDelete: false,
      canUpload: true,
      canDownload: true,
    },
    ...overrides,
  };
}

describe("DocumentLifecycleActions", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hides move and archive buttons when user lacks UPDATE permission", () => {
    const queryClient = new QueryClient();
    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <QueryClientProvider client={queryClient}>
          <DocumentLifecycleActions
            document={createDoc({
              permissions: {
                canUpdate: false,
                canDelete: false,
                canUpload: false,
                canDownload: true,
              },
            })}
          />
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(screen.queryByRole("button", { name: "Move folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("moves document to selected active folder and archives eligible document with feedback", async () => {
    const onFeedback = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-1" } }), { status: 200 });
      }
      if (url.startsWith("/api/v1/folders")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: FOLDER_A_ID,
                  organizationId: ORG_ID,
                  parentId: null,
                  name: "Origem",
                  materializedPath: `/${FOLDER_A_ID}`,
                  status: "ACTIVE",
                  createdAt: "2026-01-10T10:00:00Z",
                  updatedAt: "2026-01-10T10:00:00Z",
                },
                {
                  id: FOLDER_B_ID,
                  organizationId: ORG_ID,
                  parentId: null,
                  name: "Destino",
                  materializedPath: `/${FOLDER_B_ID}`,
                  status: "ACTIVE",
                  createdAt: "2026-01-10T10:00:00Z",
                  updatedAt: "2026-01-10T10:00:00Z",
                },
              ],
              pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
            },
          }),
          { status: 200 },
        );
      }
      if (url === `/api/v1/documents/${DOC_ID}/move` && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              id: DOC_ID,
              organizationId: ORG_ID,
              title: "Contrato ACME 2026",
              categoryId: CAT_ID,
              folderId: FOLDER_B_ID,
              status: "APPROVED",
              currentVersionId: null,
              ownerUserId: OWNER_ID,
              issueDate: null,
              expirationDate: null,
              metadata: {},
              version: 3,
              createdAt: "2026-01-10T12:00:00Z",
              updatedAt: "2026-01-12T12:00:00Z",
            },
          }),
          { status: 200 },
        );
      }
      if (url === `/api/v1/documents/${DOC_ID}/archive` && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              id: DOC_ID,
              organizationId: ORG_ID,
              title: "Contrato ACME 2026",
              categoryId: CAT_ID,
              folderId: FOLDER_B_ID,
              status: "ARCHIVED",
              currentVersionId: null,
              ownerUserId: OWNER_ID,
              issueDate: null,
              expirationDate: null,
              metadata: {},
              version: 3,
              createdAt: "2026-01-10T12:00:00Z",
              updatedAt: "2026-01-12T12:00:00Z",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <QueryClientProvider client={queryClient}>
          <DocumentLifecycleActions document={createDoc()} onActionFeedback={onFeedback} />
        </QueryClientProvider>
      </ThemeProvider>,
    );

    // Move flow
    fireEvent.click(screen.getByRole("button", { name: "Move folder" }));
    const moveDialog = await screen.findByRole("dialog", { name: "Move document to folder" });
    const folderSelect = within(moveDialog).getByRole("combobox");
    await waitFor(() => {
      expect(folderSelect).not.toHaveAttribute("aria-disabled", "true");
    });
    fireEvent.mouseDown(folderSelect);
    fireEvent.click(await screen.findByRole("option", { name: "Destino" }));
    fireEvent.click(within(moveDialog).getByRole("button", { name: "Confirm move" }));

    await waitFor(() => {
      expect(onFeedback).toHaveBeenCalledWith({
        severity: "success",
        message: 'Document moved to "Destino".',
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Move document to folder" }),
      ).not.toBeInTheDocument();
    });

    // Archive flow
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const archiveDialog = await screen.findByRole("dialog", { name: "Archive document" });
    fireEvent.change(within(archiveDialog).getByLabelText("Archive reason (optional)"), {
      target: { value: "Contrato encerrado" },
    });
    fireEvent.click(within(archiveDialog).getByRole("button", { name: "Confirm archive" }));

    await waitFor(() => {
      expect(onFeedback).toHaveBeenCalledWith({
        severity: "success",
        message: "Document archived successfully.",
      });
    });

    const archiveCall = fetchSpy.mock.calls.find(
      (call) => call[0] === `/api/v1/documents/${DOC_ID}/archive`,
    );
    expect(JSON.parse(String(archiveCall?.[1]?.body))).toEqual({
      expectedVersion: 2,
      reason: "Contrato encerrado",
    });
  });
});
