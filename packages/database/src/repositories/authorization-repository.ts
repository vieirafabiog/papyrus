import type {
  AccessAction,
  AccessEffect,
  AccessResource,
  AccessScope,
  DocumentDetailQueryData,
  DocumentEntity,
  DocumentListFilter,
  DocumentListItemEntity,
  DocumentMetadataMap,
  DocumentSortField,
  DocumentVersionHistoryQueryItem,
  PaginatedResult,
} from "@papyrus/domain";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { documentTags, documentVersions, documents } from "../schema/documents.js";
import {
  permissions,
  rolePermissions,
  roles,
  userGroups,
  userRoleScopes,
  users,
} from "../schema/identity.js";
import { fileObjects } from "../schema/storage.js";
import { categories, categoryFields, folders, tags } from "../schema/taxonomy.js";

export interface LoadedRoleAssignment {
  readonly roleId: string;
  readonly roleKey: string;
  readonly scope: AccessScope;
  readonly effect: AccessEffect;
  readonly source: "USER" | "GROUP";
}

export interface LoadedRolePermission {
  readonly roleId: string;
  readonly roleKey: string;
  readonly action: AccessAction;
  readonly resource: AccessResource;
}

export interface LoadedAuthorizationSubject {
  readonly userId: string;
  readonly organizationId: string;
  readonly groupIds: readonly string[];
  readonly assignments: readonly LoadedRoleAssignment[];
  readonly rolePermissions: readonly LoadedRolePermission[];
}

export interface AuthorizedDocumentQueryScope {
  readonly hasGlobalDeny: boolean;
  readonly hasGlobalAllow: boolean;
  readonly allowedCategoryIds: readonly string[];
  readonly allowedFolderIds: readonly string[];
  readonly allowedDocumentIds: readonly string[];
  readonly deniedCategoryIds: readonly string[];
  readonly deniedFolderIds: readonly string[];
  readonly deniedDocumentIds: readonly string[];
}

const SORT_COLUMNS: Readonly<
  Record<
    DocumentSortField,
    | typeof documents.title
    | typeof documents.status
    | typeof documents.issueDate
    | typeof documents.expirationDate
    | typeof documents.createdAt
    | typeof documents.updatedAt
    | typeof documents.id
  >
> = {
  title: documents.title,
  status: documents.status,
  issueDate: documents.issueDate,
  expirationDate: documents.expirationDate,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  id: documents.id,
};

function toAccessScope(
  scopeType: "GLOBAL" | "CATEGORY" | "FOLDER" | "DOCUMENT",
  targetId: string | null,
): AccessScope | null {
  switch (scopeType) {
    case "GLOBAL":
      return { type: "GLOBAL" };
    case "CATEGORY":
      return targetId ? { type: "CATEGORY", categoryId: targetId } : null;
    case "FOLDER":
      return targetId ? { type: "FOLDER", folderId: targetId } : null;
    case "DOCUMENT":
      return targetId ? { type: "DOCUMENT", documentId: targetId } : null;
  }
}

function toDocumentEntity(row: typeof documents.$inferSelect): DocumentEntity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    categoryId: row.categoryId,
    folderId: row.folderId,
    status: row.status,
    currentVersionId: row.currentVersionId,
    ownerUserId: row.ownerUserId,
    issueDate: row.issueDate,
    expirationDate: row.expirationDate,
    metadata: row.metadata as DocumentMetadataMap,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface AuthorizationRepository {
  loadSubject(organizationId: string, userId: string): Promise<LoadedAuthorizationSubject>;
  loadFolderAncestorIds(
    organizationId: string,
    folderId: string | null,
  ): Promise<readonly string[]>;
  expandFolderSubtreeIds(
    organizationId: string,
    rootFolderIds: readonly string[],
  ): Promise<readonly string[]>;
  listAuthorizedDocuments(
    filter: DocumentListFilter,
    scope: AuthorizedDocumentQueryScope,
  ): Promise<PaginatedResult<DocumentEntity>>;
  listAuthorizedDocumentSummaries?(
    filter: DocumentListFilter,
    scope: AuthorizedDocumentQueryScope,
  ): Promise<PaginatedResult<DocumentListItemEntity>>;
  loadDocumentDetailView?(document: DocumentEntity): Promise<DocumentDetailQueryData | null>;
  listDocumentVersionHistory?(
    document: DocumentEntity,
  ): Promise<readonly DocumentVersionHistoryQueryItem[]>;
}

export function createAuthorizationRepository(db: NodePgDatabase): AuthorizationRepository {
  return {
    async loadSubject(organizationId: string, userId: string): Promise<LoadedAuthorizationSubject> {
      const membershipRows = await db
        .select({ groupId: userGroups.groupId })
        .from(userGroups)
        .where(eq(userGroups.userId, userId));
      const groupIds = membershipRows.map((row) => row.groupId);

      const subjectCondition =
        groupIds.length > 0
          ? or(eq(userRoleScopes.userId, userId), inArray(userRoleScopes.groupId, groupIds))
          : eq(userRoleScopes.userId, userId);

      const assignmentRows = await db
        .select({
          roleId: userRoleScopes.roleId,
          roleKey: roles.key,
          scopeType: userRoleScopes.scopeType,
          scopeTargetId: userRoleScopes.scopeTargetId,
          effect: userRoleScopes.effect,
          userId: userRoleScopes.userId,
        })
        .from(userRoleScopes)
        .innerJoin(roles, eq(roles.id, userRoleScopes.roleId))
        .where(and(eq(userRoleScopes.organizationId, organizationId), subjectCondition));

      const assignments: LoadedRoleAssignment[] = [];
      const roleIds = new Set<string>();
      for (const row of assignmentRows) {
        const scope = toAccessScope(row.scopeType, row.scopeTargetId);
        if (!scope) {
          continue;
        }
        roleIds.add(row.roleId);
        assignments.push({
          roleId: row.roleId,
          roleKey: row.roleKey,
          scope,
          effect: row.effect,
          source: row.userId !== null ? "USER" : "GROUP",
        });
      }

      const loadedPerms: LoadedRolePermission[] = [];
      if (roleIds.size > 0) {
        const permRows = await db
          .select({
            roleId: rolePermissions.roleId,
            roleKey: roles.key,
            action: permissions.action,
            resource: permissions.resource,
          })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(inArray(rolePermissions.roleId, Array.from(roleIds)));

        for (const row of permRows) {
          loadedPerms.push(row);
        }
      }

      return {
        userId,
        organizationId,
        groupIds,
        assignments,
        rolePermissions: loadedPerms,
      };
    },

    async loadFolderAncestorIds(
      organizationId: string,
      folderId: string | null,
    ): Promise<readonly string[]> {
      if (!folderId) {
        return [];
      }

      const orgFolders = await db
        .select({ id: folders.id, parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.organizationId, organizationId));

      const parentById = new Map<string, string | null>();
      for (const folder of orgFolders) {
        parentById.set(folder.id, folder.parentId);
      }

      const ancestors: string[] = [];
      const visited = new Set<string>();
      let current: string | null = folderId;

      while (current !== null && !visited.has(current)) {
        visited.add(current);
        if (!parentById.has(current)) {
          break;
        }
        ancestors.push(current);
        current = parentById.get(current) ?? null;
      }

      return ancestors;
    },

    async expandFolderSubtreeIds(
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
        if (folder.parentId) {
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
        const children = childrenByParent.get(current) ?? [];
        for (const childId of children) {
          if (!expanded.has(childId)) {
            queue.push(childId);
          }
        }
      }

      return Array.from(expanded);
    },

    async listAuthorizedDocuments(
      filter: DocumentListFilter,
      scope: AuthorizedDocumentQueryScope,
    ): Promise<PaginatedResult<DocumentEntity>> {
      const whereClause = await buildAuthorizedWhereClause(filter, scope, this);
      if (!whereClause) {
        return {
          items: [],
          page: filter.page,
          pageSize: filter.pageSize,
          totalItems: 0,
          totalPages: 0,
        };
      }

      const sortColumn = SORT_COLUMNS[filter.sortBy];
      const primaryOrder = filter.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const tiebreakerOrder =
        filter.sortDirection === "asc" ? asc(documents.id) : desc(documents.id);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(documents).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const rows = await db
        .select()
        .from(documents)
        .where(whereClause)
        .orderBy(primaryOrder, tiebreakerOrder)
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map(toDocumentEntity),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },

    async listAuthorizedDocumentSummaries(
      filter: DocumentListFilter,
      scope: AuthorizedDocumentQueryScope,
    ): Promise<PaginatedResult<DocumentListItemEntity>> {
      const whereClause = await buildAuthorizedWhereClause(filter, scope, this);
      if (!whereClause) {
        return {
          items: [],
          page: filter.page,
          pageSize: filter.pageSize,
          totalItems: 0,
          totalPages: 0,
        };
      }

      const sortColumn = SORT_COLUMNS[filter.sortBy];
      const primaryOrder = filter.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const tiebreakerOrder =
        filter.sortDirection === "asc" ? asc(documents.id) : desc(documents.id);
      const offset = (filter.page - 1) * filter.pageSize;

      const [countRow] = await db.select({ total: count() }).from(documents).where(whereClause);
      const totalItems = Number(countRow?.total ?? 0);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filter.pageSize);

      const rows = await db
        .select({
          id: documents.id,
          title: documents.title,
          categoryId: documents.categoryId,
          folderId: documents.folderId,
          status: documents.status,
          currentVersionId: documents.currentVersionId,
          ownerUserId: documents.ownerUserId,
          issueDate: documents.issueDate,
          expirationDate: documents.expirationDate,
          version: documents.version,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(whereClause)
        .orderBy(primaryOrder, tiebreakerOrder)
        .limit(filter.pageSize)
        .offset(offset);

      return {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          categoryId: row.categoryId,
          folderId: row.folderId,
          status: row.status,
          currentVersionId: row.currentVersionId,
          ownerUserId: row.ownerUserId,
          issueDate: row.issueDate,
          expirationDate: row.expirationDate,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        page: filter.page,
        pageSize: filter.pageSize,
        totalItems,
        totalPages,
      };
    },

    async loadDocumentDetailView(
      document: DocumentEntity,
    ): Promise<DocumentDetailQueryData | null> {
      const [categoryRow] = await db
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.id, document.categoryId),
            eq(categories.organizationId, document.organizationId),
          ),
        )
        .limit(1);

      if (!categoryRow) {
        return null;
      }

      const [fieldRows, folderRows, ownerRows, versionRows, tagRows] = await Promise.all([
        db
          .select()
          .from(categoryFields)
          .where(eq(categoryFields.categoryId, categoryRow.id))
          .orderBy(asc(categoryFields.sortOrder), asc(categoryFields.key), asc(categoryFields.id)),
        document.folderId !== null
          ? db
              .select({
                id: folders.id,
                name: folders.name,
                materializedPath: folders.materializedPath,
              })
              .from(folders)
              .where(
                and(
                  eq(folders.id, document.folderId),
                  eq(folders.organizationId, document.organizationId),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
        db
          .select({
            id: users.id,
            fullName: users.fullName,
            email: users.email,
          })
          .from(users)
          .where(
            and(
              eq(users.id, document.ownerUserId),
              eq(users.organizationId, document.organizationId),
            ),
          )
          .limit(1),
        document.currentVersionId !== null
          ? db
              .select({
                version: documentVersions,
                fileObject: {
                  id: fileObjects.id,
                  originalFileName: fileObjects.originalFileName,
                  detectedContentType: fileObjects.detectedContentType,
                  sizeBytes: fileObjects.sizeBytes,
                  checksumSha256: fileObjects.checksumSha256,
                  status: fileObjects.status,
                },
              })
              .from(documentVersions)
              .leftJoin(fileObjects, eq(documentVersions.fileObjectId, fileObjects.id))
              .where(
                and(
                  eq(documentVersions.id, document.currentVersionId),
                  eq(documentVersions.documentId, document.id),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
        db
          .select({ tag: tags })
          .from(documentTags)
          .innerJoin(tags, eq(documentTags.tagId, tags.id))
          .where(
            and(
              eq(documentTags.documentId, document.id),
              eq(tags.organizationId, document.organizationId),
            ),
          )
          .orderBy(asc(tags.name), asc(tags.id)),
      ]);

      const ownerRow = ownerRows[0];
      if (!ownerRow) {
        return null;
      }

      const folderRow = folderRows[0] ?? null;
      const versionJoined = versionRows[0] ?? null;

      return {
        category: {
          id: categoryRow.id,
          name: categoryRow.name,
          color: categoryRow.color,
          icon: categoryRow.icon,
          textIndexingMode: categoryRow.textIndexingMode,
          fields: fieldRows.map((field) => ({
            id: field.id,
            key: field.key,
            label: field.label,
            type: field.type,
            required: field.required,
            options: field.options ?? undefined,
            sortOrder: field.sortOrder,
          })),
        },
        folder: folderRow,
        owner: ownerRow,
        currentVersion: versionJoined
          ? {
              id: versionJoined.version.id,
              versionNumber: versionJoined.version.versionNumber,
              fileObjectId: versionJoined.version.fileObjectId,
              uploadedByUserId: versionJoined.version.uploadedByUserId,
              changeNote: versionJoined.version.changeNote,
              createdAt: versionJoined.version.createdAt.toISOString(),
              fileObject: versionJoined.fileObject,
            }
          : null,
        tags: tagRows.map((row) => ({
          id: row.tag.id,
          organizationId: row.tag.organizationId,
          name: row.tag.name,
          normalizedName: row.tag.normalizedName,
          color: row.tag.color,
          createdAt: row.tag.createdAt.toISOString(),
        })),
      };
    },

    async listDocumentVersionHistory(
      document: DocumentEntity,
    ): Promise<readonly DocumentVersionHistoryQueryItem[]> {
      const rows = await db
        .select({
          version: documentVersions,
          author: {
            id: users.id,
            fullName: users.fullName,
            email: users.email,
          },
          fileObject: {
            id: fileObjects.id,
            originalFileName: fileObjects.originalFileName,
            detectedContentType: fileObjects.detectedContentType,
            sizeBytes: fileObjects.sizeBytes,
            checksumSha256: fileObjects.checksumSha256,
            status: fileObjects.status,
          },
        })
        .from(documentVersions)
        .innerJoin(users, eq(documentVersions.uploadedByUserId, users.id))
        .leftJoin(fileObjects, eq(documentVersions.fileObjectId, fileObjects.id))
        .where(
          and(
            eq(documentVersions.documentId, document.id),
            eq(users.organizationId, document.organizationId),
          ),
        )
        .orderBy(desc(documentVersions.versionNumber), desc(documentVersions.id));

      return rows.map((row) => ({
        id: row.version.id,
        documentId: row.version.documentId,
        versionNumber: row.version.versionNumber,
        fileObjectId: row.version.fileObjectId,
        uploadedByUserId: row.version.uploadedByUserId,
        uploadedByUser: row.author,
        changeNote: row.version.changeNote,
        createdAt: row.version.createdAt.toISOString(),
        fileObject: row.fileObject,
      }));
    },
  };

  async function buildAuthorizedWhereClause(
    filter: DocumentListFilter,
    scope: AuthorizedDocumentQueryScope,
    repo: Pick<AuthorizationRepository, "expandFolderSubtreeIds">,
  ): Promise<SQL | undefined | null> {
    const hasAnyAllow =
      scope.hasGlobalAllow ||
      scope.allowedCategoryIds.length > 0 ||
      scope.allowedFolderIds.length > 0 ||
      scope.allowedDocumentIds.length > 0;

    if (scope.hasGlobalDeny || !hasAnyAllow) {
      return null;
    }

    const [expandedAllowedFolders, expandedDeniedFolders] = await Promise.all([
      repo.expandFolderSubtreeIds(filter.organizationId, scope.allowedFolderIds),
      repo.expandFolderSubtreeIds(filter.organizationId, scope.deniedFolderIds),
    ]);

    const conditions: SQL[] = [eq(documents.organizationId, filter.organizationId)];

    if (filter.status !== undefined) {
      conditions.push(eq(documents.status, filter.status));
    } else {
      conditions.push(ne(documents.status, "DELETED"));
    }
    if (filter.categoryId !== undefined) {
      conditions.push(eq(documents.categoryId, filter.categoryId));
    }
    if (filter.folderId !== undefined) {
      conditions.push(eq(documents.folderId, filter.folderId));
    }
    if (filter.ownerUserId !== undefined) {
      conditions.push(eq(documents.ownerUserId, filter.ownerUserId));
    }
    if (filter.expirationFrom !== undefined) {
      conditions.push(gte(documents.expirationDate, filter.expirationFrom));
    }
    if (filter.expirationTo !== undefined) {
      conditions.push(lte(documents.expirationDate, filter.expirationTo));
    }
    if (filter.tagId !== undefined) {
      const taggedDocIds = db
        .select({ documentId: documentTags.documentId })
        .from(documentTags)
        .where(eq(documentTags.tagId, filter.tagId));
      conditions.push(inArray(documents.id, taggedDocIds));
    }
    if (filter.search !== undefined && filter.search.trim().length > 0) {
      conditions.push(ilike(documents.title, `%${filter.search.trim()}%`));
    }

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
        return null;
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

    return and(...conditions);
  }
}
