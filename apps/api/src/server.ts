import { createStandaloneApiRuntime } from "./bootstrap.js";

async function start(): Promise<void> {
  const runtime = createStandaloneApiRuntime(process.env);
  const { app, host, port } = runtime;

  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    app.log.info({ signal }, "Shutting down API server gracefully");
    try {
      await runtime.close();
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
    await runtime.dbClient.close().catch(() => {});
    process.exit(1);
  }
}

void start();
