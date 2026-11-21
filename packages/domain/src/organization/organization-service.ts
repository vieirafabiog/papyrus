import { createAuditWriter } from "../audit/audit-writer.js";
import { isValidIanaTimeZone } from "../documents/expiration.js";
import { DomainError } from "../index.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.port.js";
import type { OrganizationRepositoryPort } from "../ports/organization-repository.port.js";
import type { TransactionManagerPort } from "../ports/transaction.port.js";
import {
  ALLOWED_ORGANIZATION_PAGE_SIZES,
  DEFAULT_ORGANIZATION_PREFERENCES,
  type OrganizationDateFormat,
  type OrganizationEntity,
  type OrganizationLanguage,
  type OrganizationListPageSize,
  type OrganizationPreferences,
  SUPPORTED_ORGANIZATION_DATE_FORMATS,
  SUPPORTED_ORGANIZATION_LANGUAGES,
} from "./organization.types.js";

export const MIN_ORGANIZATION_NAME_LENGTH = 2;
export const MAX_ORGANIZATION_NAME_LENGTH = 160;
export const MAX_EXPIRATION_PREFERENCE_DAYS = 365;
export const MAX_TRASH_GRACE_PREFERENCE_DAYS = 3_650;

export interface OrganizationServiceDependencies {
  readonly organizations: OrganizationRepositoryPort;
  readonly transactions: TransactionManagerPort;
  readonly audit: AuditRepositoryPort;
  readonly now?: (() => Date) | undefined;
}

export interface OrganizationPreferencesPatch {
  readonly defaultExpirationWindowDays?: number | undefined;
  readonly trashGraceDays?: number | undefined;
  readonly dateFormat?: OrganizationDateFormat | undefined;
  readonly defaultListPageSize?: OrganizationListPageSize | undefined;
  readonly auditDocumentViews?: boolean | undefined;
  readonly auditDocumentDownloads?: boolean | undefined;
}

export interface UpdateOrganizationCommand {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly name?: string | undefined;
  readonly defaultLanguage?: OrganizationLanguage | undefined;
  readonly timezone?: string | undefined;
  readonly preferences?: OrganizationPreferencesPatch | undefined;
}

export interface OrganizationService {
  getOrganization(organizationId: string): Promise<OrganizationEntity>;
  updateOrganization(command: UpdateOrganizationCommand): Promise<OrganizationEntity>;
}

function isSupportedLanguage(value: string): value is OrganizationLanguage {
  return (SUPPORTED_ORGANIZATION_LANGUAGES as readonly string[]).includes(value);
}

function isSupportedDateFormat(value: string): value is OrganizationDateFormat {
  return (SUPPORTED_ORGANIZATION_DATE_FORMATS as readonly string[]).includes(value);
}

function isAllowedPageSize(value: number): value is OrganizationListPageSize {
  return (ALLOWED_ORGANIZATION_PAGE_SIZES as readonly number[]).includes(value);
}

/**
 * Normalizes stored organization preferences with explicit defaults so newly added
 * allowed installation preferences remain backward compatible.
 */
export function normalizeOrganizationPreferences(
  raw: Partial<Record<keyof OrganizationPreferences, unknown>> | null | undefined,
): OrganizationPreferences {
  const source = raw ?? {};

  const expDays =
    typeof source.defaultExpirationWindowDays === "number" &&
    Number.isInteger(source.defaultExpirationWindowDays) &&
    source.defaultExpirationWindowDays >= 1 &&
    source.defaultExpirationWindowDays <= MAX_EXPIRATION_PREFERENCE_DAYS
      ? source.defaultExpirationWindowDays
      : DEFAULT_ORGANIZATION_PREFERENCES.defaultExpirationWindowDays;

  const graceDays =
    typeof source.trashGraceDays === "number" &&
    Number.isInteger(source.trashGraceDays) &&
    source.trashGraceDays >= 1 &&
    source.trashGraceDays <= MAX_TRASH_GRACE_PREFERENCE_DAYS
      ? source.trashGraceDays
      : DEFAULT_ORGANIZATION_PREFERENCES.trashGraceDays;

  const dateFormat =
    typeof source.dateFormat === "string" && isSupportedDateFormat(source.dateFormat)
      ? source.dateFormat
      : DEFAULT_ORGANIZATION_PREFERENCES.dateFormat;

  const pageSize =
    typeof source.defaultListPageSize === "number" && isAllowedPageSize(source.defaultListPageSize)
      ? source.defaultListPageSize
      : DEFAULT_ORGANIZATION_PREFERENCES.defaultListPageSize;

  const auditViews =
    typeof source.auditDocumentViews === "boolean"
      ? source.auditDocumentViews
      : DEFAULT_ORGANIZATION_PREFERENCES.auditDocumentViews;

  const auditDownloads =
    typeof source.auditDocumentDownloads === "boolean"
      ? source.auditDocumentDownloads
      : DEFAULT_ORGANIZATION_PREFERENCES.auditDocumentDownloads;

  return {
    defaultExpirationWindowDays: expDays,
    trashGraceDays: graceDays,
    dateFormat,
    defaultListPageSize: pageSize,
    auditDocumentViews: auditViews,
    auditDocumentDownloads: auditDownloads,
  };
}

/**
 * Normalizes a persisted organization language tag to an allowed product locale.
 */
export function normalizeOrganizationLanguage(rawLanguage: string): OrganizationLanguage {
  return isSupportedLanguage(rawLanguage) ? rawLanguage : "pt-BR";
}

function validateAndNormalizeName(rawName: string): string {
  const trimmed = rawName.trim();
  if (
    trimmed.length < MIN_ORGANIZATION_NAME_LENGTH ||
    trimmed.length > MAX_ORGANIZATION_NAME_LENGTH
  ) {
    throw new DomainError(
      "INVALID_ORGANIZATION_NAME",
      `O nome da organização deve ter entre ${MIN_ORGANIZATION_NAME_LENGTH} e ${MAX_ORGANIZATION_NAME_LENGTH} caracteres.`,
    );
  }
  return trimmed;
}

function mergePreferences(
  current: OrganizationPreferences,
  patch: OrganizationPreferencesPatch,
): OrganizationPreferences {
  if (patch.defaultExpirationWindowDays !== undefined) {
    if (
      !Number.isInteger(patch.defaultExpirationWindowDays) ||
      patch.defaultExpirationWindowDays < 1 ||
      patch.defaultExpirationWindowDays > MAX_EXPIRATION_PREFERENCE_DAYS
    ) {
      throw new DomainError(
        "INVALID_ORGANIZATION_PREFERENCE",
        `A janela padrão de vencimentos deve estar entre 1 e ${MAX_EXPIRATION_PREFERENCE_DAYS} dias.`,
      );
    }
  }

  if (patch.trashGraceDays !== undefined) {
    if (
      !Number.isInteger(patch.trashGraceDays) ||
      patch.trashGraceDays < 1 ||
      patch.trashGraceDays > MAX_TRASH_GRACE_PREFERENCE_DAYS
    ) {
      throw new DomainError(
        "INVALID_ORGANIZATION_PREFERENCE",
        `O prazo de carência da lixeira deve estar entre 1 e ${MAX_TRASH_GRACE_PREFERENCE_DAYS} dias.`,
      );
    }
  }

  if (patch.dateFormat !== undefined && !isSupportedDateFormat(patch.dateFormat)) {
    throw new DomainError("INVALID_ORGANIZATION_PREFERENCE", "Formato de data não permitido.");
  }

  if (patch.defaultListPageSize !== undefined && !isAllowedPageSize(patch.defaultListPageSize)) {
    throw new DomainError(
      "INVALID_ORGANIZATION_PREFERENCE",
      "Tamanho padrão de paginação não permitido.",
    );
  }

  return {
    defaultExpirationWindowDays:
      patch.defaultExpirationWindowDays ?? current.defaultExpirationWindowDays,
    trashGraceDays: patch.trashGraceDays ?? current.trashGraceDays,
    dateFormat: patch.dateFormat ?? current.dateFormat,
    defaultListPageSize: patch.defaultListPageSize ?? current.defaultListPageSize,
    auditDocumentViews: patch.auditDocumentViews ?? current.auditDocumentViews,
    auditDocumentDownloads: patch.auditDocumentDownloads ?? current.auditDocumentDownloads,
  };
}

/**
 * Domain service for viewing and updating installation organization identity,
 * localization settings, and allowed non-secret installation preferences with auditability.
 */
export function createOrganizationService(
  deps: OrganizationServiceDependencies,
): OrganizationService {
  const auditWriter = createAuditWriter({ repository: deps.audit });
  const nowFn = deps.now ?? (() => new Date());

  return {
    async getOrganization(organizationId: string): Promise<OrganizationEntity> {
      const org = await deps.organizations.findById(organizationId);
      if (!org) {
        throw new DomainError("ORGANIZATION_NOT_FOUND", "Organização não encontrada.");
      }
      return org;
    },

    async updateOrganization(command: UpdateOrganizationCommand): Promise<OrganizationEntity> {
      const normalizedName =
        command.name !== undefined ? validateAndNormalizeName(command.name) : undefined;

      if (command.defaultLanguage !== undefined && !isSupportedLanguage(command.defaultLanguage)) {
        throw new DomainError(
          "INVALID_ORGANIZATION_LANGUAGE",
          "Idioma padrão não suportado pela instalação.",
        );
      }

      const normalizedTimezone =
        command.timezone !== undefined ? command.timezone.trim() : undefined;
      if (normalizedTimezone !== undefined && !isValidIanaTimeZone(normalizedTimezone)) {
        throw new DomainError("INVALID_TIMEZONE", "Fuso horário IANA inválido.");
      }

      const hasPreferencePatch =
        command.preferences !== undefined && Object.keys(command.preferences).length > 0;
      if (
        normalizedName === undefined &&
        command.defaultLanguage === undefined &&
        normalizedTimezone === undefined &&
        !hasPreferencePatch
      ) {
        throw new DomainError(
          "EMPTY_ORGANIZATION_UPDATE",
          "Informe ao menos uma configuração para atualizar.",
        );
      }

      const updatedAt = nowFn();

      return deps.transactions.runInTransaction(async (tx) => {
        const existing = await deps.organizations.findById(command.organizationId, tx);
        if (!existing) {
          throw new DomainError("ORGANIZATION_NOT_FOUND", "Organização não encontrada.");
        }

        const nextPreferences =
          command.preferences !== undefined
            ? mergePreferences(existing.preferences, command.preferences)
            : undefined;

        const updated = await deps.organizations.updateSettings(
          existing.id,
          {
            name: normalizedName,
            defaultLanguage: command.defaultLanguage,
            timezone: normalizedTimezone,
            preferences: nextPreferences,
            updatedAt,
          },
          tx,
        );

        if (!updated) {
          throw new DomainError("ORGANIZATION_NOT_FOUND", "Organização não encontrada.");
        }

        await auditWriter.write(
          {
            organizationId: existing.id,
            actorUserId: command.actorUserId,
            action: "ORGANIZATION_SETTINGS_UPDATED",
            resourceType: "ORGANIZATION",
            resourceId: existing.id,
            result: "SUCCESS",
            requestId: command.requestId,
            metadata: {
              updatedName: normalizedName !== undefined,
              updatedLanguage: command.defaultLanguage !== undefined,
              updatedTimezone: normalizedTimezone !== undefined,
              updatedPreferences: hasPreferencePatch,
              defaultLanguage: updated.defaultLanguage,
              timezone: updated.timezone,
            },
          },
          tx,
        );

        return updated;
      });
    },
  };
}
