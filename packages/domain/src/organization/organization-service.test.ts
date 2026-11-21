import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DomainError } from "../index.js";
import type { AuditEventInput, AuditEventRecord } from "../ports/audit-repository.port.js";
import type { OrganizationRepositoryPort } from "../ports/organization-repository.port.js";
import type { TransactionContext, TransactionManagerPort } from "../ports/transaction.port.js";
import { createOrganizationService } from "./organization-service.js";
import { DEFAULT_ORGANIZATION_PREFERENCES, type OrganizationEntity } from "./organization.types.js";

function createOrgHarness() {
  let org: OrganizationEntity | null = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Acme Documentos",
    slug: "acme-documentos",
    defaultLanguage: "pt-BR",
    timezone: "America/Sao_Paulo",
    logoObjectKey: null,
    preferences: { ...DEFAULT_ORGANIZATION_PREFERENCES },
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
  };

  const audits: AuditEventInput[] = [];
  const transactions: TransactionManagerPort = {
    async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({} as TransactionContext);
    },
  };

  const organizations: OrganizationRepositoryPort = {
    async findById(organizationId) {
      return org && org.id === organizationId ? org : null;
    },
    async updateSettings(organizationId, input) {
      if (!org || org.id !== organizationId) {
        return null;
      }
      org = {
        ...org,
        name: input.name ?? org.name,
        defaultLanguage: input.defaultLanguage ?? org.defaultLanguage,
        timezone: input.timezone ?? org.timezone,
        preferences: input.preferences ?? org.preferences,
        updatedAt: input.updatedAt.toISOString(),
      };
      return org;
    },
  };

  const service = createOrganizationService({
    organizations,
    transactions,
    audit: {
      async append(event): Promise<AuditEventRecord> {
        audits.push(event);
        return {
          ...event,
          id: `audit-${audits.length}`,
          occurredAt: "2026-02-01T12:00:00.000Z",
        };
      },
      async list() {
        return { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
      },
    },
    now: () => new Date("2026-02-01T12:00:00.000Z"),
  });

  return { service, audits };
}

describe("createOrganizationService", () => {
  it("updates allowed organization details and preferences with audit trail", async () => {
    const { service, audits } = createOrgHarness();

    const updated = await service.updateOrganization({
      organizationId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "22222222-2222-4222-8222-222222222222",
      requestId: "req-org-1",
      name: "  Acme Brasil Ltda  ",
      defaultLanguage: "en-US",
      timezone: "America/Manaus",
      preferences: {
        defaultExpirationWindowDays: 45,
        auditDocumentViews: false,
      },
    });

    assert.equal(updated.name, "Acme Brasil Ltda");
    assert.equal(updated.defaultLanguage, "en-US");
    assert.equal(updated.timezone, "America/Manaus");
    assert.equal(updated.preferences.defaultExpirationWindowDays, 45);
    assert.equal(updated.preferences.auditDocumentViews, false);
    assert.equal(updated.preferences.auditDocumentDownloads, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, "ORGANIZATION_SETTINGS_UPDATED");
  });

  it("rejects invalid IANA timezones and invalid preference bounds", async () => {
    const { service } = createOrgHarness();

    await assert.rejects(
      () =>
        service.updateOrganization({
          organizationId: "11111111-1111-4111-8111-111111111111",
          actorUserId: "22222222-2222-4222-8222-222222222222",
          requestId: "req-org-2",
          timezone: "Invalid/Zone_Test",
        }),
      (err: unknown) => err instanceof DomainError && err.code === "INVALID_TIMEZONE",
    );

    await assert.rejects(
      () =>
        service.updateOrganization({
          organizationId: "11111111-1111-4111-8111-111111111111",
          actorUserId: "22222222-2222-4222-8222-222222222222",
          requestId: "req-org-3",
          preferences: {
            trashGraceDays: 0,
          },
        }),
      (err: unknown) =>
        err instanceof DomainError && err.code === "INVALID_ORGANIZATION_PREFERENCE",
    );
  });
});
