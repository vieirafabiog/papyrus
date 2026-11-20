import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  CreateSessionInput,
  IssuedSession,
  SessionPolicy,
  SessionStorePort,
  ValidatedSession,
} from "./session.types.js";

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ROTATION_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TOKEN_BYTE_LENGTH = 32;

export interface SessionServiceOptions {
  readonly store: SessionStorePort;
  readonly policy?: Partial<SessionPolicy> | undefined;
  readonly secretPepper?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface SessionService {
  createSession(input: CreateSessionInput): Promise<IssuedSession>;
  validateAndMaybeRotate(
    rawToken: string,
    context?: {
      readonly ipAddress?: string | null | undefined;
      readonly userAgent?: string | null | undefined;
    },
  ): Promise<ValidatedSession | null>;
  revokeSession(rawToken: string): Promise<void>;
  revokeAllUserSessions(userId: string): Promise<void>;
}

export function hashSessionToken(rawToken: string, secretPepper?: string): string {
  if (secretPepper && secretPepper.length > 0) {
    return createHmac("sha256", secretPepper).update(rawToken).digest("hex");
  }
  return createHash("sha256").update(rawToken).digest("hex");
}

function resolvePolicy(partial?: Partial<SessionPolicy>): SessionPolicy {
  const ttlMs = partial?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const rotationThresholdMs = partial?.rotationThresholdMs ?? DEFAULT_ROTATION_THRESHOLD_MS;
  const tokenByteLength = partial?.tokenByteLength ?? DEFAULT_TOKEN_BYTE_LENGTH;

  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Invalid session policy: ttlMs must be a positive integer.");
  }
  if (!Number.isInteger(rotationThresholdMs) || rotationThresholdMs < 0) {
    throw new Error("Invalid session policy: rotationThresholdMs must be non-negative.");
  }
  if (!Number.isInteger(tokenByteLength) || tokenByteLength < 16) {
    throw new Error("Invalid session policy: tokenByteLength must be at least 16 bytes.");
  }

  return {
    ttlMs,
    rotationThresholdMs,
    tokenByteLength,
  };
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  const policy = resolvePolicy(options.policy);
  const nowFn = options.now ?? (() => new Date());

  const issue = async (input: CreateSessionInput): Promise<IssuedSession> => {
    const rawToken = randomBytes(policy.tokenByteLength).toString("base64url");
    const tokenHash = hashSessionToken(rawToken, options.secretPepper);
    const issuedAt = nowFn();
    const expiresAt = new Date(issuedAt.getTime() + policy.ttlMs);

    const session = await options.store.create({
      id: randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      tokenHash,
      expiresAt,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    return { session, rawToken };
  };

  return {
    createSession: issue,

    async validateAndMaybeRotate(rawToken, context): Promise<ValidatedSession | null> {
      const trimmed = rawToken.trim();
      if (trimmed.length < 16) {
        return null;
      }

      const tokenHash = hashSessionToken(trimmed, options.secretPepper);
      const existing = await options.store.findByTokenHash(tokenHash);
      if (!existing) {
        return null;
      }

      const now = nowFn();
      if (existing.revokedAt !== null || existing.expiresAt.getTime() <= now.getTime()) {
        return null;
      }

      const remainingMs = existing.expiresAt.getTime() - now.getTime();
      if (policy.rotationThresholdMs > 0 && remainingMs <= policy.rotationThresholdMs) {
        await options.store.revokeById(existing.id, now);
        const rotated = await issue({
          organizationId: existing.organizationId,
          userId: existing.userId,
          ipAddress: context?.ipAddress ?? existing.ipAddress,
          userAgent: context?.userAgent ?? existing.userAgent,
        });
        return {
          session: rotated.session,
          rotatedToken: rotated.rawToken,
        };
      }

      return {
        session: existing,
        rotatedToken: null,
      };
    },

    async revokeSession(rawToken: string): Promise<void> {
      const trimmed = rawToken.trim();
      if (trimmed.length === 0) {
        return;
      }
      const tokenHash = hashSessionToken(trimmed, options.secretPepper);
      const existing = await options.store.findByTokenHash(tokenHash);
      if (existing && existing.revokedAt === null) {
        await options.store.revokeById(existing.id, nowFn());
      }
    },

    async revokeAllUserSessions(userId: string): Promise<void> {
      await options.store.revokeAllForUser(userId, nowFn());
    },
  };
}
