import type { DocumentMetadataMap, DocumentMetadataValue } from "../documents/document.types.js";

export type CategoryFieldType =
  | "TEXT"
  | "NUMBER"
  | "DATE"
  | "BOOLEAN"
  | "SINGLE_SELECT"
  | "MULTI_SELECT";

export interface CategoryFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: CategoryFieldType;
  readonly required: boolean;
  readonly options?: readonly string[] | undefined;
}

export interface MetadataValidationIssue {
  readonly fieldKey: string;
  readonly reason: string;
}

export type MetadataValidationResult =
  | {
      readonly valid: true;
      readonly normalizedMetadata: DocumentMetadataMap;
    }
  | {
      readonly valid: false;
      readonly issues: readonly MetadataValidationIssue[];
    };

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function validateFieldValue(
  field: CategoryFieldDefinition,
  rawValue: DocumentMetadataValue,
): { ok: true; value: DocumentMetadataValue } | { ok: false; reason: string } {
  switch (field.type) {
    case "TEXT": {
      if (typeof rawValue !== "string") {
        return { ok: false, reason: "Deve ser um texto." };
      }
      const trimmed = rawValue.trim();
      if (field.required && trimmed.length === 0) {
        return { ok: false, reason: "Campo obrigatório não pode ser vazio." };
      }
      return { ok: true, value: trimmed };
    }
    case "NUMBER": {
      if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
        return { ok: false, reason: "Deve ser um número válido." };
      }
      return { ok: true, value: rawValue };
    }
    case "DATE": {
      if (typeof rawValue !== "string" || !isValidIsoDate(rawValue)) {
        return { ok: false, reason: "Deve ser uma data válida no formato YYYY-MM-DD." };
      }
      return { ok: true, value: rawValue };
    }
    case "BOOLEAN": {
      if (typeof rawValue !== "boolean") {
        return { ok: false, reason: "Deve ser verdadeiro ou falso." };
      }
      return { ok: true, value: rawValue };
    }
    case "SINGLE_SELECT": {
      if (typeof rawValue !== "string") {
        return { ok: false, reason: "Deve selecionar uma opção válida." };
      }
      const allowed = field.options ?? [];
      if (!allowed.includes(rawValue)) {
        return { ok: false, reason: "Opção selecionada não é permitida." };
      }
      return { ok: true, value: rawValue };
    }
    case "MULTI_SELECT": {
      if (!Array.isArray(rawValue)) {
        return { ok: false, reason: "Deve ser uma lista de opções válidas." };
      }
      const allowed = field.options ?? [];
      const uniqueValues = new Set<string>();
      for (const item of rawValue) {
        if (typeof item !== "string" || !allowed.includes(item)) {
          return { ok: false, reason: "Contém opção não permitida." };
        }
        uniqueValues.add(item);
      }
      if (field.required && uniqueValues.size === 0) {
        return { ok: false, reason: "Selecione ao menos uma opção." };
      }
      return { ok: true, value: Array.from(uniqueValues) };
    }
  }
}

export function validateFieldValueForDefinition(
  field: CategoryFieldDefinition,
  rawValue: DocumentMetadataValue | undefined,
): { ok: true; value: DocumentMetadataValue | undefined } | { ok: false; reason: string } {
  if (rawValue === undefined || rawValue === null) {
    if (field.required) {
      return { ok: false, reason: "Campo obrigatório não informado." };
    }
    return { ok: true, value: rawValue === null ? null : undefined };
  }

  return validateFieldValue(field, rawValue);
}

export function validateDocumentMetadata(
  fields: readonly CategoryFieldDefinition[],
  inputMetadata: Readonly<Record<string, DocumentMetadataValue>>,
): MetadataValidationResult {
  const issues: MetadataValidationIssue[] = [];
  const normalized: Record<string, DocumentMetadataValue> = {};
  const fieldsByKey = new Map<string, CategoryFieldDefinition>();

  for (const field of fields) {
    fieldsByKey.set(field.key, field);
  }

  for (const key of Object.keys(inputMetadata)) {
    if (!fieldsByKey.has(key)) {
      issues.push({
        fieldKey: key,
        reason: "Campo não pertence à categoria informada.",
      });
    }
  }

  for (const field of fields) {
    const rawValue = inputMetadata[field.key];
    if (rawValue === undefined || rawValue === null) {
      if (field.required) {
        issues.push({
          fieldKey: field.key,
          reason: "Campo obrigatório não informado.",
        });
      } else if (rawValue === null) {
        normalized[field.key] = null;
      }
      continue;
    }

    const result = validateFieldValue(field, rawValue);
    if (!result.ok) {
      issues.push({
        fieldKey: field.key,
        reason: result.reason,
      });
      continue;
    }

    normalized[field.key] = result.value;
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    normalizedMetadata: normalized,
  };
}
