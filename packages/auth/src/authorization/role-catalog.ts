import type { AccessAction, AccessResource } from "@papyrus/domain";

export interface PermissionPair {
  readonly action: AccessAction;
  readonly resource: AccessResource;
}

export type SystemRoleKey = "admin" | "document_manager" | "collaborator" | "reviewer" | "viewer";

export interface SystemRoleDefinition {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly description: string;
  readonly isSystem: true;
  readonly permissions: readonly PermissionPair[];
}

export const PERMISSION_CATALOG: readonly PermissionPair[] = [
  { action: "READ", resource: "DOCUMENT" },
  { action: "CREATE", resource: "DOCUMENT" },
  { action: "UPDATE", resource: "DOCUMENT" },
  { action: "DELETE", resource: "DOCUMENT" },
  { action: "UPLOAD", resource: "DOCUMENT" },
  { action: "DOWNLOAD", resource: "DOCUMENT" },
  { action: "MANAGE_PERMISSIONS", resource: "DOCUMENT" },

  { action: "READ", resource: "FOLDER" },
  { action: "CREATE", resource: "FOLDER" },
  { action: "UPDATE", resource: "FOLDER" },
  { action: "DELETE", resource: "FOLDER" },
  { action: "MANAGE_PERMISSIONS", resource: "FOLDER" },

  { action: "READ", resource: "CATEGORY" },
  { action: "CREATE", resource: "CATEGORY" },
  { action: "UPDATE", resource: "CATEGORY" },
  { action: "DELETE", resource: "CATEGORY" },
  { action: "MANAGE_PERMISSIONS", resource: "CATEGORY" },

  { action: "READ", resource: "WORKFLOW" },
  { action: "CREATE", resource: "WORKFLOW" },
  { action: "UPDATE", resource: "WORKFLOW" },
  { action: "APPROVE", resource: "WORKFLOW" },
  { action: "REJECT", resource: "WORKFLOW" },

  { action: "READ", resource: "USER" },
  { action: "MANAGE_USERS", resource: "USER" },
  { action: "READ", resource: "GROUP" },
  { action: "MANAGE_USERS", resource: "GROUP" },
  { action: "READ", resource: "ROLE" },
  { action: "MANAGE_PERMISSIONS", resource: "ROLE" },

  { action: "READ", resource: "STORAGE" },
  { action: "MANAGE_STORAGE", resource: "STORAGE" },
  { action: "VIEW_AUDIT", resource: "AUDIT" },
  { action: "READ", resource: "ORGANIZATION" },
  { action: "UPDATE", resource: "ORGANIZATION" },
];

export const SYSTEM_ROLE_DEFINITIONS: Readonly<Record<SystemRoleKey, SystemRoleDefinition>> = {
  admin: {
    key: "admin",
    name: "Administrador",
    description: "Administração completa, inclusive configuração de storage e usuários.",
    isSystem: true,
    permissions: PERMISSION_CATALOG,
  },
  document_manager: {
    key: "document_manager",
    name: "Gestor documental",
    description: "Documentos, categorias, pastas, metadados, fluxos e relatórios.",
    isSystem: true,
    permissions: [
      { action: "READ", resource: "DOCUMENT" },
      { action: "CREATE", resource: "DOCUMENT" },
      { action: "UPDATE", resource: "DOCUMENT" },
      { action: "DELETE", resource: "DOCUMENT" },
      { action: "UPLOAD", resource: "DOCUMENT" },
      { action: "DOWNLOAD", resource: "DOCUMENT" },
      { action: "MANAGE_PERMISSIONS", resource: "DOCUMENT" },
      { action: "READ", resource: "FOLDER" },
      { action: "CREATE", resource: "FOLDER" },
      { action: "UPDATE", resource: "FOLDER" },
      { action: "DELETE", resource: "FOLDER" },
      { action: "MANAGE_PERMISSIONS", resource: "FOLDER" },
      { action: "READ", resource: "CATEGORY" },
      { action: "CREATE", resource: "CATEGORY" },
      { action: "UPDATE", resource: "CATEGORY" },
      { action: "DELETE", resource: "CATEGORY" },
      { action: "MANAGE_PERMISSIONS", resource: "CATEGORY" },
      { action: "READ", resource: "WORKFLOW" },
      { action: "CREATE", resource: "WORKFLOW" },
      { action: "UPDATE", resource: "WORKFLOW" },
      { action: "APPROVE", resource: "WORKFLOW" },
      { action: "REJECT", resource: "WORKFLOW" },
    ],
  },
  collaborator: {
    key: "collaborator",
    name: "Colaborador",
    description: "Criar documentos e editar o que lhe for permitido.",
    isSystem: true,
    permissions: [
      { action: "READ", resource: "DOCUMENT" },
      { action: "CREATE", resource: "DOCUMENT" },
      { action: "UPDATE", resource: "DOCUMENT" },
      { action: "UPLOAD", resource: "DOCUMENT" },
      { action: "DOWNLOAD", resource: "DOCUMENT" },
      { action: "READ", resource: "FOLDER" },
      { action: "READ", resource: "CATEGORY" },
      { action: "READ", resource: "WORKFLOW" },
      { action: "CREATE", resource: "WORKFLOW" },
    ],
  },
  reviewer: {
    key: "reviewer",
    name: "Revisor",
    description: "Visualizar documentos atribuídos e executar tarefas de aprovação.",
    isSystem: true,
    permissions: [
      { action: "READ", resource: "DOCUMENT" },
      { action: "DOWNLOAD", resource: "DOCUMENT" },
      { action: "READ", resource: "FOLDER" },
      { action: "READ", resource: "CATEGORY" },
      { action: "READ", resource: "WORKFLOW" },
      { action: "APPROVE", resource: "WORKFLOW" },
      { action: "REJECT", resource: "WORKFLOW" },
    ],
  },
  viewer: {
    key: "viewer",
    name: "Consulta",
    description: "Leitura de recursos autorizados, sem alterar conteúdo.",
    isSystem: true,
    permissions: [
      { action: "READ", resource: "DOCUMENT" },
      { action: "DOWNLOAD", resource: "DOCUMENT" },
      { action: "READ", resource: "FOLDER" },
      { action: "READ", resource: "CATEGORY" },
      { action: "READ", resource: "WORKFLOW" },
    ],
  },
};

export function roleGrantsPermission(
  permissions: readonly PermissionPair[],
  action: AccessAction,
  resource: AccessResource,
): boolean {
  return permissions.some((pair) => pair.action === action && pair.resource === resource);
}
