import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type {
  AuditEventInput,
  AuditRepositoryPort,
  CreateStorageConnectionInput,
  StorageConnectionEntity,
  StorageConnectionRepositoryPort,
  TransactionManagerPort,
  UpdateStorageConnectionInput,
} from "@papyrus/domain";
import { createStorageConnectionAdminService } from "@papyrus/domain";
import { createStorageSecretVault } from "@papyrus/storage-core";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../src/modules/auth/auth.routes.js";
import type { AuthService } from "../src/modules/auth/auth.service.js";
import { createApiStorageProviderRegistry } from "../src/modules/storage/storage-provider.registry.js";
import { registerStorageRoutes } from "../src/modules/storage/storage.routes.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000002";
const TEST_ENCRYPTION_KEY = "a".repeat(64);

function createInMemoryStorageHarness(sharePointFetchFn: typeof fetch) {
  const connections = new Map<string, StorageConnectionEntity>();
  const auditEvents: AuditEventInput[] = [];

  const connectionRepo: StorageConnectionRepositoryPort = {
    async findById(id: string) {
      return connections.get(id) ?? null;
    },
    async findDefaultByOrganization(organizationId: string) {
      for (const item of connections.values()) {
        if (item.organizationId === organizationId && item.isDefault) {
          return item;
        }
      }
      return null;
    },
    async listByOrganization(organizationId: string) {
      return [...connections.values()].filter((item) => item.organizationId === organizationId);
    },
    async create(input: CreateStorageConnectionInput) {
      const now = new Date().toISOString();
      const entity: StorageConnectionEntity = {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        kind: input.kind,
        isDefault: input.isDefault,
        status: "ACTIVE",
        nonSecretConfig: input.nonSecretConfig,
        encryptedSecretRef: input.encryptedSecretRef,
        lastHealthCheckAt: null,
        lastHealthMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      connections.set(entity.id, entity);
      return entity;
    },
    async update(id: string, input: UpdateStorageConnectionInput) {
      const existing = connections.get(id);
      if (!existing) {
        return null;
      }
      const updated: StorageConnectionEntity = {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.nonSecretConfig !== undefined ? { nonSecretConfig: input.nonSecretConfig } : {}),
        ...(input.encryptedSecretRef !== undefined
          ? { encryptedSecretRef: input.encryptedSecretRef }
          : {}),
        ...(input.lastHealthCheckAt !== undefined
          ? { lastHealthCheckAt: input.lastHealthCheckAt }
          : {}),
        ...(input.lastHealthMessage !== undefined
          ? { lastHealthMessage: input.lastHealthMessage }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      connections.set(id, updated);
      return updated;
    },
    async hasLinkedFileObjects() {
      return false;
    },
  };

  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      return fn({} as never);
    },
  };

  const audit: AuditRepositoryPort = {
    async append(event: AuditEventInput) {
      auditEvents.push(event);
    },
  };

  const secretVault = createStorageSecretVault({ masterKey: TEST_ENCRYPTION_KEY });
  const registry = createApiStorageProviderRegistry({
    secretVault,
    sharePointFetchFn,
  });

  const storageAdminService = createStorageConnectionAdminService({
    connections: connectionRepo,
    transactions,
    audit,
    secretEncryptor: {
      encrypt: (credentials) => secretVault.encryptCredentials(credentials),
    },
    healthTester: {
      testConnection: async (connection) => {
        const provider = await registry.resolveProvider(connection);
        return provider.checkHealth();
      },
    },
    generateId: () => randomUUID(),
  });

  const authService = {
    async getMe(rawToken: string | undefined) {
      if (rawToken !== "valid-admin-token") {
        return null;
      }
      return {
        me: {
          user: {
            id: ADMIN_USER_ID,
            organizationId: ORG_ID,
            email: "admin@papyrus.local",
            displayName: "Admin",
            status: "ACTIVE",
          },
          roles: [{ id: randomUUID(), key: "admin", name: "Administrador" }],
          permissions: [{ action: "MANAGE_STORAGE", resource: "STORAGE" }],
          session: {
            id: randomUUID(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        },
      };
    },
  } as unknown as AuthService;

  return {
    connections,
    auditEvents,
    storageAdminService,
    authService,
  };
}

describe("SharePoint storage connection admin routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it("creates, encrypts, updates without losing secret, and health-checks a SharePoint connection", async () => {
    const observedSecrets: string[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/oauth2/v2.0/token")) {
        const bodyText = String(init?.body ?? "");
        const params = new URLSearchParams(bodyText);
        observedSecrets.push(params.get("client_secret") ?? "");
        return new Response(
          JSON.stringify({
            access_token: "mock-graph-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/v1.0/sites/contoso.sharepoint.com:/sites/Legal")) {
        return new Response(JSON.stringify({ id: "site-legal-01" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/v1.0/sites/site-legal-01/drives")) {
        return new Response(
          JSON.stringify({
            value: [
              { id: "drive-contracts", name: "Contratos" },
              { id: "drive-contracts-2026", name: "Contratos 2026" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/v1.0/drives/drive-contracts-2026/root")) {
        return new Response(JSON.stringify({ id: "root-item", name: "root" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: { message: `Unhandled URL ${url}` } }), {
        status: 404,
      });
    };

    const harness = createInMemoryStorageHarness(mockFetch);
    const app = Fastify();
    apps.push(app);
    await app.register(cookie);
    await registerStorageRoutes(app, {
      authService: harness.authService,
      storageAdminService: harness.storageAdminService,
    });

    const initialSecret = "sp-client-secret-initial-987654";

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/storage-connections",
      cookies: { [SESSION_COOKIE_NAME]: "valid-admin-token" },
      payload: {
        kind: "sharepoint",
        name: "SharePoint Jurídico",
        tenantId: "11111111-2222-3333-4444-555555555555",
        clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        siteUrl: "https://contoso.sharepoint.com/sites/Legal",
        libraryName: "Contratos",
        baseFolderPath: "papyrus/juridico",
        credentials: {
          clientSecret: initialSecret,
        },
      },
    });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.body).not.toContain(initialSecret);
    const createdBody = createRes.json() as {
      data: {
        id: string;
        kind: string;
        hasCredentials: boolean;
        nonSecretConfig: Record<string, unknown>;
      };
    };
    expect(createdBody.data.kind).toBe("sharepoint");
    expect(createdBody.data.hasCredentials).toBe(true);
    expect(createdBody.data.nonSecretConfig.siteUrl).toBe(
      "https://contoso.sharepoint.com/sites/Legal",
    );
    expect(createdBody.data.nonSecretConfig.clientSecret).toBeUndefined();
    expect(JSON.stringify(harness.auditEvents)).not.toContain(initialSecret);

    // Reject non-SharePoint / SSRF URLs
    const ssrfRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/storage-connections",
      cookies: { [SESSION_COOKIE_NAME]: "valid-admin-token" },
      payload: {
        kind: "sharepoint",
        name: "SSRF Attempt",
        tenantId: "11111111-2222-3333-4444-555555555555",
        clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        siteUrl: "http://169.254.169.254/latest/meta-data",
        credentials: { clientSecret: "secret-ssrf-1234" },
      },
    });
    expect(ssrfRes.statusCode).toBe(400);

    // Update library name without resending credentials -> keeps encrypted secret
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/storage-connections/${createdBody.data.id}`,
      cookies: { [SESSION_COOKIE_NAME]: "valid-admin-token" },
      payload: {
        libraryName: "Contratos 2026",
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.body).not.toContain(initialSecret);

    // Health check uses decrypted secret to fetch token + resolve site + drive
    const testRes = await app.inject({
      method: "POST",
      url: `/api/v1/admin/storage-connections/${createdBody.data.id}/test`,
      cookies: { [SESSION_COOKIE_NAME]: "valid-admin-token" },
    });
    expect(testRes.statusCode).toBe(200);
    const testBody = testRes.json() as {
      data: { health: { healthy: boolean; message: string } };
    };
    expect(testBody.data.health.healthy).toBe(true);
    expect(observedSecrets).toEqual([initialSecret]);
  });
});
