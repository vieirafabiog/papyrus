import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { StorageError } from "@docuflow/storage-core";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStorageProvider } from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "docuflow-put-"));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

afterEach(async () => {
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

    const payload = Buffer.from("conteudo-seguro-docuflow");
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
});
