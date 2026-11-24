import { randomUUID } from "node:crypto";
import type {
  LoadedAuthorizationSubject,
  ReportRepository,
  RepositoryReportQueryInput,
  RepositoryReportRecord,
} from "@docuflow/database";
import {
  type AuditEventEntity,
  type AuditRepositoryPort,
  type CreateWorkflowDefinitionRecordInput,
  type CreateWorkflowTasksService,
  DomainError,
  type PublishWorkflowDefinitionVersionInput,
  type StartWorkflowService,
  type UpdateWorkflowDefinitionInput,
  type WorkflowDefinitionEntity,
  type WorkflowDefinitionRepositoryPort,
  type WorkflowDefinitionVersionEntity,
  createWorkflowDefinitionService,
} from "@docuflow/domain";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerReportRoutes } from "../src/modules/reports/index.js";
import { registerWorkflowRoutes } from "../src/modules/workflows/index.js";
import {
  type AuthenticatedAuthorizationContext,
  type DocumentAuthorizationGuard,
  buildRolePermissionsLookup,
  toSubjectContext,
} from "../src/plugins/authorization.js";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const ADMIN_USER_ID = "550e8400-e29b-41d4-a716-446655440001";
const REVIEWER_ROLE_ID = "550e8400-e29b-41d4-a716-446655440010";
const VIEWER_USER_ID = "550e8400-e29b-41d4-a716-446655440002";
const VIEWER_ROLE_ID = "550e8400-e29b-41d4-a716-446655440011";
const ALLOWED_CATEGORY_ID = "550e8400-e29b-41d4-a716-446655440020";

function buildAuthContext(
  userId: string,
  roleId: string,
  roleKey: string,
  permissions: LoadedAuthorizationSubject["rolePermissions"],
  scope: LoadedAuthorizationSubject["assignments"][number]["scope"] = { type: "GLOBAL" },
): AuthenticatedAuthorizationContext {
  const loaded: LoadedAuthorizationSubject = {
    userId,
    organizationId: ORG_ID,
    groupIds: [],
    assignments: [
      {
        roleId,
        roleKey,
        scope,
        effect: "ALLOW",
        source: "USER",
      },
    ],
    rolePermissions: permissions,
  };

  return {
    me: {
      user: {
        id: userId,
        organizationId: ORG_ID,
        email: `${roleKey}@docuflow.invalid`,
        fullName: `Usuário ${roleKey}`,
        status: "ACTIVE",
        createdAt: "2026-11-24T10:00:00.000Z",
        updatedAt: "2026-11-24T10:00:00.000Z",
      },
      groups: [],
      roles: [],
      permissions: [],
    },
    loaded,
    subject: toSubjectContext(loaded),
    rolePermissions: buildRolePermissionsLookup(loaded),
  };
}

function createStaticGuard(ctx: AuthenticatedAuthorizationContext): DocumentAuthorizationGuard {
  return {
    async requireSubject() {
      return ctx;
    },
    async authorizeCreateScope() {
      return true;
    },
    async authorizeUploadScope() {
      return true;
    },
    async authorizeDocument() {
      return null;
    },
  };
}

function createMemoryWorkflowDefinitionRepository(): WorkflowDefinitionRepositoryPort {
  const definitions = new Map<string, WorkflowDefinitionEntity>();
  const versions = new Map<string, WorkflowDefinitionVersionEntity[]>();

  return {
    async findById(id: string) {
      return definitions.get(id) ?? null;
    },
    async findByName(organizationId: string, name: string) {
      const normalized = name.toLowerCase();
      for (const def of definitions.values()) {
        if (def.organizationId === organizationId && def.name.toLowerCase() === normalized) {
          return def;
        }
      }
      return null;
    },
    async listByOrganization(organizationId: string, options) {
      return Array.from(definitions.values()).filter(
        (item) =>
          item.organizationId === organizationId && (options?.activeOnly ? item.isActive : true),
      );
    },
    async findVersionById(versionId: string) {
      for (const list of versions.values()) {
        const found = list.find((item) => item.id === versionId);
        if (found) {
          return found;
        }
      }
      return null;
    },
    async findVersionByNumber(workflowDefinitionId: string, versionNumber: number) {
      return (
        (versions.get(workflowDefinitionId) ?? []).find(
          (item) => item.versionNumber === versionNumber,
        ) ?? null
      );
    },
    async listVersions(workflowDefinitionId: string) {
      return [...(versions.get(workflowDefinitionId) ?? [])].sort(
        (a, b) => b.versionNumber - a.versionNumber,
      );
    },
    async createWithInitialVersion(input: CreateWorkflowDefinitionRecordInput) {
      const now = new Date("2026-11-24T12:00:00.000Z");
      const definition: WorkflowDefinitionEntity = {
        id: input.definitionId,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        isActive: true,
        latestVersionNumber: 1,
        createdByUserId: input.createdByUserId,
        createdAt: now,
        updatedAt: now,
      };
      const version: WorkflowDefinitionVersionEntity = {
        id: input.versionId,
        workflowDefinitionId: input.definitionId,
        versionNumber: 1,
        steps: [...input.steps],
        createdByUserId: input.createdByUserId,
        createdAt: now,
      };
      definitions.set(definition.id, definition);
      versions.set(definition.id, [version]);
      return { definition, version };
    },
    async publishNewVersion(input: PublishWorkflowDefinitionVersionInput) {
      const existing = definitions.get(input.workflowDefinitionId);
      if (!existing || existing.latestVersionNumber !== input.expectedLatestVersionNumber) {
        return null;
      }
      const nextVersionNumber = existing.latestVersionNumber + 1;
      const now = new Date("2026-11-24T12:05:00.000Z");
      const updated: WorkflowDefinitionEntity = {
        ...existing,
        latestVersionNumber: nextVersionNumber,
        updatedAt: now,
      };
      const version: WorkflowDefinitionVersionEntity = {
        id: input.versionId,
        workflowDefinitionId: existing.id,
        versionNumber: nextVersionNumber,
        steps: [...input.steps],
        createdByUserId: input.createdByUserId,
        createdAt: now,
      };
      definitions.set(existing.id, updated);
      versions.set(existing.id, [...(versions.get(existing.id) ?? []), version]);
      return { definition: updated, version };
    },
    async updateMetadata(input: UpdateWorkflowDefinitionInput) {
      const existing = definitions.get(input.workflowDefinitionId);
      if (!existing) {
        return null;
      }
      const updated: WorkflowDefinitionEntity = {
        ...existing,
        isActive: input.isActive ?? existing.isActive,
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        updatedAt: new Date("2026-11-24T12:10:00.000Z"),
      };
      definitions.set(existing.id, updated);
      return updated;
    },
  };
}

function createMemoryAuditRepository(): {
  readonly repository: AuditRepositoryPort;
  readonly events: AuditEventEntity[];
} {
  const events: AuditEventEntity[] = [];
  const repository: AuditRepositoryPort = {
    async append(input) {
      const event: AuditEventEntity = {
        id: `audit-${events.length + 1}`,
        organizationId: input.organizationId,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        result: input.result,
        requestId: input.requestId ?? null,
        ipAddress: input.ipAddress ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date("2026-11-24T12:15:00.000Z"),
      };
      events.push(event);
      return event;
    },
    async listByOrganization() {
      return {
        items: events,
        page: 1,
        pageSize: 20,
        total: events.length,
      };
    },
  };
  return { repository, events };
}

describe("Workflow definition and repository report routes", () => {
  it("manages versioned workflow definitions and enforces WORKFLOW RBAC", async () => {
    const repo = createMemoryWorkflowDefinitionRepository();
    const audit = createMemoryAuditRepository();
    const workflowDefinitionService = createWorkflowDefinitionService({
      definitions: repo,
      transactions: {
        async runInTransaction(work) {
          return work({});
        },
      },
      audit: audit.repository,
      generateId: () => randomUUID(),
      validateAssigneeTarget: async (_orgId, assignee) => {
        if (assignee.type === "USER" && assignee.userId === ADMIN_USER_ID) {
          return;
        }
        if (assignee.type === "ROLE" && assignee.roleId === REVIEWER_ROLE_ID) {
          return;
        }
        throw new DomainError("WORKFLOW_ASSIGNEE_NOT_FOUND", "Aprovador não encontrado.");
      },
    });

    const adminCtx = buildAuthContext(ADMIN_USER_ID, REVIEWER_ROLE_ID, "admin", [
      { roleId: REVIEWER_ROLE_ID, roleKey: "admin", action: "READ", resource: "WORKFLOW" },
      { roleId: REVIEWER_ROLE_ID, roleKey: "admin", action: "CREATE", resource: "WORKFLOW" },
      { roleId: REVIEWER_ROLE_ID, roleKey: "admin", action: "UPDATE", resource: "WORKFLOW" },
    ]);

    const unusedStartWorkflow: StartWorkflowService = {
      async startWorkflow() {
        throw new Error("Unused in test");
      },
    };
    const unusedCreateTasks: CreateWorkflowTasksService = {
      async generateTaskForStep() {
        throw new Error("Unused in test");
      },
    };

    const app = Fastify({ logger: false });
    await registerWorkflowRoutes(app, {
      guard: createStaticGuard(adminCtx),
      workflowDefinitionRepository: repo,
      workflowDefinitionService,
      assigneeCatalog: {
        async listCatalog() {
          return {
            users: [
              {
                id: ADMIN_USER_ID,
                fullName: "Administrador DocuFlow",
                email: "admin@docuflow.invalid",
              },
            ],
            groups: [],
            roles: [{ id: REVIEWER_ROLE_ID, key: "reviewer", name: "Revisor" }],
          };
        },
      },
      startWorkflowService: unusedStartWorkflow,
      createWorkflowTasksService: unusedCreateTasks,
    });

    const assigneesRes = await app.inject({ method: "GET", url: "/api/v1/workflows/assignees" });
    expect(assigneesRes.statusCode).toBe(200);
    expect(assigneesRes.json().data.roles).toHaveLength(1);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/definitions",
      payload: {
        name: "Aprovação Jurídica",
        description: "Revisão sequencial obrigatória.",
        steps: [
          {
            stepOrder: 1,
            name: "Revisão técnica",
            assignee: { type: "ROLE", roleId: REVIEWER_ROLE_ID },
            dueDays: 3,
          },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdId = createRes.json().data.definition.id as string;
    expect(createRes.json().data.version.versionNumber).toBe(1);

    const versionRes = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/definitions/${createdId}/versions`,
      payload: {
        steps: [
          {
            stepOrder: 1,
            name: "Revisão técnica",
            assignee: { type: "ROLE", roleId: REVIEWER_ROLE_ID },
            dueDays: 2,
          },
          {
            stepOrder: 2,
            name: "Aprovação final",
            assignee: { type: "USER", userId: ADMIN_USER_ID },
            dueDays: 5,
          },
        ],
      },
    });
    expect(versionRes.statusCode).toBe(201);
    expect(versionRes.json().data.version.versionNumber).toBe(2);

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/v1/workflows/definitions/${createdId}`,
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().data.versions).toHaveLength(2);
    expect(detailRes.json().data.versions[0].versionNumber).toBe(2);

    const deactivateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/workflows/definitions/${createdId}/status`,
      payload: { isActive: false },
    });
    expect(deactivateRes.statusCode).toBe(200);
    expect(deactivateRes.json().data.isActive).toBe(false);

    const activeOnlyList = await app.inject({
      method: "GET",
      url: "/api/v1/workflows/definitions",
    });
    expect(activeOnlyList.json().data).toHaveLength(0);

    const allList = await app.inject({
      method: "GET",
      url: "/api/v1/workflows/definitions?includeInactive=true",
    });
    expect(allList.json().data).toHaveLength(1);
    await app.close();

    // Verify 403 enforcement for user without WORKFLOW permissions
    const viewerCtx = buildAuthContext(VIEWER_USER_ID, VIEWER_ROLE_ID, "viewer", [
      { roleId: VIEWER_ROLE_ID, roleKey: "viewer", action: "READ", resource: "DOCUMENT" },
    ]);
    const viewerApp = Fastify({ logger: false });
    await registerWorkflowRoutes(viewerApp, {
      guard: createStaticGuard(viewerCtx),
      workflowDefinitionRepository: repo,
      workflowDefinitionService,
      assigneeCatalog: {
        async listCatalog() {
          return { users: [], groups: [], roles: [] };
        },
      },
      startWorkflowService: unusedStartWorkflow,
      createWorkflowTasksService: unusedCreateTasks,
    });

    const forbiddenCreate = await viewerApp.inject({
      method: "POST",
      url: "/api/v1/workflows/definitions",
      payload: {
        name: "Sem permissão",
        steps: [
          {
            stepOrder: 1,
            name: "Etapa",
            assignee: { type: "USER", userId: ADMIN_USER_ID },
          },
        ],
      },
    });
    expect(forbiddenCreate.statusCode).toBe(403);

    const forbiddenAssignees = await viewerApp.inject({
      method: "GET",
      url: "/api/v1/workflows/assignees",
    });
    expect(forbiddenAssignees.statusCode).toBe(403);
    await viewerApp.close();
  });

  it("scopes repository reports by server-side authorization, neutralizes CSV formulas, and audits export", async () => {
    const capturedQueries: RepositoryReportQueryInput[] = [];
    const sampleReport: RepositoryReportRecord = {
      generatedAt: "2026-11-24T12:15:00.000Z",
      timezone: "America/Sao_Paulo",
      totals: {
        totalDocuments: 4,
        totalVersions: 7,
        totalActiveFiles: 7,
        storageUsedBytes: 204800,
        quarantinedFiles: 1,
        pendingTasks: 2,
      },
      expirations: {
        expired: 1,
        expiringSoon: 1,
        onTrack: 1,
        withoutDate: 1,
        windowDays: 30,
      },
      byStatus: [{ status: "APPROVED", documentCount: 4, storageBytes: 204800 }],
      byCategory: [
        {
          categoryId: ALLOWED_CATEGORY_ID,
          categoryName: "=SUM(A1:A2)",
          documentCount: 4,
          versionCount: 7,
          storageBytes: 204800,
          expiredCount: 1,
          expiringSoonCount: 1,
        },
      ],
      byStorageConnection: [
        {
          storageConnectionId: "550e8400-e29b-41d4-a716-446655440099",
          storageConnectionName: "Local Padrão",
          kind: "local",
          fileCount: 7,
          storageBytes: 204800,
        },
      ],
    };

    const reportRepository: ReportRepository = {
      async getAuthorizedRepositoryReport(input) {
        capturedQueries.push(input);
        return sampleReport;
      },
    };
    const audit = createMemoryAuditRepository();
    const scopedCtx = buildAuthContext(
      VIEWER_USER_ID,
      VIEWER_ROLE_ID,
      "viewer",
      [{ roleId: VIEWER_ROLE_ID, roleKey: "viewer", action: "READ", resource: "DOCUMENT" }],
      { type: "CATEGORY", categoryId: ALLOWED_CATEGORY_ID },
    );

    const app = Fastify({ logger: false });
    await registerReportRoutes(app, {
      guard: createStaticGuard(scopedCtx),
      reportRepository,
      auditRepository: audit.repository,
      now: () => new Date("2026-11-24T12:15:00.000Z"),
    });

    const overviewRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/overview?expirationWindowDays=60&status=APPROVED",
    });
    expect(overviewRes.statusCode).toBe(200);
    expect(overviewRes.headers["cache-control"]).toContain("no-store");
    expect(capturedQueries[0]?.scope.hasGlobalAllow).toBe(false);
    expect(capturedQueries[0]?.scope.allowedCategoryIds).toEqual([ALLOWED_CATEGORY_ID]);
    expect(capturedQueries[0]?.expirationWindowDays).toBe(60);
    expect(capturedQueries[0]?.status).toBe("APPROVED");

    const invalidRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/overview?expirationWindowDays=9999",
    });
    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.json().error.code).toBe("VALIDATION_ERROR");

    const csvRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/export.csv?expirationWindowDays=30",
    });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers["content-type"]).toContain("text/csv");
    expect(csvRes.headers["content-disposition"]).toContain("docuflow-relatorio-acervo.csv");
    expect(csvRes.body).toContain("CATEGORIA,'=SUM(A1:A2),4,7,1,1,,204800");
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.action).toBe("REPORT_EXPORTED");
    expect(audit.events[0]?.resourceType).toBe("REPORT");

    await app.close();
  });
});
