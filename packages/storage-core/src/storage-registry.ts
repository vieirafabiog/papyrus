import type { StorageProvider } from "./storage-provider.js";
import { StorageError, normalizeStorageError } from "./storage.errors.js";
import type { StorageProviderKind } from "./storage.types.js";

export type RegistryConnectionStatus = "ACTIVE" | "INACTIVE" | "ERROR";

export type RegistryNonSecretConfig = Readonly<Record<string, string | number | boolean | null>>;

export interface StorageConnectionDescriptor {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly kind: StorageProviderKind;
  readonly status: RegistryConnectionStatus;
  readonly nonSecretConfig: RegistryNonSecretConfig;
  readonly encryptedSecretRef: string | null;
}

export interface StorageSecretResolver {
  resolveSecret(
    encryptedSecretRef: string | null,
  ): Promise<Readonly<Record<string, string>> | null>;
}

export interface StorageConnectionLookup {
  findById(connectionId: string): Promise<StorageConnectionDescriptor | null>;
}

export interface StorageProviderFactoryContext {
  readonly connection: StorageConnectionDescriptor;
  readonly resolvedSecret: Readonly<Record<string, string>> | null;
}

export type StorageProviderFactory = (
  context: StorageProviderFactoryContext,
) => StorageProvider | Promise<StorageProvider>;

export interface RegisterFactoryOptions {
  readonly overwrite?: boolean | undefined;
}

export interface ResolveStorageProviderOptions {
  readonly allowInactive?: boolean | undefined;
  readonly bypassCache?: boolean | undefined;
}

export interface StorageProviderRegistryOptions {
  readonly secretResolver?: StorageSecretResolver | undefined;
  readonly connectionLookup?: StorageConnectionLookup | undefined;
}

export interface StorageProviderRegistry {
  registerFactory(
    kind: StorageProviderKind,
    factory: StorageProviderFactory,
    options?: RegisterFactoryOptions,
  ): void;
  unregisterFactory(kind: StorageProviderKind): boolean;
  hasFactory(kind: StorageProviderKind): boolean;
  listRegisteredKinds(): readonly StorageProviderKind[];
  resolveProvider(
    connection: StorageConnectionDescriptor,
    options?: ResolveStorageProviderOptions,
  ): Promise<StorageProvider>;
  resolveByConnectionId(
    connectionId: string,
    options?: ResolveStorageProviderOptions,
  ): Promise<StorageProvider>;
  invalidate(connectionId: string): void;
  clear(): void;
}

interface CachedProviderEntry {
  readonly kind: StorageProviderKind;
  readonly fingerprint: string;
  readonly provider: StorageProvider;
}

function buildConnectionFingerprint(connection: StorageConnectionDescriptor): string {
  const sortedConfigEntries = Object.entries(connection.nonSecretConfig).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify({
    kind: connection.kind,
    nonSecretConfig: sortedConfigEntries,
    encryptedSecretRef: connection.encryptedSecretRef,
  });
}

export function createStorageProviderRegistry(
  options: StorageProviderRegistryOptions = {},
): StorageProviderRegistry {
  const factories = new Map<StorageProviderKind, StorageProviderFactory>();
  const cache = new Map<string, CachedProviderEntry>();

  const invalidateByKind = (kind: StorageProviderKind): void => {
    for (const [connectionId, entry] of cache.entries()) {
      if (entry.kind === kind) {
        cache.delete(connectionId);
      }
    }
  };

  return {
    registerFactory(
      kind: StorageProviderKind,
      factory: StorageProviderFactory,
      registerOptions?: RegisterFactoryOptions,
    ): void {
      if (factories.has(kind) && !registerOptions?.overwrite) {
        throw new StorageError(
          "CONFLICT",
          `Já existe uma factory registrada para o provedor '${kind}'.`,
          kind,
        );
      }
      factories.set(kind, factory);
      invalidateByKind(kind);
    },

    unregisterFactory(kind: StorageProviderKind): boolean {
      const removed = factories.delete(kind);
      if (removed) {
        invalidateByKind(kind);
      }
      return removed;
    },

    hasFactory(kind: StorageProviderKind): boolean {
      return factories.has(kind);
    },

    listRegisteredKinds(): readonly StorageProviderKind[] {
      return Array.from(factories.keys());
    },

    async resolveProvider(
      connection: StorageConnectionDescriptor,
      resolveOptions?: ResolveStorageProviderOptions,
    ): Promise<StorageProvider> {
      const factory = factories.get(connection.kind);
      if (!factory) {
        throw new StorageError(
          "CAPABILITY_NOT_SUPPORTED",
          `Provedor de armazenamento '${connection.kind}' não possui factory registrada.`,
          connection.kind,
        );
      }

      if (connection.status === "INACTIVE" && !resolveOptions?.allowInactive) {
        throw new StorageError(
          "UNAVAILABLE",
          "A conexão de armazenamento selecionada está inativa.",
          connection.kind,
        );
      }

      const fingerprint = buildConnectionFingerprint(connection);
      if (!resolveOptions?.bypassCache) {
        const cached = cache.get(connection.id);
        if (cached && cached.fingerprint === fingerprint) {
          return cached.provider;
        }
      }

      let resolvedSecret: Readonly<Record<string, string>> | null = null;
      if (connection.encryptedSecretRef !== null) {
        if (!options.secretResolver) {
          throw new StorageError(
            "UNAUTHORIZED",
            "Resolvedor de credenciais não configurado para a conexão de armazenamento.",
            connection.kind,
          );
        }
        try {
          resolvedSecret = await options.secretResolver.resolveSecret(
            connection.encryptedSecretRef,
          );
        } catch (error) {
          throw normalizeStorageError(error, connection.kind);
        }
      }

      try {
        const provider = await factory({
          connection,
          resolvedSecret,
        });
        cache.set(connection.id, {
          kind: connection.kind,
          fingerprint,
          provider,
        });
        return provider;
      } catch (error) {
        throw normalizeStorageError(error, connection.kind);
      }
    },

    async resolveByConnectionId(
      connectionId: string,
      resolveOptions?: ResolveStorageProviderOptions,
    ): Promise<StorageProvider> {
      if (!options.connectionLookup) {
        throw new StorageError(
          "UNAVAILABLE",
          "Consulta de conexões de armazenamento não configurada no registry.",
        );
      }

      const connection = await options.connectionLookup.findById(connectionId);
      if (!connection) {
        throw new StorageError("NOT_FOUND", "Conexão de armazenamento não encontrada.");
      }

      return this.resolveProvider(connection, resolveOptions);
    },

    invalidate(connectionId: string): void {
      cache.delete(connectionId);
    },

    clear(): void {
      cache.clear();
    },
  };
}
