import type {
  StorageConnectionEntity,
  StorageConnectionHealthOutput,
  StorageConnectionHealthTesterPort,
} from "@papyrus/domain";
import type { StorageSecretVault } from "@papyrus/storage-core";
import type { S3EndpointSecurityPolicy } from "@papyrus/storage-s3";
import { createApiStorageProviderRegistry } from "./storage-provider.registry.js";

export interface StorageHealthTesterOptions {
  readonly secretVault?: StorageSecretVault | undefined;
  readonly s3SecurityPolicy?: S3EndpointSecurityPolicy | undefined;
  readonly healthVerifyReadWrite?: boolean | undefined;
}

/**
 * Bridges domain `StorageConnectionHealthTesterPort` to the concrete storage
 * provider registry (`local` filesystem and `s3`-compatible endpoints).
 */
export function createStorageHealthTester(
  options: StorageHealthTesterOptions = {},
): StorageConnectionHealthTesterPort {
  const registry = createApiStorageProviderRegistry({
    secretVault: options.secretVault,
    s3SecurityPolicy: options.s3SecurityPolicy,
    healthVerifyReadWrite: options.healthVerifyReadWrite,
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

export function createLocalStorageHealthTester(): StorageConnectionHealthTesterPort {
  return createStorageHealthTester();
}
