import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { BootstrapAlreadyCompletedError, type SetupService } from "./setup.service.js";

export async function registerSetupRoutes(
  app: FastifyInstance,
  setupService: SetupService,
): Promise<void> {
  app.get(`${CONTRACTS_API_PREFIX}/setup/status`, async () => {
    const status = await setupService.getStatus();
    return { data: status };
  });

  app.post(`${CONTRACTS_API_PREFIX}/setup/bootstrap-admin`, async (request, reply) => {
    try {
      const created = await setupService.bootstrapFirstAdmin(request.body, request.id);
      return reply.status(201).send({ data: created });
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Dados inválidos para criação do administrador inicial.",
            requestId: request.id,
          },
        });
      }
      if (error instanceof BootstrapAlreadyCompletedError) {
        return reply.status(409).send({
          error: {
            code: "CONFLICT",
            message: error.message,
            requestId: request.id,
          },
        });
      }
      throw error;
    }
  });
}
