import type { TransactionContext } from "./transaction.port.js";

export type StorageConnectionKind = "local" | "s3" | "sharepoint" | "azure_blob" | "google_cloud";

export type StorageConnectionStatus = "ACTIVE" | "INACTIVE" | "ERROR";

export interface StorageConnectionEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly kind: StorageConnectionKind;
  readonly isDefault: boolean;
  readonly status: StorageConnectionStatus;
  readonly nonSecretConfig: Readonly<Record<string, string | number | boolean | null>>;
  readonly encryptedSecretRef: string | null;
  readonly lastHealthCheckAt: string | null;
  readonly lastHealthMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateStorageConnectionInput {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly kind: StorageConnectionKind;
  readonly isDefault: boolean;
  readonly nonSecretConfig: Readonly<Record<string, string | number | boolean | null>>;
  readonly encryptedSecretRef: string | null;
}

export interface UpdateStorageConnectionInput {
  readonly name?: string | undefined;
  readonly isDefault?: boolean | undefined;
  readonly status?: StorageConnectionStatus | undefined;
  readonly nonSecretConfig?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  readonly encryptedSecretRef?: string | null | undefined;
  readonly lastHealthCheckAt?: string | null | undefined;
  readonly lastHealthMessage?: string | null | undefined;
}

export interface StorageConnectionRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<StorageConnectionEntity | null>;
  findDefaultByOrganization(
    organizationId: string,
    tx?: TransactionContext,
  ): Promise<StorageConnectionEntity | null>;
  listByOrganization(organizationId: string): Promise<readonly StorageConnectionEntity[]>;
  create(
    input: CreateStorageConnectionInput,
    tx?: TransactionContext,
  ): Promise<StorageConnectionEntity>;
  update(
    id: string,
    input: UpdateStorageConnectionInput,
    tx?: TransactionContext,
  ): Promise<StorageConnectionEntity | null>;
  hasLinkedFileObjects(connectionId: string, tx?: TransactionContext): Promise<boolean>;
}

export interface StorageRoutingRuleEntity {
  readonly id: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly storageConnectionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertStorageRoutingRuleInput {
  readonly id: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly storageConnectionId: string;
  readonly actorUserId: string;
}

export interface StorageRoutingRuleRepositoryPort {
  findByOrganizationAndCategory(
    organizationId: string,
    categoryId: string | null,
    tx?: TransactionContext,
  ): Promise<StorageRoutingRuleEntity | null>;
  listByOrganization(organizationId: string): Promise<readonly StorageRoutingRuleEntity[]>;
  upsertRule(
    input: UpsertStorageRoutingRuleInput,
    tx?: TransactionContext,
  ): Promise<StorageRoutingRuleEntity>;
  deleteCategoryRule(
    organizationId: string,
    categoryId: string,
    tx?: TransactionContext,
  ): Promise<boolean>;
}
