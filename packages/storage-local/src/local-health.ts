import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { StorageError, type StorageHealthCheckResult } from "@docuflow/storage-core";
import { resolveSafeLocalRoot } from "./safe-path.js";

export interface LocalHealthCheckOptions {
  readonly rootDirectory: string;
  readonly minFreeBytes?: number | undefined;
}

export interface LocalStorageHealthResult extends StorageHealthCheckResult {
  readonly availableBytes?: number | undefined;
}

async function readAvailableSpaceBytes(rootRealPath: string): Promise<number | undefined> {
  try {
    const fsStats = await statfs(rootRealPath);
    const available = Number(fsStats.bavail) * Number(fsStats.bsize);
    return Number.isFinite(available) && available >= 0 ? available : undefined;
  } catch {
    return undefined;
  }
}

async function runControlledReadWriteProbe(rootRealPath: string): Promise<boolean> {
  const probeFilePath = path.join(rootRealPath, `.docuflow-health-${randomUUID()}.tmp`);
  const probeToken = `docuflow-health-probe-${randomUUID()}`;

  try {
    const writeHandle = await open(probeFilePath, "wx", 0o600);
    try {
      await writeHandle.writeFile(probeToken, "utf8");
      await writeHandle.sync();
    } finally {
      await writeHandle.close();
    }

    const readHandle = await open(probeFilePath, "r");
    try {
      const readBack = await readHandle.readFile("utf8");
      return readBack === probeToken;
    } finally {
      await readHandle.close();
    }
  } finally {
    await rm(probeFilePath, { force: true });
  }
}

/**
 * Verifies existence, R/W/X permissions, controlled read/write probe, and
 * available disk space (when supported by the OS) without exposing host paths.
 */
export async function checkLocalStorageHealth(
  options: LocalHealthCheckOptions,
): Promise<LocalStorageHealthResult> {
  const checkedAt = new Date();

  let rootRealPath: string;
  try {
    rootRealPath = await resolveSafeLocalRoot(options.rootDirectory);
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.code === "NOT_FOUND") {
        return {
          healthy: false,
          message: "Diretório de armazenamento local não encontrado.",
          checkedAt,
        };
      }
      if (error.code === "UNAUTHORIZED") {
        return {
          healthy: false,
          message: "Sem permissão para acessar o diretório de armazenamento local.",
          checkedAt,
        };
      }
      return {
        healthy: false,
        message: "Configuração do diretório de armazenamento local é inválida.",
        checkedAt,
      };
    }

    return {
      healthy: false,
      message: "Falha ao validar o diretório de armazenamento local.",
      checkedAt,
    };
  }

  try {
    await access(rootRealPath, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    return {
      healthy: false,
      message: "Permissões insuficientes de leitura ou escrita no armazenamento local.",
      checkedAt,
    };
  }

  try {
    const probeOk = await runControlledReadWriteProbe(rootRealPath);
    if (!probeOk) {
      return {
        healthy: false,
        message: "Falha na verificação controlada de leitura e escrita do armazenamento local.",
        checkedAt,
      };
    }
  } catch {
    return {
      healthy: false,
      message: "Falha no teste controlado de leitura e escrita do armazenamento local.",
      checkedAt,
    };
  }

  const availableBytes = await readAvailableSpaceBytes(rootRealPath);
  if (
    options.minFreeBytes !== undefined &&
    availableBytes !== undefined &&
    availableBytes < options.minFreeBytes
  ) {
    return {
      healthy: false,
      message: "Espaço livre insuficiente no volume de armazenamento local.",
      checkedAt,
      availableBytes,
    };
  }

  return {
    healthy: true,
    message:
      availableBytes !== undefined
        ? "Armazenamento local operacional com leitura, escrita e espaço verificados."
        : "Armazenamento local operacional com leitura e escrita verificadas.",
    checkedAt,
    ...(availableBytes !== undefined ? { availableBytes } : {}),
  };
}
