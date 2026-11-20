import { StorageError } from "./storage-errors.js";
import type { StorageProvider } from "./storage-provider.js";
import type { StorageCapabilities } from "./storage.types.js";

export type StorageCapabilityName = keyof StorageCapabilities;

export const ALL_STORAGE_CAPABILITIES: readonly StorageCapabilityName[] = [
  "streamingRead",
  "streamingWrite",
  "signedUpload",
  "signedDownload",
  "multipartUpload",
  "serverSideCopy",
] as const;

const CAPABILITY_LABELS: Readonly<Record<StorageCapabilityName, string>> = {
  streamingRead: "leitura por streaming",
  streamingWrite: "escrita por streaming",
  signedUpload: "upload por URL assinada",
  signedDownload: "download por URL assinada",
  multipartUpload: "upload multipart",
  serverSideCopy: "cópia no servidor",
};

export interface CapabilityValidationResult {
  readonly supported: boolean;
  readonly missing: readonly StorageCapabilityName[];
}

export type StorageUploadMode = "SIGNED_UPLOAD" | "API_STREAMING";
export type StorageDownloadMode = "SIGNED_DOWNLOAD" | "API_STREAMING";

export type SignedUploadCapableProvider = StorageProvider &
  Required<Pick<StorageProvider, "createSignedUploadTarget">>;

export type SignedDownloadCapableProvider = StorageProvider &
  Required<Pick<StorageProvider, "createSignedDownloadTarget">>;

type CapabilityCheckSubject = Pick<
  StorageProvider,
  "kind" | "capabilities" | "createSignedUploadTarget" | "createSignedDownloadTarget"
>;

/**
 * Verifies whether a storage provider genuinely supports a capability, checking both
 * the declared capability flag and the presence of optional signed-target methods.
 */
export function hasStorageCapability(
  provider: Pick<
    StorageProvider,
    "capabilities" | "createSignedUploadTarget" | "createSignedDownloadTarget"
  >,
  capability: StorageCapabilityName,
): boolean {
  if (!provider.capabilities[capability]) {
    return false;
  }

  if (capability === "signedUpload") {
    return typeof provider.createSignedUploadTarget === "function";
  }

  if (capability === "signedDownload") {
    return typeof provider.createSignedDownloadTarget === "function";
  }

  return true;
}

export function validateStorageCapabilities(
  provider: Pick<
    StorageProvider,
    "capabilities" | "createSignedUploadTarget" | "createSignedDownloadTarget"
  >,
  required: readonly StorageCapabilityName[],
): CapabilityValidationResult {
  const missing: StorageCapabilityName[] = [];
  const seen = new Set<StorageCapabilityName>();

  for (const capability of required) {
    if (seen.has(capability)) {
      continue;
    }
    seen.add(capability);
    if (!hasStorageCapability(provider, capability)) {
      missing.push(capability);
    }
  }

  return {
    supported: missing.length === 0,
    missing,
  };
}

export function assertStorageCapabilities(
  provider: CapabilityCheckSubject,
  required: readonly StorageCapabilityName[],
): void {
  const result = validateStorageCapabilities(provider, required);
  if (result.supported) {
    return;
  }

  const labels = result.missing.map((cap) => CAPABILITY_LABELS[cap]).join(", ");
  throw new StorageError(
    "CAPABILITY_NOT_SUPPORTED",
    `O provedor '${provider.kind}' não suporta a operação solicitada (${labels}).`,
    provider.kind,
  );
}

export function assertStorageCapability(
  provider: CapabilityCheckSubject,
  capability: StorageCapabilityName,
): void {
  assertStorageCapabilities(provider, [capability]);
}

export function resolveUploadMode(
  provider: CapabilityCheckSubject,
  preferSigned: boolean,
): StorageUploadMode {
  if (preferSigned && hasStorageCapability(provider, "signedUpload")) {
    return "SIGNED_UPLOAD";
  }
  assertStorageCapability(provider, "streamingWrite");
  return "API_STREAMING";
}

export function resolveDownloadMode(
  provider: CapabilityCheckSubject,
  preferSigned: boolean,
): StorageDownloadMode {
  if (preferSigned && hasStorageCapability(provider, "signedDownload")) {
    return "SIGNED_DOWNLOAD";
  }
  assertStorageCapability(provider, "streamingRead");
  return "API_STREAMING";
}

export function requireSignedUploadTargetProvider(
  provider: StorageProvider,
): SignedUploadCapableProvider {
  assertStorageCapability(provider, "signedUpload");
  if (typeof provider.createSignedUploadTarget !== "function") {
    throw new StorageError(
      "CAPABILITY_NOT_SUPPORTED",
      `O provedor '${provider.kind}' não implementa geração de URL assinada para upload.`,
      provider.kind,
    );
  }
  return provider as SignedUploadCapableProvider;
}

export function requireSignedDownloadTargetProvider(
  provider: StorageProvider,
): SignedDownloadCapableProvider {
  assertStorageCapability(provider, "signedDownload");
  if (typeof provider.createSignedDownloadTarget !== "function") {
    throw new StorageError(
      "CAPABILITY_NOT_SUPPORTED",
      `O provedor '${provider.kind}' não implementa geração de URL assinada para download.`,
      provider.kind,
    );
  }
  return provider as SignedDownloadCapableProvider;
}
