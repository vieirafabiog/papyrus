import type {
  OrganizationEntity,
  OrganizationLanguage,
  OrganizationPreferences,
} from "../organization/organization.types.js";
import type { TransactionContext } from "./transaction.port.js";

export interface UpdateOrganizationSettingsInput {
  readonly name?: string | undefined;
  readonly defaultLanguage?: OrganizationLanguage | undefined;
  readonly timezone?: string | undefined;
  readonly preferences?: OrganizationPreferences | undefined;
  readonly updatedAt: Date;
}

export interface OrganizationRepositoryPort {
  findById(organizationId: string, tx?: TransactionContext): Promise<OrganizationEntity | null>;
  updateSettings(
    organizationId: string,
    input: UpdateOrganizationSettingsInput,
    tx?: TransactionContext,
  ): Promise<OrganizationEntity | null>;
}
