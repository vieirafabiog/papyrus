import { PERMISSION_CATALOG, SYSTEM_ROLE_DEFINITIONS } from "@papyrus/auth";
import { type DatabaseClient, createSystemBootstrapRepository } from "@papyrus/database";
import {
  BootstrapAlreadyCompletedError,
  type SetupBootstrapRepositoryPort,
} from "./setup.service.js";

export function createDrizzleSetupRepository(
  db: DatabaseClient["db"],
): SetupBootstrapRepositoryPort {
  return createSystemBootstrapRepository(db, {
    permissionCatalog: PERMISSION_CATALOG,
    systemRoles: Object.values(SYSTEM_ROLE_DEFINITIONS),
    onAlreadyInitialized: () => new BootstrapAlreadyCompletedError(),
  });
}
