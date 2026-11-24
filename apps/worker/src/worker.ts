import http, { type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { type StandaloneWorkerJobs, createStandaloneWorkerJobs } from "./bootstrap.js";

export interface WorkerHealth {
  status: "starting" | "running" | "stopping" | "stopped";
  startedAt: string | null;
  uptimeMs: number;
}

export type WorkerDependencyState = "ok" | "degraded" | "unavailable";

export interface WorkerProbeOutcome {
  readonly healthy: boolean;
}

export interface WorkerCriticalDependency {
  readonly name: string;
  readonly check: () => Promise<WorkerProbeOutcome>;
}

export interface WorkerReadinessReport {
  readonly status: "ready" | "not_ready";
  readonly checkedAt: string;
  readonly checks: Readonly<Record<string, WorkerDependencyState>>;
}

export interface WorkerLogger {
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface WorkerRuntimeOptions {
  readonly logger?: WorkerLogger | undefined;
  readonly checkDatabase?: (() => Promise<WorkerProbeOutcome>) | undefined;
  readonly dependencies?: readonly WorkerCriticalDependency[] | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface WorkerRuntime {
  start(): Promise<void>;
  stop(signal?: string): Promise<void>;
  getHealth(): WorkerHealth;
  getReadiness(): Promise<WorkerReadinessReport>;
}

export interface WorkerHealthServer {
  readonly server: Server;
  close(): Promise<void>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

function createDefaultLogger(): WorkerLogger {
  const write = (
    level: "info" | "error",
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: "docuflow-worker",
      message,
      ...(context ?? {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (level === "error") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  };

  return {
    info: (message, context) => write("info", message, context),
    error: (message, context) => write("error", message, context),
  };
}

function isWorkerLogger(value: WorkerLogger | WorkerRuntimeOptions): value is WorkerLogger {
  return (
    typeof (value as WorkerLogger).info === "function" &&
    typeof (value as WorkerLogger).error === "function"
  );
}

async function runWorkerProbeWithTimeout(
  probe: () => Promise<WorkerProbeOutcome>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      probe(),
      new Promise<WorkerProbeOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ healthy: false }), timeoutMs);
      }),
    ]);
    return outcome.healthy === true;
  } catch {
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function createWorkerRuntime(
  loggerOrOptions: WorkerLogger | WorkerRuntimeOptions = {},
): WorkerRuntime {
  const options: WorkerRuntimeOptions = isWorkerLogger(loggerOrOptions)
    ? { logger: loggerOrOptions }
    : loggerOrOptions;

  const logger = options.logger ?? createDefaultLogger();
  const timeoutMs = Math.max(250, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const nowFn = options.now ?? (() => new Date());

  let status: WorkerHealth["status"] = "stopped";
  let startedAtMs: number | null = null;

  return {
    async start(): Promise<void> {
      if (status === "running" || status === "starting") {
        return;
      }
      status = "starting";
      startedAtMs = Date.now();
      status = "running";
      logger.info("Worker runtime started");
    },

    async stop(signal?: string): Promise<void> {
      if (status === "stopped" || status === "stopping") {
        return;
      }
      status = "stopping";
      logger.info("Worker runtime stopping", signal ? { signal } : undefined);
      startedAtMs = null;
      status = "stopped";
    },

    getHealth(): WorkerHealth {
      return {
        status,
        startedAt: startedAtMs !== null ? new Date(startedAtMs).toISOString() : null,
        uptimeMs: startedAtMs !== null ? Math.max(0, Date.now() - startedAtMs) : 0,
      };
    },

    async getReadiness(): Promise<WorkerReadinessReport> {
      const checkedAt = nowFn().toISOString();
      const checks: Record<string, WorkerDependencyState> = {
        runtime: status === "running" ? "ok" : "unavailable",
      };

      if (status !== "running") {
        return {
          status: "not_ready",
          checkedAt,
          checks,
        };
      }

      let ready = true;

      if (options.checkDatabase) {
        const dbHealthy = await runWorkerProbeWithTimeout(options.checkDatabase, timeoutMs);
        checks.database = dbHealthy ? "ok" : "degraded";
        if (!dbHealthy) {
          ready = false;
        }
      }

      if (options.dependencies) {
        const results = await Promise.all(
          options.dependencies.map(async (dep) => ({
            name: dep.name,
            healthy: await runWorkerProbeWithTimeout(dep.check, timeoutMs),
          })),
        );
        for (const item of results) {
          checks[item.name] = item.healthy ? "ok" : "degraded";
          if (!item.healthy) {
            ready = false;
          }
        }
      }

      return {
        status: ready ? "ready" : "not_ready",
        checkedAt,
        checks,
      };
    },
  };
}

/**
 * Exposes sanitized HTTP liveness (`/health/live`) and readiness (`/health/ready`) endpoints
 * for container orchestrators without disclosing internal credentials, hostnames, or errors.
 */
export async function createWorkerHealthServer(params: {
  readonly runtime: WorkerRuntime;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}): Promise<WorkerHealthServer> {
  const host = params.host ?? "127.0.0.1";
  const port = params.port ?? 0;

  const server = http.createServer((req, res) => {
    const requestPath = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    if (requestPath === "/health/live") {
      const health = params.runtime.getHealth();
      const alive = health.status === "running" || health.status === "starting";
      res.writeHead(alive ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ status: alive ? "ok" : "unavailable" }));
      return;
    }

    if (requestPath === "/health/ready") {
      void params.runtime.getReadiness().then((report) => {
        res.writeHead(report.status === "ready" ? 200 : 503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(report));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

async function runMain(): Promise<void> {
  const logger = createDefaultLogger();
  const jobs: StandaloneWorkerJobs = createStandaloneWorkerJobs(logger, process.env);

  const runtime = createWorkerRuntime({
    logger,
    checkDatabase: () => jobs.checkDatabase(),
    dependencies: [
      {
        name: "antivirus",
        check: () => jobs.checkAntivirus(),
      },
    ],
  });

  let healthServer: WorkerHealthServer | null = null;
  const rawHealthPort = process.env.WORKER_HEALTH_PORT?.trim();
  if (rawHealthPort) {
    const parsedPort = Number.parseInt(rawHealthPort, 10);
    if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
      healthServer = await createWorkerHealthServer({
        runtime,
        host: process.env.WORKER_HEALTH_HOST ?? "0.0.0.0",
        port: parsedPort,
      });
    }
  }

  let isShuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    try {
      await jobs.stop();
      if (healthServer) {
        await healthServer.close();
      }
      await runtime.stop(signal);
      process.exit(0);
    } catch (error) {
      logger.error("Worker failed during shutdown", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await runtime.start();
  jobs.start();
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  void runMain();
}
