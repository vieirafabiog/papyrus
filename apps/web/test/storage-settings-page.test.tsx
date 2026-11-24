import "@testing-library/jest-dom/vitest";
import { UiLocaleProvider, papyrusTheme } from "@docuflow/ui";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageSettingsPage } from "../src/features/admin/StorageSettingsPage.js";
import { I18nProvider } from "../src/i18n/index.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const CONN_LOCAL_ID = "550e8400-e29b-41d4-a716-446655440101";
const CONN_S3_ID = "550e8400-e29b-41d4-a716-446655440102";
const CONN_NEW_ID = "550e8400-e29b-41d4-a716-446655440103";
const CATEGORY_FIN_ID = "550e8400-e29b-41d4-a716-446655440201";
const CATEGORY_HR_ID = "550e8400-e29b-41d4-a716-446655440202";
const RULE_ID = "550e8400-e29b-41d4-a716-446655440301";

function buildSession(isAdmin: boolean) {
  return {
    user: {
      id: "550e8400-e29b-41d4-a716-446655440010",
      organizationId: ORG_ID,
      email: isAdmin ? "admin@docuflow.local" : "leitora@docuflow.local",
      fullName: isAdmin ? "Administradora Storage" : "Usuária Leitora",
      status: "ACTIVE",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    },
    groups: [],
    roles: isAdmin
      ? [
          {
            id: "550e8400-e29b-41d4-a716-446655440099",
            key: "admin",
            name: "Administrador",
            description: null,
            isSystem: true,
          },
        ]
      : [],
    permissions: [],
    sessionExpiresAt: "2026-12-31T10:00:00.000Z",
  };
}

function createInitialConnections() {
  return [
    {
      id: CONN_LOCAL_ID,
      organizationId: ORG_ID,
      name: "Cofre Local",
      kind: "local" as const,
      isDefault: true,
      status: "ACTIVE" as const,
      nonSecretConfig: {
        rootDirectory: "/var/lib/docuflow/local",
        maxObjectSizeBytes: 52428800,
      },
      hasCredentials: false,
      lastHealthCheckAt: "2026-04-01T10:00:00.000Z",
      lastHealthMessage: "Directory available for read and write.",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-04-01T10:00:00.000Z",
    },
    {
      id: CONN_S3_ID,
      organizationId: ORG_ID,
      name: "MinIO Primário",
      kind: "s3" as const,
      isDefault: false,
      status: "ACTIVE" as const,
      nonSecretConfig: {
        endpoint: "https://minio.interno.local",
        region: "us-east-1",
        bucket: "docuflow-arquivo",
        forcePathStyle: true,
        tlsRejectUnauthorized: true,
        tlsAllowInsecureHttp: false,
        connectionTimeoutMs: 5000,
        requestTimeoutMs: 30000,
      },
      hasCredentials: true,
      lastHealthCheckAt: null,
      lastHealthMessage: null,
      createdAt: "2026-03-05T10:00:00.000Z",
      updatedAt: "2026-03-05T10:00:00.000Z",
    },
  ];
}

function createCategoriesFixture() {
  return [
    {
      id: CATEGORY_FIN_ID,
      organizationId: ORG_ID,
      name: "Financeiro",
      description: null,
      color: null,
      icon: null,
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: CATEGORY_HR_ID,
      organizationId: ORG_ID,
      name: "Recursos Humanos",
      description: null,
      color: null,
      icon: null,
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

function renderStorageSettingsPage() {
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
              <StorageSettingsPage />
            </MemoryRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </UiLocaleProvider>
    </I18nProvider>,
  );
}

describe("StorageSettingsPage (Step 14.04)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("blocks access for users without MANAGE_STORAGE or admin permission", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession(false) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403 });
    });

    renderStorageSettingsPage();

    expect(await screen.findByText("Access restricted")).toBeInTheDocument();
  });

  it("lists masked connections and creates a local storage connection", async () => {
    let connections = createInitialConnections();
    const categories = createCategoriesFixture();
    let capturedCreateBody: Record<string, unknown> | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession(true) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-storage-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/v1/categories")) {
        return new Response(
          JSON.stringify({
            data: {
              items: categories,
              pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
            },
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

      if (url.endsWith("/api/v1/admin/storage-connections") && method === "GET") {
        return new Response(JSON.stringify({ data: connections }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/admin/storage-connections") && method === "POST") {
        capturedCreateBody = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        const created = {
          id: CONN_NEW_ID,
          organizationId: ORG_ID,
          name: String(capturedCreateBody.name ?? ""),
          kind: "local" as const,
          isDefault: false,
          status: "ACTIVE" as const,
          nonSecretConfig: {
            rootDirectory: String(capturedCreateBody.rootDirectory ?? ""),
          },
          hasCredentials: false,
          lastHealthCheckAt: null,
          lastHealthMessage: null,
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        };
        connections = [...connections, created];
        return new Response(JSON.stringify({ data: created }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    renderStorageSettingsPage();

    expect(await screen.findByText("File storage")).toBeInTheDocument();
    expect(await screen.findByText("Cofre Local")).toBeInTheDocument();
    expect(screen.getByText("MinIO Primário")).toBeInTheDocument();
    expect(screen.getByText("•••••••• (encrypted)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New connection" }));
    const createDialog = await screen.findByRole("dialog");
    fireEvent.change(within(createDialog).getByLabelText(/Connection name/i), {
      target: { value: "Arquivo Secundário" },
    });
    fireEvent.change(within(createDialog).getByLabelText(/Folder path/i), {
      target: { value: "/mnt/docuflow-secundario" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create connection" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(capturedCreateBody).toMatchObject({
      kind: "local",
      name: "Arquivo Secundário",
      rootDirectory: "/mnt/docuflow-secundario",
    });
    expect(await screen.findByText("Arquivo Secundário")).toBeInTheDocument();
  });

  it("edits S3 without re-entering credentials, tests health, and sets default destination", async () => {
    let connections = createInitialConnections();
    const categories = createCategoriesFixture();
    let capturedPatchBody: Record<string, unknown> | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession(true) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-storage-2" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/v1/categories")) {
        return new Response(
          JSON.stringify({
            data: {
              items: categories,
              pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
            },
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

      if (url.endsWith("/api/v1/admin/storage-connections") && method === "GET") {
        return new Response(JSON.stringify({ data: connections }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith(`/api/v1/admin/storage-connections/${CONN_S3_ID}`) && method === "PATCH") {
        capturedPatchBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
          string,
          unknown
        >;
        connections = connections.map((conn) =>
          conn.id === CONN_S3_ID
            ? {
                ...conn,
                name: String(capturedPatchBody?.name ?? conn.name),
                updatedAt: "2026-04-02T11:00:00.000Z",
              }
            : conn,
        );
        const updated = connections.find((conn) => conn.id === CONN_S3_ID);
        return new Response(JSON.stringify({ data: updated }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.endsWith(`/api/v1/admin/storage-connections/${CONN_S3_ID}/test`) &&
        method === "POST"
      ) {
        connections = connections.map((conn) =>
          conn.id === CONN_S3_ID
            ? {
                ...conn,
                lastHealthCheckAt: "2026-04-02T12:00:00.000Z",
                lastHealthMessage: "Bucket accessible and healthy.",
              }
            : conn,
        );
        const target = connections.find((conn) => conn.id === CONN_S3_ID);
        return new Response(
          JSON.stringify({
            data: {
              connection: target,
              health: {
                healthy: true,
                message: "Bucket accessible and healthy.",
                checkedAt: "2026-04-02T12:00:00.000Z",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (
        url.endsWith(`/api/v1/admin/storage-connections/${CONN_S3_ID}/default`) &&
        method === "POST"
      ) {
        connections = connections.map((conn) => ({
          ...conn,
          isDefault: conn.id === CONN_S3_ID,
        }));
        const target = connections.find((conn) => conn.id === CONN_S3_ID);
        return new Response(JSON.stringify({ data: target }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    renderStorageSettingsPage();

    const s3NameCell = await screen.findByText("MinIO Primário");
    const s3Row = s3NameCell.closest("tr");
    if (!s3Row) {
      throw new Error("Expected MinIO Primário row");
    }

    fireEvent.click(within(s3Row).getByRole("button", { name: "Edit" }));
    const editDialog = await screen.findByRole("dialog");
    expect(
      within(editDialog).getByText(/Current credentials are encrypted and hidden/i),
    ).toBeInTheDocument();
    fireEvent.change(within(editDialog).getByLabelText(/Connection name/i), {
      target: { value: "MinIO Primário Atualizado" },
    });
    fireEvent.click(within(editDialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(capturedPatchBody).toMatchObject({ name: "MinIO Primário Atualizado" });
    expect(capturedPatchBody).not.toHaveProperty("credentials");

    const updatedS3Cell = await screen.findByText("MinIO Primário Atualizado");
    const updatedS3Row = updatedS3Cell.closest("tr");
    if (!updatedS3Row) {
      throw new Error("Expected updated S3 row");
    }

    fireEvent.click(within(updatedS3Row).getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText(
        'Health check passed for "MinIO Primário Atualizado": Bucket accessible and healthy.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(updatedS3Row).getByRole("button", { name: "Set as default" }));
    expect(
      await screen.findByText(
        '"MinIO Primário Atualizado" set as the organization default destination.',
      ),
    ).toBeInTheDocument();
  });

  it("creates and removes category storage routing rules", async () => {
    const connections = createInitialConnections();
    const categories = createCategoriesFixture();
    let rules = [
      {
        id: RULE_ID,
        organizationId: ORG_ID,
        categoryId: CATEGORY_FIN_ID,
        storageConnectionId: CONN_S3_ID,
        createdAt: "2026-03-10T10:00:00.000Z",
        updatedAt: "2026-03-10T10:00:00.000Z",
      },
    ];
    let capturedRuleUpsertBody: Record<string, unknown> | null = null;
    let deletedRuleCategoryId: string | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url.endsWith("/auth/me")) {
        return new Response(JSON.stringify({ data: buildSession(true) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/auth/csrf-token")) {
        return new Response(JSON.stringify({ data: { csrfToken: "csrf-storage-3" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/v1/categories")) {
        return new Response(
          JSON.stringify({
            data: {
              items: categories,
              pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/api/v1/admin/storage-connections") && method === "GET") {
        return new Response(JSON.stringify({ data: connections }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/admin/storage-routing-rules") && method === "GET") {
        return new Response(JSON.stringify({ data: rules }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/v1/admin/storage-routing-rules") && method === "PUT") {
        capturedRuleUpsertBody = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        const newRule = {
          id: "550e8400-e29b-41d4-a716-446655440302",
          organizationId: ORG_ID,
          categoryId: String(capturedRuleUpsertBody.categoryId),
          storageConnectionId: String(capturedRuleUpsertBody.storageConnectionId),
          createdAt: "2026-04-02T12:30:00.000Z",
          updatedAt: "2026-04-02T12:30:00.000Z",
        };
        rules = [...rules.filter((r) => r.categoryId !== newRule.categoryId), newRule];
        return new Response(JSON.stringify({ data: newRule }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.endsWith(`/api/v1/admin/storage-routing-rules/categories/${CATEGORY_FIN_ID}`) &&
        method === "DELETE"
      ) {
        deletedRuleCategoryId = CATEGORY_FIN_ID;
        rules = rules.filter((r) => r.categoryId !== CATEGORY_FIN_ID);
        return new Response(JSON.stringify({ data: { cleared: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: { message: "Unexpected endpoint" } }), {
        status: 404,
      });
    });

    renderStorageSettingsPage();

    expect(await screen.findByText("Financeiro")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText("Document category"));
    fireEvent.click(await screen.findByRole("option", { name: "Recursos Humanos" }));

    fireEvent.mouseDown(screen.getByLabelText("Destination connection"));
    fireEvent.click(await screen.findByRole("option", { name: /Cofre Local/i }));

    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => {
      expect(capturedRuleUpsertBody).toEqual({
        categoryId: CATEGORY_HR_ID,
        storageConnectionId: CONN_LOCAL_ID,
      });
    });

    const rulesTable = screen.getByRole("table", { name: "Category routing rules" });
    const finRuleRow = within(rulesTable).getByText("Financeiro").closest("tr");
    if (!finRuleRow) {
      throw new Error("Expected Financeiro rule row");
    }
    fireEvent.click(within(finRuleRow).getByRole("button", { name: "Remove rule" }));
    const confirmDialog = await screen.findByRole("dialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Remove rule" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(deletedRuleCategoryId).toBe(CATEGORY_FIN_ID);
  });
});
