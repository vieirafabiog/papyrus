import { readFileSync } from "node:fs";

const MASTER_KEY_BYTES = 32;
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

export class MasterKeyConfigError extends Error {
  public readonly code: "MASTER_KEY_MISSING" | "MASTER_KEY_INVALID";

  public constructor(code: "MASTER_KEY_MISSING" | "MASTER_KEY_INVALID", message: string) {
    super(message);
    this.name = "MasterKeyConfigError";
    this.code = code;
  }
}

export interface LoadedMasterKeyring {
  readonly activeKeyId: string;
  readonly activeKey: Buffer;
  readonly keysById: Readonly<Record<string, Buffer>>;
}

function decodeBase64Exact32(raw: string): Buffer | null {
  if (!STRICT_BASE64_PATTERN.test(raw)) {
    return null;
  }
  const normalized = raw.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== MASTER_KEY_BYTES) {
    return null;
  }
  // Ensure round-trip canonical encoding matches so corrupt/truncated strings aren't silently padded
  const reencodedNoPad = decoded.toString("base64").replace(/=+$/, "");
  if (normalized.replace(/=+$/, "") !== reencodedNoPad) {
    return null;
  }
  return decoded;
}

/**
 * Parses and validates an external 256-bit (32-byte) master key encoded as 64-char hex or base64/base64url.
 */
export function parseMasterKeyMaterial(rawValue: string | undefined): Buffer {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    throw new MasterKeyConfigError(
      "MASTER_KEY_MISSING",
      "Chave mestra de criptografia (ENCRYPTION_KEY) ausente no ambiente.",
    );
  }

  const trimmed = rawValue.trim();

  if (HEX_KEY_PATTERN.test(trimmed)) {
    const key = Buffer.from(trimmed, "hex");
    if (key.length === MASTER_KEY_BYTES) {
      return key;
    }
  }

  const base64Key = decodeBase64Exact32(trimmed);
  if (base64Key) {
    return base64Key;
  }

  throw new MasterKeyConfigError(
    "MASTER_KEY_INVALID",
    "Formato da chave mestra de criptografia inválido: forneça exatamente 32 bytes em hex (64 caracteres) ou base64.",
  );
}

function readSecretFromFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    throw new MasterKeyConfigError(
      "MASTER_KEY_MISSING",
      "Não foi possível ler o arquivo da chave mestra configurada em ENCRYPTION_KEY_FILE.",
    );
  }
}

/**
 * Loads the primary external master encryption key from `ENCRYPTION_KEY_FILE` or `ENCRYPTION_KEY`.
 */
export function loadMasterEncryptionKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Buffer {
  const keyFilePath = env.ENCRYPTION_KEY_FILE?.trim();
  if (keyFilePath && keyFilePath.length > 0) {
    const fileMaterial = readSecretFromFile(keyFilePath);
    return parseMasterKeyMaterial(fileMaterial);
  }

  return parseMasterKeyMaterial(env.ENCRYPTION_KEY);
}

/**
 * Loads the active master key alongside optional previous keys (`ENCRYPTION_PREVIOUS_KEYS`,
 * formatted as comma-separated `keyId:material`) for non-disruptive key rotation.
 */
export function loadMasterKeyring(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LoadedMasterKeyring {
  const activeKeyId = env.ENCRYPTION_KEY_ID?.trim() || "v1";
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new MasterKeyConfigError(
      "MASTER_KEY_INVALID",
      "Identificador ENCRYPTION_KEY_ID inválido.",
    );
  }

  const activeKey = loadMasterEncryptionKey(env);
  const keysById: Record<string, Buffer> = {
    [activeKeyId]: activeKey,
  };

  const previousRaw = env.ENCRYPTION_PREVIOUS_KEYS?.trim();
  if (previousRaw && previousRaw.length > 0) {
    for (const entry of previousRaw.split(",")) {
      const trimmedEntry = entry.trim();
      if (trimmedEntry.length === 0) {
        continue;
      }
      const separatorIdx = trimmedEntry.indexOf(":");
      if (separatorIdx <= 0) {
        throw new MasterKeyConfigError(
          "MASTER_KEY_INVALID",
          "Entrada inválida em ENCRYPTION_PREVIOUS_KEYS; utilize o formato '<id>:<chave>'.",
        );
      }
      const prevId = trimmedEntry.slice(0, separatorIdx).trim();
      const prevMaterial = trimmedEntry.slice(separatorIdx + 1).trim();
      if (!KEY_ID_PATTERN.test(prevId) || prevId === activeKeyId) {
        throw new MasterKeyConfigError(
          "MASTER_KEY_INVALID",
          "Identificador duplicado ou inválido em ENCRYPTION_PREVIOUS_KEYS.",
        );
      }
      keysById[prevId] = parseMasterKeyMaterial(prevMaterial);
    }
  }

  return {
    activeKeyId,
    activeKey,
    keysById,
  };
}
