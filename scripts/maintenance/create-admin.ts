import { randomUUID } from "node:crypto";
import { createPasswordService } from "@docuflow/auth";
import { createDatabaseClient } from "@docuflow/database";
import { createDrizzleSetupRepository } from "../../apps/api/src/modules/setup/setup.repository.js";
import { createSetupService } from "../../apps/api/src/modules/setup/setup.service.js";

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  const email = process.env["DOCUFLOW_ADMIN_EMAIL"];
  const fullName = process.env["DOCUFLOW_ADMIN_NAME"];
  const password = process.env["DOCUFLOW_ADMIN_PASSWORD"];
  const organizationName = process.env["DOCUFLOW_ORG_NAME"] ?? "DocuFlow";
  const organizationSlug = process.env["DOCUFLOW_ORG_SLUG"] ?? "default";

  if (!databaseUrl || !email || !fullName || !password) {
    throw new Error(
      "Defina DATABASE_URL, DOCUFLOW_ADMIN_EMAIL, DOCUFLOW_ADMIN_NAME e DOCUFLOW_ADMIN_PASSWORD.",
    );
  }

  const dbClient = createDatabaseClient({ connectionString: databaseUrl });
  try {
    const setupService = createSetupService({
      repository: createDrizzleSetupRepository(dbClient.db),
      passwordService: createPasswordService(),
    });

    const created = await setupService.bootstrapFirstAdmin(
      {
        organizationName,
        organizationSlug,
        email,
        fullName,
        password,
      },
      randomUUID(),
    );

    process.stdout.write(
      `${JSON.stringify({
        status: "created",
        organizationId: created.organizationId,
        adminUserId: created.adminUserId,
        email: created.email,
      })}\n`,
    );
  } finally {
    await dbClient.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Erro ao criar administrador inicial.";
  process.stderr.write(`${JSON.stringify({ status: "error", message })}\n`);
  process.exit(1);
});
