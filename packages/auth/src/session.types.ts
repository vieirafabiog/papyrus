export interface SessionPolicy {
  readonly ttlMs: number;
  readonly rotationThresholdMs: number;
  readonly tokenByteLength: number;
}

export interface StoredSessionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

export interface CreateSessionRecordInput {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface SessionStorePort {
  create(input: CreateSessionRecordInput): Promise<StoredSessionRecord>;
  findByTokenHash(tokenHash: string): Promise<StoredSessionRecord | null>;
  revokeById(sessionId: string, revokedAt: Date): Promise<void>;
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>;
}

export interface CreateSessionInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly ipAddress?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

export interface IssuedSession {
  readonly session: StoredSessionRecord;
  readonly rawToken: string;
}

export interface ValidatedSession {
  readonly session: StoredSessionRecord;
  readonly rotatedToken: string | null;
}
