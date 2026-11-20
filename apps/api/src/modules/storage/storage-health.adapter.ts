import type {
  StorageConnectionEntity,
  StorageConnectionHealthOutput,
  StorageConnectionHealthTesterPort,
} from "@docuflow/domain";
import { createStorageProviderRegistry } from "@docuflow/storage-core";
import { createLocalStorageProvider } from "@docuflow/storage-local";

function readNonEmptyString(value: string | number | boolean | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalPositiveNumber(
  value: string | number | boolean | null | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Bridges domain `StorageConnectionHealthTesterPort` to the concrete storage
 * provider registry (currently wired for `local` filesystem connections).
 */
export function createLocalStorageHealthTester(): StorageConnectionHealthTesterPort {
  const registry = createStorageProviderRegistry();

  registry.registerFactory("local", ({ connection }) => {
    const rootDirectory = readNonEmptyString(connection.nonSecretConfig.rootDirectory);
    if (!rootDirectory) {
      throw new Error("Local rootDirectory is missing");
    }
    return createLocalStorageProvider({
      rootDirectory,
      maxObjectSizeBytes: readOptionalPositiveNumber(connection.nonSecretConfig.maxObjectSizeBytes),
      minFreeBytes: readOptionalPositiveNumber(connection.nonSecretConfig.minFreeBytes),
    });
  });

  return {
    async testConnection(
      connection: StorageConnectionEntity,
    ): Promise<StorageConnectionHealthOutput> {
      try {
        const provider = await registry.resolveProvider(connection, {
          allowInactive: true,
          bypassCache: true,
        });
        return await provider.checkHealth();
      } catch {
        return {
          healthy: false,
          message: "Falha ao verificar a saúde da conexão de armazenamento.",
          checkedAt: new Date(),
        };
      }
    },
  };
}
