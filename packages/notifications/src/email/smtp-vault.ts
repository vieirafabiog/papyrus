import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VAULT_PREFIX = "dfsmtp";
const VAULT_VERSION = "v1";
const REQUIRED_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export type SmtpMasterKeyInput = Uint8Array | string;

export interface SmtpCredentials {
  readonly username: string;
  readonly password: string;
}

export interface SmtpSecretVaultOptions {
  readonly masterKey: SmtpMasterKeyInput | undefined;
  readonly activeKeyId?: string | undefined;
  readonly previousKeys?: Readonly<Record<string, SmtpMasterKeyInput>> | undefined;
}

export class SmtpSecretVaultError extends Error {
  public readonly code: "KEY_CONFIG_INVALID" | "ENVELOPE_INVALID" | "DECRYPT_FAILED";

  public constructor(
    code: "KEY_CONFIG_INVALID" | "ENVELOPE_INVALID" | "DECRYPT_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SmtpSecretVaultError";
    this.code = code;
  }
}

export interface SmtpSecretVault {
  readonly activeKeyId: string;
  encryptCredentials(credentials: SmtpCredentials): string;
  decryptCredentials(encryptedEnvelope: string): SmtpCredentials;
  rotateCredentials(encryptedEnvelope: string): string;
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

function normalizeMasterKey(input: SmtpMasterKeyInput | undefined, label: string): Buffer {
  if (input === undefined) {
    throw new SmtpSecretVaultError(
      "KEY_CONFIG_INVALID",
      `Chave mestra '${label}' ausente para criptografia das credenciais SMTP.`,
    );
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
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
    throw new SmtpSecretVaultError(
      "KEY_CONFIG_INVALID",
      `Chave mestra '${label}' inválida: forneça 32 bytes em hex ou base64.`,
    );
  }

  if (input.byteLength !== REQUIRED_KEY_BYTES) {
    throw new SmtpSecretVaultError(
      "KEY_CONFIG_INVALID",
      `Chave mestra '${label}' deve possuir exatamente 32 bytes (256 bits).`,
    );
  }

  return Buffer.from(input);
}

/**
 * Validates only the outer structural envelope of an encrypted SMTP credential secret.
 */
export function isValidSmtpSecretEnvelope(value: string): boolean {
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
    version !== VAULT_VERSION ||
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
 * Redacts SMTP passwords, encrypted vault payloads, and AUTH tokens from error messages.
 */
export function sanitizeSmtpErrorMessage(
  rawMessage: string,
  extraSecrets: readonly (string | undefined)[] = [],
): string {
  let sanitized = rawMessage;
  for (const secret of extraSecrets) {
    if (secret && secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }
  sanitized = sanitized.replace(/dfsmtp:v1:[^\s]+/gi, "[REDACTED_VAULT]");
  sanitized = sanitized.replace(/(AUTH\s+(?:PLAIN|LOGIN)\s+)[^\r\n]+/gi, "$1[REDACTED]");
  sanitized = sanitized.replace(
    /(password|pass|secret|token)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );
  return sanitized.trim().slice(0, 480);
}

/**
 * Creates an AES-256-GCM vault protecting SMTP credentials at rest with external key rotation.
 */
export function createSmtpSecretVault(options: SmtpSecretVaultOptions): SmtpSecretVault {
  const activeKeyId = options.activeKeyId?.trim() || "v1";
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new SmtpSecretVaultError(
      "KEY_CONFIG_INVALID",
      "Identificador da chave mestra ativa para SMTP é inválido.",
    );
  }

  const keyring = new Map<string, Buffer>();
  keyring.set(activeKeyId, normalizeMasterKey(options.masterKey, activeKeyId));

  if (options.previousKeys) {
    for (const [keyId, material] of Object.entries(options.previousKeys)) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new SmtpSecretVaultError(
          "KEY_CONFIG_INVALID",
          `Identificador da chave anterior '${keyId}' é inválido.`,
        );
      }
      keyring.set(keyId, normalizeMasterKey(material, keyId));
    }
  }

  return {
    activeKeyId,

    encryptCredentials(credentials: SmtpCredentials): string {
      const username = credentials.username.trim();
      if (username.length === 0 || credentials.password.length === 0) {
        throw new SmtpSecretVaultError(
          "KEY_CONFIG_INVALID",
          "Usuário e senha SMTP são obrigatórios para criptografar credenciais.",
        );
      }
      if (/[\r\n\0]/.test(username) || /[\r\n\0]/.test(credentials.password)) {
        throw new SmtpSecretVaultError(
          "KEY_CONFIG_INVALID",
          "Credenciais SMTP contêm caracteres de controle não permitidos.",
        );
      }

      const key = keyring.get(activeKeyId);
      if (!key) {
        throw new SmtpSecretVaultError("KEY_CONFIG_INVALID", "Chave ativa indisponível.");
      }

      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`${VAULT_PREFIX}:${VAULT_VERSION}:${activeKeyId}`, "utf8"));

      const plaintext = JSON.stringify({
        username,
        password: credentials.password,
      });
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        VAULT_PREFIX,
        VAULT_VERSION,
        activeKeyId,
        iv.toString("base64url"),
        authTag.toString("base64url"),
        encrypted.toString("base64url"),
      ].join(":");
    },

    decryptCredentials(encryptedEnvelope: string): SmtpCredentials {
      if (!isValidSmtpSecretEnvelope(encryptedEnvelope)) {
        throw new SmtpSecretVaultError(
          "ENVELOPE_INVALID",
          "Envelope criptografado de credenciais SMTP inválido.",
        );
      }

      const parts = encryptedEnvelope.split(":");
      const keyId = parts[2] ?? "";
      const ivB64 = parts[3] ?? "";
      const tagB64 = parts[4] ?? "";
      const cipherB64 = parts[5] ?? "";

      const key = keyring.get(keyId);
      if (!key) {
        throw new SmtpSecretVaultError(
          "DECRYPT_FAILED",
          "Chave de descriptografia SMTP não configurada para o identificador informado.",
        );
      }

      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
        decipher.setAAD(Buffer.from(`${VAULT_PREFIX}:${VAULT_VERSION}:${keyId}`, "utf8"));
        decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
        const decrypted = Buffer.concat([
          decipher.update(Buffer.from(cipherB64, "base64url")),
          decipher.final(),
        ]).toString("utf8");
        const parsed = JSON.parse(decrypted) as { username?: unknown; password?: unknown };
        if (
          typeof parsed.username !== "string" ||
          parsed.username.trim().length === 0 ||
          typeof parsed.password !== "string" ||
          parsed.password.length === 0
        ) {
          throw new SmtpSecretVaultError("DECRYPT_FAILED", "Credenciais SMTP corrompidas.");
        }
        return {
          username: parsed.username,
          password: parsed.password,
        };
      } catch (error) {
        if (error instanceof SmtpSecretVaultError) {
          throw error;
        }
        throw new SmtpSecretVaultError(
          "DECRYPT_FAILED",
          "Falha ao descriptografar credenciais SMTP.",
        );
      }
    },

    rotateCredentials(encryptedEnvelope: string): string {
      const credentials = this.decryptCredentials(encryptedEnvelope);
      return this.encryptCredentials(credentials);
    },
  };
}
