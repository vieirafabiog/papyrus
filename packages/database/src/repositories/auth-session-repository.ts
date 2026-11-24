import { randomUUID } from "node:crypto";
import type { AccessAction, AccessResource } from "@docuflow/domain";
import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditEvents } from "../schema/governance.js";
import {
  groups,
  organizations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userGroups,
  userRoleScopes,
  users,
} from "../schema/identity.js";

const BOOTSTRAP_ADVISORY_LOCK_ID = 940605;

export interface DatabaseSessionRecordInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface DatabaseSessionRecord {
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

export interface DatabaseSessionStore {
  create(input: DatabaseSessionRecordInput): Promise<DatabaseSessionRecord>;
  findByTokenHash(tokenHash: string): Promise<DatabaseSessionRecord | null>;
  revokeById(sessionId: string, revokedAt: Date): Promise<void>;
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>;
}

export function createSessionStoreRepository(db: NodePgDatabase): DatabaseSessionStore {
  return {
    async create(input: DatabaseSessionRecordInput): Promise<DatabaseSessionRecord> {
      const [row] = await db.insert(sessions).values(input).returning();
      if (!row) {
        throw new Error("Failed to persist session record.");
      }
      return row;
    },

    async findByTokenHash(tokenHash: string): Promise<DatabaseSessionRecord | null> {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    },

    async revokeById(sessionId: string, revokedAt: Date): Promise<void> {
      await db.update(sessions).set({ revokedAt }).where(eq(sessions.id, sessionId));
    },

    async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
      await db.update(sessions).set({ revokedAt }).where(eq(sessions.userId, userId));
    },
  };
}

export interface DatabaseAuthUserSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: "ACTIVE" | "INACTIVE" | "LOCKED";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DatabaseAuthCredentialRecord {
  readonly user: DatabaseAuthUserSummary;
  readonly passwordHash: string;
}

export interface DatabaseAuthUserProfile {
  readonly user: DatabaseAuthUserSummary;
  readonly groups: readonly {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly description: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
  readonly roles: readonly {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
    readonly isSystem: boolean;
  }[];
  readonly permissions: readonly {
    readonly id: string;
    readonly action: AccessAction;
    readonly resource: AccessResource;
  }[];
}

export interface DatabaseAuthUserLookup {
  findCredentialByEmail(normalizedEmail: string): Promise<DatabaseAuthCredentialRecord | null>;
  findProfileById(userId: string): Promise<DatabaseAuthUserProfile | null>;
}

function toAuthUserSummary(row: typeof users.$inferSelect): DatabaseAuthUserSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    fullName: row.fullName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createAuthLookupRepository(db: NodePgDatabase): DatabaseAuthUserLookup {
  return {
    async findCredentialByEmail(
      normalizedEmail: string,
    ): Promise<DatabaseAuthCredentialRecord | null> {
      const [row] = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
      if (!row) {
        return null;
      }
      return {
        user: toAuthUserSummary(row),
        passwordHash: row.passwordHash,
      };
    },

    async findProfileById(userId: string): Promise<DatabaseAuthUserProfile | null> {
      const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!userRow) {
        return null;
      }

      const rawGroupRows = await db
        .select({
          id: groups.id,
          organizationId: groups.organizationId,
          name: groups.name,
          description: groups.description,
          createdAt: groups.createdAt,
          updatedAt: groups.updatedAt,
        })
        .from(userGroups)
        .innerJoin(groups, eq(groups.id, userGroups.groupId))
        .where(
          and(eq(userGroups.userId, userRow.id), eq(groups.organizationId, userRow.organizationId)),
        );

      const groupRows = rawGroupRows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        name: row.name,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));

      const groupIds = groupRows.map((g) => g.id);
      const subjectCondition =
        groupIds.length > 0
          ? or(eq(userRoleScopes.userId, userRow.id), inArray(userRoleScopes.groupId, groupIds))
          : eq(userRoleScopes.userId, userRow.id);

      const assignmentRows = await db
        .select({
          roleId: userRoleScopes.roleId,
          effect: userRoleScopes.effect,
        })
        .from(userRoleScopes)
        .where(and(eq(userRoleScopes.organizationId, userRow.organizationId), subjectCondition));

      const allowedRoleIds = Array.from(
        new Set(assignmentRows.filter((a) => a.effect === "ALLOW").map((a) => a.roleId)),
      );

      const roleRows =
        allowedRoleIds.length > 0
          ? await db
              .select({
                id: roles.id,
                key: roles.key,
                name: roles.name,
                description: roles.description,
                isSystem: roles.isSystem,
              })
              .from(roles)
              .where(inArray(roles.id, allowedRoleIds))
          : [];

      const permissionRows =
        allowedRoleIds.length > 0
          ? await db
              .select({
                id: permissions.id,
                action: permissions.action,
                resource: permissions.resource,
              })
              .from(rolePermissions)
              .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
              .where(inArray(rolePermissions.roleId, allowedRoleIds))
          : [];

      const uniquePermissions = new Map<
        string,
        { readonly id: string; readonly action: AccessAction; readonly resource: AccessResource }
      >();
      for (const perm of permissionRows) {
        uniquePermissions.set(perm.id, perm);
      }

      return {
        user: toAuthUserSummary(userRow),
        groups: groupRows,
        roles: roleRows,
        permissions: Array.from(uniquePermissions.values()),
      };
    },
  };
}

export interface SystemRoleSeedDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly permissions: readonly {
    readonly action: AccessAction;
    readonly resource: AccessResource;
  }[];
}

export interface SystemBootstrapRepositoryOptions {
  readonly permissionCatalog: readonly {
    readonly action: AccessAction;
    readonly resource: AccessResource;
  }[];
  readonly systemRoles: readonly SystemRoleSeedDefinition[];
  readonly onAlreadyInitialized: () => Error;
}

export interface SystemBootstrapInput {
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly email: string;
  readonly fullName: string;
  readonly passwordHash: string;
  readonly requestId: string;
}

export interface SystemBootstrapResult {
  readonly organizationId: string;
  readonly adminUserId: string;
  readonly email: string;
  readonly fullName: string;
}

export interface SystemBootstrapRepository {
  hasAnyActiveAdmin(): Promise<boolean>;
  createInitialAdmin(input: SystemBootstrapInput): Promise<SystemBootstrapResult>;
}

export function createSystemBootstrapRepository(
  db: NodePgDatabase,
  options: SystemBootstrapRepositoryOptions,
): SystemBootstrapRepository {
  return {
    async hasAnyActiveAdmin(): Promise<boolean> {
      const [row] = await db
        .select({ total: count() })
        .from(users)
        .innerJoin(userRoleScopes, eq(userRoleScopes.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoleScopes.roleId))
        .where(
          and(
            eq(users.status, "ACTIVE"),
            eq(roles.key, "admin"),
            eq(userRoleScopes.scopeType, "GLOBAL"),
            eq(userRoleScopes.effect, "ALLOW"),
          ),
        );
      return Number(row?.total ?? 0) > 0;
    },

    async createInitialAdmin(input: SystemBootstrapInput): Promise<SystemBootstrapResult> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_ID})`);

        const [existingAdmin] = await tx
          .select({ total: count() })
          .from(users)
          .innerJoin(userRoleScopes, eq(userRoleScopes.userId, users.id))
          .innerJoin(roles, eq(roles.id, userRoleScopes.roleId))
          .where(
            and(
              eq(users.status, "ACTIVE"),
              eq(roles.key, "admin"),
              eq(userRoleScopes.scopeType, "GLOBAL"),
              eq(userRoleScopes.effect, "ALLOW"),
            ),
          );

        if (Number(existingAdmin?.total ?? 0) > 0) {
          throw options.onAlreadyInitialized();
        }

        const [existingOrg] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.slug, input.organizationSlug))
          .limit(1);

        const organizationId = existingOrg?.id ?? randomUUID();
        if (!existingOrg) {
          await tx.insert(organizations).values({
            id: organizationId,
            name: input.organizationName,
            slug: input.organizationSlug,
          });
        }

        if (options.permissionCatalog.length > 0) {
          await tx
            .insert(permissions)
            .values(
              options.permissionCatalog.map((pair) => ({
                id: randomUUID(),
                action: pair.action,
                resource: pair.resource,
              })),
            )
            .onConflictDoNothing({
              target: [permissions.action, permissions.resource],
            });
        }

        const allPermissions = await tx.select().from(permissions);
        const permissionIdByKey = new Map<string, string>(
          allPermissions.map((perm) => [`${perm.action}:${perm.resource}`, perm.id]),
        );

        let adminRoleId: string | null = null;

        for (const roleDef of options.systemRoles) {
          const [existingRole] = await tx
            .select()
            .from(roles)
            .where(and(eq(roles.organizationId, organizationId), eq(roles.key, roleDef.key)))
            .limit(1);

          const roleId = existingRole?.id ?? randomUUID();
          if (!existingRole) {
            await tx.insert(roles).values({
              id: roleId,
              organizationId,
              key: roleDef.key,
              name: roleDef.name,
              description: roleDef.description,
              isSystem: roleDef.isSystem,
            });
          }

          if (roleDef.key === "admin") {
            adminRoleId = roleId;
          }

          const rolePermValues = roleDef.permissions
            .map((pair) => permissionIdByKey.get(`${pair.action}:${pair.resource}`))
            .filter((permId): permId is string => permId !== undefined)
            .map((permissionId) => ({
              id: randomUUID(),
              roleId,
              permissionId,
            }));

          if (rolePermValues.length > 0) {
            await tx
              .insert(rolePermissions)
              .values(rolePermValues)
              .onConflictDoNothing({
                target: [rolePermissions.roleId, rolePermissions.permissionId],
              });
          }
        }

        if (!adminRoleId) {
          adminRoleId = randomUUID();
          await tx.insert(roles).values({
            id: adminRoleId,
            organizationId,
            key: "admin",
            name: "Administrador",
            description: "Administração completa da instalação.",
            isSystem: true,
          });
        }

        const adminUserId = randomUUID();
        await tx.insert(users).values({
          id: adminUserId,
          organizationId,
          email: input.email,
          fullName: input.fullName,
          passwordHash: input.passwordHash,
          status: "ACTIVE",
        });

        await tx.insert(userRoleScopes).values({
          organizationId,
          userId: adminUserId,
          roleId: adminRoleId,
          scopeType: "GLOBAL",
          scopeTargetId: null,
          effect: "ALLOW",
          createdBy: adminUserId,
        });

        await tx.insert(auditEvents).values({
          organizationId,
          actorUserId: adminUserId,
          action: "SETUP_BOOTSTRAP_ADMIN",
          resourceType: "USER",
          resourceId: adminUserId,
          result: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            organizationSlug: input.organizationSlug,
          },
        });

        return {
          organizationId,
          adminUserId,
          email: input.email,
          fullName: input.fullName,
        };
      });
    },
  };
}
