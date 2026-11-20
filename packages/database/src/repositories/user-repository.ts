import type {
  CreateUserInput,
  TransactionContext,
  UpdateUserInput,
  UserEntity,
  UserRepositoryPort,
} from "@docuflow/domain";
import { and, asc, countDistinct, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { roles, userRoleScopes, users } from "../schema/identity.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toUserEntity(row: typeof users.$inferSelect): UserEntity {
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

export function createUserRepository(db: NodePgDatabase): UserRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<UserEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toUserEntity(row) : null;
    },

    async findByEmail(
      organizationId: string,
      normalizedEmail: string,
      tx?: TransactionContext,
    ): Promise<UserEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const email = normalizedEmail.trim().toLowerCase();
      const [row] = await executor
        .select()
        .from(users)
        .where(and(eq(users.organizationId, organizationId), eq(users.email, email)))
        .limit(1);
      return row ? toUserEntity(row) : null;
    },

    async listByOrganization(organizationId: string): Promise<readonly UserEntity[]> {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.organizationId, organizationId))
        .orderBy(asc(users.fullName), asc(users.id));
      return rows.map(toUserEntity);
    },

    async create(input: CreateUserInput, tx?: TransactionContext): Promise<UserEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(users)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          email: input.email.trim().toLowerCase(),
          fullName: input.fullName.trim(),
          passwordHash: input.passwordHash,
          status: input.status,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert user record.");
      }
      return toUserEntity(row);
    },

    async update(
      id: string,
      input: UpdateUserInput,
      tx?: TransactionContext,
    ): Promise<UserEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const patch: Partial<typeof users.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.fullName !== undefined) {
        patch.fullName = input.fullName.trim();
      }
      if (input.status !== undefined) {
        patch.status = input.status;
      }

      const [row] = await executor.update(users).set(patch).where(eq(users.id, id)).returning();
      return row ? toUserEntity(row) : null;
    },

    async countActiveAdmins(organizationId: string, tx?: TransactionContext): Promise<number> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ total: countDistinct(users.id) })
        .from(users)
        .innerJoin(userRoleScopes, eq(userRoleScopes.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoleScopes.roleId))
        .where(
          and(
            eq(users.organizationId, organizationId),
            eq(users.status, "ACTIVE"),
            eq(roles.key, "admin"),
            eq(userRoleScopes.scopeType, "GLOBAL"),
            eq(userRoleScopes.effect, "ALLOW"),
          ),
        );
      return Number(row?.total ?? 0);
    },

    async isActiveGlobalAdmin(userId: string, tx?: TransactionContext): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ total: countDistinct(users.id) })
        .from(users)
        .innerJoin(userRoleScopes, eq(userRoleScopes.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoleScopes.roleId))
        .where(
          and(
            eq(users.id, userId),
            eq(users.status, "ACTIVE"),
            eq(roles.key, "admin"),
            eq(userRoleScopes.scopeType, "GLOBAL"),
            eq(userRoleScopes.effect, "ALLOW"),
          ),
        );
      return Number(row?.total ?? 0) > 0;
    },
  };
}
