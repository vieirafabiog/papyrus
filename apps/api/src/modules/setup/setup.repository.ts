import { randomUUID } from "node:crypto";
import {
  auditEvents,
  organizations,
  roles,
  userRoleScopes,
  users,
} from "@docuflow/database";
import { and, count, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  type BootstrapAdminResult,
  BootstrapAlreadyCompletedError,
  type SetupBootstrapRepositoryPort,
} from "./setup.service.js";

const BOOTSTRAP_ADVISORY_LOCK_ID = 940605;

export function createDrizzleSetupRepository(db: NodePgDatabase): SetupBootstrapRepositoryPort {
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

    async createInitialAdmin(input): Promise<BootstrapAdminResult> {
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
          throw new BootstrapAlreadyCompletedError();
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

        const [existingRole] = await tx
          .select()
          .from(roles)
          .where(and(eq(roles.organizationId, organizationId), eq(roles.key, "admin")))
          .limit(1);

        const adminRoleId = existingRole?.id ?? randomUUID();
        if (!existingRole) {
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
