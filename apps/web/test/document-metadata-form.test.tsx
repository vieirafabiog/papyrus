import "@testing-library/jest-dom/vitest";
import type { DocumentDetail } from "@docuflow/contracts";
import { papyrusTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentMetadataForm } from "../src/features/documents/DocumentMetadataForm.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440001";
const CAT_ID = "550e8400-e29b-41d4-a716-446655440002";
const OWNER_ID = "550e8400-e29b-41d4-a716-446655440004";
const REQ_ID = "550e8400-e29b-41d4-a716-446655440099";

function createSampleDocument(): DocumentDetail {
  return {
    id: DOC_ID,
    organizationId: ORG_ID,
    title: "Contrato ACME 2026",
    categoryId: CAT_ID,
    folderId: null,
    status: "DRAFT",
    currentVersionId: null,
    ownerUserId: OWNER_ID,
    issueDate: "2026-01-10",
    expirationDate: "2026-12-31",
    metadata: {
      fornecedor: "ACME Ltda",
      valor: 1500,
      assinatura: "2026-01-10",
      confidencial: false,
      criticidade: "MEDIA",
      areas: ["JURIDICO"],
    },
    version: 3,
    createdAt: "2026-01-10T12:00:00Z",
    updatedAt: "2026-01-11T12:00:00Z",
    category: {
      id: CAT_ID,
      name: "Contratos",
      color: "#00639B",
      icon: "description",
      fields: [
        {
          id: "550e8400-e29b-41d4-a716-446655440010",
          key: "fornecedor",
          label: "Fornecedor",
          type: "TEXT",
          required: true,
          sortOrder: 0,
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440011",
          key: "valor",
          label: "Valor do contrato",
          type: "NUMBER",
          required: true,
          sortOrder: 1,
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440012",
          key: "assinatura",
          label: "Data de assinatura",
          type: "DATE",
          required: false,
          sortOrder: 2,
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440013",
          key: "confidencial",
          label: "Confidencial",
          type: "BOOLEAN",
          required: true,
          sortOrder: 3,
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440014",
          key: "criticidade",
          label: "Criticidade",
          type: "SINGLE_SELECT",
          required: true,
          options: ["BAIXA", "MEDIA", "ALTA"],
          sortOrder: 4,
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440015",
          key: "areas",
          label: "Áreas envolvidas",
          type: "MULTI_SELECT",
          required: true,
          options: ["JURIDICO", "FINANCEIRO"],
          sortOrder: 5,
        },
      ],
    },
    folder: null,
    owner: {
      id: OWNER_ID,
      fullName: "Ana Souza",
      email: "ana@docuflow.local",
    },
    currentVersion: null,
    tags: [],
    permissions: {
      canUpdate: true,
      canDelete: false,
      canUpload: true,
      canDownload: false,
    },
  };
}

function renderForm(onSaved = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return {
    onSaved,
    ...render(
      <ThemeProvider theme={papyrusTheme}>
        <CssBaseline />
        <QueryClientProvider client={queryClient}>
          <DocumentMetadataForm document={createSampleDocument()} onSaved={onSaved} />
        </QueryClientProvider>
      </ThemeProvider>,
    ),
  };
}

describe("DocumentMetadataForm", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders typed fields from category schema and shows client-side validation errors adjacent to invalid fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderForm();

    expect(screen.getByLabelText(/Fornecedor/i)).toHaveValue("ACME Ltda");
    expect(screen.getByLabelText(/Valor do contrato/i)).toHaveValue("1500");

    fireEvent.change(screen.getByLabelText(/Fornecedor/i), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText(/Valor do contrato/i), { target: { value: "abc" } });

    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    expect(await screen.findByText("This field is required.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid number.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps server-side field validation errors next to fields and submits normalized metadata cleanly", async () => {
    const onSaved = vi.fn();
    let callCount = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-1" } }), { status: 200 });
      }
      if (url === `/api/v1/documents/${DOC_ID}` && init?.method === "PATCH") {
        callCount += 1;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: "VALIDATION_ERROR",
                message: "Metadados inválidos para a categoria selecionada.",
                requestId: REQ_ID,
                details: {
                  fieldErrors: {
                    fornecedor: "Fornecedor bloqueado pela política de compliance.",
                  },
                },
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            data: {
              id: DOC_ID,
              organizationId: ORG_ID,
              title: "Contrato ACME Atualizado",
              categoryId: CAT_ID,
              folderId: null,
              status: "DRAFT",
              currentVersionId: null,
              ownerUserId: OWNER_ID,
              issueDate: "2026-01-10",
              expirationDate: "2026-12-31",
              metadata: {
                fornecedor: "ACME Aprovada",
                valor: 2500.5,
                assinatura: "2026-01-10",
                confidencial: true,
                criticidade: "MEDIA",
                areas: ["JURIDICO"],
              },
              version: 4,
              createdAt: "2026-01-10T12:00:00Z",
              updatedAt: "2026-01-12T12:00:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    renderForm(onSaved);

    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(
      await screen.findByText("Fornecedor bloqueado pela política de compliance."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Document title/i), {
      target: { value: "Contrato ACME Atualizado" },
    });
    fireEvent.change(screen.getByLabelText(/Fornecedor/i), {
      target: { value: "ACME Aprovada" },
    });
    fireEvent.change(screen.getByLabelText(/Valor do contrato/i), {
      target: { value: "2500.5" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /Confidencial/i }));

    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    const patchCall = fetchSpy.mock.calls.findLast(
      (call) => call[0] === `/api/v1/documents/${DOC_ID}`,
    );
    const sentBody = JSON.parse(String(patchCall?.[1]?.body)) as {
      expectedVersion: number;
      title: string;
      metadata: Record<string, unknown>;
    };
    expect(sentBody.expectedVersion).toBe(3);
    expect(sentBody.title).toBe("Contrato ACME Atualizado");
    expect(sentBody.metadata.valor).toBe(2500.5);
    expect(sentBody.metadata.confidencial).toBe(true);
  });
});
