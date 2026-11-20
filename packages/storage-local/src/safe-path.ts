import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StorageError, normalizeStorageError } from "@docuflow/storage-core";

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_OBJECT_KEY_LENGTH = 512;
const MAX_SEGMENTS = 16;

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export interface SafeLocalPathResult {
  readonly normalizedKey: string;
  readonly rootRealPath: string;
  readonly targetPath: string;
  readonly parentDirPath: string;
}

function isErrnoWithCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === expectedCode
  );
}

function isPathStrictlyInsideRoot(rootRealPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootRealPath, candidatePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Validates that a storage object key is a clean, relative, opaque key without
 * traversal segments, hidden dot-entries, backslashes, control chars, or odd symbols.
 */
export function validateLocalObjectKey(rawKey: string): string {
  if (typeof rawKey !== "string" || rawKey.length === 0 || rawKey.length > MAX_OBJECT_KEY_LENGTH) {
    throw new StorageError(
      "INVALID_KEY",
      "Chave de objeto ausente ou fora do tamanho permitido.",
      "local",
    );
  }

  if (rawKey.trim() !== rawKey) {
    throw new StorageError(
      "INVALID_KEY",
      "Chave de objeto não pode conter espaços no início ou no fim.",
      "local",
    );
  }

  if (
    hasControlCharacters(rawKey) ||
    rawKey.includes("\\") ||
    rawKey.includes(":") ||
    rawKey.includes("%") ||
    rawKey.startsWith("/") ||
    rawKey.endsWith("/")
  ) {
    throw new StorageError(
      "INVALID_KEY",
      "Chave de objeto contém caracteres ou prefixos não permitidos.",
      "local",
    );
  }

  const segments = rawKey.split("/");
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) {
    throw new StorageError(
      "INVALID_KEY",
      "Chave de objeto excede a profundidade máxima permitida.",
      "local",
    );
  }

  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      !SAFE_SEGMENT_PATTERN.test(segment) ||
      WINDOWS_RESERVED_NAME_PATTERN.test(segment)
    ) {
      throw new StorageError(
        "INVALID_KEY",
        "Chave de objeto contém segmento inválido ou proibido.",
        "local",
      );
    }
  }

  return segments.join("/");
}

/**
 * Validates the configured storage root directory and resolves its canonical real path.
 */
export async function resolveSafeLocalRoot(rootDirectory: string): Promise<string> {
  if (
    typeof rootDirectory !== "string" ||
    rootDirectory.trim().length === 0 ||
    hasControlCharacters(rootDirectory) ||
    !path.isAbsolute(rootDirectory)
  ) {
    throw new StorageError(
      "INVALID_KEY",
      "Diretório raiz de armazenamento local deve ser um caminho absoluto válido.",
      "local",
    );
  }

  try {
    const rootRealPath = await realpath(rootDirectory);
    const rootStats = await stat(rootRealPath);
    if (!rootStats.isDirectory()) {
      throw new StorageError(
        "INVALID_KEY",
        "O diretório raiz configurado para armazenamento local não é uma pasta.",
        "local",
      );
    }
    return rootRealPath;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw normalizeStorageError(error, "local");
  }
}

/**
 * Resolves a local object key inside `rootDirectory`, blocking path traversal,
 * unexpected segment names, and any symbolic links inside the storage hierarchy.
 */
export async function resolveSafeLocalPath(
  rootDirectory: string,
  objectKey: string,
): Promise<SafeLocalPathResult> {
  const normalizedKey = validateLocalObjectKey(objectKey);
  const rootRealPath = await resolveSafeLocalRoot(rootDirectory);
  const segments = normalizedKey.split("/");

  let currentPath = rootRealPath;
  let lastExistingRealPath = rootRealPath;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      throw new StorageError("INVALID_KEY", "Segmento vazio na chave de objeto.", "local");
    }

    currentPath = path.join(currentPath, segment);
    if (!isPathStrictlyInsideRoot(rootRealPath, currentPath)) {
      throw new StorageError(
        "INVALID_KEY",
        "Tentativa de saída do diretório raiz (path traversal) bloqueada.",
        "local",
      );
    }

    const isLeaf = index === segments.length - 1;

    try {
      const entryStats = await lstat(currentPath);
      if (entryStats.isSymbolicLink()) {
        throw new StorageError(
          "INVALID_KEY",
          "Links simbólicos não são permitidos dentro do diretório de armazenamento.",
          "local",
        );
      }

      if (isLeaf && entryStats.isDirectory()) {
        throw new StorageError(
          "INVALID_KEY",
          "A chave de objeto aponta para um diretório existente.",
          "local",
        );
      }

      if (!isLeaf && !entryStats.isDirectory()) {
        throw new StorageError(
          "CONFLICT",
          "Componente intermediário do caminho de armazenamento não é um diretório.",
          "local",
        );
      }

      const verifiedReal = await realpath(currentPath);
      if (!isPathStrictlyInsideRoot(rootRealPath, verifiedReal)) {
        throw new StorageError(
          "INVALID_KEY",
          "Caminho resolvido escapa da raiz configurada para armazenamento local.",
          "local",
        );
      }
      lastExistingRealPath = verifiedReal;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (isErrnoWithCode(error, "ENOENT")) {
        // Remaining segments do not yet exist on disk; lexical containment still holds
        // from the verified existing ancestor (`lastExistingRealPath`).
        if (
          lastExistingRealPath !== rootRealPath &&
          !isPathStrictlyInsideRoot(rootRealPath, lastExistingRealPath)
        ) {
          throw new StorageError(
            "INVALID_KEY",
            "Ancestral resolvido escapa do diretório raiz configurado.",
            "local",
          );
        }
        break;
      }
      throw normalizeStorageError(error, "local");
    }
  }

  const targetPath = path.resolve(rootRealPath, ...segments);
  if (!isPathStrictlyInsideRoot(rootRealPath, targetPath)) {
    throw new StorageError(
      "INVALID_KEY",
      "Caminho final fora da raiz configurada para armazenamento local.",
      "local",
    );
  }

  return {
    normalizedKey,
    rootRealPath,
    targetPath,
    parentDirPath: path.dirname(targetPath),
  };
}
