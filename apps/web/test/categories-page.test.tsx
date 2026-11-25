import "@testing-library/jest-dom/vitest";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { UiLocaleProvider, papyrusTheme } from "@papyrus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoriesPage } from "../src/features/admin/CategoriesPage.js";
import { CategoryEditor } from "../src/features/admin/CategoryEditor.js";
import { I18nProvider } from "../src/i18n/index.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const CAT_1_ID = "550e8400-e29b-41d4-a716-446655440201";
const CAT_NEW_ID = "550e8400-e29b-41d4-a716-446655440202";
const FIELD_1_ID = "550e8400-e29b-41d4-a716-446655440401";
const FIELD_NEW_ID = "550e8400-e29b-41d4-a716-446655440402";
const CONN_S3_ID = "550e8400-e29b-41d4-a716-446655440102";

function buildSession(roleKey: "admin" | "viewer") {
  return {
    user: {
      id: "550e8400-e29b-41d4-a716-446655440010",
      organizationId: ORG_ID,
      email: `${roleKey}@papyrus.local`,
      fullName: roleKey === "admin" ? "Administradora" : "Consultor",
      status: "ACTIVE",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    },
    groups: [],
    roles: [
      {
        id: "550e8400-e29b-41d4-a716-446655440099",
        key: roleKey,
        name: roleKey === "admin" ? "Administrador" : "Consulta",
        description: null,
        isSystem: true,
      },
    ],
    permissions: [],
    sessionExpiresAt: "2026-12-31T10:00:00.000Z",
  };
}

function renderCategoriesPage() {
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
            <MemoryRouter>
              <CategoriesPage />
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("CategoriesPage & CategoryEditor (Step 14.05)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hides creation and mutation controls for read-only users while listing authorized categories", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession("viewer") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/categories")) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: CAT_1_ID,
                  organizationId: ORG_ID,
                  name: "Contratos",
                  description: "Contratos comerciais",
                  color: "#0F5C73",
                  icon: "description",
                  isActive: true,
                  createdAt: "2026-01-01T10:00:00.000Z",
                  updatedAt: "2026-02-01T10:00:00.000Z",
                },
              ],
              pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    renderCategoriesPage();

    expect(await screen.findByText("Contratos")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New category" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View fields" })).toBeInTheDocument();
  });

  it("creates a category and searches categories via server query parameters", async () => {
    let categories = [
      {
        id: CAT_1_ID,
        organizationId: ORG_ID,
        name: "Contratos",
        description: "Contratos comerciais",
        color: "#0F5C73",
        icon: "description",
        isActive: true,
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-02-01T10:00:00.000Z",
      },
    ];
    let capturedCreateBody: Record<string, unknown> | null = null;
    const listUrls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession("admin") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-cat-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/categories?") && method === "GET") {
        listUrls.push(url);
        const searchTerm = new URL(url, "http://localhost").searchParams.get("search") ?? "";
        const filtered = searchTerm
          ? categories.filter((cat) => cat.name.toLowerCase().includes(searchTerm.toLowerCase()))
          : categories;
        return new Response(
          JSON.stringify({
            data: {
              items: filtered,
              pagination: { page: 1, pageSize: 20, totalItems: filtered.length, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/categories") && method === "POST") {
        capturedCreateBody = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        const created = {
          id: CAT_NEW_ID,
          organizationId: ORG_ID,
          name: String(capturedCreateBody.name ?? ""),
          description: (capturedCreateBody.description as string | null) ?? null,
          color: (capturedCreateBody.color as string | null) ?? null,
          icon: (capturedCreateBody.icon as string | null) ?? null,
          isActive: true,
          createdAt: "2026-04-01T10:00:00.000Z",
          updatedAt: "2026-04-01T10:00:00.000Z",
        };
        categories = [...categories, created];
        return new Response(JSON.stringify({ data: created }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes(`/api/v1/categories/${CAT_NEW_ID}/fields`) && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-connections")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-routing-rules")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    renderCategoriesPage();

    expect(await screen.findByText("Contratos")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New category" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Category name/i), {
      target: { value: "Laudos Técnicos" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Category description/i), {
      target: { value: "Laudos de inspeção" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create category" }));

    await waitFor(() => {
      expect(capturedCreateBody).toMatchObject({
        name: "Laudos Técnicos",
        description: "Laudos de inspeção",
      });
    });

    // Transitions editor into full edit mode with custom fields and storage destination
    expect(await within(dialog).findByText("Custom metadata fields")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Search category"), {
      target: { value: "Laudos" },
    });
    await waitFor(() => {
      expect(listUrls.some((u) => u.includes("search=Laudos"))).toBe(true);
    });
    expect(await screen.findByText("Laudos Técnicos")).toBeInTheDocument();
  });

  it("adds custom SINGLE_SELECT field with options", async () => {
    let fields = [
      {
        id: FIELD_1_ID,
        categoryId: CAT_1_ID,
        key: "cnpj_fornecedor",
        label: "CNPJ do Fornecedor",
        type: "TEXT" as const,
        required: true,
        options: null,
        sortOrder: 0,
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    ];

    let capturedFieldCreate: Record<string, unknown> | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession("admin") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-cat-2a" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/categories?") && method === "GET") {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: CAT_1_ID,
                  organizationId: ORG_ID,
                  name: "Contratos",
                  description: null,
                  color: "#0F5C73",
                  icon: null,
                  isActive: true,
                  createdAt: "2026-01-01T10:00:00.000Z",
                  updatedAt: "2026-02-01T10:00:00.000Z",
                },
              ],
              pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith(`/api/v1/categories/${CAT_1_ID}/fields`) && method === "GET") {
        return new Response(JSON.stringify({ data: fields }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith(`/api/v1/categories/${CAT_1_ID}/fields`) && method === "POST") {
        capturedFieldCreate = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        const createdField = {
          id: FIELD_NEW_ID,
          categoryId: CAT_1_ID,
          key: String(capturedFieldCreate.key ?? ""),
          label: String(capturedFieldCreate.label ?? ""),
          type: "SINGLE_SELECT" as const,
          required: Boolean(capturedFieldCreate.required),
          options: (capturedFieldCreate.options as string[]) ?? [],
          sortOrder: Number(capturedFieldCreate.sortOrder ?? 1),
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        };
        fields = [...fields, createdField];
        return new Response(JSON.stringify({ data: createdField }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-connections") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-routing-rules") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <I18nProvider initialLocale="en-US">
        <UiLocaleProvider locale="en-US">
          <ThemeProvider theme={papyrusTheme}>
            <CssBaseline />
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <CategoryEditor
                  open
                  category={{
                    id: CAT_1_ID,
                    organizationId: ORG_ID,
                    name: "Contratos",
                    description: null,
                    color: "#0F5C73",
                    icon: null,
                    isActive: true,
                    createdAt: "2026-01-01T10:00:00.000Z",
                    updatedAt: "2026-02-01T10:00:00.000Z",
                  }}
                  canEditCategory
                  canManageStoragePolicy={false}
                  onClose={vi.fn()}
                  onFeedback={vi.fn()}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </UiLocaleProvider>
      </I18nProvider>,
    );

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("CNPJ do Fornecedor")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/Field label/i), {
      target: { value: "Regime Tributário" },
    });
    fireEvent.mouseDown(within(dialog).getByLabelText("Field type"));
    fireEvent.click(await screen.findByRole("option", { name: "Single select" }));

    fireEvent.change(within(dialog).getByLabelText("New selection option"), {
      target: { value: "Simples Nacional" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add option" }));

    fireEvent.change(within(dialog).getByLabelText("New selection option"), {
      target: { value: "Lucro Real" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add option" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));

    await waitFor(() => {
      expect(capturedFieldCreate).toMatchObject({
        key: "regime_tributario",
        label: "Regime Tributário",
        type: "SINGLE_SELECT",
        options: ["Simples Nacional", "Lucro Real"],
      });
    });
    expect(await within(dialog).findByText("Regime Tributário")).toBeInTheDocument();
  });

  it("removes a custom field with REMOVE_FROM_DOCUMENTS migration strategy", async () => {
    let fields = [
      {
        id: FIELD_1_ID,
        categoryId: CAT_1_ID,
        key: "cnpj_fornecedor",
        label: "CNPJ do Fornecedor",
        type: "TEXT" as const,
        required: true,
        options: null,
        sortOrder: 0,
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    ];

    let capturedDeleteBody: Record<string, unknown> | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession("admin") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-cat-2b" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/categories?") && method === "GET") {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: CAT_1_ID,
                  organizationId: ORG_ID,
                  name: "Contratos",
                  description: null,
                  color: "#0F5C73",
                  icon: null,
                  isActive: true,
                  createdAt: "2026-01-01T10:00:00.000Z",
                  updatedAt: "2026-02-01T10:00:00.000Z",
                },
              ],
              pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith(`/api/v1/categories/${CAT_1_ID}/fields`) && method === "GET") {
        return new Response(JSON.stringify({ data: fields }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.endsWith(`/api/v1/categories/${CAT_1_ID}/fields/${FIELD_1_ID}`) &&
        method === "DELETE"
      ) {
        capturedDeleteBody = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        fields = fields.filter((f) => f.id !== FIELD_1_ID);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/api/v1/admin/storage-connections") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-routing-rules") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    renderCategoriesPage();

    expect(await screen.findByText("Contratos")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fields & storage" }));

    const dialog = await screen.findByRole("dialog");
    const cnpjLabel = await within(dialog).findByText("CNPJ do Fornecedor");
    const cnpjRow = cnpjLabel.closest("tr");
    if (!cnpjRow) {
      throw new Error("Expected CNPJ field row");
    }
    fireEvent.click(within(cnpjRow).getByRole("button", { name: "Remove" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm removal" }));

    await waitFor(() => {
      expect(capturedDeleteBody).toEqual({
        migrationStrategy: { type: "REMOVE_FROM_DOCUMENTS" },
      });
    });
  });

  it("applies per-category storage routing policy inside CategoryEditor", async () => {
    let capturedStorageRuleBody: Record<string, unknown> | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession("admin") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-cat-3" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/categories?") && method === "GET") {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: CAT_1_ID,
                  organizationId: ORG_ID,
                  name: "Contratos",
                  description: null,
                  color: "#0F5C73",
                  icon: null,
                  isActive: true,
                  createdAt: "2026-01-01T10:00:00.000Z",
                  updatedAt: "2026-02-01T10:00:00.000Z",
                },
              ],
              pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith(`/api/v1/categories/${CAT_1_ID}/fields`) && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-connections") && method === "GET") {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: CONN_S3_ID,
                organizationId: ORG_ID,
                name: "S3 Contratos",
                kind: "s3",
                isDefault: false,
                status: "ACTIVE",
                nonSecretConfig: {
                  endpoint: "https://s3.local",
                  region: "us-east-1",
                  bucket: "contratos",
                },
                hasCredentials: true,
                lastHealthCheckAt: null,
                lastHealthMessage: null,
                createdAt: "2026-01-01T10:00:00.000Z",
                updatedAt: "2026-01-01T10:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/admin/storage-routing-rules") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-routing-rules") && method === "PUT") {
        capturedStorageRuleBody = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: {
              id: "550e8400-e29b-41d4-a716-446655440399",
              organizationId: ORG_ID,
              categoryId: CAT_1_ID,
              storageConnectionId: CONN_S3_ID,
              createdAt: "2026-04-02T10:00:00.000Z",
              updatedAt: "2026-04-02T10:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    renderCategoriesPage();

    expect(await screen.findByText("Contratos")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fields & storage" }));

    const dialog = await screen.findByRole("dialog");
    const policySelect = await within(dialog).findByLabelText("Storage destination");
    fireEvent.mouseDown(policySelect);
    fireEvent.click(await screen.findByRole("option", { name: /S3 Contratos/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save destination" }));

    await waitFor(() => {
      expect(capturedStorageRuleBody).toEqual({
        categoryId: CAT_1_ID,
        storageConnectionId: CONN_S3_ID,
      });
    });
  });

  it("displays textIndexingMode badge and saves textIndexingMode changes in CategoryEditor", async () => {
    let capturedPatchBody: Record<string, unknown> | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession("admin") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-indexing-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/categories?") && method === "GET") {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: CAT_1_ID,
                  organizationId: ORG_ID,
                  name: "Contratos",
                  description: null,
                  color: "#0F5C73",
                  icon: null,
                  isActive: true,
                  textIndexingMode: "ALWAYS",
                  createdAt: "2026-01-01T10:00:00.000Z",
                  updatedAt: "2026-02-01T10:00:00.000Z",
                },
              ],
              pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith(`/api/v1/categories/${CAT_1_ID}/fields`) && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-connections") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/admin/storage-routing-rules") && method === "GET") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith(`/api/v1/categories/${CAT_1_ID}`) && method === "PATCH") {
        capturedPatchBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            data: {
              id: CAT_1_ID,
              organizationId: ORG_ID,
              name: "Contratos",
              description: null,
              color: "#0F5C73",
              icon: null,
              isActive: true,
              textIndexingMode: capturedPatchBody.textIndexingMode ?? "ASK",
              createdAt: "2026-01-01T10:00:00.000Z",
              updatedAt: "2026-02-02T10:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    renderCategoriesPage();

    expect(await screen.findByText("Always index automatically")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fields & storage" }));

    const dialog = await screen.findByRole("dialog");
    const modeSelect = await within(dialog).findByLabelText("Content search policy");
    fireEvent.mouseDown(modeSelect);
    fireEvent.click(await screen.findByRole("option", { name: "Ask user on upload" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save category" }));

    await waitFor(() => {
      expect(capturedPatchBody?.textIndexingMode).toBe("ASK");
    });
  });
});
