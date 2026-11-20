import type {
  AddGroupMemberInput,
  CreateGroupInput,
  GroupEntity,
  GroupRepositoryPort,
  TransactionContext,
  UserEntity,
} from "@docuflow/domain";
import { and, asc, count, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { groups, userGroups, users } from "../schema/identity.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toGroupEntity(row: typeof groups.$inferSelect): GroupEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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

export function createGroupRepository(db: NodePgDatabase): GroupRepositoryPort {
  return {
    async findById(id: string, tx?: TransactionContext): Promise<GroupEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor.select().from(groups).where(eq(groups.id, id)).limit(1);
      return row ? toGroupEntity(row) : null;
    },

    async findByName(
      organizationId: string,
      name: string,
      tx?: TransactionContext,
    ): Promise<GroupEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(groups)
        .where(and(eq(groups.organizationId, organizationId), eq(groups.name, name.trim())))
        .limit(1);
      return row ? toGroupEntity(row) : null;
    },

    async listByOrganization(organizationId: string): Promise<readonly GroupEntity[]> {
      const rows = await db
        .select()
        .from(groups)
        .where(eq(groups.organizationId, organizationId))
        .orderBy(asc(groups.name), asc(groups.id));
      return rows.map(toGroupEntity);
    },

    async create(input: CreateGroupInput, tx?: TransactionContext): Promise<GroupEntity> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .insert(groups)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          name: input.name,
          description: input.description,
          createdBy: input.createdBy,
          updatedBy: input.createdBy,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to insert group record.");
      }
      return toGroupEntity(row);
    },

    async isMember(
      groupId: string,
      userId: string,
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({ total: count() })
        .from(userGroups)
        .where(and(eq(userGroups.groupId, groupId), eq(userGroups.userId, userId)));
      return Number(row?.total ?? 0) > 0;
    },

    async addMember(input: AddGroupMemberInput, tx?: TransactionContext): Promise<void> {
      const executor = resolveDbExecutor(db, tx);
      await executor.insert(userGroups).values({
        id: input.id,
        groupId: input.groupId,
        userId: input.userId,
      });
    },

    async removeMember(
      groupId: string,
      userId: string,
      tx?: TransactionContext,
    ): Promise<boolean> {
      const executor = resolveDbExecutor(db, tx);
      const deleted = await executor
        .delete(userGroups)
        .where(and(eq(userGroups.groupId, groupId), eq(userGroups.userId, userId)))
        .returning({ id: userGroups.id });
      return deleted.length > 0;
    },

    async listMembers(groupId: string): Promise<readonly UserEntity[]> {
      const rows = await db
        .select({ user: users })
        .from(userGroups)
        .innerJoin(users, eq(users.id, userGroups.userId))
        .where(eq(userGroups.groupId, groupId))
        .orderBy(asc(users.fullName), asc(users.id));
      return rows.map((entry) => toUserEntity(entry.user));
    },
  };
}
