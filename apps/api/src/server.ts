import { buildApp } from "./app.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(rawPort, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }
  return parsed;
}

async function start(): Promise<void> {
  const app = buildApp({ logger: true });
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;

  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    app.log.info({ signal }, "Shutting down API server gracefully");
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error({ err: error }, "Failed to start API server");
    process.exit(1);
  }
}

void start();
