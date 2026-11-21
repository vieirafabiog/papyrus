import { randomUUID } from "node:crypto";
import type {
  AuthorizationRepository,
  DashboardRepository,
  DocumentSearchRepository,
  TaskInboxRepository,
} from "@docuflow/database";
import type {
  ArchiveDocumentService,
  AuditRepositoryPort,
  CategoryFieldService,
  CategoryRepositoryPort,
  CategoryService,
  CreateDocumentService,
  CreateDocumentVersionService,
  DecideTaskService,
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
  FolderRepositoryPort,
  FolderService,
  GroupAdministrationService,
  MoveDocumentService,
  PermissionAdministrationService,
  StorageConnectionAdminService,
  StorageConnectionRepositoryPort,
  TagService,
  TrashDocumentService,
  UploadSessionRepositoryPort,
  UploadSessionService,
  UserAdministrationService,
} from "@docuflow/domain";
import type { InAppNotificationService } from "@docuflow/notifications";
import type { StorageProviderRegistry } from "@docuflow/storage-core";
import type { S3EndpointSecurityPolicy } from "@docuflow/storage-s3";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPermissionRoutes } from "./modules/access/permissions.routes.js";
import { registerAuditRoutes } from "./modules/audit/audit.routes.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import type { AuthService } from "./modules/auth/auth.service.js";
import { registerCategoryRoutes } from "./modules/categories/categories.routes.js";
import { registerDashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { registerDocumentRoutes } from "./modules/documents/documents.routes.js";
import { registerDocumentDownloadRoutes } from "./modules/documents/download.routes.js";
import { registerDocumentPreviewRoutes } from "./modules/documents/preview.routes.js";
import { registerDocumentSearchRoutes } from "./modules/documents/search.routes.js";
import { registerFolderRoutes } from "./modules/folders/folders.routes.js";
import { registerGroupRoutes } from "./modules/groups/groups.routes.js";
import { registerNotificationRoutes } from "./modules/notifications/index.js";
import { registerSetupRoutes } from "./modules/setup/setup.routes.js";
import type { SetupService } from "./modules/setup/setup.service.js";
import { registerStorageRoutes } from "./modules/storage/storage.routes.js";
import { registerTagRoutes } from "./modules/tags/tags.routes.js";
import { registerTaskRoutes } from "./modules/tasks/index.js";
import {
  type LocalStreamUploadDependencies,
  type StorageUploadDependencies,
  registerUploadRoutes,
} from "./modules/uploads/upload.routes.js";
import { registerUserRoutes } from "./modules/users/users.routes.js";
import {
  createCategoryAuthorizationGuard,
  createDocumentAuthorizationGuard,
  createFolderAuthorizationGuard,
} from "./plugins/authorization.js";
import { type SecurityPluginOptions, registerSecurityPlugin } from "./plugins/security.js";

export interface AppOptions {
  readonly logger?: boolean | undefined;
  readonly authService?: AuthService | undefined;
  readonly setupService?: SetupService | undefined;
  readonly userAdminService?: UserAdministrationService | undefined;
  readonly groupAdminService?: GroupAdministrationService | undefined;
  readonly permissionAdminService?: PermissionAdministrationService | undefined;
  readonly storageAdminService?: StorageConnectionAdminService | undefined;
  readonly auditRepository?: AuditRepositoryPort | undefined;
  readonly s3SecurityPolicy?: S3EndpointSecurityPolicy | undefined;
  readonly documentDeps?:
    | {
        readonly authzRepository: AuthorizationRepository;
        readonly documentRepository: DocumentRepositoryPort;
        readonly auditRepository: AuditRepositoryPort;
        readonly documentSearchRepository?: DocumentSearchRepository | undefined;
        readonly categoryRepository?: CategoryRepositoryPort | undefined;
        readonly createDocumentService?: CreateDocumentService | undefined;
        readonly createDocumentVersionService?: CreateDocumentVersionService | undefined;
        readonly moveDocumentService?: MoveDocumentService | undefined;
        readonly archiveDocumentService?: ArchiveDocumentService | undefined;
        readonly trashDocumentService?: TrashDocumentService | undefined;
        readonly documentVersionRepository?: DocumentVersionRepositoryPort | undefined;
        readonly uploadRepository?: UploadSessionRepositoryPort | undefined;
        readonly storageConnections?: StorageConnectionRepositoryPort | undefined;
        readonly storageRegistry?: StorageProviderRegistry | undefined;
        readonly dashboardRepository?: DashboardRepository | undefined;
        readonly dashboardNow?: (() => Date) | undefined;
      }
    | undefined;
  readonly folderDeps?:
    | {
        readonly authzRepository: AuthorizationRepository;
        readonly folderRepository: FolderRepositoryPort;
        readonly folderService: FolderService;
      }
    | undefined;
  readonly categoryDeps?:
    | {
        readonly authzRepository: AuthorizationRepository;
        readonly categoryRepository: CategoryRepositoryPort;
        readonly categoryService: CategoryService;
        readonly categoryFieldService: CategoryFieldService;
      }
    | undefined;
  readonly tagDeps?:
    | {
        readonly authzRepository: AuthorizationRepository;
        readonly documentRepository: DocumentRepositoryPort;
        readonly tagService: TagService;
      }
    | undefined;
  readonly uploadDeps?:
    | {
        readonly authzRepository: AuthorizationRepository;
        readonly documentRepository: DocumentRepositoryPort;
        readonly uploadRepository: UploadSessionRepositoryPort;
        readonly uploadSessionService: UploadSessionService;
        readonly storageUploadDeps?: StorageUploadDependencies | undefined;
        readonly localUploadDeps?: LocalStreamUploadDependencies | undefined;
      }
    | undefined;
  readonly taskDeps?:
    | {
        readonly authzRepository: AuthorizationRepository;
        readonly documentRepository: DocumentRepositoryPort;
        readonly taskInboxRepository: TaskInboxRepository;
        readonly decideTaskService?: DecideTaskService | undefined;
        readonly now?: (() => Date) | undefined;
      }
    | undefined;
  readonly auditDeps?:
    | {
        readonly authzRepository: AuthorizationRepository;
        readonly auditRepository: AuditRepositoryPort;
        readonly now?: (() => Date) | undefined;
      }
    | undefined;
  readonly notificationService?: InAppNotificationService | undefined;
  readonly secureCookies?: boolean | undefined;
  readonly security?: Partial<SecurityPluginOptions> | undefined;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers['set-cookie']",
              "*.password",
              "*.passwordHash",
              "*.accessKeyId",
              "*.secretAccessKey",
              "*.sessionToken",
              "*.encryptedSecretRef",
              "*.encryptedSecretPayload",
            ],
            censor: "[REDACTED]",
          },
        }
      : false,
    genReqId: () => randomUUID(),
  });

  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === "production";

  void app.register(cookie);
  app.after(() => {
    void registerSecurityPlugin(app, {
      allowedOrigins: options.security?.allowedOrigins ?? ["http://localhost:5173"],
      secureCookies,
      enforceCsrf: options.security?.enforceCsrf,
      loginRateLimit: options.security?.loginRateLimit,
      now: options.security?.now,
    });
  });

  app.get("/api/v1/health/live", async () => {
    return { status: "ok" };
  });

  if (options.setupService) {
    const setupService = options.setupService;
    void app.register(async (instance) => {
      await registerSetupRoutes(instance, setupService);
    });
  }

  if (options.authService) {
    const authService = options.authService;
    void app.register(async (instance) => {
      await registerAuthRoutes(instance, { authService, secureCookies });
    });

    if (options.userAdminService) {
      const userAdminService = options.userAdminService;
      void app.register(async (instance) => {
        await registerUserRoutes(instance, { authService, userAdminService });
      });
    }

    if (options.groupAdminService) {
      const groupAdminService = options.groupAdminService;
      void app.register(async (instance) => {
        await registerGroupRoutes(instance, { authService, groupAdminService });
      });
    }

    if (options.permissionAdminService) {
      const permissionAdminService = options.permissionAdminService;
      void app.register(async (instance) => {
        await registerPermissionRoutes(instance, { authService, permissionAdminService });
      });
    }

    if (options.storageAdminService) {
      const storageAdminService = options.storageAdminService;
      const s3SecurityPolicy = options.s3SecurityPolicy;
      void app.register(async (instance) => {
        await registerStorageRoutes(instance, {
          authService,
          storageAdminService,
          s3SecurityPolicy,
        });
      });
    }

    if (options.documentDeps) {
      const documentDeps = options.documentDeps;
      const guard = createDocumentAuthorizationGuard({
        authService,
        authzRepository: documentDeps.authzRepository,
        documentRepository: documentDeps.documentRepository,
        auditRepository: documentDeps.auditRepository,
      });
      void app.register(async (instance) => {
        if (documentDeps.documentSearchRepository) {
          await registerDocumentSearchRoutes(instance, {
            guard,
            documentSearchRepository: documentDeps.documentSearchRepository,
          });
        }
        if (documentDeps.dashboardRepository) {
          await registerDashboardRoutes(instance, {
            guard,
            dashboardRepository: documentDeps.dashboardRepository,
            now: documentDeps.dashboardNow,
          });
        }
        if (
          documentDeps.documentVersionRepository &&
          documentDeps.uploadRepository &&
          documentDeps.storageConnections &&
          documentDeps.storageRegistry
        ) {
          await registerDocumentDownloadRoutes(instance, {
            guard,
            documentVersionRepository: documentDeps.documentVersionRepository,
            uploadRepository: documentDeps.uploadRepository,
            storageConnections: documentDeps.storageConnections,
            storageRegistry: documentDeps.storageRegistry,
            auditRepository: documentDeps.auditRepository,
          });
          await registerDocumentPreviewRoutes(instance, {
            guard,
            documentVersionRepository: documentDeps.documentVersionRepository,
            uploadRepository: documentDeps.uploadRepository,
            storageConnections: documentDeps.storageConnections,
            storageRegistry: documentDeps.storageRegistry,
            auditRepository: documentDeps.auditRepository,
          });
        }
        await registerDocumentRoutes(instance, {
          guard,
          authzRepository: documentDeps.authzRepository,
          documentRepository: documentDeps.documentRepository,
          auditRepository: documentDeps.auditRepository,
          categoryRepository: documentDeps.categoryRepository,
          createDocumentService: documentDeps.createDocumentService,
          createDocumentVersionService: documentDeps.createDocumentVersionService,
          moveDocumentService: documentDeps.moveDocumentService,
          archiveDocumentService: documentDeps.archiveDocumentService,
          trashDocumentService: documentDeps.trashDocumentService,
        });
      });
    }

    if (options.uploadDeps) {
      const uploadDeps = options.uploadDeps;
      const uploadGuard = createDocumentAuthorizationGuard({
        authService,
        authzRepository: uploadDeps.authzRepository,
        documentRepository: uploadDeps.documentRepository,
        auditRepository: options.auditRepository ?? options.documentDeps?.auditRepository,
      });
      void app.register(async (instance) => {
        await registerUploadRoutes(instance, {
          guard: uploadGuard,
          uploadSessionService: uploadDeps.uploadSessionService,
          uploadRepository: uploadDeps.uploadRepository,
          storageUploadDeps: uploadDeps.storageUploadDeps,
          localUploadDeps: uploadDeps.localUploadDeps,
        });
      });
    }

    if (options.folderDeps) {
      const folderDeps = options.folderDeps;
      const folderGuard = createFolderAuthorizationGuard({
        authService,
        authzRepository: folderDeps.authzRepository,
        folderRepository: folderDeps.folderRepository,
        auditRepository: options.auditRepository ?? options.documentDeps?.auditRepository,
      });
      void app.register(async (instance) => {
        await registerFolderRoutes(instance, {
          guard: folderGuard,
          folderService: folderDeps.folderService,
        });
      });
    }

    if (options.categoryDeps) {
      const categoryDeps = options.categoryDeps;
      const categoryGuard = createCategoryAuthorizationGuard({
        authService,
        authzRepository: categoryDeps.authzRepository,
        categoryRepository: categoryDeps.categoryRepository,
        auditRepository: options.auditRepository ?? options.documentDeps?.auditRepository,
      });
      void app.register(async (instance) => {
        await registerCategoryRoutes(instance, {
          guard: categoryGuard,
          categoryService: categoryDeps.categoryService,
          categoryFieldService: categoryDeps.categoryFieldService,
        });
      });
    }

    if (options.tagDeps) {
      const tagDeps = options.tagDeps;
      const tagDocGuard = createDocumentAuthorizationGuard({
        authService,
        authzRepository: tagDeps.authzRepository,
        documentRepository: tagDeps.documentRepository,
      });
      void app.register(async (instance) => {
        await registerTagRoutes(instance, {
          documentGuard: tagDocGuard,
          tagService: tagDeps.tagService,
        });
      });
    }

    if (options.taskDeps) {
      const taskDeps = options.taskDeps;
      const taskGuard = createDocumentAuthorizationGuard({
        authService,
        authzRepository: taskDeps.authzRepository,
        documentRepository: taskDeps.documentRepository,
        auditRepository: options.auditRepository ?? options.documentDeps?.auditRepository,
      });
      void app.register(async (instance) => {
        await registerTaskRoutes(instance, {
          guard: taskGuard,
          taskInboxRepository: taskDeps.taskInboxRepository,
          decideTaskService: taskDeps.decideTaskService,
          now: taskDeps.now,
        });
      });
    }

    if (options.notificationService) {
      const notificationService = options.notificationService;
      void app.register(async (instance) => {
        await registerNotificationRoutes(instance, {
          authService,
          notificationService,
        });
      });
    }

    const resolvedAuditAuthzRepo =
      options.auditDeps?.authzRepository ?? options.documentDeps?.authzRepository;
    const resolvedAuditRepo =
      options.auditDeps?.auditRepository ??
      options.auditRepository ??
      options.documentDeps?.auditRepository;
    if (resolvedAuditAuthzRepo && resolvedAuditRepo) {
      const auditNow = options.auditDeps?.now;
      void app.register(async (instance) => {
        await registerAuditRoutes(instance, {
          authService,
          authzRepository: resolvedAuditAuthzRepo,
          auditRepository: resolvedAuditRepo,
          now: auditNow,
        });
      });
    }
  }

  return app;
}
