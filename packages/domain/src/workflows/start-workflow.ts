import { createAuditWriter } from "../audit/audit-writer.js";
import { canTransitionDocumentStatus } from "../documents/document-state.js";
import type { DocumentEntity, DocumentVersionEntity } from "../documents/document.types.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type {
  DocumentRepositoryPort,
  DocumentVersionRepositoryPort,
} from "../ports/document-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import type { UploadSessionRepositoryPort } from "../ports/upload-session-repository.port.js";
import type { WorkflowDefinitionRepositoryPort } from "../ports/workflow-definition-repository.port.js";
import type { WorkflowInstanceRepositoryPort } from "../ports/workflow-instance-repository.port.js";
import type { WorkflowDefinitionVersionEntity, WorkflowInstanceEntity } from "./workflow.types.js";

export interface StartWorkflowServiceDependencies {
  readonly documents: DocumentRepositoryPort;
  readonly documentVersions: DocumentVersionRepositoryPort;
  readonly uploadSessions: UploadSessionRepositoryPort;
  readonly definitions: WorkflowDefinitionRepositoryPort;
  readonly workflowInstances: WorkflowInstanceRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly generateId: () => string;
  readonly now?: (() => Date) | undefined;
}

export interface StartWorkflowCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly documentId: string;
  readonly documentVersionId?: string | undefined;
  readonly workflowDefinitionId: string;
  readonly workflowDefinitionVersionId?: string | undefined;
  readonly expectedDocumentVersion?: number | undefined;
}

export interface StartedWorkflowResult {
  readonly instance: WorkflowInstanceEntity;
  readonly document: DocumentEntity;
  readonly documentVersion: DocumentVersionEntity;
  readonly definitionVersion: WorkflowDefinitionVersionEntity;
}

export interface StartWorkflowService {
  startWorkflow(command: StartWorkflowCommand): Promise<StartedWorkflowResult>;
}

/**
 * Starts a workflow instance pinned strictly to an immutable workflow definition
 * version and an explicit verified `documentVersionId`, transitioning the document
 * to `IN_REVIEW` inside the same database transaction.
 */
export function createStartWorkflowUseCase(
  deps: StartWorkflowServiceDependencies,
): StartWorkflowService {
  const now = deps.now ?? (() => new Date());
  const auditWriter = createAuditWriter({ repository: deps.audit });

  return {
    async startWorkflow(command: StartWorkflowCommand): Promise<StartedWorkflowResult> {
      const startedAt = now();

      return deps.transactions.runInTransaction(async (tx) => {
        const doc = await deps.documents.findById(command.documentId, tx);
        if (!doc || doc.organizationId !== command.organizationId) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
        }

        if (
          command.expectedDocumentVersion !== undefined &&
          doc.version !== command.expectedDocumentVersion
        ) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "O documento foi modificado simultaneamente; atualize antes de iniciar a revisão.",
          );
        }

        if (!canTransitionDocumentStatus(doc.status, "IN_REVIEW")) {
          throw new DomainError(
            "INVALID_DOCUMENT_TRANSITION",
            `O documento no estado '${doc.status}' não pode ser encaminhado para revisão.`,
          );
        }

        const existingActive = await deps.workflowInstances.findActiveByDocumentId(doc.id, tx);
        if (existingActive) {
          throw new DomainError(
            "WORKFLOW_ALREADY_ACTIVE",
            "Este documento já possui uma instância de fluxo de aprovação ativa.",
          );
        }

        const targetDocVersionId = command.documentVersionId ?? doc.currentVersionId;
        if (!targetDocVersionId) {
          throw new DomainError(
            "DOCUMENT_VERSION_NOT_FOUND",
            "O documento não possui versão vinculada para iniciar o fluxo de aprovação.",
          );
        }

        const docVersion = await deps.documentVersions.findById(targetDocVersionId, tx);
        if (!docVersion || docVersion.documentId !== doc.id) {
          throw new DomainError(
            "DOCUMENT_VERSION_NOT_FOUND",
            "A versão documental especificada não foi encontrada para este documento.",
          );
        }

        if (doc.currentVersionId !== docVersion.id) {
          throw new DomainError(
            "STALE_DOCUMENT_VERSION",
            "Apenas a versão vigente do documento pode iniciar uma instância de aprovação.",
          );
        }

        if (deps.uploadSessions.findFileObjectOrganizationId) {
          const ownerOrgId = await deps.uploadSessions.findFileObjectOrganizationId(
            docVersion.fileObjectId,
            tx,
          );
          if (!ownerOrgId || ownerOrgId !== command.organizationId) {
            throw new DomainError("FILE_OBJECT_NOT_FOUND", "Arquivo da versão não encontrado.");
          }
        }

        const fileObject = await deps.uploadSessions.findFileObjectById(
          docVersion.fileObjectId,
          tx,
        );
        if (!fileObject) {
          throw new DomainError("FILE_OBJECT_NOT_FOUND", "Arquivo da versão não encontrado.");
        }

        if (fileObject.status !== "AVAILABLE") {
          throw new DomainError(
            "FILE_OBJECT_NOT_AVAILABLE",
            "O arquivo desta versão precisa concluir a verificação de segurança antes da aprovação.",
          );
        }

        const definition = await deps.definitions.findById(command.workflowDefinitionId, tx);
        if (!definition || definition.organizationId !== command.organizationId) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_NOT_FOUND",
            "Definição de fluxo não encontrada.",
          );
        }
        if (!definition.isActive) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_INACTIVE",
            "Esta definição de fluxo está desativada e não pode iniciar novas instâncias.",
          );
        }

        const definitionVersion = command.workflowDefinitionVersionId
          ? await deps.definitions.findVersionById(command.workflowDefinitionVersionId, tx)
          : await deps.definitions.findVersionByNumber(
              definition.id,
              definition.latestVersionNumber,
              tx,
            );

        if (!definitionVersion || definitionVersion.workflowDefinitionId !== definition.id) {
          throw new DomainError(
            "WORKFLOW_DEFINITION_VERSION_NOT_FOUND",
            "Versão da definição de fluxo não encontrada.",
          );
        }

        const firstStep = [...definitionVersion.steps].sort((a, b) => a.stepOrder - b.stepOrder)[0];
        if (!firstStep) {
          throw new DomainError(
            "INVALID_WORKFLOW_STEPS",
            "A versão da definição de fluxo não possui etapas válidas.",
          );
        }

        const updatedDocument = await deps.documents.updateStatus(
          doc.id,
          "IN_REVIEW",
          doc.version,
          tx,
        );
        if (!updatedDocument) {
          throw new DomainError(
            "DOCUMENT_VERSION_CONFLICT",
            "Conflito ao encaminhar o documento para revisão; tente novamente.",
          );
        }

        const instance = await deps.workflowInstances.create(
          {
            id: deps.generateId(),
            organizationId: command.organizationId,
            documentId: doc.id,
            documentVersionId: docVersion.id,
            workflowDefinitionVersionId: definitionVersion.id,
            currentStepOrder: firstStep.stepOrder,
            startedByUserId: command.actorUserId,
            startedAt,
          },
          tx,
        );

        await auditWriter.write(
          {
            organizationId: command.organizationId,
            actorUserId: command.actorUserId,
            action: "WORKFLOW_STARTED",
            resourceType: "WORKFLOW_INSTANCE",
            resourceId: instance.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              documentId: doc.id,
              documentVersionId: docVersion.id,
              workflowDefinitionId: definition.id,
              workflowDefinitionVersionId: definitionVersion.id,
              definitionVersionNumber: definitionVersion.versionNumber,
            },
          },
          tx,
        );

        return {
          instance,
          document: updatedDocument,
          documentVersion: docVersion,
          definitionVersion,
        };
      });
    },
  };
}
