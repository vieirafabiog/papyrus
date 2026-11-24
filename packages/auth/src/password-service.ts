import argon2 from "argon2";

export interface PasswordServiceOptions {
  readonly memoryCost?: number | undefined;
  readonly timeCost?: number | undefined;
  readonly parallelism?: number | undefined;
  readonly hashLength?: number | undefined;
  readonly minPasswordLength?: number | undefined;
  readonly maxPasswordLength?: number | undefined;
}

export interface PasswordService {
  hashPassword(plainPassword: string): Promise<string>;
  verifyPassword(plainPassword: string, storedHash: string): Promise<boolean>;
  needsRehash(storedHash: string): boolean;
}

const DEFAULT_MEMORY_COST_KIB = 65_536;
const DEFAULT_TIME_COST = 3;
const DEFAULT_PARALLELISM = 1;
const DEFAULT_HASH_LENGTH = 32;
const DEFAULT_MIN_PASSWORD_LENGTH = 10;
const DEFAULT_MAX_PASSWORD_LENGTH = 256;

function assertPositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid password service option "${name}": expected positive integer.`);
  }
  return value;
}

export function createPasswordService(options: PasswordServiceOptions = {}): PasswordService {
  const memoryCost = assertPositiveInt("memoryCost", options.memoryCost ?? DEFAULT_MEMORY_COST_KIB);
  const timeCost = assertPositiveInt("timeCost", options.timeCost ?? DEFAULT_TIME_COST);
  const parallelism = assertPositiveInt("parallelism", options.parallelism ?? DEFAULT_PARALLELISM);
  const hashLength = assertPositiveInt("hashLength", options.hashLength ?? DEFAULT_HASH_LENGTH);
  const minPasswordLength = assertPositiveInt(
    "minPasswordLength",
    options.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH,
  );
  const maxPasswordLength = assertPositiveInt(
    "maxPasswordLength",
    options.maxPasswordLength ?? DEFAULT_MAX_PASSWORD_LENGTH,
  );

  if (minPasswordLength > maxPasswordLength) {
    throw new Error("minPasswordLength cannot exceed maxPasswordLength.");
  }

  return {
    async hashPassword(plainPassword: string): Promise<string> {
      if (plainPassword.length < minPasswordLength) {
        throw new Error(`A senha deve ter no mínimo ${minPasswordLength} caracteres.`);
      }
      if (plainPassword.length > maxPasswordLength) {
        throw new Error(`A senha deve ter no máximo ${maxPasswordLength} caracteres.`);
      }

      return argon2.hash(plainPassword, {
        type: argon2.argon2id,
        memoryCost,
        timeCost,
        parallelism,
        hashLength,
      });
    },

    async verifyPassword(plainPassword: string, storedHash: string): Promise<boolean> {
      if (
        plainPassword.length === 0 ||
        plainPassword.length > maxPasswordLength ||
        !storedHash.startsWith("$argon2id$")
      ) {
        return false;
      }

      try {
        return await argon2.verify(storedHash, plainPassword);
      } catch {
        return false;
      }
    },

    needsRehash(storedHash: string): boolean {
      if (!storedHash.startsWith("$argon2id$")) {
        return true;
      }
      try {
        return argon2.needsRehash(storedHash, {
          memoryCost,
          timeCost,
          parallelism,
        });
      } catch {
        return true;
      }
    },
  };
}
