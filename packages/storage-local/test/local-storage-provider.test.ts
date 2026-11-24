import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { StorageError } from "@papyrus/storage-core";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStorageProvider } from "../src/index.js";

const tempDirs: string[] = [];
const permissionRestores: Array<() => Promise<void>> = [];

async function makeTempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "papyrus-put-"));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

afterEach(async () => {
  while (permissionRestores.length > 0) {
    const restore = permissionRestores.pop();
    if (restore) {
      await restore();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("LocalStorageProvider putObject streaming", () => {
  it("writes multi-chunk streams atomically with SHA-256 verification and empty stream support", async () => {
    const rootDirectory = await makeTempRoot();
    const provider = createLocalStorageProvider({ rootDirectory });

    // 1. Empty stream
    const emptyKey = "org/1/documents/1/versions/1/empty-obj";
    const emptyChecksum = sha256Hex(Buffer.alloc(0));
    const emptyStored = await provider.putObject({
      key: { value: emptyKey },
      body: Readable.from([]),
      metadata: {
        contentType: "application/octet-stream",
        contentLength: 0,
        checksumSha256: emptyChecksum,
      },
    });
    expect(emptyStored.contentLength).toBe(0);
    expect(emptyStored.checksumSha256).toBe(emptyChecksum);
    expect(await readFile(path.join(rootDirectory, emptyKey))).toEqual(Buffer.alloc(0));

    // 2. Large chunked stream (2 MiB across multiple chunks)
    const chunks = Array.from({ length: 32 }, (_, idx) => Buffer.alloc(64 * 1024, idx + 1));
    const fullBuffer = Buffer.concat(chunks);
    const fullChecksum = sha256Hex(fullBuffer);
    const largeKey = "org/1/documents/1/versions/2/large-obj";

    const stored = await provider.putObject({
      key: { value: largeKey },
      body: Readable.from(chunks),
      metadata: {
        contentType: "application/pdf",
        contentLength: fullBuffer.length,
        checksumSha256: fullChecksum.toUpperCase(),
        customMetadata: { versionTag: "v2" },
      },
    });

    expect(stored.key.value).toBe(largeKey);
    expect(stored.contentLength).toBe(fullBuffer.length);
    expect(stored.checksumSha256).toBe(fullChecksum);
    expect(stored.etag).toBe(fullChecksum);
    expect(await readFile(path.join(rootDirectory, largeKey))).toEqual(fullBuffer);

    // Ensure no leftover .tmp-* files remain in parent directory
    const siblingEntries = await readdir(path.dirname(path.join(rootDirectory, largeKey)));
    expect(siblingEntries.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("rejects checksum mismatch, declared length mismatch, and size limit exceedance without leaving target or temp files", async () => {
    const rootDirectory = await makeTempRoot();
    const provider = createLocalStorageProvider({
      rootDirectory,
      maxObjectSizeBytes: 1024,
    });

    const payload = Buffer.from("conteudo-seguro-papyrus");
    const validChecksum = sha256Hex(payload);

    // Checksum mismatch
    const badChecksumKey = "org/1/documents/2/versions/1/bad-checksum";
    await expect(
      provider.putObject({
        key: { value: badChecksumKey },
        body: Readable.from([payload]),
        metadata: {
          contentType: "text/plain",
          contentLength: payload.length,
          checksumSha256: "f".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH", providerKind: "local" });

    const dirAfterBadChecksum = await readdir(
      path.dirname(path.join(rootDirectory, badChecksumKey)),
    );
    expect(dirAfterBadChecksum).toEqual([]);

    // Length mismatch
    const badLengthKey = "org/1/documents/2/versions/2/bad-length";
    await expect(
      provider.putObject({
        key: { value: badLengthKey },
        body: Readable.from([payload]),
        metadata: {
          contentType: "text/plain",
          contentLength: payload.length + 10,
          checksumSha256: validChecksum,
        },
      }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });

    const dirAfterBadLength = await readdir(path.dirname(path.join(rootDirectory, badLengthKey)));
    expect(dirAfterBadLength).toEqual([]);

    // Exceeds configured maxObjectSizeBytes during streaming
    const oversized = Buffer.alloc(2048, 7);
    const oversizedKey = "org/1/documents/2/versions/3/oversized";
    await expect(
      provider.putObject({
        key: { value: oversizedKey },
        body: Readable.from([oversized]),
        metadata: {
          contentType: "application/octet-stream",
          contentLength: 512,
          checksumSha256: sha256Hex(oversized),
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("handles abort signal cleanly and removes temporary files on stream failure or abort", async () => {
    const rootDirectory = await makeTempRoot();
    const provider = createLocalStorageProvider({ rootDirectory });

    // Pre-aborted signal
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      provider.putObject({
        key: { value: "org/1/documents/3/versions/1/pre-abort" },
        body: Readable.from([Buffer.from("abc")]),
        metadata: {
          contentType: "text/plain",
          contentLength: 3,
          checksumSha256: sha256Hex(Buffer.from("abc")),
        },
        abortSignal: preAborted.signal,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT", providerKind: "local" });

    // Mid-stream abort
    const midAbortController = new AbortController();
    const slowStream = new Readable({
      read() {
        this.push(Buffer.from("parte-1"));
        setTimeout(() => {
          midAbortController.abort();
        }, 10);
      },
    });
    const abortKey = "org/1/documents/3/versions/2/mid-abort";

    await expect(
      provider.putObject({
        key: { value: abortKey },
        body: slowStream,
        metadata: {
          contentType: "text/plain",
          contentLength: 100,
          checksumSha256: "a".repeat(64),
        },
        abortSignal: midAbortController.signal,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    const dirEntries = await readdir(path.dirname(path.join(rootDirectory, abortKey)));
    expect(dirEntries).toEqual([]);

    // Path traversal blocked before write
    await expect(
      provider.putObject({
        key: { value: "../escape" },
        body: Readable.from([Buffer.from("x")]),
        metadata: {
          contentType: "text/plain",
          contentLength: 1,
          checksumSha256: sha256Hex(Buffer.from("x")),
        },
      }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it("reads objects via stream, inspects metadata with headObject, and deletes idempotently", async () => {
    const rootDirectory = await makeTempRoot();
    const provider = createLocalStorageProvider({ rootDirectory, fsync: false });

    const key = { value: "org/10/documents/20/versions/1/doc-read" };
    const payload = Buffer.from("Conteúdo binário papyrus para leitura em streaming.");
    const checksum = sha256Hex(payload);

    // Non-existent object behavior
    expect(await provider.headObject(key)).toBeNull();
    await expect(provider.getObject(key)).rejects.toMatchObject({
      code: "NOT_FOUND",
      providerKind: "local",
    });

    await provider.putObject({
      key,
      body: Readable.from([payload]),
      metadata: {
        contentType: "application/pdf",
        contentLength: payload.length,
        checksumSha256: checksum,
        customMetadata: { documentId: "doc-20" },
      },
    });

    const head = await provider.headObject(key);
    expect(head).toEqual({
      key,
      contentType: "application/pdf",
      contentLength: payload.length,
      checksumSha256: checksum,
      customMetadata: { documentId: "doc-20" },
      etag: checksum,
    });

    const download = await provider.getObject(key);
    expect(download.metadata).toEqual({
      contentType: "application/pdf",
      contentLength: payload.length,
      checksumSha256: checksum,
      customMetadata: { documentId: "doc-20" },
    });

    const readChunks: Buffer[] = [];
    for await (const chunk of download.body) {
      readChunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(readChunks)).toEqual(payload);

    // Sidecar missing fallback computes SHA-256 via stream cleanly
    await rm(path.join(rootDirectory, ".papyrus-meta", `${key.value}.json`), { force: true });
    const headWithoutSidecar = await provider.headObject(key);
    expect(headWithoutSidecar?.checksumSha256).toBe(checksum);
    expect(headWithoutSidecar?.contentLength).toBe(payload.length);

    // Detect on-disk size tampering if sidecar diverges from file size
    await provider.putObject({
      key,
      body: Readable.from([payload]),
      metadata: {
        contentType: "application/pdf",
        contentLength: payload.length,
        checksumSha256: checksum,
      },
    });
    await writeFile(path.join(rootDirectory, key.value), Buffer.from("tampered"));
    await expect(provider.headObject(key)).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
    });

    // Idempotent delete removes object and returns cleanly when called twice
    await provider.deleteObject(key);
    expect(await provider.headObject(key)).toBeNull();
    await expect(provider.deleteObject(key)).resolves.toBeUndefined();
  });

  it("distinguishes NOT_FOUND from permission/I/O failures on headObject, getObject, and deleteObject", async () => {
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) {
      return;
    }

    const rootDirectory = await makeTempRoot();
    const provider = createLocalStorageProvider({ rootDirectory, fsync: false });

    const lockedKey = { value: "org/99/documents/1/versions/1/locked-file" };
    const payload = Buffer.from("dados-protegidos");
    await provider.putObject({
      key: lockedKey,
      body: Readable.from([payload]),
      metadata: {
        contentType: "text/plain",
        contentLength: payload.length,
        checksumSha256: sha256Hex(payload),
      },
    });

    const targetPath = path.join(rootDirectory, lockedKey.value);
    const parentDir = path.dirname(targetPath);

    // 1. Removing read permission on file makes getObject throw UNAUTHORIZED (not NOT_FOUND)
    await chmod(targetPath, 0o000);
    permissionRestores.push(async () => {
      await chmod(targetPath, 0o640);
    });
    await expect(provider.getObject(lockedKey)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      providerKind: "local",
    });
    await chmod(targetPath, 0o640);

    // 2. Removing traverse/write permissions on parent directory makes headObject, getObject, and deleteObject throw UNAUTHORIZED
    await chmod(parentDir, 0o000);
    permissionRestores.push(async () => {
      await chmod(parentDir, 0o750);
    });

    await expect(provider.headObject(lockedKey)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      providerKind: "local",
    });
    await expect(provider.getObject(lockedKey)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      providerKind: "local",
    });
    await expect(provider.deleteObject(lockedKey)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      providerKind: "local",
    });
  });
});
