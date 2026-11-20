import { CONTRACTS_API_PREFIX, loginRequestSchema } from "@docuflow/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthService } from "./auth.service.js";

export const SESSION_COOKIE_NAME = "docuflow_session";

export interface AuthRoutesOptions {
  readonly authService: AuthService;
  readonly secureCookies: boolean;
}

function setSessionCookie(
  reply: FastifyReply,
  rawToken: string,
  expiresAt: Date,
  secureCookies: boolean,
): void {
  reply.setCookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
    expires: expiresAt,
  });
}

function clearSessionCookie(reply: FastifyReply, secureCookies: boolean): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
  });
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const { authService, secureCookies } = options;

  app.post(`${CONTRACTS_API_PREFIX}/auth/login`, async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados de login inválidos.",
          requestId: request.id,
        },
      });
    }

    const result = await authService.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ipAddress: request.ip ?? null,
      userAgent:
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 512)
          : null,
      requestId: request.id,
    });

    if (!result) {
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "E-mail ou senha inválidos.",
          requestId: request.id,
        },
      });
    }

    setSessionCookie(reply, result.rawToken, result.session.expiresAt, secureCookies);
    return reply.status(200).send({ data: result.me });
  });

  app.post(`${CONTRACTS_API_PREFIX}/auth/logout`, async (request, reply) => {
    const rawToken = request.cookies[SESSION_COOKIE_NAME];
    await authService.logout(rawToken, request.id);
    clearSessionCookie(reply, secureCookies);
    return reply.status(200).send({ data: { loggedOut: true } });
  });

  app.get(`${CONTRACTS_API_PREFIX}/auth/me`, async (request, reply) => {
    const rawToken = request.cookies[SESSION_COOKIE_NAME];
    const outcome = await authService.getMe(rawToken);

    if (!outcome) {
      clearSessionCookie(reply, secureCookies);
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Sessão não autenticada ou expirada.",
          requestId: request.id,
        },
      });
    }

    if (outcome.rotatedToken !== null) {
      setSessionCookie(reply, outcome.rotatedToken, outcome.session.expiresAt, secureCookies);
    }

    return reply.status(200).send({ data: outcome.me });
  });
}
