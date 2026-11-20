import type { GroupEntity, UserEntity } from "../access/access.types.js";
import type { TransactionContext } from "./transaction.port.js";

export interface CreateGroupInput {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdBy: string;
}

export interface AddGroupMemberInput {
  readonly id: string;
  readonly groupId: string;
  readonly userId: string;
}

export interface GroupRepositoryPort {
  findById(id: string, tx?: TransactionContext): Promise<GroupEntity | null>;
  findByName(
    organizationId: string,
    name: string,
    tx?: TransactionContext,
  ): Promise<GroupEntity | null>;
  listByOrganization(organizationId: string): Promise<readonly GroupEntity[]>;
  create(input: CreateGroupInput, tx?: TransactionContext): Promise<GroupEntity>;
  isMember(groupId: string, userId: string, tx?: TransactionContext): Promise<boolean>;
  addMember(input: AddGroupMemberInput, tx?: TransactionContext): Promise<void>;
  removeMember(groupId: string, userId: string, tx?: TransactionContext): Promise<boolean>;
  listMembers(groupId: string): Promise<readonly UserEntity[]>;
}
