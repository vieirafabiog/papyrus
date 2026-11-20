import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPasswordService } from "@docuflow/auth";
import { auditEvents } from "@docuflow/database";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createDrizzleSetupRepository } from "../../src/modules/setup/setup.repository.js";
import { createSetupService } from "../../src/modules/setup/setup.service.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/plugins/security.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../../../../packages/database/drizzle");

describe("Setup bootstrap admin integration", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let pool: Pool;

  beforeAll(async () => {
    const externalUrl = process.env["DATABASE_URL"];
    let connectionString: string;
    if (externalUrl && externalUrl.trim().length > 0) {
      connectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      connectionString = container.getConnectionUri();
    }

    pool = new Pool({ connectionString });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("bootstraps the first admin once, blocks subsequent attempts with 409, and never leaks password", async () => {
    const db = drizzle(pool);
    const setupService = createSetupService({
      repository: createDrizzleSetupRepository(db),
      passwordService: createPasswordService({
        memoryCost: 8_192,
        timeCost: 2,
        parallelism: 1,
        minPasswordLength: 10,
      }),
    });
    const app = buildApp({ logger: false, setupService, secureCookies: false });

    const beforeStatus = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(beforeStatus.statusCode).toBe(200);
    expect(beforeStatus.json()).toEqual({ data: { initialized: false } });

    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    const csrfToken = csrfRes.json().data.csrfToken as string;

    const secretPassword = "SuperSecretAdminPassword2026!";
    const firstCreate = await app.inject({
      method: "POST",
      url: "/api/v1/setup/bootstrap-admin",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        organizationName: "Empresa Modelo",
        organizationSlug: "empresa-modelo",
        email: "Admin@Empresa.Invalid",
        fullName: "Administrador Inicial",
        password: secretPassword,
      },
    });

    expect(firstCreate.statusCode).toBe(201);
    expect(firstCreate.body).not.toContain(secretPassword);
    expect(firstCreate.body).not.toContain("passwordHash");
    expect(firstCreate.json().data.email).toBe("admin@empresa.invalid");

    const afterStatus = await app.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(afterStatus.json()).toEqual({ data: { initialized: true } });

    // Second attempt must fail with 409 Conflict
    const secondCreate = await app.inject({
      method: "POST",
      url: "/api/v1/setup/bootstrap-admin",
      cookies: { [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      payload: {
        organizationName: "Empresa Modelo",
        organizationSlug: "empresa-modelo",
        email: "outro@empresa.invalid",
        fullName: "Outro Admin",
        password: secretPassword,
      },
    });
    expect(secondCreate.statusCode).toBe(409);

    // Audit event recorded without password
    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("SETUP_BOOTSTRAP_ADMIN");
    expect(JSON.stringify(events[0]?.metadata)).not.toContain(secretPassword);

    await app.close();
  });
});
