import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool, PoolClient } from "pg";
import {
  type DatabaseClient,
  type DatabaseLogger,
  createDatabaseClient,
  sanitizeDatabaseErrorMessage,
} from "../client.js";

/**
 * Deterministic 64-bit PostgreSQL advisory lock key dedicated to DocuFlow schema migrations.
 */
export const DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY = "7428910513001";
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;
export const DEFAULT_MIGRATION_LOCK_RETRY_INTERVAL_MS = 100;
const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 120_000;

export class MigrationGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationGuardError";
  }
}

export class MigrationLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationLockTimeoutError";
  }
}

export interface RunMigrationsOptions {
  readonly connectionString?: string | undefined;
  readonly pool?: Pool | undefined;
  readonly migrationsFolder?: string | undefined;
  readonly advisoryLockKey?: string | undefined;
  readonly lockTimeoutMs?: number | undefined;
  readonly lockRetryIntervalMs?: number | undefined;
  readonly statementTimeoutMs?: number | undefined;
  readonly nodeEnv?: string | undefined;
  readonly allowDestructiveSeed?: boolean | undefined;
  readonly logger?: DatabaseLogger | undefined;
}

export interface RunMigrationsResult {
  readonly lockKey: string;
  readonly lockWaitMs: number;
  readonly appliedBefore: number;
  readonly appliedAfter: number;
  readonly newlyAppliedCount: number;
  readonly migrationsFolder: string;
}

export function resolveDefaultMigrationsFolder(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../drizzle");
}

export function isProductionNodeEnv(nodeEnv: string | undefined): boolean {
  return (nodeEnv ?? "").trim().toLowerCase() === "production";
}

/**
 * Prevents destructive seeds or fixture resets from ever running during production migrations.
 */
export function assertDestructiveSeedAllowed(
  nodeEnv: string | undefined,
  allowDestructiveSeed: boolean,
): void {
  if (allowDestructiveSeed && isProductionNodeEnv(nodeEnv)) {
    throw new MigrationGuardError(
      "Seed destrutivo não é permitido em ambiente de produção (NODE_ENV=production).",
    );
  }
}

function validateAdvisoryLockKey(rawKey: string | undefined): string {
  const key = (rawKey ?? DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY).trim();
  if (!/^-?\d{1,19}$/.test(key)) {
    throw new MigrationGuardError(`Chave de advisory lock inválida: "${key}".`);
  }
  const parsed = BigInt(key);
  if (parsed < -9223372036854775808n || parsed > 9223372036854775807n) {
    throw new MigrationGuardError("Chave de advisory lock fora do intervalo bigint do PostgreSQL.");
  }
  return key;
}

function assertPositiveTimeout(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MigrationGuardError(`Parâmetro "${name}" deve ser um inteiro positivo.`);
  }
  return value;
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function countAppliedDrizzleMigrations(client: PoolClient): Promise<number> {
  const existsResult = await client.query<{ readonly exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'drizzle'
        AND table_name = '__drizzle_migrations'
    ) AS exists`,
  );
  const existsRow = existsResult.rows[0];
  if (!existsRow?.exists) {
    return 0;
  }

  const countResult = await client.query<{ readonly count: string }>(
    'SELECT COUNT(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
  );
  const rawCount = countResult.rows[0]?.count ?? "0";
  const parsed = Number.parseInt(rawCount, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function acquireSessionAdvisoryLock(
  client: PoolClient,
  lockKey: string,
  timeoutMs: number,
  retryIntervalMs: number,
  logger?: DatabaseLogger,
): Promise<number> {
  const startedAt = Date.now();
  let loggedWait = false;

  while (true) {
    const lockResult = await client.query<{ readonly acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [lockKey],
    );
    if (lockResult.rows[0]?.acquired === true) {
      return Math.max(0, Date.now() - startedAt);
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new MigrationLockTimeoutError(
        `Tempo limite (${timeoutMs}ms) excedido aguardando advisory lock de migration (${lockKey}).`,
      );
    }

    if (!loggedWait) {
      loggedWait = true;
      logger?.info("Waiting for PostgreSQL migration advisory lock", {
        lockKey,
        timeoutMs,
      });
    }

    const remainingMs = timeoutMs - elapsedMs;
    await delayMs(Math.min(retryIntervalMs, remainingMs));
  }
}

/**
 * Executes Drizzle PostgreSQL migrations under a dedicated session-level advisory lock,
 * ensuring at most one instance applies schema migrations at a time and blocking destructive
 * seeds when `NODE_ENV=production`.
 */
export async function runMigrationsWithAdvisoryLock(
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const allowDestructiveSeed = options.allowDestructiveSeed ?? false;
  assertDestructiveSeedAllowed(nodeEnv, allowDestructiveSeed);

  const lockKey = validateAdvisoryLockKey(options.advisoryLockKey);
  const lockTimeoutMs = assertPositiveTimeout(
    "lockTimeoutMs",
    options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  );
  const lockRetryIntervalMs = assertPositiveTimeout(
    "lockRetryIntervalMs",
    options.lockRetryIntervalMs ?? DEFAULT_MIGRATION_LOCK_RETRY_INTERVAL_MS,
  );
  const statementTimeoutMs = assertPositiveTimeout(
    "statementTimeoutMs",
    options.statementTimeoutMs ?? DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  );

  const migrationsFolder = path.resolve(
    options.migrationsFolder ?? resolveDefaultMigrationsFolder(),
  );
  if (!existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    throw new MigrationGuardError(
      `Diretório de migrations inválido ou sem meta/_journal.json: ${migrationsFolder}`,
    );
  }

  let ownedClient: DatabaseClient | null = null;
  let activePool: Pool;
  if (options.pool) {
    activePool = options.pool;
  } else {
    const connectionString = options.connectionString?.trim() ?? "";
    if (connectionString.length === 0) {
      throw new MigrationGuardError(
        "DATABASE_URL (connectionString) ou pool PostgreSQL é obrigatório para executar migrations.",
      );
    }
    ownedClient = createDatabaseClient({
      connectionString,
      maxPoolSize: 2,
      minPoolSize: 0,
      statementTimeoutMs,
      queryTimeoutMs: statementTimeoutMs,
      applicationName: "docuflow-migrator",
      logger: options.logger,
    });
    activePool = ownedClient.pool;
  }

  let pgClient: PoolClient | null = null;
  let lockAcquired = false;

  try {
    pgClient = await activePool.connect();
    const lockWaitMs = await acquireSessionAdvisoryLock(
      pgClient,
      lockKey,
      lockTimeoutMs,
      lockRetryIntervalMs,
      options.logger,
    );
    lockAcquired = true;

    const appliedBefore = await countAppliedDrizzleMigrations(pgClient);
    await migrate(drizzle(pgClient), { migrationsFolder });
    const appliedAfter = await countAppliedDrizzleMigrations(pgClient);
    const newlyAppliedCount = Math.max(0, appliedAfter - appliedBefore);

    options.logger?.info("PostgreSQL migrations completed safely", {
      lockKey,
      lockWaitMs,
      appliedBefore,
      appliedAfter,
      newlyAppliedCount,
    });

    return {
      lockKey,
      lockWaitMs,
      appliedBefore,
      appliedAfter,
      newlyAppliedCount,
      migrationsFolder,
    };
  } catch (error) {
    if (error instanceof MigrationGuardError || error instanceof MigrationLockTimeoutError) {
      throw error;
    }
    const sanitized =
      error instanceof Error
        ? sanitizeDatabaseErrorMessage(error.message)
        : "Erro desconhecido durante execução de migrations.";
    throw new Error(`Falha ao executar migrations no PostgreSQL: ${sanitized}`);
  } finally {
    if (pgClient && lockAcquired) {
      try {
        await pgClient.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
      } catch (unlockError) {
        const sanitized =
          unlockError instanceof Error
            ? sanitizeDatabaseErrorMessage(unlockError.message)
            : "Erro desconhecido ao liberar advisory lock.";
        options.logger?.error("Failed to release PostgreSQL migration advisory lock", {
          lockKey,
          error: sanitized,
        });
      }
    }
    if (pgClient) {
      pgClient.release();
    }
    if (ownedClient) {
      await ownedClient.close();
    }
  }
}
