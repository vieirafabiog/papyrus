import { describe, expect, it } from "vitest";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createSessionService,
} from "../src/index.js";

function createInMemorySessionStore(): {
  store: SessionStorePort;
  records: Map<string, StoredSessionRecord>;
} {
  const records = new Map<string, StoredSessionRecord>();

  return {
    records,
    store: {
      async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
        const record: StoredSessionRecord = {
          ...input,
          revokedAt: null,
          createdAt: new Date(),
        };
        records.set(record.id, record);
        return record;
      },
      async findByTokenHash(tokenHash: string): Promise<StoredSessionRecord | null> {
        for (const record of records.values()) {
          if (record.tokenHash === tokenHash) {
            return record;
          }
        }
        return null;
      },
      async revokeById(sessionId: string, revokedAt: Date): Promise<void> {
        const current = records.get(sessionId);
        if (current) {
          records.set(sessionId, { ...current, revokedAt });
        }
      },
      async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
        for (const [id, record] of records.entries()) {
          if (record.userId === userId && record.revokedAt === null) {
            records.set(id, { ...record, revokedAt });
          }
        }
      },
    },
  };
}

describe("SessionService", () => {
  it("stores only token hash, validates active sessions, and rejects expired or revoked sessions", async () => {
    let currentTime = new Date("2026-11-20T10:00:00Z");
    const { store, records } = createInMemorySessionStore();
    const service = createSessionService({
      store,
      secretPepper: "test-pepper-at-least-32-chars-long-value",
      policy: { ttlMs: 60 * 60 * 1000, rotationThresholdMs: 10 * 60 * 1000 },
      now: () => currentTime,
    });

    const issued = await service.createSession({
      organizationId: "org-1",
      userId: "user-1",
      ipAddress: "127.0.0.1",
      userAgent: "Vitest",
    });

    expect(issued.rawToken.length).toBeGreaterThanOrEqual(32);
    expect(issued.session.tokenHash).not.toBe(issued.rawToken);
    expect(records.get(issued.session.id)?.tokenHash).not.toContain(issued.rawToken);

    const valid = await service.validateAndMaybeRotate(issued.rawToken);
    expect(valid?.session.id).toBe(issued.session.id);
    expect(valid?.rotatedToken).toBeNull();

    // Expire session
    currentTime = new Date("2026-11-20T11:05:00Z");
    expect(await service.validateAndMaybeRotate(issued.rawToken)).toBeNull();

    // Revoke session
    currentTime = new Date("2026-11-20T10:05:00Z");
    await service.revokeSession(issued.rawToken);
    expect(await service.validateAndMaybeRotate(issued.rawToken)).toBeNull();
  });

  it("rotates session token when remaining lifetime enters threshold", async () => {
    let currentTime = new Date("2026-11-20T10:00:00Z");
    const { store } = createInMemorySessionStore();
    const service = createSessionService({
      store,
      policy: { ttlMs: 60 * 60 * 1000, rotationThresholdMs: 15 * 60 * 1000 },
      now: () => currentTime,
    });

    const issued = await service.createSession({
      organizationId: "org-1",
      userId: "user-1",
    });

    currentTime = new Date("2026-11-20T10:50:00Z");
    const rotated = await service.validateAndMaybeRotate(issued.rawToken);
    expect(rotated).not.toBeNull();
    expect(rotated?.rotatedToken).not.toBeNull();
    expect(rotated?.rotatedToken).not.toBe(issued.rawToken);
    expect(rotated?.session.id).not.toBe(issued.session.id);

    // Old token must now be revoked
    expect(await service.validateAndMaybeRotate(issued.rawToken)).toBeNull();
    // New rotated token works
    const checkNew = await service.validateAndMaybeRotate(rotated?.rotatedToken ?? "");
    expect(checkNew?.session.id).toBe(rotated?.session.id);
  });
});
