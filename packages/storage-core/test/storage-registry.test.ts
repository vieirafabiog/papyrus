import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  type StorageConnectionDescriptor,
  StorageError,
  type StorageProvider,
  type StorageProviderKind,
  createStorageProviderRegistry,
} from "../src/index.js";

function createFakeProvider(kind: StorageProviderKind, label: string): StorageProvider {
  return {
    kind,
    capabilities: {
      streamingRead: true,
      streamingWrite: true,
      signedUpload: false,
      signedDownload: false,
      multipartUpload: false,
      serverSideCopy: false,
    },
    async checkHealth() {
      return { healthy: true, message: label, checkedAt: new Date() };
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

function makeConnection(
  overrides: Partial<StorageConnectionDescriptor> = {},
): StorageConnectionDescriptor {
  return {
    id: "conn-1",
    organizationId: "org-1",
    name: "Local Primary",
    kind: "local",
    status: "ACTIVE",
    nonSecretConfig: { rootPath: "/var/lib/papyrus/storage" },
    encryptedSecretRef: null,
    ...overrides,
  };
}

describe("StorageProviderRegistry", () => {
  it("registers factories by kind, prevents accidental overwrite, and allows explicit overwrite", async () => {
    const registry = createStorageProviderRegistry();
    registry.registerFactory("local", () => createFakeProvider("local", "v1"));

    expect(registry.hasFactory("local")).toBe(true);
    expect(registry.listRegisteredKinds()).toEqual(["local"]);

    expect(() =>
      registry.registerFactory("local", () => createFakeProvider("local", "v2")),
    ).toThrowError(StorageError);

    registry.registerFactory("local", () => createFakeProvider("local", "v2"), {
      overwrite: true,
    });

    const resolved = await registry.resolveProvider(makeConnection());
    expect((await resolved.checkHealth()).message).toBe("v2");

    expect(registry.unregisterFactory("local")).toBe(true);
    expect(registry.hasFactory("local")).toBe(false);
  });

  it("caches resolved providers per connection fingerprint and invalidates on config change or explicit invalidate", async () => {
    const factory = vi.fn(({ connection }) =>
      createFakeProvider(connection.kind, String(connection.nonSecretConfig.rootPath ?? "")),
    );
    const registry = createStorageProviderRegistry();
    registry.registerFactory("local", factory);

    const conn = makeConnection();
    const first = await registry.resolveProvider(conn);
    const second = await registry.resolveProvider(conn);
    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);

    const updatedConn = makeConnection({
      nonSecretConfig: { rootPath: "/var/lib/papyrus/storage-v2" },
    });
    const third = await registry.resolveProvider(updatedConn);
    expect(third).not.toBe(first);
    expect((await third.checkHealth()).message).toBe("/var/lib/papyrus/storage-v2");
    expect(factory).toHaveBeenCalledTimes(2);

    registry.invalidate(updatedConn.id);
    const fourth = await registry.resolveProvider(updatedConn);
    expect(fourth).not.toBe(third);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("rejects unregistered provider kinds and inactive connections unless allowInactive is set", async () => {
    const registry = createStorageProviderRegistry();
    registry.registerFactory("local", ({ connection }) =>
      createFakeProvider(connection.kind, "ok"),
    );

    await expect(registry.resolveProvider(makeConnection({ kind: "s3" }))).rejects.toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });

    const inactive = makeConnection({ status: "INACTIVE" });
    await expect(registry.resolveProvider(inactive)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    const allowed = await registry.resolveProvider(inactive, { allowInactive: true });
    expect((await allowed.checkHealth()).healthy).toBe(true);
  });

  it("resolves encrypted secrets via secretResolver and sanitizes unexpected failures without leaking credentials", async () => {
    const s3Conn = makeConnection({
      id: "conn-s3",
      kind: "s3",
      nonSecretConfig: { bucket: "docs", region: "us-east-1" },
      encryptedSecretRef: "vault:enc:v1:abc",
    });

    const withoutResolver = createStorageProviderRegistry();
    withoutResolver.registerFactory("s3", ({ connection }) =>
      createFakeProvider(connection.kind, "s3"),
    );

    await expect(withoutResolver.resolveProvider(s3Conn)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const withFailingSecretResolver = createStorageProviderRegistry({
      secretResolver: {
        async resolveSecret() {
          throw new Error("Unauthorized accessKeyId=AKIASECRET123 secret=topsecret");
        },
      },
    });
    withFailingSecretResolver.registerFactory("s3", ({ connection }) =>
      createFakeProvider(connection.kind, "s3"),
    );

    try {
      await withFailingSecretResolver.resolveProvider(s3Conn);
      expect.unreachable("Expected secret resolution error");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      const storageErr = error as StorageError;
      expect(storageErr.code).toBe("UNAUTHORIZED");
      expect(storageErr.message).not.toContain("AKIASECRET123");
      expect(storageErr.message).not.toContain("topsecret");
    }

    const withValidResolver = createStorageProviderRegistry({
      secretResolver: {
        async resolveSecret(ref) {
          expect(ref).toBe("vault:enc:v1:abc");
          return { accessKeyId: "AKIA...", secretAccessKey: "SEC..." };
        },
      },
      connectionLookup: {
        async findById(id) {
          return id === "conn-s3" ? s3Conn : null;
        },
      },
    });
    withValidResolver.registerFactory("s3", ({ resolvedSecret }) => {
      expect(resolvedSecret).toEqual({ accessKeyId: "AKIA...", secretAccessKey: "SEC..." });
      return createFakeProvider("s3", "s3-ready");
    });

    const resolved = await withValidResolver.resolveByConnectionId("conn-s3");
    expect((await resolved.checkHealth()).message).toBe("s3-ready");

    await expect(withValidResolver.resolveByConnectionId("missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
