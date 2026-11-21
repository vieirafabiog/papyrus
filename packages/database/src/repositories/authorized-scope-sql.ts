import { type SQL, eq, inArray, not, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documents } from "../schema/documents.js";
import { folders } from "../schema/taxonomy.js";
import type { AuthorizedDocumentQueryScope } from "./authorization-repository.js";

export interface AuthorizedDocumentScopeResult {
  readonly allowed: boolean;
  readonly conditions: readonly SQL[];
}

/**
 * Expands folder IDs into full descending folder subtrees within an organization.
 */
export async function expandFolderSubtreeIds(
  db: NodePgDatabase,
  organizationId: string,
  rootFolderIds: readonly string[],
): Promise<readonly string[]> {
  if (rootFolderIds.length === 0) {
    return [];
  }

  const orgFolders = await db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.organizationId, organizationId));

  const childrenByParent = new Map<string, string[]>();
  for (const folder of orgFolders) {
    if (folder.parentId !== null) {
      const list = childrenByParent.get(folder.parentId) ?? [];
      list.push(folder.id);
      childrenByParent.set(folder.parentId, list);
    }
  }

  const expanded = new Set<string>();
  const queue = [...rootFolderIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || expanded.has(current)) {
      continue;
    }
    expanded.add(current);
    for (const childId of childrenByParent.get(current) ?? []) {
      if (!expanded.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return Array.from(expanded);
}

/**
 * Builds PostgreSQL predicates enforcing ALLOW scopes and DENY overrides before any
 * counting, aggregation, sorting, or pagination occurs.
 */
export function buildAuthorizedDocumentScopeConditions(
  scope: AuthorizedDocumentQueryScope,
  expandedAllowedFolders: readonly string[],
  expandedDeniedFolders: readonly string[],
): AuthorizedDocumentScopeResult {
  const hasAnyAllow =
    scope.hasGlobalAllow ||
    scope.allowedCategoryIds.length > 0 ||
    scope.allowedFolderIds.length > 0 ||
    scope.allowedDocumentIds.length > 0;

  if (scope.hasGlobalDeny || !hasAnyAllow) {
    return { allowed: false, conditions: [] };
  }

  const conditions: SQL[] = [];

  if (!scope.hasGlobalAllow) {
    const allowPredicates: SQL[] = [];
    if (scope.allowedCategoryIds.length > 0) {
      allowPredicates.push(inArray(documents.categoryId, [...scope.allowedCategoryIds]));
    }
    if (expandedAllowedFolders.length > 0) {
      allowPredicates.push(inArray(documents.folderId, [...expandedAllowedFolders]));
    }
    if (scope.allowedDocumentIds.length > 0) {
      allowPredicates.push(inArray(documents.id, [...scope.allowedDocumentIds]));
    }
    if (allowPredicates.length === 0) {
      return { allowed: false, conditions: [] };
    }
    const combinedAllow = or(...allowPredicates);
    if (combinedAllow) {
      conditions.push(combinedAllow);
    }
  }

  if (scope.deniedCategoryIds.length > 0) {
    conditions.push(not(inArray(documents.categoryId, [...scope.deniedCategoryIds])));
  }
  if (expandedDeniedFolders.length > 0) {
    conditions.push(
      sql`(${documents.folderId} IS NULL OR ${not(inArray(documents.folderId, [...expandedDeniedFolders]))})`,
    );
  }
  if (scope.deniedDocumentIds.length > 0) {
    conditions.push(not(inArray(documents.id, [...scope.deniedDocumentIds])));
  }

  return { allowed: true, conditions };
}
