import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type {
  CategoryRepositoryPort,
  UpdateCategoryInput,
} from "../ports/category-repository.port.js";
import type { PaginatedResult } from "../ports/document-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type {
  AuthorizedCategoryQueryScope,
  CategoryEntity,
  CategoryListFilter,
  CategoryTextIndexingMode,
} from "./category.types.js";

export const MAX_CATEGORY_NAME_LENGTH = 120;
export const MAX_CATEGORY_DESCRIPTION_LENGTH = 500;
export const MAX_CATEGORY_ICON_LENGTH = 64;

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export interface CategoryServiceDependencies {
  readonly categories: CategoryRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
}

export interface CreateCategoryCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly icon?: string | null | undefined;
  readonly textIndexingMode?: CategoryTextIndexingMode | undefined;
}

export interface UpdateCategoryCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly categoryId: string;
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly icon?: string | null | undefined;
  readonly isActive?: boolean | undefined;
  readonly textIndexingMode?: CategoryTextIndexingMode | undefined;
}

export interface DeactivateCategoryCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly categoryId: string;
}

export interface CategoryService {
  listAuthorizedCategories(
    filter: CategoryListFilter,
    scope: AuthorizedCategoryQueryScope,
  ): Promise<PaginatedResult<CategoryEntity>>;
  getCategoryById(organizationId: string, categoryId: string): Promise<CategoryEntity>;
  createCategory(command: CreateCategoryCommand): Promise<CategoryEntity>;
  updateCategory(command: UpdateCategoryCommand): Promise<CategoryEntity>;
  deactivateCategory(command: DeactivateCategoryCommand): Promise<CategoryEntity>;
}

/**
 * Normalizes and validates a category name.
 */
export function normalizeCategoryName(rawName: string): string {
  const normalized = rawName.trim();
  if (normalized.length === 0) {
    throw new DomainError("INVALID_CATEGORY_NAME", "O nome da categoria é obrigatório.");
  }
  if (normalized.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new DomainError(
      "INVALID_CATEGORY_NAME",
      `O nome da categoria deve ter no máximo ${MAX_CATEGORY_NAME_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

/**
 * Normalizes and validates an optional category description.
 */
export function normalizeCategoryDescription(
  rawDescription: string | null | undefined,
): string | null {
  if (rawDescription === undefined || rawDescription === null) {
    return null;
  }
  const normalized = rawDescription.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > MAX_CATEGORY_DESCRIPTION_LENGTH) {
    throw new DomainError(
      "INVALID_CATEGORY_DESCRIPTION",
      `A descrição da categoria deve ter no máximo ${MAX_CATEGORY_DESCRIPTION_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

/**
 * Normalizes and validates an optional category hex color (#RRGGBB).
 */
export function normalizeCategoryColor(rawColor: string | null | undefined): string | null {
  if (rawColor === undefined || rawColor === null) {
    return null;
  }
  const normalized = rawColor.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (!HEX_COLOR_PATTERN.test(normalized)) {
    throw new DomainError(
      "INVALID_CATEGORY_COLOR",
      "A cor da categoria deve estar no formato hexadecimal #RRGGBB.",
    );
  }
  return normalized.toUpperCase();
}

/**
 * Normalizes and validates an optional category icon identifier.
 */
export function normalizeCategoryIcon(rawIcon: string | null | undefined): string | null {
  if (rawIcon === undefined || rawIcon === null) {
    return null;
  }
  const normalized = rawIcon.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > MAX_CATEGORY_ICON_LENGTH) {
    throw new DomainError(
      "INVALID_CATEGORY_ICON",
      `O ícone da categoria deve ter no máximo ${MAX_CATEGORY_ICON_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

/**
 * Validates the per-category full-text and OCR indexing policy mode.
 */
export function normalizeCategoryTextIndexingMode(
  rawMode: CategoryTextIndexingMode | undefined,
  fallback: CategoryTextIndexingMode = "NEVER",
): CategoryTextIndexingMode {
  if (rawMode === undefined) {
    return fallback;
  }
  if (rawMode !== "NEVER" && rawMode !== "ALWAYS" && rawMode !== "ASK") {
    throw new DomainError(
      "INVALID_CATEGORY_TEXT_INDEXING_MODE",
      "Política de indexação de conteúdo inválida para a categoria.",
    );
  }
  return rawMode;
}

/**
 * Resolves effective indexing intent on the server from category policy and optional upload opt-in.
 */
export function resolveCategoryTextIndexingDecision(
  mode: CategoryTextIndexingMode | null | undefined,
  requested: boolean | null | undefined,
): boolean {
  if (mode === "ALWAYS") {
    return true;
  }
  if (mode === "ASK") {
    return requested === true;
  }
  return false;
}

/**
 * Creates the domain service responsible for category CRUD and document-link safeguards.
 */
export function createCategoryService(deps: CategoryServiceDependencies): CategoryService {
  return {
    async listAuthorizedCategories(
      filter: CategoryListFilter,
      scope: AuthorizedCategoryQueryScope,
    ): Promise<PaginatedResult<CategoryEntity>> {
      return deps.categories.listAuthorized(filter, scope);
    },

    async getCategoryById(organizationId: string, categoryId: string): Promise<CategoryEntity> {
      const category = await deps.categories.findById(categoryId);
      if (!category || category.organizationId !== organizationId) {
        throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
      }
      return category;
    },

    async createCategory(command: CreateCategoryCommand): Promise<CategoryEntity> {
      const normalizedName = normalizeCategoryName(command.name);
      const description = normalizeCategoryDescription(command.description);
      const color = normalizeCategoryColor(command.color);
      const icon = normalizeCategoryIcon(command.icon);
      const textIndexingMode = normalizeCategoryTextIndexingMode(command.textIndexingMode, "NEVER");

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.categories.findByName(
          command.organizationId,
          normalizedName,
          tx,
        );
        if (existing) {
          throw new DomainError(
            "CATEGORY_NAME_ALREADY_IN_USE",
            "Já existe uma categoria cadastrada com este nome.",
          );
        }

        const created = await deps.categories.create(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            name: normalizedName,
            description,
            color,
            icon,
            textIndexingMode,
            createdBy: command.actorUserId,
          },
          tx,
        );

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "CATEGORY_CREATED",
            resourceType: "CATEGORY",
            resourceId: created.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              name: created.name,
              textIndexingMode: created.textIndexingMode,
            },
          },
          tx,
        );

        return created;
      });
    },

    async updateCategory(command: UpdateCategoryCommand): Promise<CategoryEntity> {
      const nextName = command.name !== undefined ? normalizeCategoryName(command.name) : undefined;
      const nextDescription =
        command.description !== undefined
          ? normalizeCategoryDescription(command.description)
          : undefined;
      const nextColor =
        command.color !== undefined ? normalizeCategoryColor(command.color) : undefined;
      const nextIcon = command.icon !== undefined ? normalizeCategoryIcon(command.icon) : undefined;
      const nextTextIndexingMode =
        command.textIndexingMode !== undefined
          ? normalizeCategoryTextIndexingMode(command.textIndexingMode)
          : undefined;

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.categories.findById(command.categoryId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
        }

        if (nextName !== undefined && nextName !== existing.name) {
          const conflicting = await deps.categories.findByName(
            command.organizationId,
            nextName,
            tx,
          );
          if (conflicting && conflicting.id !== existing.id) {
            throw new DomainError(
              "CATEGORY_NAME_ALREADY_IN_USE",
              "Já existe uma categoria cadastrada com este nome.",
            );
          }
        }

        if (command.isActive === false && existing.isActive) {
          const linkedDocuments = await deps.categories.countExistingDocuments(
            command.organizationId,
            existing.id,
            tx,
          );
          if (linkedDocuments > 0) {
            throw new DomainError(
              "CATEGORY_HAS_EXISTING_DOCUMENTS",
              "Não é possível desativar uma categoria que possui documentos vinculados.",
            );
          }
        }

        const updatePayload: UpdateCategoryInput = {
          id: existing.id,
          organizationId: command.organizationId,
          updatedBy: command.actorUserId,
          ...(nextName !== undefined ? { name: nextName } : {}),
          ...(nextDescription !== undefined ? { description: nextDescription } : {}),
          ...(nextColor !== undefined ? { color: nextColor } : {}),
          ...(nextIcon !== undefined ? { icon: nextIcon } : {}),
          ...(command.isActive !== undefined ? { isActive: command.isActive } : {}),
          ...(nextTextIndexingMode !== undefined ? { textIndexingMode: nextTextIndexingMode } : {}),
        };

        const updated = await deps.categories.update(updatePayload, tx);
        if (!updated) {
          throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
        }

        let auditAction = "CATEGORY_UPDATED";
        if (existing.isActive && !updated.isActive) {
          auditAction = "CATEGORY_DEACTIVATED";
        } else if (!existing.isActive && updated.isActive) {
          auditAction = "CATEGORY_REACTIVATED";
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: auditAction,
            resourceType: "CATEGORY",
            resourceId: updated.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              name: updated.name,
              isActive: updated.isActive,
              textIndexingMode: updated.textIndexingMode,
            },
          },
          tx,
        );

        return updated;
      });
    },

    async deactivateCategory(command: DeactivateCategoryCommand): Promise<CategoryEntity> {
      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.categories.findById(command.categoryId, tx);
        if (!existing || existing.organizationId !== command.organizationId) {
          throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
        }

        if (!existing.isActive) {
          return existing;
        }

        const linkedDocuments = await deps.categories.countExistingDocuments(
          command.organizationId,
          existing.id,
          tx,
        );
        if (linkedDocuments > 0) {
          throw new DomainError(
            "CATEGORY_HAS_EXISTING_DOCUMENTS",
            "Não é possível desativar uma categoria que possui documentos vinculados.",
          );
        }

        const deactivated = await deps.categories.update(
          {
            id: existing.id,
            organizationId: command.organizationId,
            isActive: false,
            updatedBy: command.actorUserId,
          },
          tx,
        );
        if (!deactivated) {
          throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "CATEGORY_DEACTIVATED",
            resourceType: "CATEGORY",
            resourceId: deactivated.id,
            result: "SUCCESS",
            requestId: command.requestId,
          },
          tx,
        );

        return deactivated;
      });
    },
  };
}
