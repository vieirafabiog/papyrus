import Fastify, { type FastifyInstance } from "fastify";

export interface AppOptions {
  logger?: boolean;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  app.get("/api/v1/health/live", async () => {
    return { status: "ok" };
  });

  return app;
}
