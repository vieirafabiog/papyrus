import type { TextExtractionPolicy } from "./types.js";

export type TextQualityEvaluationResult =
  | {
      readonly accepted: true;
      readonly text: string;
      readonly charCount: number;
      readonly truncated: boolean;
      readonly printableRatio: number;
    }
  | {
      readonly accepted: false;
      readonly reason: string;
      readonly charCount: number;
      readonly printableRatio: number;
    };

function isAcceptableTextCharCode(code: number): boolean {
  // Keep tab (9), LF (10), CR (13), printable ASCII (32..126), and valid non-C1 Unicode >= 160 excluding replacement char 0xFFFD
  if (code === 9 || code === 10 || code === 13) {
    return true;
  }
  if (code >= 32 && code <= 126) {
    return true;
  }
  return code >= 160 && code !== 0xfffd;
}

/**
 * Strips unsafe control/NUL bytes (invalid in PostgreSQL text columns), normalizes
 * whitespace, enforces `maxExtractedChars`, and rejects noisy/low-quality text.
 */
export function evaluateAndNormalizeExtractedText(
  rawText: string,
  policy: TextExtractionPolicy,
): TextQualityEvaluationResult {
  if (rawText.length === 0) {
    return {
      accepted: false,
      reason: "Nenhum texto legível foi encontrado no arquivo.",
      charCount: 0,
      printableRatio: 0,
    };
  }

  let totalEvaluatedChars = 0;
  let acceptableChars = 0;
  const cleanedChunks: string[] = [];

  for (const ch of rawText) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0) {
      totalEvaluatedChars += 1;
      continue;
    }
    totalEvaluatedChars += 1;
    if (isAcceptableTextCharCode(code)) {
      acceptableChars += 1;
      cleanedChunks.push(ch);
    } else {
      cleanedChunks.push(" ");
    }
  }

  const printableRatio = totalEvaluatedChars > 0 ? acceptableChars / totalEvaluatedChars : 0;
  if (printableRatio < policy.minPrintableRatio) {
    return {
      accepted: false,
      reason: "A proporção de caracteres legíveis está abaixo do mínimo exigido.",
      charCount: 0,
      printableRatio,
    };
  }

  const normalized = cleanedChunks
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const truncated = normalized.length > policy.maxExtractedChars;
  const finalText = truncated
    ? normalized.slice(0, policy.maxExtractedChars).trimEnd()
    : normalized;

  const alphanumericCount = (finalText.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (finalText.length < policy.minReadableChars || alphanumericCount < 3) {
    return {
      accepted: false,
      reason: "O conteúdo extraído não possui texto legível suficiente para indexação.",
      charCount: finalText.length,
      printableRatio,
    };
  }

  return {
    accepted: true,
    text: finalText,
    charCount: finalText.length,
    truncated,
    printableRatio,
  };
}
