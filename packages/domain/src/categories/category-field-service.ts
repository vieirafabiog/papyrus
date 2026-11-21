import type { DocumentMetadataValue } from "../documents/document.types.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type {
  CategoryRepositoryPort,
  ExistingDocumentMetadataSnapshot,
  UpdateCategoryFieldRecordInput,
} from "../ports/category-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { CategoryFieldEntity } from "./category.types.js";
import {
  type CategoryFieldDefinition,
  type CategoryFieldType,
  validateFieldValueForDefinition,
} from "./metadata-validation.js";

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FIELD_LABEL_LENGTH = 120;
const MAX_FIELD_OPTION_LENGTH = 120;

export type FieldMigrationStrategy =
  | { readonly type: "NONE" }
  | { readonly type: "BACKFILL_DEFAULT"; readonly defaultValue: DocumentMetadataValue }
  | { readonly type: "RESET_TO_DEFAULT"; readonly defaultValue: DocumentMetadataValue }
  | { readonly type: "REMOVE_FROM_DOCUMENTS" };

export interface CategoryFieldServiceDependencies {
  readonly categories: CategoryRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
}

export interface CreateCategoryFieldCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly categoryId: string;
  readonly key: string;
  readonly label: string;
  readonly type: CategoryFieldType;
  readonly required: boolean;
  readonly options?: readonly string[] | null | undefined;
  readonly sortOrder?: number | undefined;
  readonly migrationStrategy?: FieldMigrationStrategy | undefined;
}

export interface UpdateCategoryFieldCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly categoryId: string;
  readonly fieldId: string;
  readonly label?: string | undefined;
  readonly type?: CategoryFieldType | undefined;
  readonly required?: boolean | undefined;
  readonly options?: readonly string[] | null | undefined;
  readonly sortOrder?: number | undefined;
  readonly migrationStrategy?: FieldMigrationStrategy | undefined;
}

export interface RemoveCategoryFieldCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly categoryId: string;
  readonly fieldId: string;
  readonly migrationStrategy?: FieldMigrationStrategy | undefined;
}

export interface CategoryFieldService {
  listFields(organizationId: string, categoryId: string): Promise<readonly CategoryFieldEntity[]>;
  addField(command: CreateCategoryFieldCommand): Promise<CategoryFieldEntity>;
  updateField(command: UpdateCategoryFieldCommand): Promise<CategoryFieldEntity>;
  removeField(command: RemoveCategoryFieldCommand): Promise<void>;
}

/**
 * Validates and normalizes a category field key (lowercase snake_case).
 */
export function normalizeCategoryFieldKey(rawKey: string): string {
  const normalized = rawKey.trim();
  if (!FIELD_KEY_PATTERN.test(normalized)) {
    throw new DomainError(
      "INVALID_CATEGORY_FIELD",
      "A chave do campo deve usar snake_case minúsculo (a-z, 0-9, _).",
    );
  }
  return normalized;
}

/**
 * Validates and normalizes a category field display label.
 */
export function normalizeCategoryFieldLabel(rawLabel: string): string {
  const normalized = rawLabel.trim();
  if (normalized.length === 0 || normalized.length > MAX_FIELD_LABEL_LENGTH) {
    throw new DomainError(
      "INVALID_CATEGORY_FIELD",
      `O rótulo do campo deve ter entre 1 e ${MAX_FIELD_LABEL_LENGTH} caracteres.`,
    );
  }
  return normalized;
}

/**
 * Normalizes and validates selectable options for field types that support them.
 */
export function normalizeCategoryFieldOptions(
  type: CategoryFieldType,
  rawOptions: readonly string[] | null | undefined,
): readonly string[] | null {
  const isSelect = type === "SINGLE_SELECT" || type === "MULTI_SELECT";
  if (!isSelect) {
    if (rawOptions && rawOptions.length > 0) {
      throw new DomainError(
        "INVALID_CATEGORY_FIELD",
        "Apenas campos de seleção podem definir opções.",
      );
    }
    return null;
  }

  if (!rawOptions || rawOptions.length === 0) {
    throw new DomainError(
      "INVALID_CATEGORY_FIELD",
      "Campos de seleção devem definir ao menos uma opção.",
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const option of rawOptions) {
    const trimmed = option.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_FIELD_OPTION_LENGTH) {
      throw new DomainError(
        "INVALID_CATEGORY_FIELD",
        `Cada opção do campo deve ter entre 1 e ${MAX_FIELD_OPTION_LENGTH} caracteres.`,
      );
    }
    if (seen.has(trimmed)) {
      throw new DomainError(
        "INVALID_CATEGORY_FIELD",
        "As opções de seleção do campo não podem ser duplicadas.",
      );
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeSortOrder(sortOrder: number | undefined): number {
  const resolved = sortOrder ?? 0;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new DomainError(
      "INVALID_CATEGORY_FIELD",
      "A ordem de exibição do campo deve ser um número inteiro não negativo.",
    );
  }
  return resolved;
}

function toFieldDefinition(field: {
  readonly key: string;
  readonly label: string;
  readonly type: CategoryFieldType;
  readonly required: boolean;
  readonly options: readonly string[] | null;
}): CategoryFieldDefinition {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options ?? undefined,
  };
}

function validateMigrationDefaultValue(
  definition: CategoryFieldDefinition,
  defaultValue: DocumentMetadataValue,
): DocumentMetadataValue {
  const check = validateFieldValueForDefinition(definition, defaultValue);
  if (!check.ok || check.value === undefined) {
    throw new DomainError(
      "INVALID_FIELD_MIGRATION",
      check.ok
        ? "O valor padrão da migração é obrigatório."
        : `Valor padrão da estratégia de migração é inválido para o campo: ${check.reason}`,
    );
  }
  return check.value;
}

function hasIncompatibleExistingValues(
  targetDef: CategoryFieldDefinition,
  snapshots: readonly ExistingDocumentMetadataSnapshot[],
  includeMissingOrNull: boolean,
): { readonly hasAnyIncompatible: boolean; readonly hasNonNullIncompatible: boolean } {
  let hasAnyIncompatible = false;
  let hasNonNullIncompatible = false;

  for (const doc of snapshots) {
    const rawValue = doc.metadata[targetDef.key];
    const isNullOrMissing = rawValue === undefined || rawValue === null;
    if (isNullOrMissing) {
      if (includeMissingOrNull && targetDef.required) {
        hasAnyIncompatible = true;
      }
      continue;
    }

    const validation = validateFieldValueForDefinition(targetDef, rawValue);
    if (!validation.ok) {
      hasAnyIncompatible = true;
      hasNonNullIncompatible = true;
    }
  }

  return { hasAnyIncompatible, hasNonNullIncompatible };
}

/**
 * Evaluates field schema compatibility against existing documents and validates migration strategy.
 */
export function resolveFieldChangePlan(params: {
  readonly mode: "CREATE" | "UPDATE" | "DELETE";
  readonly existingField: CategoryFieldEntity | null;
  readonly targetDefinition: CategoryFieldDefinition;
  readonly snapshots: readonly ExistingDocumentMetadataSnapshot[];
  readonly migrationStrategy: FieldMigrationStrategy;
}):
  | { readonly action: "NOOP" }
  | { readonly action: "BACKFILL"; readonly defaultValue: DocumentMetadataValue }
  | { readonly action: "RESET"; readonly defaultValue: DocumentMetadataValue }
  | { readonly action: "REMOVE" } {
  const { mode, existingField, targetDefinition, snapshots, migrationStrategy } = params;

  if (mode === "DELETE") {
    const hasAnyValueOrReference = snapshots.some((doc) => targetDefinition.key in doc.metadata);
    if (!hasAnyValueOrReference && snapshots.length === 0) {
      return { action: "NOOP" };
    }

    if (snapshots.length > 0) {
      if (migrationStrategy.type === "REMOVE_FROM_DOCUMENTS") {
        return { action: "REMOVE" };
      }
      throw new DomainError(
        "INCOMPATIBLE_CATEGORY_FIELD_CHANGE",
        "Existem documentos na categoria; informe a estratégia de migração REMOVE_FROM_DOCUMENTS para remover o campo.",
      );
    }

    return { action: "NOOP" };
  }

  if (snapshots.length === 0) {
    if (migrationStrategy.type === "REMOVE_FROM_DOCUMENTS") {
      throw new DomainError(
        "INVALID_FIELD_MIGRATION",
        "Estratégia REMOVE_FROM_DOCUMENTS é aplicável apenas na remoção de campos.",
      );
    }
    return { action: "NOOP" };
  }

  if (mode === "CREATE") {
    if (!targetDefinition.required) {
      return { action: "NOOP" };
    }

    if (
      migrationStrategy.type === "BACKFILL_DEFAULT" ||
      migrationStrategy.type === "RESET_TO_DEFAULT"
    ) {
      const normalizedDefault = validateMigrationDefaultValue(
        targetDefinition,
        migrationStrategy.defaultValue,
      );
      return {
        action: migrationStrategy.type === "BACKFILL_DEFAULT" ? "BACKFILL" : "RESET",
        defaultValue: normalizedDefault,
      };
    }

    throw new DomainError(
      "INCOMPATIBLE_CATEGORY_FIELD_CHANGE",
      "Não é possível adicionar campo obrigatório em categoria com documentos existentes sem estratégia de migração.",
    );
  }

  // UPDATE
  if (!existingField) {
    throw new DomainError("CATEGORY_FIELD_NOT_FOUND", "Campo da categoria não encontrado.");
  }

  const compatibility = hasIncompatibleExistingValues(targetDefinition, snapshots, true);
  if (!compatibility.hasAnyIncompatible) {
    if (migrationStrategy.type === "RESET_TO_DEFAULT") {
      return {
        action: "RESET",
        defaultValue: validateMigrationDefaultValue(
          targetDefinition,
          migrationStrategy.defaultValue,
        ),
      };
    }
    return { action: "NOOP" };
  }

  if (migrationStrategy.type === "RESET_TO_DEFAULT") {
    return {
      action: "RESET",
      defaultValue: validateMigrationDefaultValue(targetDefinition, migrationStrategy.defaultValue),
    };
  }

  if (migrationStrategy.type === "BACKFILL_DEFAULT") {
    if (compatibility.hasNonNullIncompatible) {
      throw new DomainError(
        "INCOMPATIBLE_CATEGORY_FIELD_CHANGE",
        "Documentos existentes possuem valores incompatíveis com o novo tipo ou opções; use a estratégia RESET_TO_DEFAULT.",
      );
    }
    return {
      action: "BACKFILL",
      defaultValue: validateMigrationDefaultValue(targetDefinition, migrationStrategy.defaultValue),
    };
  }

  throw new DomainError(
    "INCOMPATIBLE_CATEGORY_FIELD_CHANGE",
    "Alteração de tipo, opções ou obrigatoriedade incompatível com metadados existentes sem estratégia de migração.",
  );
}

/**
 * Creates the domain service responsible for managing typed category fields and metadata compatibility.
 */
export function createCategoryFieldService(
  deps: CategoryFieldServiceDependencies,
): CategoryFieldService {
  return {
    async listFields(
      organizationId: string,
      categoryId: string,
    ): Promise<readonly CategoryFieldEntity[]> {
      const category = await deps.categories.findById(categoryId);
      if (!category || category.organizationId !== organizationId) {
        throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
      }
      return deps.categories.listFields(categoryId);
    },

    async addField(command: CreateCategoryFieldCommand): Promise<CategoryFieldEntity> {
      const key = normalizeCategoryFieldKey(command.key);
      const label = normalizeCategoryFieldLabel(command.label);
      const options = normalizeCategoryFieldOptions(command.type, command.options);
      const sortOrder = normalizeSortOrder(command.sortOrder);
      const migrationStrategy = command.migrationStrategy ?? { type: "NONE" };

      return deps.transactions.runInTransaction(async (tx) => {
        const category = await deps.categories.findById(command.categoryId, tx);
        if (!category || category.organizationId !== command.organizationId) {
          throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
        }

        const existingKey = await deps.categories.findFieldByKey(category.id, key, tx);
        if (existingKey) {
          throw new DomainError(
            "CATEGORY_FIELD_KEY_ALREADY_IN_USE",
            "Já existe um campo com esta chave nesta categoria.",
          );
        }

        const targetDef = toFieldDefinition({
          key,
          label,
          type: command.type,
          required: command.required,
          options,
        });
        const snapshots = await deps.categories.listExistingDocumentMetadata(
          command.organizationId,
          category.id,
          tx,
        );
        const plan = resolveFieldChangePlan({
          mode: "CREATE",
          existingField: null,
          targetDefinition: targetDef,
          snapshots,
          migrationStrategy,
        });

        const created = await deps.categories.createField(
          {
            id: deps.generateId(),
            categoryId: category.id,
            key,
            label,
            type: command.type,
            required: command.required,
            options,
            sortOrder,
          },
          tx,
        );

        if (plan.action === "BACKFILL" || plan.action === "RESET") {
          await deps.categories.backfillFieldMetadata(
            {
              organizationId: command.organizationId,
              categoryId: category.id,
              fieldId: created.id,
              fieldKey: created.key,
              fieldType: created.type,
              defaultValue: plan.defaultValue,
              updatedBy: command.actorUserId,
            },
            tx,
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "CATEGORY_FIELD_CREATED",
            resourceType: "CATEGORY",
            resourceId: category.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              fieldId: created.id,
              fieldKey: created.key,
              fieldType: created.type,
              required: created.required,
              migrationStrategy: migrationStrategy.type,
            },
          },
          tx,
        );

        return created;
      });
    },

    async updateField(command: UpdateCategoryFieldCommand): Promise<CategoryFieldEntity> {
      const nextLabel =
        command.label !== undefined ? normalizeCategoryFieldLabel(command.label) : undefined;
      const nextSortOrder =
        command.sortOrder !== undefined ? normalizeSortOrder(command.sortOrder) : undefined;
      const migrationStrategy = command.migrationStrategy ?? { type: "NONE" };

      return deps.transactions.runInTransaction(async (tx) => {
        const category = await deps.categories.findById(command.categoryId, tx);
        if (!category || category.organizationId !== command.organizationId) {
          throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
        }

        const existingField = await deps.categories.findFieldById(category.id, command.fieldId, tx);
        if (!existingField) {
          throw new DomainError("CATEGORY_FIELD_NOT_FOUND", "Campo da categoria não encontrado.");
        }

        const resolvedType = command.type ?? existingField.type;
        const resolvedRequired = command.required ?? existingField.required;
        const rawOptions = command.options !== undefined ? command.options : existingField.options;
        const resolvedOptions = normalizeCategoryFieldOptions(resolvedType, rawOptions);
        const resolvedLabel = nextLabel ?? existingField.label;

        const targetDef = toFieldDefinition({
          key: existingField.key,
          label: resolvedLabel,
          type: resolvedType,
          required: resolvedRequired,
          options: resolvedOptions,
        });

        const snapshots = await deps.categories.listExistingDocumentMetadata(
          command.organizationId,
          category.id,
          tx,
        );
        const plan = resolveFieldChangePlan({
          mode: "UPDATE",
          existingField,
          targetDefinition: targetDef,
          snapshots,
          migrationStrategy,
        });

        const updateInput: UpdateCategoryFieldRecordInput = {
          id: existingField.id,
          categoryId: category.id,
          ...(nextLabel !== undefined ? { label: nextLabel } : {}),
          ...(command.type !== undefined ? { type: resolvedType } : {}),
          ...(command.required !== undefined ? { required: resolvedRequired } : {}),
          ...(command.options !== undefined || command.type !== undefined
            ? { options: resolvedOptions }
            : {}),
          ...(nextSortOrder !== undefined ? { sortOrder: nextSortOrder } : {}),
        };

        const updated = await deps.categories.updateField(updateInput, tx);
        if (!updated) {
          throw new DomainError("CATEGORY_FIELD_NOT_FOUND", "Campo da categoria não encontrado.");
        }

        if (plan.action === "BACKFILL") {
          await deps.categories.backfillFieldMetadata(
            {
              organizationId: command.organizationId,
              categoryId: category.id,
              fieldId: updated.id,
              fieldKey: updated.key,
              fieldType: updated.type,
              defaultValue: plan.defaultValue,
              updatedBy: command.actorUserId,
            },
            tx,
          );
        } else if (plan.action === "RESET") {
          await deps.categories.resetFieldMetadata(
            {
              organizationId: command.organizationId,
              categoryId: category.id,
              fieldId: updated.id,
              fieldKey: updated.key,
              fieldType: updated.type,
              defaultValue: plan.defaultValue,
              updatedBy: command.actorUserId,
            },
            tx,
          );
        }

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "CATEGORY_FIELD_UPDATED",
            resourceType: "CATEGORY",
            resourceId: category.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              fieldId: updated.id,
              fieldKey: updated.key,
              fieldType: updated.type,
              required: updated.required,
              migrationStrategy: migrationStrategy.type,
            },
          },
          tx,
        );

        return updated;
      });
    },

    async removeField(command: RemoveCategoryFieldCommand): Promise<void> {
      const migrationStrategy = command.migrationStrategy ?? { type: "NONE" };

      await deps.transactions.runInTransaction(async (tx) => {
        const category = await deps.categories.findById(command.categoryId, tx);
        if (!category || category.organizationId !== command.organizationId) {
          throw new DomainError("CATEGORY_NOT_FOUND", "Categoria não encontrada.");
        }

        const existingField = await deps.categories.findFieldById(category.id, command.fieldId, tx);
        if (!existingField) {
          throw new DomainError("CATEGORY_FIELD_NOT_FOUND", "Campo da categoria não encontrado.");
        }

        const snapshots = await deps.categories.listExistingDocumentMetadata(
          command.organizationId,
          category.id,
          tx,
        );
        const plan = resolveFieldChangePlan({
          mode: "DELETE",
          existingField,
          targetDefinition: toFieldDefinition(existingField),
          snapshots,
          migrationStrategy,
        });

        if (plan.action === "REMOVE") {
          await deps.categories.removeFieldMetadata(
            {
              organizationId: command.organizationId,
              categoryId: category.id,
              fieldId: existingField.id,
              fieldKey: existingField.key,
              updatedBy: command.actorUserId,
            },
            tx,
          );
        }

        await deps.categories.deleteField(category.id, existingField.id, tx);

        await deps.audit.append(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "CATEGORY_FIELD_REMOVED",
            resourceType: "CATEGORY",
            resourceId: category.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              fieldId: existingField.id,
              fieldKey: existingField.key,
              migrationStrategy: migrationStrategy.type,
            },
          },
          tx,
        );
      });
    },
  };
}
