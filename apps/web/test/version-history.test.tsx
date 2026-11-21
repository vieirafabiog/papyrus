import "@testing-library/jest-dom/vitest";
import type { DocumentDetail, DocumentVersionHistoryItem } from "@docuflow/contracts";
import { docuflowTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionHistory } from "../src/features/documents/VersionHistory.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440004";
const AUTHOR_2_ID = "550e8400-e29b-41d4-a716-446655440014";
const VER_1_ID = "550e8400-e29b-41d4-a716-446655440021";
const VER_2_ID = "550e8400-e29b-41d4-a716-446655440022";
const VER_3_ID = "550e8400-e29b-41d4-a716-446655440023";
const FILE_1_ID = "550e8400-e29b-41d4-a716-446655440031";
const FILE_2_ID = "550e8400-e29b-41d4-a716-446655440032";
const REQ_ID = "550e8400-e29b-41d4-a716-446655440099";

function createDocument(overrides?: Partial<DocumentDetail>): DocumentDetail {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato ACME 2026",
    categoryId: CAT_ID,
    folderId: null,
    status: "APPROVED",
    currentVersionId: VER_2_ID,
    ownerUserId: OWNER_ID,
    issueDate: "2026-01-10",
    expirationDate: "2026-12-31",
    metadata: {},
    version: 3,
    createdAt: "2026-01-10T12:00:00Z",
    updatedAt: "2026-01-11T15:30:00Z",
    category: {
      id: CAT_ID,
      name: "Contratos",
      color: "#00639B",
      icon: "description",
      fields: [],
    },
    folder: null,
    owner: {
      id: OWNER_ID,
      fullName: "Ana Souza",
      email: "ana.souza@docuflow.local",
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

function renderVersionHistory(
  document = createDocument(),
  props?: {
    readonly onUploadNewVersion?: () => void;
    readonly onDownloadVersion?: (version: DocumentVersionHistoryItem) => Promise<void> | void;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <ThemeProvider theme={docuflowTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <VersionHistory
          document={document}
          onUploadNewVersion={props?.onUploadNewVersion}
          onDownloadVersion={props?.onDownloadVersion}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("VersionHistory", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("displays version number, date, author, note, current badge and respects server-authorized actions", async () => {
    const history: DocumentVersionHistoryItem[] = [
      {
        id: VER_2_ID,
        documentId: DOC_ID,
        versionNumber: 2,
        fileObjectId: FILE_2_ID,
        uploadedByUserId: AUTHOR_2_ID,
        uploadedByUser: {
          id: AUTHOR_2_ID,
          fullName: "Carlos Lima",
          email: "carlos.lima@docuflow.local",
        },
        changeNote: "Aditivo de reajuste",
        createdAt: "2026-01-15T14:30:00Z",
        isCurrent: true,
        fileObject: {
          id: FILE_2_ID,
          originalFileName: "contrato-v2.pdf",
          detectedContentType: "application/pdf",
          sizeBytes: 3072,
          checksumSha256: "b".repeat(64),
          status: "AVAILABLE",
        },
        permissions: {
          canDownload: true,
          canRestore: false,
        },
      },
      {
        id: VER_1_ID,
        documentId: DOC_ID,
        versionNumber: 1,
        fileObjectId: FILE_1_ID,
        uploadedByUserId: OWNER_ID,
        uploadedByUser: {
          id: OWNER_ID,
          fullName: "Ana Souza",
          email: "ana.souza@docuflow.local",
        },
        changeNote: null,
        createdAt: "2026-01-10T10:00:00Z",
        isCurrent: false,
        fileObject: {
          id: FILE_1_ID,
          originalFileName: "contrato-v1.pdf",
          detectedContentType: "application/pdf",
          sizeBytes: 1024,
          checksumSha256: "a".repeat(64),
          status: "AVAILABLE",
        },
        permissions: {
          canDownload: false,
          canRestore: true,
        },
      },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: history }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const onDownloadVersion = vi.fn();
    renderVersionHistory(createDocument(), { onDownloadVersion });

    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByText("Vigente")).toBeInTheDocument();
    expect(screen.getByText("Carlos Lima")).toBeInTheDocument();
    expect(screen.getByText("Aditivo de reajuste")).toBeInTheDocument();

    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("Sem observação registrada")).toBeInTheDocument();

    const downloadV2 = screen.getByRole("button", { name: "Baixar versão v2" });
    expect(downloadV2).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restaurar versão v2" })).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Baixar versão v1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restaurar versão v1" })).toBeInTheDocument();

    fireEvent.click(downloadV2);
    await waitFor(() => {
      expect(onDownloadVersion).toHaveBeenCalledWith(expect.objectContaining({ id: VER_2_ID }));
    });
  });

  it("restores an older version by creating an append-only new version without rewriting history", async () => {
    let currentHistory: DocumentVersionHistoryItem[] = [
      {
        id: VER_2_ID,
        documentId: DOC_ID,
        versionNumber: 2,
        fileObjectId: FILE_2_ID,
        uploadedByUserId: AUTHOR_2_ID,
        uploadedByUser: {
          id: AUTHOR_2_ID,
          fullName: "Carlos Lima",
          email: "carlos.lima@docuflow.local",
        },
        changeNote: "Versão com erro",
        createdAt: "2026-01-15T14:30:00Z",
        isCurrent: true,
        fileObject: {
          id: FILE_2_ID,
          originalFileName: "contrato-v2.pdf",
          detectedContentType: "application/pdf",
          sizeBytes: 3072,
          checksumSha256: "b".repeat(64),
          status: "AVAILABLE",
        },
        permissions: {
          canDownload: true,
          canRestore: false,
        },
      },
      {
        id: VER_1_ID,
        documentId: DOC_ID,
        versionNumber: 1,
        fileObjectId: FILE_1_ID,
        uploadedByUserId: OWNER_ID,
        uploadedByUser: {
          id: OWNER_ID,
          fullName: "Ana Souza",
          email: "ana.souza@docuflow.local",
        },
        changeNote: "Versão inicial aprovada",
        createdAt: "2026-01-10T10:00:00Z",
        isCurrent: false,
        fileObject: {
          id: FILE_1_ID,
          originalFileName: "contrato-v1.pdf",
          detectedContentType: "application/pdf",
          sizeBytes: 1024,
          checksumSha256: "a".repeat(64),
          status: "AVAILABLE",
        },
        permissions: {
          canDownload: true,
          canRestore: true,
        },
      },
    ];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-1" } }), { status: 200 });
      }
      if (url === `/api/v1/documents/${DOC_ID}/versions` && (!init || init.method === "GET")) {
        return new Response(JSON.stringify({ data: currentHistory }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url === `/api/v1/documents/${DOC_ID}/versions/${VER_1_ID}/restore` &&
        init?.method === "POST"
      ) {
        currentHistory = [
          {
            id: VER_3_ID,
            documentId: DOC_ID,
            versionNumber: 3,
            fileObjectId: FILE_1_ID,
            uploadedByUserId: OWNER_ID,
            uploadedByUser: {
              id: OWNER_ID,
              fullName: "Ana Souza",
              email: "ana.souza@docuflow.local",
            },
            changeNote: "Retorno à redação validada",
            createdAt: "2026-01-16T09:00:00Z",
            isCurrent: true,
            fileObject: {
              id: FILE_1_ID,
              originalFileName: "contrato-v1.pdf",
              detectedContentType: "application/pdf",
              sizeBytes: 1024,
              checksumSha256: "a".repeat(64),
              status: "AVAILABLE",
            },
            permissions: {
              canDownload: true,
              canRestore: false,
            },
          },
          ...currentHistory.map((item) => ({
            ...item,
            isCurrent: false,
            permissions: { canDownload: true, canRestore: true },
          })),
        ];

        return new Response(
          JSON.stringify({
            data: {
              id: VER_3_ID,
              documentId: DOC_ID,
              versionNumber: 3,
              fileObjectId: FILE_1_ID,
              uploadedByUserId: OWNER_ID,
              changeNote: "Retorno à redação validada",
              createdAt: "2026-01-16T09:00:00Z",
            },
            document: {
              id: DOC_ID,
              organizationId: ORG_ID,
              title: "Contrato ACME 2026",
              categoryId: CAT_ID,
              folderId: null,
              status: "APPROVED",
              currentVersionId: VER_3_ID,
              ownerUserId: OWNER_ID,
              issueDate: "2026-01-10",
              expirationDate: "2026-12-31",
              metadata: {},
              version: 4,
              createdAt: "2026-01-10T12:00:00Z",
              updatedAt: "2026-01-16T09:00:00Z",
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    renderVersionHistory(createDocument({ version: 3 }));

    const restoreBtn = await screen.findByRole("button", { name: "Restaurar versão v1" });
    fireEvent.click(restoreBtn);

    const dialog = await screen.findByRole("dialog", { name: "Restaurar versão v1" });
    expect(
      within(dialog).getByText(
        /nova versão vigente \(v3\).*histórico anterior continuará preservado/i,
      ),
    ).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Observação da restauração (opcional)"), {
      target: { value: "Retorno à redação validada" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar restauração" }));

    expect(
      await screen.findByText(
        "Versão v3 criada a partir da versão v1 preservando todo o histórico.",
      ),
    ).toBeInTheDocument();

    expect(await screen.findByText("v3")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("Versão inicial aprovada")).toBeInTheDocument();

    const restoreCall = fetchSpy.mock.calls.find(
      (call) => call[0] === `/api/v1/documents/${DOC_ID}/versions/${VER_1_ID}/restore`,
    );
    expect(restoreCall).toBeDefined();
    expect(JSON.parse(String(restoreCall?.[1]?.body))).toEqual({
      expectedVersion: 3,
      changeNote: "Retorno à redação validada",
    });
  });

  it("displays empty state and handles restore concurrency conflict cleanly in pt-BR", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const onUploadNewVersion = vi.fn();
    renderVersionHistory(createDocument(), { onUploadNewVersion });

    expect(await screen.findByText("Nenhuma versão registrada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enviar primeira versão" }));
    expect(onUploadNewVersion).toHaveBeenCalledTimes(1);
  });

  it("surfaces 409 version conflict message when restoring stale document version", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-1" } }), { status: 200 });
      }
      if (url === `/api/v1/documents/${DOC_ID}/versions`) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: VER_1_ID,
                documentId: DOC_ID,
                versionNumber: 1,
                fileObjectId: FILE_1_ID,
                uploadedByUserId: OWNER_ID,
                uploadedByUser: {
                  id: OWNER_ID,
                  fullName: "Ana Souza",
                  email: "ana.souza@docuflow.local",
                },
                changeNote: "Versão 1",
                createdAt: "2026-01-10T10:00:00Z",
                isCurrent: false,
                fileObject: null,
                permissions: {
                  canDownload: false,
                  canRestore: true,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (
        url === `/api/v1/documents/${DOC_ID}/versions/${VER_1_ID}/restore` &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            error: {
              code: "DOCUMENT_VERSION_CONFLICT",
              message: "O documento foi atualizado simultaneamente por outro usuário.",
              requestId: REQ_ID,
            },
          }),
          { status: 409 },
        );
      }
      return new Response(null, { status: 404 });
    });

    renderVersionHistory(createDocument());

    fireEvent.click(await screen.findByRole("button", { name: "Restaurar versão v1" }));
    const dialog = await screen.findByRole("dialog", { name: "Restaurar versão v1" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar restauração" }));

    expect(
      await screen.findByText("O documento foi atualizado simultaneamente por outro usuário."),
    ).toBeInTheDocument();
  });
});
