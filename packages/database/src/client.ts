import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

export interface DatabaseLogger {
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface DatabaseClientOptions {
  readonly connectionString: string;
  readonly maxPoolSize?: number | undefined;
  readonly minPoolSize?: number | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly connectionTimeoutMs?: number | undefined;
  readonly statementTimeoutMs?: number | undefined;
  readonly queryTimeoutMs?: number | undefined;
  readonly applicationName?: string | undefined;
  readonly logger?: DatabaseLogger | undefined;
}

export interface DatabaseClient {
  readonly db: NodePgDatabase;
  readonly pool: Pool;
  checkHealth(): Promise<{ readonly healthy: boolean; readonly message: string }>;
  close(): Promise<void>;
}

const DEFAULT_MAX_POOL_SIZE = 20;
const DEFAULT_MIN_POOL_SIZE = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

export function sanitizeDatabaseErrorMessage(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgresql://[REDACTED]")
    .replace(/(password|pwd|secret)\s*=\s*[^\s;,'"]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

function assertPositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid database option "${name}": expected a positive integer.`);
  }
  return value;
}

function assertNonNegativeInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid database option "${name}": expected a non-negative integer.`);
  }
  return value;
}

export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const connectionString = options.connectionString.trim();
  if (connectionString.length === 0) {
    throw new Error("Database connectionString must not be empty.");
  }

  const max = assertPositiveInt("maxPoolSize", options.maxPoolSize ?? DEFAULT_MAX_POOL_SIZE);
  const min = assertNonNegativeInt("minPoolSize", options.minPoolSize ?? DEFAULT_MIN_POOL_SIZE);
  if (min > max) {
    throw new Error("Invalid database option: minPoolSize cannot exceed maxPoolSize.");
  }

  const idleTimeoutMillis = assertPositiveInt(
    "idleTimeoutMs",
    options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  );
  const connectionTimeoutMillis = assertPositiveInt(
    "connectionTimeoutMs",
    options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  );
  const statementTimeout = assertPositiveInt(
    "statementTimeoutMs",
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  );
  const queryTimeout = assertPositiveInt(
    "queryTimeoutMs",
    options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
  );

  const poolConfig: PoolConfig = {
    connectionString,
    max,
    min,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statement_timeout: statementTimeout,
    query_timeout: queryTimeout,
    application_name: options.applicationName ?? "docuflow",
  };

  const pool = new Pool(poolConfig);
  const logger = options.logger;

  pool.on("error", (error: Error) => {
    logger?.error("Unexpected PostgreSQL pool error", {
      error: sanitizeDatabaseErrorMessage(error.message),
    });
  });

  const db = drizzle(pool);
  let closed = false;

  logger?.info("PostgreSQL pool initialized", {
    maxPoolSize: max,
    minPoolSize: min,
    idleTimeoutMs: idleTimeoutMillis,
    connectionTimeoutMs: connectionTimeoutMillis,
    statementTimeoutMs: statementTimeout,
    queryTimeoutMs: queryTimeout,
  });

  return {
    db,
    pool,

    async checkHealth(): Promise<{ readonly healthy: boolean; readonly message: string }> {
      if (closed) {
        return { healthy: false, message: "Pool de conexões encerrado." };
      }

      try {
        await pool.query("SELECT 1");
        return { healthy: true, message: "PostgreSQL disponível." };
      } catch (error) {
        const message =
          error instanceof Error
            ? sanitizeDatabaseErrorMessage(error.message)
            : "Erro desconhecido ao verificar PostgreSQL.";
        return { healthy: false, message };
      }
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await pool.end();
      logger?.info("PostgreSQL pool closed");
    },
  };
}
