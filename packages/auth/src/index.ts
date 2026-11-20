export const AUTH_MODULE_VERSION = 1 as const;

export {
  createPasswordService,
  type PasswordService,
  type PasswordServiceOptions,
} from "./password-service.js";

export {
  createSessionService,
  hashSessionToken,
  type SessionService,
  type SessionServiceOptions,
} from "./session-service.js";

export type {
  CreateSessionInput,
  CreateSessionRecordInput,
  IssuedSession,
  SessionPolicy,
  SessionStorePort,
  StoredSessionRecord,
  ValidatedSession,
} from "./session.types.js";
