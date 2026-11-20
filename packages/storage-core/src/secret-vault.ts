import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { StorageError } from "./storage-errors.js";
import type { StorageSecretResolver } from "./storage-registry.js";

const VAULT_PREFIX = "dfvault";
const VAULT_FORMAT_VERSION = "v1";
const REQUIRED_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export type MasterKeyInput = Uint8Array | string;

export interface SecretVaultOptions {
  readonly masterKey: MasterKeyInput | undefined;
  readonly activeKeyId?: string | undefined;
  readonly previousKeys?: Readonly<Record<string, MasterKeyInput>> | undefined;
}

export type ConnectorCredentials = Readonly<Record<string, string>>;

export interface StorageSecretVault {
  readonly activeKeyId: string;
  encryptCredentials(credentials: ConnectorCredentials): string;
  decryptCredentials(encryptedPayload: string): ConnectorCredentials;
  rotateCredentials(encryptedPayload: string): string;
  toStorageSecretResolver(): StorageSecretResolver;
}

function decodeBase64Exact32(raw: string): Buffer | null {
  if (!STRICT_BASE64_PATTERN.test(raw)) {
    return null;
  }
  const normalized = raw.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== REQUIRED_KEY_BYTES) {
    return null;
  }
  const reencodedNoPad = decoded.toString("base64").replace(/=+$/, "");
  if (normalized.replace(/=+$/, "") !== reencodedNoPad) {
    return null;
  }
  return decoded;
}

function normalizeKeyMaterial(input: MasterKeyInput | undefined, label: string): Buffer {
  if (input === undefined) {
    throw new StorageError(
      "UNAUTHORIZED",
      `Chave mestra '${label}' ausente para criptografia de credenciais.`,
    );
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new StorageError("UNAUTHORIZED", `Chave mestra '${label}' não pode estar vazia.`);
    }
    if (HEX_KEY_PATTERN.test(trimmed)) {
      const hexBuf = Buffer.from(trimmed, "hex");
      if (hexBuf.length === REQUIRED_KEY_BYTES) {
        return hexBuf;
      }
    }
    const base64Buf = decodeBase64Exact32(trimmed);
    if (base64Buf) {
      return base64Buf;
    }
    throw new StorageError(
      "UNAUTHORIZED",
      `Formato da chave mestra '${label}' inválido: utilize 32 bytes em hex ou base64.`,
    );
  }

  if (input.byteLength !== REQUIRED_KEY_BYTES) {
    throw new StorageError(
      "UNAUTHORIZED",
      `Chave mestra '${label}' deve possuir exatamente 32 bytes (256 bits).`,
    );
  }

  return Buffer.from(input);
}

function validateCredentialsRecord(raw: unknown): ConnectorCredentials {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Estrutura de credenciais do conector inválida para o vault.",
    );
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Conjunto de credenciais do conector não pode ser vazio.",
    );
  }

  const clean: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.trim().length === 0 || typeof value !== "string") {
      throw new StorageError(
        "UNAUTHORIZED",
        "Todas as credenciais do conector devem ser pares chave/texto válidos.",
      );
    }
    clean[key] = value;
  }

  return Object.freeze(clean);
}

/**
 * Validates only the outer structural envelope of an encrypted vault reference.
 */
export function isValidEncryptedVaultEnvelope(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const parts = value.split(":");
  if (parts.length !== 6) {
    return false;
  }
  const [prefix, version, keyId, ivB64, tagB64, cipherB64] = parts;
  if (
    prefix !== VAULT_PREFIX ||
    version !== VAULT_FORMAT_VERSION ||
    !keyId ||
    !KEY_ID_PATTERN.test(keyId) ||
    !ivB64 ||
    !tagB64 ||
    !cipherB64
  ) {
    return false;
  }

  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const cipher = Buffer.from(cipherB64, "base64url");
  return iv.length === IV_BYTES && tag.length === AUTH_TAG_BYTES && cipher.length > 0;
}

/**
 * Creates an AES-256-GCM credential vault backed by an external 32-byte master key.
 */
export function createStorageSecretVault(options: SecretVaultOptions): StorageSecretVault {
  const activeKeyId = options.activeKeyId?.trim() || "v1";
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Identificador da chave mestra ativa possui formato inválido.",
    );
  }

  const keyring = new Map<string, Buffer>();
  const activeKey = normalizeKeyMaterial(options.masterKey, activeKeyId);
  keyring.set(activeKeyId, activeKey);

  if (options.previousKeys) {
    for (const [prevId, prevMaterial] of Object.entries(options.previousKeys)) {
      if (!KEY_ID_PATTERN.test(prevId) || prevId === activeKeyId) {
        throw new StorageError(
          "UNAUTHORIZED",
          "Identificador de chave anterior no vault é inválido ou duplicado.",
        );
      }
      keyring.set(prevId, normalizeKeyMaterial(prevMaterial, prevId));
    }
  }

  return {
    activeKeyId,

    encryptCredentials(credentials: ConnectorCredentials): string {
      const validated = validateCredentialsRecord(credentials);
      const plaintext = JSON.stringify(validated);
      const iv = randomBytes(IV_BYTES);
      const aad = Buffer.from(`${VAULT_PREFIX}:${VAULT_FORMAT_VERSION}:${activeKeyId}`, "utf8");

      const cipher = createCipheriv("aes-256-gcm", activeKey, iv);
      cipher.setAAD(aad);

      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        VAULT_PREFIX,
        VAULT_FORMAT_VERSION,
        activeKeyId,
        iv.toString("base64url"),
        authTag.toString("base64url"),
        encrypted.toString("base64url"),
      ].join(":");
    },

    decryptCredentials(encryptedPayload: string): ConnectorCredentials {
      if (!isValidEncryptedVaultEnvelope(encryptedPayload)) {
        throw new StorageError("UNAUTHORIZED", "Formato da credencial criptografada é inválido.");
      }

      const parts = encryptedPayload.split(":");
      const keyId = parts[2];
      const ivB64 = parts[3];
      const tagB64 = parts[4];
      const cipherB64 = parts[5];

      if (!keyId || !ivB64 || !tagB64 || !cipherB64) {
        throw new StorageError("UNAUTHORIZED", "Envelope de credencial criptografada incompleto.");
      }

      const key = keyring.get(keyId);
      if (!key) {
        throw new StorageError(
          "UNAUTHORIZED",
          "Chave mestra correspondente ao envelope não está disponível.",
        );
      }

      try {
        const iv = Buffer.from(ivB64, "base64url");
        const authTag = Buffer.from(tagB64, "base64url");
        const ciphertext = Buffer.from(cipherB64, "base64url");
        const aad = Buffer.from(`${VAULT_PREFIX}:${VAULT_FORMAT_VERSION}:${keyId}`, "utf8");

        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);

        const decryptedUtf8 = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");

        const parsed: unknown = JSON.parse(decryptedUtf8);
        return validateCredentialsRecord(parsed);
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        throw new StorageError(
          "UNAUTHORIZED",
          "Falha ao descriptografar ou autenticar credenciais do conector.",
        );
      }
    },

    rotateCredentials(encryptedPayload: string): string {
      const credentials = this.decryptCredentials(encryptedPayload);
      return this.encryptCredentials(credentials);
    },

    toStorageSecretResolver(): StorageSecretResolver {
      return {
        resolveSecret: async (encryptedSecretRef: string | null) => {
          if (encryptedSecretRef === null) {
            return null;
          }
          return this.decryptCredentials(encryptedSecretRef);
        },
      };
    },
  };
}
