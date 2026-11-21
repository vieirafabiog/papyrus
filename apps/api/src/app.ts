import { randomUUID } from "node:crypto";
import type { AuthorizationRepository } from "@docuflow/database";
import type {
  ArchiveDocumentService,
  AuditRepositoryPort,
  CategoryFieldService,
  CategoryRepositoryPort,
  CategoryService,
  CreateDocumentService,
  CreateDocumentVersionService,
  DocumentRepositoryPort,
  FolderRepositoryPort,
  FolderService,
  GroupAdministrationService,
  MoveDocumentService,
  StorageConnectionAdminService,
  TagService,
  UploadSessionRepositoryPort,
  UploadSessionService,
  UserAdministrationService,
} from "@docuflow/domain";
import type { S3EndpointSecurityPolicy } from "@docuflow/storage-s3";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import type { AuthService } from "./modules/auth/auth.service.js";
import { registerCategoryRoutes } from "./modules/categories/categories.routes.js";
import { registerDocumentRoutes } from "./modules/documents/documents.routes.js";
import { registerFolderRoutes } from "./modules/folders/folders.routes.js";
import { registerGroupRoutes } from "./modules/groups/groups.routes.js";
import { registerSetupRoutes } from "./modules/setup/setup.routes.js";
import type { SetupService } from "./modules/setup/setup.service.js";
import { registerStorageRoutes } from "./modules/storage/storage.routes.js";
import { registerTagRoutes } from "./modules/tags/tags.routes.js";
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
  readonly storageAdminService?: StorageConnectionAdminService | undefined;
  readonly s3SecurityPolicy?: S3EndpointSecurityPolicy | undefined;
  readonly documentDeps?:
    | {
        readonly authzRepository: AuthorizationRepository;
        readonly documentRepository: DocumentRepositoryPort;
        readonly auditRepository: AuditRepositoryPort;
        readonly categoryRepository?: CategoryRepositoryPort | undefined;
        readonly createDocumentService?: CreateDocumentService | undefined;
        readonly createDocumentVersionService?: CreateDocumentVersionService | undefined;
        readonly moveDocumentService?: MoveDocumentService | undefined;
        readonly archiveDocumentService?: ArchiveDocumentService | undefined;
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

  const secureCookies = options.secureCookies ?? process.env["NODE_ENV"] === "production";

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
      });
      void app.register(async (instance) => {
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
        });
      });
    }

    if (options.uploadDeps) {
      const uploadDeps = options.uploadDeps;
      const uploadGuard = createDocumentAuthorizationGuard({
        authService,
        authzRepository: uploadDeps.authzRepository,
        documentRepository: uploadDeps.documentRepository,
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
  }

  return app;
}
