import { sanitizeDatabaseErrorMessage } from "./client.js";
import {
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  assertDestructiveSeedAllowed,
  runMigrationsWithAdvisoryLock,
} from "./migrations/safe-migrator.js";

function parseOptionalPositiveIntEnv(
  rawValue: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!rawValue || rawValue.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Variável de ambiente ${name} inválida: esperado inteiro positivo.`);
  }
  return parsed;
}

function parseBooleanEnv(rawValue: string | undefined): boolean {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "production";
  const args = new Set(process.argv.slice(2));
  const requestedDestructiveSeed =
    args.has("--seed-destructive") || parseBooleanEnv(process.env.PAPYRUS_RUN_DESTRUCTIVE_SEED);

  assertDestructiveSeedAllowed(nodeEnv, requestedDestructiveSeed);

  const connectionString = process.env.DATABASE_URL?.trim() ?? "";
  if (connectionString.length === 0) {
    throw new Error("Variável DATABASE_URL é obrigatória para executar migrations.");
  }

  const lockTimeoutMs = parseOptionalPositiveIntEnv(
    process.env.MIGRATION_LOCK_TIMEOUT_MS,
    DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    "MIGRATION_LOCK_TIMEOUT_MS",
  );
  const migrationsFolder = process.env.MIGRATIONS_DIR?.trim();

  const result = await runMigrationsWithAdvisoryLock({
    connectionString,
    migrationsFolder:
      migrationsFolder && migrationsFolder.length > 0 ? migrationsFolder : undefined,
    lockTimeoutMs,
    nodeEnv,
    allowDestructiveSeed: false,
    logger: {
      info(message, context) {
        process.stdout.write(
          `${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", service: "papyrus-migrator", message, ...(context ?? {}) })}\n`,
        );
      },
      error(message, context) {
        process.stderr.write(
          `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "papyrus-migrator", message, ...(context ?? {}) })}\n`,
        );
      },
    },
  });

  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      lockKey: result.lockKey,
      lockWaitMs: result.lockWaitMs,
      appliedBefore: result.appliedBefore,
      appliedAfter: result.appliedAfter,
      newlyAppliedCount: result.newlyAppliedCount,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const rawMessage =
    error instanceof Error ? error.message : "Erro desconhecido no executor de migrations.";
  process.stderr.write(
    `${JSON.stringify({
      status: "error",
      message: sanitizeDatabaseErrorMessage(rawMessage),
    })}\n`,
  );
  process.exit(1);
});
