import { randomUUID } from "node:crypto";
import type {
  GroupAdministrationService,
  UserAdministrationService,
} from "@docuflow/domain";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import type { AuthService } from "./modules/auth/auth.service.js";
import { registerGroupRoutes } from "./modules/groups/groups.routes.js";
import { registerSetupRoutes } from "./modules/setup/setup.routes.js";
import type { SetupService } from "./modules/setup/setup.service.js";
import { registerUserRoutes } from "./modules/users/users.routes.js";
import { registerSecurityPlugin, type SecurityPluginOptions } from "./plugins/security.js";

export interface AppOptions {
  readonly logger?: boolean | undefined;
  readonly authService?: AuthService | undefined;
  readonly setupService?: SetupService | undefined;
  readonly userAdminService?: UserAdministrationService | undefined;
  readonly groupAdminService?: GroupAdministrationService | undefined;
  readonly secureCookies?: boolean | undefined;
  readonly security?: Partial<SecurityPluginOptions> | undefined;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
  });

  const secureCookies = options.secureCookies ?? process.env["NODE_ENV"] === "production";

  void app.register(cookie);
  app.after(() => {
    void registerSecurityPlugin(app, {
      allowedOrigins: options.security?.allowedOrigins ?? ["http://localhost:5173"],
      secureCookies,
      enforceCsrf: options.security?.enforceCsrf,
      loginRateLimit: options.security?.loginRateLimit,
      now: options.security?.now,
    });
  });

  app.get("/api/v1/health/live", async () => {
    return { status: "ok" };
  });

  if (options.setupService) {
    const setupService = options.setupService;
    void app.register(async (instance) => {
      await registerSetupRoutes(instance, setupService);
    });
  }

  if (options.authService) {
    const authService = options.authService;
    void app.register(async (instance) => {
      await registerAuthRoutes(instance, { authService, secureCookies });
    });

    if (options.userAdminService) {
      const userAdminService = options.userAdminService;
      void app.register(async (instance) => {
        await registerUserRoutes(instance, { authService, userAdminService });
      });
    }

    if (options.groupAdminService) {
      const groupAdminService = options.groupAdminService;
      void app.register(async (instance) => {
        await registerGroupRoutes(instance, { authService, groupAdminService });
      });
    }
  }

  return app;
}
