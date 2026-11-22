import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY,
  MigrationGuardError,
  MigrationLockTimeoutError,
  assertDestructiveSeedAllowed,
  runMigrationsWithAdvisoryLock,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, "../drizzle");
const ENTRYPOINT_SCRIPT = path.resolve(
  CURRENT_DIR,
  "../../../scripts/maintenance/migrate-entrypoint.sh",
);
const MIGRATE_CLI_DIST = path.resolve(CURRENT_DIR, "../dist/migrate-cli.js");

describe("PostgreSQL safe migration runner with advisory lock", () => {
  let container: StartedPostgreSqlContainer | null = null;
  let baseConnectionString = "";
  let pool: Pool;

  beforeAll(async () => {
    const externalUrl = process.env.DATABASE_URL;
    if (externalUrl && externalUrl.trim().length > 0) {
      baseConnectionString = externalUrl;
    } else {
      container = await new PostgreSqlContainer("postgres:16-alpine").start();
      baseConnectionString = container.getConnectionUri();
    }
    pool = new Pool({ connectionString: baseConnectionString });
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("blocks destructive seeds in production while allowing safe production migrations", async () => {
    expect(() => assertDestructiveSeedAllowed("production", true)).toThrowError(
      MigrationGuardError,
    );
    expect(() => assertDestructiveSeedAllowed("PRODUCTION", true)).toThrowError(
      MigrationGuardError,
    );
    expect(() => assertDestructiveSeedAllowed("development", true)).not.toThrow();
    expect(() => assertDestructiveSeedAllowed("production", false)).not.toThrow();

    await expect(
      runMigrationsWithAdvisoryLock({
        connectionString: baseConnectionString,
        migrationsFolder: MIGRATIONS_FOLDER,
        nodeEnv: "production",
        allowDestructiveSeed: true,
      }),
    ).rejects.toBeInstanceOf(MigrationGuardError);
  });

  it("applies migrations idempotently under advisory lock and releases lock afterward", async () => {
    const firstRun = await runMigrationsWithAdvisoryLock({
      connectionString: baseConnectionString,
      migrationsFolder: MIGRATIONS_FOLDER,
      nodeEnv: "production",
      allowDestructiveSeed: false,
    });

    expect(firstRun.lockKey).toBe(DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY);
    expect(firstRun.appliedBefore).toBe(0);
    expect(firstRun.appliedAfter).toBeGreaterThan(0);
    expect(firstRun.newlyAppliedCount).toBe(firstRun.appliedAfter);

    const secondRun = await runMigrationsWithAdvisoryLock({
      connectionString: baseConnectionString,
      migrationsFolder: MIGRATIONS_FOLDER,
      nodeEnv: "production",
      allowDestructiveSeed: false,
    });

    expect(secondRun.appliedBefore).toBe(firstRun.appliedAfter);
    expect(secondRun.appliedAfter).toBe(firstRun.appliedAfter);
    expect(secondRun.newlyAppliedCount).toBe(0);

    // Ensure advisory lock was completely released so another session acquires it immediately
    const checker = await pool.connect();
    try {
      const checkRes = await checker.query<{ readonly acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY],
      );
      expect(checkRes.rows[0]?.acquired).toBe(true);
      await checker.query("SELECT pg_advisory_unlock($1::bigint)", [
        DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY,
      ]);
    } finally {
      checker.release();
    }
  });

  it("serializes concurrent migrators and times out cleanly when lock remains held", async () => {
    const holder = await pool.connect();
    try {
      const lockRes = await holder.query<{ readonly acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY],
      );
      expect(lockRes.rows[0]?.acquired).toBe(true);

      // Verify bounded wait fails closed with MigrationLockTimeoutError while lock is held
      await expect(
        runMigrationsWithAdvisoryLock({
          connectionString: baseConnectionString,
          migrationsFolder: MIGRATIONS_FOLDER,
          lockTimeoutMs: 250,
          lockRetryIntervalMs: 50,
        }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

      // Start second instance while lock is held, then release lock after 250ms
      const releaseTimer = setTimeout(() => {
        void holder.query("SELECT pg_advisory_unlock($1::bigint)", [
          DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY,
        ]);
      }, 250);

      try {
        const result = await runMigrationsWithAdvisoryLock({
          connectionString: baseConnectionString,
          migrationsFolder: MIGRATIONS_FOLDER,
          lockTimeoutMs: 5_000,
          lockRetryIntervalMs: 50,
        });
        expect(result.lockWaitMs).toBeGreaterThanOrEqual(150);
      } finally {
        clearTimeout(releaseTimer);
      }
    } finally {
      await holder
        .query("SELECT pg_advisory_unlock($1::bigint)", [DOCUFLOW_MIGRATION_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
      holder.release();
    }
  });

  it("prevents concurrent fresh migrations from colliding via Promise.all", async () => {
    const dbName = "docuflow_concurrent_migrator_test";
    await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await pool.query(`CREATE DATABASE ${dbName}`);

    const targetUrl = new URL(baseConnectionString);
    targetUrl.pathname = `/${dbName}`;
    const concurrentConnectionString = targetUrl.toString();

    try {
      const [runA, runB] = await Promise.all([
        runMigrationsWithAdvisoryLock({
          connectionString: concurrentConnectionString,
          migrationsFolder: MIGRATIONS_FOLDER,
          nodeEnv: "production",
        }),
        runMigrationsWithAdvisoryLock({
          connectionString: concurrentConnectionString,
          migrationsFolder: MIGRATIONS_FOLDER,
          nodeEnv: "production",
        }),
      ]);

      expect(runA.appliedAfter).toBeGreaterThan(0);
      expect(runB.appliedAfter).toBe(runA.appliedAfter);
      // Strictly one instance applied the initial schema while the second serialized cleanly
      const newlyAppliedTotal = runA.newlyAppliedCount + runB.newlyAppliedCount;
      expect(newlyAppliedTotal).toBe(runA.appliedAfter);
      expect([runA.newlyAppliedCount, runB.newlyAppliedCount].sort((a, b) => a - b)).toEqual([
        0,
        runA.appliedAfter,
      ]);
    } finally {
      await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    }
  });

  it("runs entrypoint script safely in production and rejects destructive seed flag", async () => {
    await expect(
      execFileAsync("sh", [ENTRYPOINT_SCRIPT], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DOCUFLOW_RUN_DESTRUCTIVE_SEED: "true",
          DATABASE_URL: baseConnectionString,
          DOCUFLOW_MIGRATE_SCRIPT: MIGRATE_CLI_DIST,
        },
      }),
    ).rejects.toThrow();

    const { stdout } = await execFileAsync("sh", [ENTRYPOINT_SCRIPT, "echo", "entrypoint-ready"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        DOCUFLOW_RUN_DESTRUCTIVE_SEED: "false",
        DATABASE_URL: baseConnectionString,
        DOCUFLOW_MIGRATE_SCRIPT: MIGRATE_CLI_DIST,
      },
    });

    expect(stdout).toContain('"status":"ok"');
    expect(stdout).toContain("entrypoint-ready");
  });
});
