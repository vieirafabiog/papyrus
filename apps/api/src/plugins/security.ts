import { randomBytes, timingSafeEqual } from "node:crypto";
import { CONTRACTS_API_PREFIX } from "@docuflow/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const CSRF_COOKIE_NAME = "docuflow_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface RateLimitRule {
  readonly maxAttempts: number;
  readonly windowMs: number;
}

export interface SecurityPluginOptions {
  readonly allowedOrigins: readonly string[];
  readonly secureCookies: boolean;
  readonly enforceCsrf?: boolean | undefined;
  readonly loginRateLimit?: RateLimitRule | undefined;
  readonly now?: (() => number) | undefined;
}

interface RateLimitBucket {
  count: number;
  resetAtMs: number;
}

export interface LoginRateLimiter {
  consume(key: string): { readonly allowed: boolean; readonly retryAfterSeconds: number };
  reset(key: string): void;
}

export function createLoginRateLimiter(
  rule: RateLimitRule,
  nowFn: () => number = () => Date.now(),
): LoginRateLimiter {
  if (!Number.isInteger(rule.maxAttempts) || rule.maxAttempts < 1) {
    throw new Error("Invalid rate limit maxAttempts.");
  }
  if (!Number.isInteger(rule.windowMs) || rule.windowMs < 1000) {
    throw new Error("Invalid rate limit windowMs.");
  }

  const buckets = new Map<string, RateLimitBucket>();

  return {
    consume(key: string): { readonly allowed: boolean; readonly retryAfterSeconds: number } {
      const now = nowFn();
      const existing = buckets.get(key);

      if (!existing || existing.resetAtMs <= now) {
        buckets.set(key, { count: 1, resetAtMs: now + rule.windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (existing.count >= rule.maxAttempts) {
        const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000));
        return { allowed: false, retryAfterSeconds };
      }

      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },

    reset(key: string): void {
      buckets.delete(key);
    },
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function issueCsrfCookie(reply: FastifyReply, secureCookies: boolean): string {
  const token = randomBytes(32).toString("base64url");
  reply.setCookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
  });
  return token;
}

function sendForbidden(reply: FastifyReply, requestId: string, message: string): void {
  void reply.status(403).send({
    error: {
      code: "FORBIDDEN",
      message,
      requestId,
    },
  });
}

export async function registerSecurityPlugin(
  app: FastifyInstance,
  options: SecurityPluginOptions,
): Promise<void> {
  const allowedOriginSet = new Set(options.allowedOrigins);
  const enforceCsrf = options.enforceCsrf ?? true;
  const nowFn = options.now ?? (() => Date.now());
  const loginLimiter = createLoginRateLimiter(
    options.loginRateLimit ?? { maxAttempts: 5, windowMs: 60_000 },
    nowFn,
  );

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-XSS-Protection", "0");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (options.secureCookies) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const originHeader = request.headers.origin;
    if (typeof originHeader === "string" && originHeader.length > 0) {
      if (!allowedOriginSet.has(originHeader)) {
        sendForbidden(reply, request.id, "Origem não permitida pela política de CORS.");
        return reply;
      }
      reply.header("Access-Control-Allow-Origin", originHeader);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
    }

    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }

    if (enforceCsrf && MUTATING_METHODS.has(request.method)) {
      const cookieToken = request.cookies[CSRF_COOKIE_NAME];
      const headerValue = request.headers[CSRF_HEADER_NAME];
      const headerToken = typeof headerValue === "string" ? headerValue : undefined;

      if (
        !cookieToken ||
        !headerToken ||
        cookieToken.length < 16 ||
        !constantTimeEquals(cookieToken, headerToken)
      ) {
        sendForbidden(reply, request.id, "Token CSRF ausente ou inválido.");
        return reply;
      }
    }

    const urlPath = request.url.split("?")[0];
    if (request.method === "POST" && urlPath === `${CONTRACTS_API_PREFIX}/auth/login`) {
      const limitKey = request.ip || "unknown";
      const outcome = loginLimiter.consume(limitKey);
      if (!outcome.allowed) {
        reply.header("Retry-After", String(outcome.retryAfterSeconds));
        return reply.status(429).send({
          error: {
            code: "RATE_LIMITED",
            message: "Muitas tentativas de login. Aguarde antes de tentar novamente.",
            requestId: request.id,
          },
        });
      }
    }

    return;
  });

  app.get(`${CONTRACTS_API_PREFIX}/auth/csrf-token`, async (_request, reply) => {
    const csrfToken = issueCsrfCookie(reply, options.secureCookies);
    return reply.status(200).send({ data: { csrfToken } });
  });
}
