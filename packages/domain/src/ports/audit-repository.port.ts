import type { PaginatedResult } from "./document-repository.port.js";
import type { TransactionContext } from "./transaction.port.js";

export type AuditResult = "SUCCESS" | "DENIED" | "FAILURE";

export type AuditMetadataValue = string | number | boolean | null;

export interface AuditEventInput {
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly result: AuditResult;
  readonly requestId: string;
  readonly ipAddress?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, AuditMetadataValue>> | undefined;
}

export interface AuditEventRecord extends AuditEventInput {
  readonly id: string;
  readonly occurredAt: string;
}

export interface AuditListFilter {
  readonly organizationId: string;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

export interface AuditRepositoryPort {
  append(event: AuditEventInput, tx?: TransactionContext): Promise<AuditEventRecord>;
  list(filter: AuditListFilter): Promise<PaginatedResult<AuditEventRecord>>;
}
