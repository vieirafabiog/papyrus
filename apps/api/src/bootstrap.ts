import { randomUUID } from "node:crypto";
import { createPasswordService, createSessionService } from "@papyrus/auth";
import {
  type DatabaseClient,
  createAuditRepository,
  createAuthLookupRepository,
  createAuthorizationRepository,
  createCategoryRepository,
  createDashboardRepository,
  createDatabaseClient,
  createDocumentExpirationRepository,
  createDocumentRepository,
  createDocumentRetentionHoldRepository,
  createDocumentSearchRepository,
  createDocumentTrashRepository,
  createDocumentVersionRepository,
  createFolderRepository,
  createGroupRepository,
  createInAppNotificationRepository,
  createOrganizationRepository,
  createOutboxRepository,
  createPermissionScopeRepository,
  createReportRepository,
  createRetentionPolicyRepository,
  createSessionStoreRepository,
  createStorageConnectionRepository,
  createStorageRoutingRuleRepository,
  createTagRepository,
  createTaskInboxRepository,
  createTransactionManager,
  createUploadPolicyRepository,
  createUploadSessionRepository,
  createUserRepository,
  createWorkflowAssigneeVerifier,
  createWorkflowDecisionRepository,
  createWorkflowDefinitionRepository,
  createWorkflowInstanceRepository,
  createWorkflowTaskRepository,
  createWorkflowTimelineRepository,
} from "@papyrus/database";
import {
  DOMAIN_DEFAULT_PROXY_MAX_BODY_BYTES,
  DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS,
  DOMAIN_DEFAULT_UPLOAD_MAX_BYTES,
  DOMAIN_MAX_SYSTEM_UPLOAD_BYTES,
  DOMAIN_MIN_UPLOAD_MAX_BYTES,
  DomainError,
  archiveDocumentUseCase,
  createCategoryFieldService,
  createCategoryService,
  createDecideTaskUseCase,
  createDocumentUseCase,
  createDocumentVersionUseCase,
  createFinalizeUploadService,
  createFolderService,
  createGroupAdministrationService,
  createOrganizationService,
  createPermissionAdministrationService,
  createRetentionGovernanceService,
  createStartWorkflowUseCase,
  createStorageConnectionAdminService,
  createStorageRouterService,
  createTagService,
  createUploadLimitsService,
  createUploadSessionService,
  createUserAdministrationService,
  createWorkflowDefinitionService,
  createWorkflowTasksUseCase,
  moveDocumentUseCase,
  restoreDocumentUseCase,
  trashDocumentUseCase,
} from "@papyrus/domain";
import { createInAppNotificationService } from "@papyrus/notifications";
import { createStorageSecretVault } from "@papyrus/storage-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildApp } from "./app.js";
import { createAuthService } from "./modules/auth/auth.service.js";
import { createDrizzleSetupRepository } from "./modules/setup/setup.repository.js";
import { createSetupService } from "./modules/setup/setup.service.js";
import { createStorageHealthTester } from "./modules/storage/storage-health.adapter.js";
import { createApiStorageProviderRegistry } from "./modules/storage/storage-provider.registry.js";

const standaloneApiEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  APP_URL: z.string().trim().url().default("http://localhost:8080"),
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL é obrigatória."),
  SESSION_SECRET: z.string().trim().min(32, "SESSION_SECRET deve ter pelo menos 32 caracteres."),
  ENCRYPTION_KEY: z.string().trim().min(32, "ENCRYPTION_KEY deve ter pelo menos 32 caracteres."),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(DOMAIN_MIN_UPLOAD_MAX_BYTES)
    .max(DOMAIN_MAX_SYSTEM_UPLOAD_BYTES)
    .default(DOMAIN_DEFAULT_UPLOAD_MAX_BYTES),
  PROXY_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(DOMAIN_MIN_UPLOAD_MAX_BYTES)
    .default(DOMAIN_DEFAULT_PROXY_MAX_BODY_BYTES),
  UPLOAD_ALLOWED_EXTENSIONS: z.string().optional(),
  WORKER_HEALTH_URL: z.string().trim().url().optional(),
});

export interface StandaloneApiRuntime {
  readonly app: FastifyInstance;
  readonly dbClient: DatabaseClient;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function parseAllowedExtensions(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim().length === 0) {
    return [...DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS];
  }
  const items = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
  return items.length > 0 ? items : [...DOMAIN_DEFAULT_UPLOAD_ALLOWED_EXTENSIONS];
}

function resolveAllowedOrigins(appUrl: string): readonly string[] {
  const origin = new URL(appUrl).origin;
  return [origin];
}

export function createStandaloneApiRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StandaloneApiRuntime {
  const config = standaloneApiEnvSchema.parse(env);
  const allowedExtensions = parseAllowedExtensions(config.UPLOAD_ALLOWED_EXTENSIONS);
  const secureCookies = new URL(config.APP_URL).protocol === "https:";
  const allowedOrigins = resolveAllowedOrigins(config.APP_URL);
  const workerHealthUrl = config.WORKER_HEALTH_URL ?? "http://worker:3001/health/ready";

  const dbClient = createDatabaseClient({
    connectionString: config.DATABASE_URL,
    applicationName: "papyrus-api",
  });

  const { db } = dbClient;
  const transactions = createTransactionManager(db);
  const auditRepository = createAuditRepository(db);
  const authzRepository = createAuthorizationRepository(db);
  const documentRepository = createDocumentRepository(db);
  const documentVersionRepository = createDocumentVersionRepository(db);
  const documentSearchRepository = createDocumentSearchRepository(db);
  const documentExpirationRepository = createDocumentExpirationRepository(db);
  const documentTrashRepository = createDocumentTrashRepository(db);
  const dashboardRepository = createDashboardRepository(db);
  const reportRepository = createReportRepository(db);
  const categoryRepository = createCategoryRepository(db);
  const folderRepository = createFolderRepository(db);
  const tagRepository = createTagRepository(db);
  const userRepository = createUserRepository(db);
  const groupRepository = createGroupRepository(db);
  const permissionScopeRepository = createPermissionScopeRepository(db);
  const uploadRepository = createUploadSessionRepository(db);
  const connectionRepository = createStorageConnectionRepository(db);
  const routingRuleRepository = createStorageRoutingRuleRepository(db);
  const outboxRepository = createOutboxRepository(db);
  const retentionPolicyRepository = createRetentionPolicyRepository(db);
  const retentionHoldRepository = createDocumentRetentionHoldRepository(db);
  const organizationRepository = createOrganizationRepository(db);
  const uploadPolicyRepository = createUploadPolicyRepository(db);
  const notificationRepository = createInAppNotificationRepository(db);
  const workflowDefinitionRepository = createWorkflowDefinitionRepository(db);
  const workflowInstanceRepository = createWorkflowInstanceRepository(db);
  const workflowTaskRepository = createWorkflowTaskRepository(db);
  const workflowDecisionRepository = createWorkflowDecisionRepository(db);
  const workflowTimelineRepository = createWorkflowTimelineRepository(db);
  const workflowAssigneeVerifier = createWorkflowAssigneeVerifier(db);
  const taskInboxRepository = createTaskInboxRepository(db);

  const secretVault = createStorageSecretVault({
    masterKey: config.ENCRYPTION_KEY,
  });

  const storageRegistry = createApiStorageProviderRegistry({
    secretVault,
    enableS3SignedTargets: true,
  });

  const passwordService = createPasswordService();
  const sessionService = createSessionService({
    store: createSessionStoreRepository(db),
  });

  const setupService = createSetupService({
    repository: createDrizzleSetupRepository(db),
    passwordService,
  });

  const authService = createAuthService({
    users: createAuthLookupRepository(db),
    passwordService,
    sessionService,
    audit: {
      async recordAuthEvent(event) {
        await auditRepository.append({
          organizationId: event.organizationId,
          actorUserId: event.actorUserId,
          action: event.action,
          resourceType: "SESSION",
          resourceId: event.actorUserId,
          result: event.result,
          requestId: event.requestId,
        });
      },
    },
  });

  const storageRouterService = createStorageRouterService({
    connections: connectionRepository,
    routingRules: routingRuleRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const storageAdminService = createStorageConnectionAdminService({
    connections: connectionRepository,
    transactions,
    audit: auditRepository,
    healthTester: createStorageHealthTester({ secretVault }),
    secretEncryptor: {
      encrypt: (credentials) => secretVault.encryptCredentials(credentials),
    },
    generateId: () => randomUUID(),
  });

  const uploadLimitsService = createUploadLimitsService({
    repository: uploadPolicyRepository,
    transactions,
    audit: auditRepository,
    systemMaxUploadBytes: config.UPLOAD_MAX_BYTES,
    proxyMaxBodyBytes: config.PROXY_MAX_BODY_BYTES,
    defaultAllowedExtensions: allowedExtensions,
  });

  const uploadSessionService = createUploadSessionService({
    uploads: uploadRepository,
    documents: documentRepository,
    storageRouter: storageRouterService,
    transactions,
    audit: auditRepository,
    maxUploadBytes: config.UPLOAD_MAX_BYTES,
    resolveUploadPolicy: (organizationId) => uploadLimitsService.getEffectivePolicy(organizationId),
    generateId: () => randomUUID(),
  });

  const finalizeUploadService = createFinalizeUploadService({
    uploads: uploadRepository,
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    objectVerifier: {
      async verifyUploadedObject({ storageConnectionId, objectKey }) {
        const connection = await connectionRepository.findById(storageConnectionId);
        if (!connection) {
          return null;
        }
        const provider = await storageRegistry.resolveProvider(connection);
        const head = await provider.headObject({ value: objectKey });
        if (!head) {
          return null;
        }
        return {
          objectKey: head.key.value,
          contentLength: head.contentLength,
          contentType: head.contentType,
          checksumSha256: head.checksumSha256,
        };
      },
    },
    transactions,
    audit: auditRepository,
    processingQueue: outboxRepository.asUploadProcessingQueue(),
    generateId: () => randomUUID(),
  });

  const createDocumentService = createDocumentUseCase({
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    categories: categoryRepository,
    folders: folderRepository,
    users: userRepository,
    uploadSessions: uploadRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const createDocumentVersionService = createDocumentVersionUseCase({
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    uploadSessions: uploadRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const moveDocumentService = moveDocumentUseCase({
    documents: documentRepository,
    folders: folderRepository,
    transactions,
    audit: auditRepository,
  });

  const archiveDocumentService = archiveDocumentUseCase({
    documents: documentRepository,
    transactions,
    audit: auditRepository,
  });

  const trashDocumentService = trashDocumentUseCase({
    documents: documentRepository,
    transactions,
    audit: auditRepository,
  });

  const restoreDocumentService = restoreDocumentUseCase({
    documents: documentRepository,
    transactions,
    audit: auditRepository,
    policies: retentionPolicyRepository,
    holds: retentionHoldRepository,
  });

  const folderService = createFolderService({
    folders: folderRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const categoryService = createCategoryService({
    categories: categoryRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const categoryFieldService = createCategoryFieldService({
    categories: categoryRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const tagService = createTagService({
    tags: tagRepository,
    documents: documentRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const userAdminService = createUserAdministrationService({
    users: userRepository,
    transactions,
    audit: auditRepository,
    passwordHasher: {
      hashPassword: (plain) => passwordService.hashPassword(plain),
    },
    generateId: () => randomUUID(),
  });

  const groupAdminService = createGroupAdministrationService({
    groups: groupRepository,
    users: userRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const permissionAdminService = createPermissionAdministrationService({
    permissionScopes: permissionScopeRepository,
    users: userRepository,
    groups: groupRepository,
    documents: documentRepository,
    folders: folderRepository,
    categories: categoryRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const workflowDefinitionService = createWorkflowDefinitionService({
    definitions: workflowDefinitionRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
    validateAssigneeTarget: async (organizationId, assignee) => {
      if (assignee.type === "USER") {
        const user = await userRepository.findById(assignee.userId);
        if (!user || user.organizationId !== organizationId || user.status !== "ACTIVE") {
          throw new DomainError(
            "WORKFLOW_ASSIGNEE_NOT_FOUND",
            "O usuário aprovador selecionado não existe ou está inativo nesta organização.",
          );
        }
        return;
      }
      if (assignee.type === "GROUP") {
        const group = await groupRepository.findById(assignee.groupId);
        if (!group || group.organizationId !== organizationId) {
          throw new DomainError(
            "WORKFLOW_ASSIGNEE_NOT_FOUND",
            "O grupo aprovador selecionado não existe nesta organização.",
          );
        }
        return;
      }
      const role = await permissionScopeRepository.findRoleById(organizationId, assignee.roleId);
      if (!role) {
        throw new DomainError(
          "WORKFLOW_ASSIGNEE_NOT_FOUND",
          "O papel aprovador selecionado não existe nesta organização.",
        );
      }
    },
  });

  const startWorkflowService = createStartWorkflowUseCase({
    documents: documentRepository,
    documentVersions: documentVersionRepository,
    uploadSessions: uploadRepository,
    definitions: workflowDefinitionRepository,
    workflowInstances: workflowInstanceRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const createWorkflowTasksService = createWorkflowTasksUseCase({
    workflowInstances: workflowInstanceRepository,
    definitions: workflowDefinitionRepository,
    documents: documentRepository,
    tasks: workflowTaskRepository,
    transactions,
    audit: auditRepository,
    assigneeAuthorization: workflowAssigneeVerifier,
    generateId: () => randomUUID(),
  });

  const decideTaskService = createDecideTaskUseCase({
    tasks: workflowTaskRepository,
    decisions: workflowDecisionRepository,
    workflowInstances: workflowInstanceRepository,
    definitions: workflowDefinitionRepository,
    documents: documentRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const retentionService = createRetentionGovernanceService({
    policies: retentionPolicyRepository,
    holds: retentionHoldRepository,
    documents: documentRepository,
    categories: categoryRepository,
    transactions,
    audit: auditRepository,
    generateId: () => randomUUID(),
  });

  const organizationService = createOrganizationService({
    organizations: organizationRepository,
    transactions,
    audit: auditRepository,
  });

  const notificationService = createInAppNotificationService({
    repository: notificationRepository,
    generateId: () => randomUUID(),
  });

  const app = buildApp({
    logger: true,
    secureCookies,
    security: {
      allowedOrigins,
      enforceCsrf: true,
    },
    healthDeps: {
      checkDatabase: () => dbClient.checkHealth(),
      checkWorker: async () => {
        try {
          const response = await fetch(workerHealthUrl, {
            method: "GET",
            signal: AbortSignal.timeout(2_000),
          });
          if (response.ok) {
            return { healthy: true, message: "Worker operacional e pronto." };
          }
          return { healthy: false, message: "Worker reportou estado degradado." };
        } catch {
          return { healthy: false, message: "Worker indisponível no endpoint de saúde." };
        }
      },
      listStorageConnections: async (organizationId) => {
        const list = await connectionRepository.listByOrganization(organizationId);
        return list.map((conn) => ({
          id: conn.id,
          name: conn.name,
          kind: conn.kind,
          isDefault: conn.isDefault,
          status: conn.status,
          lastHealthCheckAt: conn.lastHealthCheckAt,
          lastHealthMessage: conn.lastHealthMessage,
        }));
      },
    },
    setupService,
    authService,
    userAdminService,
    groupAdminService,
    permissionAdminService,
    storageAdminService,
    storageRouterService,
    auditRepository,
    auditDeps: {
      authzRepository,
      auditRepository,
    },
    documentDeps: {
      authzRepository,
      documentRepository,
      auditRepository,
      documentSearchRepository,
      documentExpirationRepository,
      categoryRepository,
      createDocumentService,
      createDocumentVersionService,
      moveDocumentService,
      archiveDocumentService,
      trashDocumentService,
      restoreDocumentService,
      documentTrashRepository,
      documentVersionRepository,
      uploadRepository,
      storageConnections: connectionRepository,
      storageRegistry,
      dashboardRepository,
      reportRepository,
    },
    folderDeps: {
      authzRepository,
      folderRepository,
      folderService,
    },
    categoryDeps: {
      authzRepository,
      categoryRepository,
      categoryService,
      categoryFieldService,
    },
    tagDeps: {
      authzRepository,
      documentRepository,
      tagService,
    },
    uploadDeps: {
      authzRepository,
      documentRepository,
      uploadRepository,
      uploadSessionService,
      finalizeUploadService,
      storageUploadDeps: {
        connections: connectionRepository,
        storageRegistry,
        transactions,
        auditRepository,
        maxUploadBytes: config.UPLOAD_MAX_BYTES,
        proxyMaxBodyBytes: config.PROXY_MAX_BODY_BYTES,
        resolveUploadPolicy: (organizationId) =>
          uploadLimitsService.getEffectivePolicy(organizationId),
      },
    },
    taskDeps: {
      authzRepository,
      documentRepository,
      taskInboxRepository,
      decideTaskService,
      createWorkflowTasksService,
    },
    workflowDeps: {
      authzRepository,
      documentRepository,
      workflowDefinitionRepository,
      workflowDefinitionService,
      assigneeCatalog: {
        async listCatalog(organizationId) {
          const [orgUsers, orgGroups, orgRoles] = await Promise.all([
            userRepository.listByOrganization(organizationId),
            groupRepository.listByOrganization(organizationId),
            permissionScopeRepository.listRolesWithPermissions
              ? permissionScopeRepository.listRolesWithPermissions(organizationId)
              : Promise.resolve([]),
          ]);
          return {
            users: orgUsers
              .filter((user) => user.status === "ACTIVE")
              .map((user) => ({
                id: user.id,
                fullName: user.fullName,
                email: user.email,
              })),
            groups: orgGroups.map((group) => ({
              id: group.id,
              name: group.name,
            })),
            roles: orgRoles.map((role) => ({
              id: role.id,
              key: role.key,
              name: role.name,
            })),
          };
        },
      },
      workflowTimelineRepository,
      startWorkflowService,
      createWorkflowTasksService,
    },
    retentionDeps: {
      authzRepository,
      retentionService,
      documentRepository,
    },
    organizationDeps: {
      authzRepository,
      organizationService,
    },
    uploadLimitsDeps: {
      authzRepository,
      uploadLimitsService,
    },
    notificationService,
  });

  return {
    app,
    dbClient,
    host: config.HOST,
    port: config.PORT,
    async close(): Promise<void> {
      await app.close();
      await dbClient.close();
    },
  };
}
