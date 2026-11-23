import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  type StorageConnectionDescriptor,
  StorageError,
  createStorageProviderRegistry,
} from "@docuflow/storage-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalStorageProvider, resolveSafeLocalPath } from "../../src/index.js";

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("Local storage security suite (Step 16.06)", () => {
  let baseTempDir = "";
  let storageRoot = "";
  let externalDir = "";
  let externalSecretFile = "";

  beforeEach(async () => {
    baseTempDir = await mkdtemp(path.join(os.tmpdir(), "docuflow-local-sec-"));
    storageRoot = path.join(baseTempDir, "storage-root");
    externalDir = path.join(baseTempDir, "external-secret");
    await mkdir(storageRoot, { recursive: true });
    await mkdir(externalDir, { recursive: true });

    externalSecretFile = path.join(externalDir, "host-secret.txt");
    await writeFile(externalSecretFile, "TOP_SECRET_OUTSIDE_ROOT", "utf8");
  });

  afterEach(async () => {
    if (baseTempDir) {
      await rm(baseTempDir, { recursive: true, force: true });
    }
  });

  it("blocks path traversal, backslash, URL encoding, dotfiles, control chars, and deep paths across all operations", async () => {
    const provider = createLocalStorageProvider({
      rootDirectory: storageRoot,
      fsync: false,
    });

    const payload = Buffer.from("%PDF-1.7\nTraversal Attempt\n%%EOF\n", "utf8");
    const checksum = sha256Hex(payload);

    const maliciousKeys = [
      "../outside.pdf",
      "org/../../etc/passwd",
      "org\\..\\outside.pdf",
      "org/%2e%2e/outside.pdf",
      "/etc/passwd",
      "org/docs/",
      "org/.env",
      "org/.docuflow-meta/secret.json",
      "org/docs/file\0.pdf",
      "org/docs/CON",
      "org/docs/nul.pdf",
      " org/docs/leading-space.pdf",
      Array.from({ length: 17 }, (_, i) => `seg${i}`).join("/"),
    ];

    for (const rawKey of maliciousKeys) {
      await expect(resolveSafeLocalPath(storageRoot, rawKey)).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });

      await expect(
        provider.putObject({
          key: { value: rawKey },
          body: Readable.from(payload),
          metadata: {
            contentType: "application/pdf",
            contentLength: payload.byteLength,
            checksumSha256: checksum,
          },
        }),
      ).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });

      await expect(provider.getObject({ value: rawKey })).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });

      await expect(provider.headObject({ value: rawKey })).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });

      await expect(provider.deleteObject({ value: rawKey })).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });
    }

    expect(await readFile(externalSecretFile, "utf8")).toBe("TOP_SECRET_OUTSIDE_ROOT");
  });

  it("blocks symlink escape via file symlink and parent directory symlink", async () => {
    const provider = createLocalStorageProvider({
      rootDirectory: storageRoot,
      fsync: false,
    });

    // 1. Symlink de arquivo apontando para fora da raiz
    const linkParentDir = path.join(storageRoot, "org", "1", "documents", "doc1");
    await mkdir(linkParentDir, { recursive: true });
    const fileSymlinkKey = "org/1/documents/doc1/escape-file.pdf";
    await symlink(externalSecretFile, path.join(storageRoot, fileSymlinkKey));

    // 2. Symlink de diretório intermediário apontando para pasta externa
    const dirSymlinkParent = path.join(storageRoot, "org", "1", "escaped-dir");
    await symlink(externalDir, dirSymlinkParent);
    const dirSymlinkKey = "org/1/escaped-dir/host-secret.txt";
    const dirWriteKey = "org/1/escaped-dir/pwned.txt";

    for (const key of [fileSymlinkKey, dirSymlinkKey, dirWriteKey]) {
      await expect(resolveSafeLocalPath(storageRoot, key)).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });
      await expect(provider.getObject({ value: key })).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });
      await expect(provider.headObject({ value: key })).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });
      await expect(provider.deleteObject({ value: key })).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });

      const attemptPayload = Buffer.from("OVERWRITE_ATTEMPT", "utf8");
      await expect(
        provider.putObject({
          key: { value: key },
          body: Readable.from(attemptPayload),
          metadata: {
            contentType: "text/plain",
            contentLength: attemptPayload.byteLength,
            checksumSha256: sha256Hex(attemptPayload),
          },
        }),
      ).rejects.toMatchObject({
        name: "StorageError",
        code: "INVALID_KEY",
      });
    }

    // Conteúdo e existência do arquivo externo permanecem intactos
    expect(await readFile(externalSecretFile, "utf8")).toBe("TOP_SECRET_OUTSIDE_ROOT");
  });

  it("blocks access to stored objects when the local storage connection is deactivated", async () => {
    const activeConnection: StorageConnectionDescriptor = {
      id: "conn-local-sec-1",
      organizationId: "org-sec-1",
      name: "Local Primário",
      kind: "local",
      status: "ACTIVE",
      nonSecretConfig: { rootDirectory: storageRoot },
      encryptedSecretRef: null,
    };
    let currentConnection: StorageConnectionDescriptor = activeConnection;

    const registry = createStorageProviderRegistry({
      connectionLookup: {
        async findById(connectionId) {
          return connectionId === currentConnection.id ? currentConnection : null;
        },
      },
    });

    registry.registerFactory("local", ({ connection }) =>
      createLocalStorageProvider({
        rootDirectory: String(connection.nonSecretConfig.rootDirectory ?? ""),
        fsync: false,
      }),
    );

    const objectKey = { value: "org/org-sec-1/documents/d1/versions/v1/obj-1" };
    const content = Buffer.from("%PDF-1.7\nActive Connection Data\n%%EOF\n", "utf8");

    const activeProvider = await registry.resolveByConnectionId(activeConnection.id);
    await activeProvider.putObject({
      key: objectKey,
      body: Readable.from(content),
      metadata: {
        contentType: "application/pdf",
        contentLength: content.byteLength,
        checksumSha256: sha256Hex(content),
      },
    });

    // Desativar a conexão e invalidar cache bloqueia qualquer leitura/gravação comum
    currentConnection = { ...activeConnection, status: "INACTIVE" };
    registry.invalidate(activeConnection.id);

    await expect(registry.resolveProvider(currentConnection)).rejects.toMatchObject({
      name: "StorageError",
      code: "UNAVAILABLE",
    });
    await expect(registry.resolveByConnectionId(activeConnection.id)).rejects.toMatchObject({
      name: "StorageError",
      code: "UNAVAILABLE",
    });

    // O objeto físico permanece preservado para auditoria/migração autorizada com allowInactive
    const recoveryProvider = await registry.resolveByConnectionId(activeConnection.id, {
      allowInactive: true,
    });
    const downloaded = await recoveryProvider.getObject(objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of downloaded.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(content)).toBe(true);
    expect(downloaded.metadata).not.toBeNull();
  });
});
