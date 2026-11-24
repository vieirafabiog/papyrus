import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  StorageError,
  type StorageProvider,
  createStorageProviderRegistry,
  createStorageSecretVault,
  isValidEncryptedVaultEnvelope,
} from "../src/index.js";

function createDummyS3Provider(): StorageProvider {
  return {
    kind: "s3",
    capabilities: {
      streamingRead: true,
      streamingWrite: true,
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideCopy: false,
    },
    async checkHealth() {
      return { healthy: true, message: "ok", checkedAt: new Date() };
    },
    async putObject(input) {
      return { key: input.key, ...input.metadata };
    },
    async getObject() {
      return {
        body: Readable.from([]),
        metadata: {
          contentType: "application/octet-stream",
          contentLength: 0,
          checksumSha256: "0".repeat(64),
        },
      };
    },
    async headObject() {
      return null;
    },
    async deleteObject() {
      // No-op test stub.
    },
  };
}

describe("Storage secret vault (AES-256-GCM)", () => {
  it("encrypts and decrypts connector credentials with external master key without persisting plaintext", () => {
    const masterKey = randomBytes(32);
    const vault = createStorageSecretVault({ masterKey });

    const credentials = {
      accessKeyId: "AKIA_TEST_ACCESS_KEY",
      secretAccessKey: "super-secret-s3-key-2026",
    };

    const ref1 = vault.encryptCredentials(credentials);
    const ref2 = vault.encryptCredentials(credentials);

    expect(isValidEncryptedVaultEnvelope(ref1)).toBe(true);
    // Unique random IV per encryption
    expect(ref1).not.toBe(ref2);
    expect(ref1).not.toContain("AKIA_TEST_ACCESS_KEY");
    expect(ref1).not.toContain("super-secret-s3-key-2026");
    expect(ref1).not.toContain(masterKey.toString("hex"));

    const decrypted = vault.decryptCredentials(ref1);
    expect(decrypted).toEqual(credentials);
  });

  it("fails explicitly when master key is missing or has invalid format/length", () => {
    expect(() => createStorageSecretVault({ masterKey: undefined })).toThrowError(StorageError);
    expect(() => createStorageSecretVault({ masterKey: "" })).toThrowError(StorageError);
    expect(() => createStorageSecretVault({ masterKey: Buffer.alloc(16, 1) })).toThrowError(
      StorageError,
    );
    expect(() =>
      createStorageSecretVault({ masterKey: "replace_with_32_bytes_base64_or_hex_master_key" }),
    ).toThrowError(StorageError);
  });

  it("rejects tampered ciphertext, wrong key, and invalid envelope format safely", () => {
    const key1 = randomBytes(32).toString("hex");
    const key2 = randomBytes(32).toString("base64");

    const vault1 = createStorageSecretVault({ masterKey: key1 });
    const vault2 = createStorageSecretVault({ masterKey: key2 });

    const encrypted = vault1.encryptCredentials({
      accessKeyId: "AKIA1",
      secretAccessKey: "SECRET1",
    });

    // Wrong master key
    expect(() => vault2.decryptCredentials(encrypted)).toThrowError(StorageError);

    // Tampered ciphertext character
    const parts = encrypted.split(":");
    const cipherPart = parts[5] ?? "";
    const tamperedCipher = (cipherPart.startsWith("A") ? "B" : "A") + cipherPart.slice(1);
    const tampered = [...parts.slice(0, 5), tamperedCipher].join(":");
    expect(() => vault1.decryptCredentials(tampered)).toThrowError(StorageError);

    // Invalid outer format
    expect(isValidEncryptedVaultEnvelope("plaintext:not:vault")).toBe(false);
    expect(() => vault1.decryptCredentials("not-a-vault-token")).toThrowError(StorageError);
  });

  it("supports key rotation and integrates with StorageProviderRegistry", async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    const oldVault = createStorageSecretVault({ masterKey: oldKey, activeKeyId: "v1" });
    const oldRef = oldVault.encryptCredentials({
      accessKeyId: "AKIAOLD",
      secretAccessKey: "SECRETOLD",
    });

    const rotatedVault = createStorageSecretVault({
      masterKey: newKey,
      activeKeyId: "v2",
      previousKeys: { v1: oldKey },
    });

    // Can decrypt legacy v1 secret and re-encrypt under v2
    expect(rotatedVault.decryptCredentials(oldRef)).toEqual({
      accessKeyId: "AKIAOLD",
      secretAccessKey: "SECRETOLD",
    });

    const newRef = rotatedVault.rotateCredentials(oldRef);
    expect(newRef.startsWith("dfvault:v1:v2:")).toBe(true);
    expect(rotatedVault.decryptCredentials(newRef)).toEqual({
      accessKeyId: "AKIAOLD",
      secretAccessKey: "SECRETOLD",
    });

    // Integrates directly with StorageProviderRegistry via toStorageSecretResolver()
    const registry = createStorageProviderRegistry({
      secretResolver: rotatedVault.toStorageSecretResolver(),
    });
    registry.registerFactory("s3", ({ resolvedSecret }) => {
      expect(resolvedSecret).toEqual({
        accessKeyId: "AKIAOLD",
        secretAccessKey: "SECRETOLD",
      });
      return createDummyS3Provider();
    });

    const provider = await registry.resolveProvider({
      id: "conn-s3-vault",
      organizationId: "org-1",
      name: "S3 Vaulted",
      kind: "s3",
      status: "ACTIVE",
      nonSecretConfig: { bucket: "papyrus" },
      encryptedSecretRef: newRef,
    });
    expect(provider.kind).toBe("s3");
  });
});
