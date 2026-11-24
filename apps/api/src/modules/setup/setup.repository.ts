import { PERMISSION_CATALOG, SYSTEM_ROLE_DEFINITIONS } from "@docuflow/auth";
import { type DatabaseClient, createSystemBootstrapRepository } from "@docuflow/database";
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
