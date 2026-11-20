import { pathToFileURL } from "node:url";

export interface WorkerHealth {
  status: "starting" | "running" | "stopping" | "stopped";
  startedAt: string | null;
  uptimeMs: number;
}

export interface WorkerLogger {
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface WorkerRuntime {
  start(): Promise<void>;
  stop(signal?: string): Promise<void>;
  getHealth(): WorkerHealth;
}

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

export function createWorkerRuntime(logger: WorkerLogger = createDefaultLogger()): WorkerRuntime {
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
  };
}

async function runMain(): Promise<void> {
  const logger = createDefaultLogger();
  const runtime = createWorkerRuntime(logger);

  const shutdown = async (signal: string): Promise<void> => {
    try {
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
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  void runMain();
}
