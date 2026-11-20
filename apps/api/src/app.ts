import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import type { AuthService } from "./modules/auth/auth.service.js";

export interface AppOptions {
  readonly logger?: boolean | undefined;
  readonly authService?: AuthService | undefined;
  readonly secureCookies?: boolean | undefined;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
  });

  void app.register(cookie);

  app.get("/api/v1/health/live", async () => {
    return { status: "ok" };
  });

  if (options.authService) {
    const authService = options.authService;
    const secureCookies = options.secureCookies ?? process.env["NODE_ENV"] === "production";
    void app.register(async (instance) => {
      await registerAuthRoutes(instance, { authService, secureCookies });
    });
  }

  return app;
}
