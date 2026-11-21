import type {
  StoredUploadLimitsRecord,
  TransactionContext,
  UploadLimitsConfig,
  UploadPolicyRepositoryPort,
} from "@docuflow/domain";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type OrganizationPreferencesJson, organizations } from "../schema/identity.js";
import { resolveDbExecutor } from "./transaction-manager.js";

const PREF_UPLOAD_MAX_BYTES = "uploadMaxBytes";
const PREF_UPLOAD_ALLOWED_EXTENSIONS = "uploadAllowedExtensions";
const PREF_UPLOAD_ENFORCE_EXTENSION_MATCH = "uploadEnforceExtensionMatch";

function toStoredRecord(row: {
  readonly id: string;
  readonly preferences: OrganizationPreferencesJson;
  readonly updatedAt: Date;
}): StoredUploadLimitsRecord {
  const rawMaxBytes = row.preferences[PREF_UPLOAD_MAX_BYTES];
  const rawExtensions = row.preferences[PREF_UPLOAD_ALLOWED_EXTENSIONS];
  const rawEnforce = row.preferences[PREF_UPLOAD_ENFORCE_EXTENSION_MATCH];

  return {
    organizationId: row.id,
    maxFileSizeBytes: typeof rawMaxBytes === "number" ? rawMaxBytes : null,
    allowedExtensions:
      typeof rawExtensions === "string" && rawExtensions.trim().length > 0
        ? rawExtensions
            .split(",")
            .map((ext) => ext.trim())
            .filter((ext) => ext.length > 0)
        : null,
    enforceDeclaredExtensionMatch: typeof rawEnforce === "boolean" ? rawEnforce : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * PostgreSQL repository persisting per-organization upload size and allowed-extension
 * limits safely inside `organizations.preferences` JSONB without disturbing unrelated preferences.
 */
export function createUploadPolicyRepository(db: NodePgDatabase): UploadPolicyRepositoryPort {
  return {
    async getUploadLimits(
      organizationId: string,
      tx?: TransactionContext,
    ): Promise<StoredUploadLimitsRecord | null> {
      const executor = resolveDbExecutor(db, tx);
      const [row] = await executor
        .select({
          id: organizations.id,
          preferences: organizations.preferences,
          updatedAt: organizations.updatedAt,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      return row ? toStoredRecord(row) : null;
    },

    async saveUploadLimits(
      organizationId: string,
      input: UploadLimitsConfig & { readonly updatedAt: Date },
      tx?: TransactionContext,
    ): Promise<StoredUploadLimitsRecord | null> {
      const executor = resolveDbExecutor(db, tx);
      const [existing] = await executor
        .select({ preferences: organizations.preferences })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      if (!existing) {
        return null;
      }

      const nextPreferences: OrganizationPreferencesJson = {
        ...existing.preferences,
        [PREF_UPLOAD_MAX_BYTES]: input.maxFileSizeBytes,
        [PREF_UPLOAD_ALLOWED_EXTENSIONS]: input.allowedExtensions.join(","),
        [PREF_UPLOAD_ENFORCE_EXTENSION_MATCH]: input.enforceDeclaredExtensionMatch,
      };

      const [updated] = await executor
        .update(organizations)
        .set({
          preferences: nextPreferences,
          updatedAt: input.updatedAt,
        })
        .where(eq(organizations.id, organizationId))
        .returning({
          id: organizations.id,
          preferences: organizations.preferences,
          updatedAt: organizations.updatedAt,
        });

      return updated ? toStoredRecord(updated) : null;
    },
  };
}
