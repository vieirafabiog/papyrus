export const SUPPORTED_ORGANIZATION_LANGUAGES = ["pt-BR", "en-US", "es-ES"] as const;
export type OrganizationLanguage = (typeof SUPPORTED_ORGANIZATION_LANGUAGES)[number];

export const SUPPORTED_ORGANIZATION_DATE_FORMATS = [
  "DD/MM/YYYY",
  "YYYY-MM-DD",
  "MM/DD/YYYY",
] as const;
export type OrganizationDateFormat = (typeof SUPPORTED_ORGANIZATION_DATE_FORMATS)[number];

export const ALLOWED_ORGANIZATION_PAGE_SIZES = [10, 20, 50] as const;
export type OrganizationListPageSize = (typeof ALLOWED_ORGANIZATION_PAGE_SIZES)[number];

export interface OrganizationPreferences {
  readonly defaultExpirationWindowDays: number;
  readonly trashGraceDays: number;
  readonly dateFormat: OrganizationDateFormat;
  readonly defaultListPageSize: OrganizationListPageSize;
  readonly auditDocumentViews: boolean;
  readonly auditDocumentDownloads: boolean;
}

export interface OrganizationEntity {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly defaultLanguage: OrganizationLanguage;
  readonly timezone: string;
  readonly logoObjectKey: string | null;
  readonly preferences: OrganizationPreferences;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const DEFAULT_ORGANIZATION_PREFERENCES: OrganizationPreferences = {
  defaultExpirationWindowDays: 30,
  trashGraceDays: 30,
  dateFormat: "DD/MM/YYYY",
  defaultListPageSize: 20,
  auditDocumentViews: true,
  auditDocumentDownloads: true,
};
