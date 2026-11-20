import { describe, expect, it } from "vitest";
import { type CategoryFieldDefinition, validateDocumentMetadata } from "../src/index.js";

const FIELDS: readonly CategoryFieldDefinition[] = [
  { key: "fornecedor", label: "Fornecedor", type: "TEXT", required: true },
  { key: "valor", label: "Valor", type: "NUMBER", required: false },
  { key: "assinatura", label: "Data de assinatura", type: "DATE", required: true },
  { key: "confidencial", label: "Confidencial", type: "BOOLEAN", required: true },
  {
    key: "criticidade",
    label: "Criticidade",
    type: "SINGLE_SELECT",
    required: true,
    options: ["BAIXA", "MEDIA", "ALTA"],
  },
  {
    key: "areas",
    label: "Áreas",
    type: "MULTI_SELECT",
    required: false,
    options: ["JURIDICO", "FINANCEIRO", "COMPRAS"],
  },
];

describe("Document metadata validation", () => {
  it("accepts valid metadata for all supported field types", () => {
    const result = validateDocumentMetadata(FIELDS, {
      fornecedor: "  ACME Ltda  ",
      valor: 12500.5,
      assinatura: "2026-11-20",
      confidencial: false,
      criticidade: "ALTA",
      areas: ["JURIDICO", "FINANCEIRO", "JURIDICO"],
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.normalizedMetadata).toEqual({
        fornecedor: "ACME Ltda",
        valor: 12500.5,
        assinatura: "2026-11-20",
        confidencial: false,
        criticidade: "ALTA",
        areas: ["JURIDICO", "FINANCEIRO"],
      });
    }
  });

  it("rejects missing required fields, invalid types, invalid options, and unknown keys", () => {
    const result = validateDocumentMetadata(FIELDS, {
      fornecedor: "   ",
      valor: "not-a-number",
      assinatura: "2026-02-30",
      criticidade: "CRITICA",
      areas: ["DESCONHECIDA"],
      campo_extra: "invalido",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      const keys = result.issues.map((issue) => issue.fieldKey);
      expect(keys).toContain("campo_extra");
      expect(keys).toContain("fornecedor");
      expect(keys).toContain("valor");
      expect(keys).toContain("assinatura");
      expect(keys).toContain("confidencial");
      expect(keys).toContain("criticidade");
      expect(keys).toContain("areas");
    }
  });
});
