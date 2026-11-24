import { randomUUID } from "node:crypto";
import { createPasswordService } from "@papyrus/auth";
import { createDatabaseClient } from "@papyrus/database";
import { createDrizzleSetupRepository } from "../../apps/api/src/modules/setup/setup.repository.js";
import { createSetupService } from "../../apps/api/src/modules/setup/setup.service.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const email = process.env.PAPYRUS_ADMIN_EMAIL;
  const fullName = process.env.PAPYRUS_ADMIN_NAME;
  const password = process.env.PAPYRUS_ADMIN_PASSWORD;
  const organizationName = process.env.PAPYRUS_ORG_NAME ?? "papyrus";
  const organizationSlug = process.env.PAPYRUS_ORG_SLUG ?? "default";

  if (!databaseUrl || !email || !fullName || !password) {
    throw new Error(
      "Defina DATABASE_URL, PAPYRUS_ADMIN_EMAIL, PAPYRUS_ADMIN_NAME e PAPYRUS_ADMIN_PASSWORD.",
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
