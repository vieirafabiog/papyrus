import "@testing-library/jest-dom/vitest";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentDetailsPage } from "../src/features/documents/DocumentDetailsPage.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const FOLDER_ID = "550e8400-e29b-41d4-a716-446655440003";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440004";
const VER_ID = "550e8400-e29b-41d4-a716-446655440005";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440006";
const FIELD_1_ID = "550e8400-e29b-41d4-a716-446655440007";
const FIELD_2_ID = "550e8400-e29b-41d4-a716-446655440008";
const TAG_ID = "550e8400-e29b-41d4-a716-446655440009";
const REQ_ID = "550e8400-e29b-41d4-a716-446655440099";

function renderDetailsPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/documents/${DOC_ID}`]}>
          <Routes>
            <Route path="/documents/:id" element={<DocumentDetailsPage />} />
            <Route path="/documents" element={<h1>Lista de documentos</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("DocumentDetailsPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders document metadata, category, folder, status, owner, formatted dates, file availability and tags", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/v1/documents/${DOC_ID}`) {
        return new Response(
          JSON.stringify({
            data: {
              id: DOC_ID,
              organizationId: ORG_ID,
              title: "Contrato ACME 2026",
              categoryId: CAT_ID,
              folderId: FOLDER_ID,
              status: "APPROVED",
              currentVersionId: VER_ID,
              ownerUserId: OWNER_ID,
              issueDate: "2026-01-10",
              expirationDate: "2026-12-31",
              metadata: { fornecedor: "ACME Serviços", confidencial: true },
              version: 2,
              createdAt: "2026-01-10T12:00:00Z",
              updatedAt: "2026-01-11T15:30:00Z",
              category: {
                id: CAT_ID,
                name: "Contratos",
                color: "#00639B",
                icon: "description",
                fields: [
                  {
                    id: FIELD_1_ID,
                    key: "fornecedor",
                    label: "Fornecedor",
                    type: "TEXT",
                    required: true,
                    sortOrder: 0,
                  },
                  {
                    id: FIELD_2_ID,
                    key: "confidencial",
                    label: "Cláusula de Sigilo",
                    type: "BOOLEAN",
                    required: false,
                    sortOrder: 1,
                  },
                ],
              },
              folder: {
                id: FOLDER_ID,
                name: "Jurídico",
                materializedPath: `/${FOLDER_ID}`,
              },
              owner: {
                id: OWNER_ID,
                fullName: "Ana Souza",
                email: "ana.souza@docuflow.local",
              },
              currentVersion: {
                id: VER_ID,
                versionNumber: 1,
                fileObjectId: FILE_ID,
                uploadedByUserId: OWNER_ID,
                changeNote: "Versão assinada",
                createdAt: "2026-01-10T12:00:00Z",
                fileObject: {
                  id: FILE_ID,
                  originalFileName: "contrato-acme.pdf",
                  detectedContentType: "application/pdf",
                  sizeBytes: 2048,
                  checksumSha256: "a".repeat(64),
                  status: "AVAILABLE",
                },
              },
              tags: [
                {
                  id: TAG_ID,
                  organizationId: ORG_ID,
                  name: "Vigente",
                  normalizedName: "vigente",
                  color: "#2E7D32",
                  createdAt: "2026-01-10T12:00:00Z",
                },
              ],
              permissions: {
                canUpdate: false,
                canDelete: false,
                canUpload: false,
                canDownload: true,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `/api/v1/documents/${DOC_ID}/tags`) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: TAG_ID,
                organizationId: ORG_ID,
                name: "Vigente",
                normalizedName: "vigente",
                color: "#2E7D32",
                createdAt: "2026-01-10T12:00:00Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === `/api/v1/documents/${DOC_ID}/versions`) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: VER_ID,
                documentId: DOC_ID,
                versionNumber: 1,
                fileObjectId: FILE_ID,
                uploadedByUserId: OWNER_ID,
                uploadedByUser: {
                  id: OWNER_ID,
                  fullName: "Ana Souza",
                  email: "ana.souza@docuflow.local",
                },
                changeNote: "Versão assinada",
                createdAt: "2026-01-10T12:00:00Z",
                isCurrent: true,
                fileObject: {
                  id: FILE_ID,
                  originalFileName: "contrato-acme.pdf",
                  detectedContentType: "application/pdf",
                  sizeBytes: 2048,
                  checksumSha256: "a".repeat(64),
                  status: "AVAILABLE",
                },
                permissions: {
                  canDownload: true,
                  canRestore: false,
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith(`/api/v1/documents/${DOC_ID}/preview`)) {
        return new Response(new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" }), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }
      if (url.startsWith("/api/v1/tags")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [],
              pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    renderDetailsPage();

    expect(await screen.findByRole("heading", { name: "Contrato ACME 2026" })).toBeInTheDocument();
    expect(screen.getByText("Aprovado")).toBeInTheDocument();
    expect(screen.getByText("Contratos")).toBeInTheDocument();
    expect(screen.getByText("Jurídico")).toBeInTheDocument();
    expect(screen.getAllByText("Ana Souza").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("10/01/2026")).toBeInTheDocument();
    expect(screen.getByText("31/12/2026")).toBeInTheDocument();
    expect(screen.getByText("ACME Serviços")).toBeInTheDocument();
    expect(screen.getByText("Cláusula de Sigilo")).toBeInTheDocument();
    expect(screen.getByText("Sim")).toBeInTheDocument();
    expect(screen.getAllByText(/contrato-acme\.pdf/i).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText("Versão assinada")).toBeInTheDocument();
    expect((await screen.findAllByText("Vigente")).length).toBeGreaterThanOrEqual(2);
  });

  it("renders authorization error when server denies document detail access (403)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "Você não possui permissão para acessar este documento.",
            requestId: REQ_ID,
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderDetailsPage();

    expect(
      await screen.findByText(/Você não possui permissão para acessar este documento\./i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Voltar para documentos" }));
    expect(await screen.findByRole("heading", { name: "Lista de documentos" })).toBeInTheDocument();
  });
});
