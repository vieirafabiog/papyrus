import {
  type OrganizationEntity,
  type OrganizationPreferences,
  type OrganizationRepositoryPort,
  type TransactionContext,
  type UpdateOrganizationSettingsInput,
  normalizeOrganizationLanguage,
  normalizeOrganizationPreferences,
} from "@docuflow/domain";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type OrganizationPreferencesJson, organizations } from "../schema/identity.js";
import { resolveDbExecutor } from "./transaction-manager.js";

function toOrganizationPreferencesJson(
  prefs: OrganizationPreferences,
): OrganizationPreferencesJson {
  return {
    defaultExpirationWindowDays: prefs.defaultExpirationWindowDays,
    trashGraceDays: prefs.trashGraceDays,
    dateFormat: prefs.dateFormat,
    defaultListPageSize: prefs.defaultListPageSize,
    auditDocumentViews: prefs.auditDocumentViews,
    auditDocumentDownloads: prefs.auditDocumentDownloads,
  };
}

function toOrganizationEntity(row: typeof organizations.$inferSelect): OrganizationEntity {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    defaultLanguage: normalizeOrganizationLanguage(row.defaultLanguage),
    timezone: row.timezone,
    logoObjectKey: row.logoObjectKey,
    preferences: normalizeOrganizationPreferences(
      row.preferences as Partial<Record<keyof OrganizationPreferences, unknown>>,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * PostgreSQL repository for organization installation metadata and non-secret preferences.
 */
export function createOrganizationRepository(db: NodePgDatabase): OrganizationRepositoryPort {
  return {
    async findById(
      organizationId: string,
      tx?: TransactionContext,
    ): Promise<OrganizationEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      return row ? toOrganizationEntity(row) : null;
    },

    async updateSettings(
      organizationId: string,
      input: UpdateOrganizationSettingsInput,
      tx?: TransactionContext,
    ): Promise<OrganizationEntity | null> {
      const executor = resolveDbExecutor(db, tx);
      const [updated] = await executor
        .update(organizations)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.defaultLanguage !== undefined
            ? { defaultLanguage: input.defaultLanguage }
            : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.preferences !== undefined
            ? { preferences: toOrganizationPreferencesJson(input.preferences) }
            : {}),
          updatedAt: input.updatedAt,
        })
        .where(eq(organizations.id, organizationId))
        .returning();

      return updated ? toOrganizationEntity(updated) : null;
    },
  };
}
