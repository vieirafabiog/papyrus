import type { CategoryFieldType, DocumentMetadataValue } from "@papyrus/domain";
import type { DocumentMetadataColumnValue } from "../schema/documents.js";

/**
 * Converts a domain metadata value into a Drizzle-compatible JSONB column value.
 */
export function toMetadataJsonValue(value: DocumentMetadataValue): DocumentMetadataColumnValue {
  return typeof value === "object" && value !== null ? [...value] : value;
}

/**
 * Maps a field type and metadata value into the typed query columns of `document_metadata`.
 */
export function toTypedMetadataColumns(
  fieldType: CategoryFieldType,
  value: DocumentMetadataValue,
): {
  valueText: string | null;
  valueNumber: number | null;
  valueDate: string | null;
  valueBoolean: boolean | null;
  valueJson: string[] | null;
} {
  const base = {
    valueText: null as string | null,
    valueNumber: null as number | null,
    valueDate: null as string | null,
    valueBoolean: null as boolean | null,
    valueJson: null as string[] | null,
  };

  if (value === null) {
    return base;
  }

  switch (fieldType) {
    case "TEXT":
    case "SINGLE_SELECT":
      return { ...base, valueText: typeof value === "string" ? value : null };
    case "NUMBER":
      return { ...base, valueNumber: typeof value === "number" ? value : null };
    case "DATE":
      return { ...base, valueDate: typeof value === "string" ? value : null };
    case "BOOLEAN":
      return { ...base, valueBoolean: typeof value === "boolean" ? value : null };
    case "MULTI_SELECT":
      return { ...base, valueJson: Array.isArray(value) ? [...value] : null };
  }
}
