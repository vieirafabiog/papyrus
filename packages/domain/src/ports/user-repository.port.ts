import type { UserEntity, UserStatus } from "../access/access.types.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateUserInput {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly fullName: string;
  readonly passwordHash: string;
  readonly status: UserStatus;
}

export interface UpdateUserInput {
  readonly fullName?: string | undefined;
  readonly status?: UserStatus | undefined;
}

export interface UserRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<UserEntity | null>;
  findByEmail(
    organizationId: string,
    normalizedEmail: string,
    tx?: TransactionContext,
  ): Promise<UserEntity | null>;
  listByOrganization(organizationId: string): Promise<readonly UserEntity[]>;
  create(input: CreateUserInput, tx?: TransactionContext): Promise<UserEntity>;
  update(
    id: string,
    input: UpdateUserInput,
    tx?: TransactionContext,
  ): Promise<UserEntity | null>;
  countActiveAdmins(organizationId: string, tx?: TransactionContext): Promise<number>;
}
