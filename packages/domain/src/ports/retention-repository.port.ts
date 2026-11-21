import type {
  DocumentRetentionHoldEntity,
  RetentionAction,
  RetentionPolicyEntity,
} from "../retention/retention.types.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateRetentionPolicyInput {
  readonly id: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly retentionDays: number;
  readonly trashGraceDays: number;
  readonly actionOnExpiry: RetentionAction;
  readonly isActive: boolean;
  readonly createdBy: string;
}

export interface UpdateRetentionPolicyInput {
  readonly name?: string | undefined;
  readonly categoryId?: string | null | undefined;
  readonly retentionDays?: number | undefined;
  readonly trashGraceDays?: number | undefined;
  readonly actionOnExpiry?: RetentionAction | undefined;
  readonly isActive?: boolean | undefined;
  readonly updatedBy: string;
}

export interface RetentionPolicyRepositoryPort {
  listByOrganization(
    organizationId: string,
    tx?: TransactionContext,
  ): Promise<readonly RetentionPolicyEntity[]>;
  findById(policyId: string, tx?: TransactionContext): Promise<RetentionPolicyEntity | null>;
  findByName(
    organizationId: string,
    name: string,
    tx?: TransactionContext,
  ): Promise<RetentionPolicyEntity | null>;
  findApplicablePolicy(
    organizationId: string,
    categoryId: string,
    tx?: TransactionContext,
  ): Promise<RetentionPolicyEntity | null>;
  create(
    input: CreateRetentionPolicyInput,
    tx?: TransactionContext,
  ): Promise<RetentionPolicyEntity>;
  update(
    policyId: string,
    input: UpdateRetentionPolicyInput,
    tx?: TransactionContext,
  ): Promise<RetentionPolicyEntity | null>;
}

export interface CreateDocumentRetentionHoldInput {
  readonly id: string;
  readonly organizationId: string;
  readonly documentId: string;
  readonly reason: string;
  readonly placedByUserId: string;
  readonly placedAt: Date;
}

export interface ReleaseDocumentRetentionHoldInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly holdId: string;
  readonly releasedByUserId: string;
  readonly releasedAt: Date;
  readonly releaseReason: string;
}

export interface DocumentRetentionHoldRepositoryPort {
  listForDocument(
    organizationId: string,
    documentId: string,
    tx?: TransactionContext,
  ): Promise<readonly DocumentRetentionHoldEntity[]>;
  listActiveForDocument(
    organizationId: string,
    documentId: string,
    tx?: TransactionContext,
  ): Promise<readonly DocumentRetentionHoldEntity[]>;
  findById(holdId: string, tx?: TransactionContext): Promise<DocumentRetentionHoldEntity | null>;
  hasActiveHold(
    organizationId: string,
    documentId: string,
    tx?: TransactionContext,
  ): Promise<boolean>;
  findDocumentDeletedAt?(
    organizationId: string,
    documentId: string,
    tx?: TransactionContext,
  ): Promise<Date | null>;
  createHold(
    input: CreateDocumentRetentionHoldInput,
    tx?: TransactionContext,
  ): Promise<DocumentRetentionHoldEntity>;
  releaseHold(
    input: ReleaseDocumentRetentionHoldInput,
    tx?: TransactionContext,
  ): Promise<DocumentRetentionHoldEntity | null>;
}
