import type { PasswordService, SessionService, StoredSessionRecord } from "@docuflow/auth";
import type {
  AuthMeResponse,
  GroupSummary,
  PermissionRecord,
  RoleSummary,
  UserSummary,
} from "@docuflow/contracts";

export interface AuthCredentialRecord {
  readonly user: UserSummary;
  readonly passwordHash: string;
}

export interface AuthUserProfile {
  readonly user: UserSummary;
  readonly groups: readonly GroupSummary[];
  readonly roles: readonly RoleSummary[];
  readonly permissions: readonly PermissionRecord[];
}

export interface AuthUserLookupPort {
  findCredentialByEmail(normalizedEmail: string): Promise<AuthCredentialRecord | null>;
  findProfileById(userId: string): Promise<AuthUserProfile | null>;
}

export interface AuthAuditPort {
  recordAuthEvent(event: {
    readonly organizationId: string;
    readonly actorUserId: string | null;
    readonly action: "AUTH_LOGIN_SUCCESS" | "AUTH_LOGIN_FAILED" | "AUTH_LOGOUT";
    readonly result: "SUCCESS" | "DENIED";
    readonly requestId: string;
  }): Promise<void>;
}

export interface AuthServiceDependencies {
  readonly users: AuthUserLookupPort;
  readonly passwordService: PasswordService;
  readonly sessionService: SessionService;
  readonly audit?: AuthAuditPort | undefined;
}

export interface LoginCommand {
  readonly email: string;
  readonly password: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
}

export interface LoginOutcome {
  readonly rawToken: string;
  readonly session: StoredSessionRecord;
  readonly me: AuthMeResponse;
}

export interface MeOutcome {
  readonly me: AuthMeResponse;
  readonly session: StoredSessionRecord;
  readonly rotatedToken: string | null;
}

export interface AuthService {
  login(command: LoginCommand): Promise<LoginOutcome | null>;
  logout(rawToken: string | undefined, requestId: string): Promise<void>;
  getMe(rawToken: string | undefined): Promise<MeOutcome | null>;
}

function buildAuthMeResponse(
  profile: AuthUserProfile,
  sessionExpiresAt: Date,
): AuthMeResponse {
  return {
    user: {
      id: profile.user.id,
      organizationId: profile.user.organizationId,
      email: profile.user.email,
      fullName: profile.user.fullName,
      status: profile.user.status,
      createdAt: profile.user.createdAt,
      updatedAt: profile.user.updatedAt,
    },
    groups: [...profile.groups],
    roles: [...profile.roles],
    permissions: [...profile.permissions],
    sessionExpiresAt: sessionExpiresAt.toISOString(),
  };
}

export function createAuthService(deps: AuthServiceDependencies): AuthService {
  return {
    async login(command: LoginCommand): Promise<LoginOutcome | null> {
      const normalizedEmail = command.email.trim().toLowerCase();
      const credential = await deps.users.findCredentialByEmail(normalizedEmail);

      if (!credential || credential.user.status !== "ACTIVE") {
        if (credential && deps.audit) {
          await deps.audit.recordAuthEvent({
            organizationId: credential.user.organizationId,
            actorUserId: credential.user.id,
            action: "AUTH_LOGIN_FAILED",
            result: "DENIED",
            requestId: command.requestId,
          });
        }
        return null;
      }

      const passwordValid = await deps.passwordService.verifyPassword(
        command.password,
        credential.passwordHash,
      );

      if (!passwordValid) {
        if (deps.audit) {
          await deps.audit.recordAuthEvent({
            organizationId: credential.user.organizationId,
            actorUserId: credential.user.id,
            action: "AUTH_LOGIN_FAILED",
            result: "DENIED",
            requestId: command.requestId,
          });
        }
        return null;
      }

      const issued = await deps.sessionService.createSession({
        organizationId: credential.user.organizationId,
        userId: credential.user.id,
        ipAddress: command.ipAddress,
        userAgent: command.userAgent,
      });

      const profile = (await deps.users.findProfileById(credential.user.id)) ?? {
        user: credential.user,
        groups: [],
        roles: [],
        permissions: [],
      };

      if (deps.audit) {
        await deps.audit.recordAuthEvent({
          organizationId: credential.user.organizationId,
          actorUserId: credential.user.id,
          action: "AUTH_LOGIN_SUCCESS",
          result: "SUCCESS",
          requestId: command.requestId,
        });
      }

      return {
        rawToken: issued.rawToken,
        session: issued.session,
        me: buildAuthMeResponse(profile, issued.session.expiresAt),
      };
    },

    async logout(rawToken: string | undefined, requestId: string): Promise<void> {
      if (!rawToken) {
        return;
      }
      const existing = await deps.sessionService.validateAndMaybeRotate(rawToken);
      await deps.sessionService.revokeSession(rawToken);

      if (existing && deps.audit) {
        await deps.audit.recordAuthEvent({
          organizationId: existing.session.organizationId,
          actorUserId: existing.session.userId,
          action: "AUTH_LOGOUT",
          result: "SUCCESS",
          requestId,
        });
      }
    },

    async getMe(rawToken: string | undefined): Promise<MeOutcome | null> {
      if (!rawToken) {
        return null;
      }

      const validated = await deps.sessionService.validateAndMaybeRotate(rawToken);
      if (!validated) {
        return null;
      }

      const profile = await deps.users.findProfileById(validated.session.userId);
      if (!profile || profile.user.status !== "ACTIVE") {
        await deps.sessionService.revokeSession(validated.rotatedToken ?? rawToken);
        return null;
      }

      return {
        me: buildAuthMeResponse(profile, validated.session.expiresAt),
        session: validated.session,
        rotatedToken: validated.rotatedToken,
      };
    },
  };
}
