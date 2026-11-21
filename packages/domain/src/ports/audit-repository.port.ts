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
  readonly actorName?: string | null | undefined;
  readonly actorEmail?: string | null | undefined;
}

export type AuditSortField = "occurredAt" | "action" | "resourceType" | "result";

export interface AuditListFilter {
  readonly organizationId: string;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly result?: AuditResult | undefined;
  readonly occurredFrom?: Date | undefined;
  readonly occurredTo?: Date | undefined;
  readonly sortBy?: AuditSortField | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
  readonly page: number;
  readonly pageSize: number;
}

export interface AuditExportFilter {
  readonly organizationId: string;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly result?: AuditResult | undefined;
  readonly occurredFrom?: Date | undefined;
  readonly occurredTo?: Date | undefined;
  readonly sortBy?: AuditSortField | undefined;
  readonly sortDirection?: "asc" | "desc" | undefined;
  readonly limit: number;
}

export interface AuditActorSummary {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
}

export interface AuditFacetsRecord {
  readonly actors: readonly AuditActorSummary[];
  readonly actions: readonly string[];
  readonly resourceTypes: readonly string[];
}

export interface AuditRepositoryPort {
  append(event: AuditEventInput, tx?: TransactionContext): Promise<AuditEventRecord>;
  list(filter: AuditListFilter): Promise<PaginatedResult<AuditEventRecord>>;
  listForExport?(filter: AuditExportFilter): Promise<readonly AuditEventRecord[]>;
  listFacets?(organizationId: string): Promise<AuditFacetsRecord>;
}
