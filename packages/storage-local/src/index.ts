import { STORAGE_CORE_VERSION } from "@docuflow/storage-core";

export const LOCAL_STORAGE_PROVIDER_KIND = "local" as const;
export const LOCAL_STORAGE_CORE_VERSION = STORAGE_CORE_VERSION;

export {
  checkLocalStorageHealth,
  type LocalHealthCheckOptions,
  type LocalStorageHealthResult,
} from "./local-health.js";

export {
  createLocalStorageProvider,
  type LocalStorageProviderConfig,
} from "./local-storage-provider.js";

export {
  resolveSafeLocalPath,
  resolveSafeLocalRoot,
  type SafeLocalPathResult,
  validateLocalObjectKey,
} from "./safe-path.js";
