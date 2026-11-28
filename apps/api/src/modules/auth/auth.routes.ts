import { CONTRACTS_API_PREFIX, loginRequestSchema } from "@papyrus/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { issueCsrfCookie } from "../../plugins/security.js";
import type { AuthService } from "./auth.service.js";
import { type MicrosoftOidcService, sanitizeReturnToPath } from "./microsoft-oidc.service.js";

export const SESSION_COOKIE_NAME = "papyrus_session";
export const MICROSOFT_OIDC_STATE_COOKIE_NAME = "papyrus_ms_oidc";

export interface AuthRoutesOptions {
  readonly authService: AuthService;
  readonly secureCookies: boolean;
  readonly appOrigin?: string | undefined;
  readonly microsoftOidc?: MicrosoftOidcService | undefined;
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

function setMicrosoftStateCookie(
  reply: FastifyReply,
  signedState: string,
  maxAgeSeconds: number,
  secureCookies: boolean,
): void {
  reply.setCookie(MICROSOFT_OIDC_STATE_COOKIE_NAME, signedState, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: `${CONTRACTS_API_PREFIX}/auth/microsoft`,
    maxAge: maxAgeSeconds,
  });
}

function clearMicrosoftStateCookie(reply: FastifyReply, secureCookies: boolean): void {
  reply.clearCookie(MICROSOFT_OIDC_STATE_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: `${CONTRACTS_API_PREFIX}/auth/microsoft`,
  });
}

function buildAppRedirectUrl(appOrigin: string | undefined, pathWithQuery: string): string {
  if (!appOrigin) {
    return pathWithQuery;
  }
  return `${appOrigin.replace(/\/+$/, "")}${pathWithQuery}`;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const { authService, secureCookies, appOrigin, microsoftOidc } = options;

  app.get(`${CONTRACTS_API_PREFIX}/auth/providers`, async (_request, reply) => {
    return reply.status(200).send({
      data: {
        microsoft: {
          enabled: Boolean(microsoftOidc),
        },
      },
    });
  });

  app.get<{ Querystring: { returnTo?: string } }>(
    `${CONTRACTS_API_PREFIX}/auth/microsoft/start`,
    async (request, reply) => {
      if (!microsoftOidc) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Login com Microsoft não está habilitado neste ambiente.",
            requestId: request.id,
          },
        });
      }

      const started = microsoftOidc.createAuthorizationRequest(request.query.returnTo);
      setMicrosoftStateCookie(
        reply,
        started.signedStateCookie,
        started.maxAgeSeconds,
        secureCookies,
      );
      return reply.redirect(started.authorizationUrl, 302);
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    `${CONTRACTS_API_PREFIX}/auth/microsoft/callback`,
    async (request, reply) => {
      clearMicrosoftStateCookie(reply, secureCookies);

      if (!microsoftOidc) {
        return reply.redirect(
          buildAppRedirectUrl(appOrigin, "/login?authError=microsoft_failed"),
          302,
        );
      }

      if (typeof request.query.error === "string" && request.query.error.length > 0) {
        const errorParam =
          request.query.error === "access_denied" ? "microsoft_cancelled" : "microsoft_failed";
        return reply.redirect(
          buildAppRedirectUrl(appOrigin, `/login?authError=${errorParam}`),
          302,
        );
      }

      const code = typeof request.query.code === "string" ? request.query.code : "";
      const state = typeof request.query.state === "string" ? request.query.state : "";
      if (!code || !state) {
        return reply.redirect(
          buildAppRedirectUrl(appOrigin, "/login?authError=microsoft_failed"),
          302,
        );
      }

      let callbackResult: { readonly email: string; readonly returnTo: string };
      try {
        callbackResult = await microsoftOidc.completeCallback({
          code,
          state,
          signedStateCookie: request.cookies[MICROSOFT_OIDC_STATE_COOKIE_NAME],
        });
      } catch {
        return reply.redirect(
          buildAppRedirectUrl(appOrigin, "/login?authError=microsoft_failed"),
          302,
        );
      }

      const loginResult = await authService.loginWithVerifiedEmail({
        email: callbackResult.email,
        ipAddress: request.ip ?? null,
        userAgent:
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"].slice(0, 512)
            : null,
        requestId: request.id,
      });

      if (!loginResult.ok) {
        const errorParam =
          loginResult.reason === "USER_INACTIVE" ? "account_inactive" : "user_not_found";
        return reply.redirect(
          buildAppRedirectUrl(appOrigin, `/login?authError=${errorParam}`),
          302,
        );
      }

      setSessionCookie(
        reply,
        loginResult.outcome.rawToken,
        loginResult.outcome.session.expiresAt,
        secureCookies,
      );
      issueCsrfCookie(reply, secureCookies);

      const safeReturnTo = sanitizeReturnToPath(callbackResult.returnTo);
      return reply.redirect(buildAppRedirectUrl(appOrigin, safeReturnTo), 302);
    },
  );

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
