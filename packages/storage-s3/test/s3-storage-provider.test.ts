import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { StorageError } from "@docuflow/storage-core";
import { describe, expect, it } from "vitest";
import {
  type S3ChecksumSupportMode,
  type S3CommandExecutor,
  createS3StorageProvider,
} from "../src/index.js";

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

interface StoredFakeObject {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  etag: string;
  versionId: string;
  nativeSha256Base64?: string | undefined;
}

function createFakeS3Client(
  options: {
    rejectNativeChecksumMode?: boolean;
    failDeleteWithForbidden?: boolean;
    failHeadWithForbidden?: boolean;
    corruptReturnedChecksum?: boolean;
  } = {},
): {
  readonly executor: S3CommandExecutor;
  readonly objects: Map<string, StoredFakeObject>;
  readonly commandsSeen: string[];
} {
  const objects = new Map<string, StoredFakeObject>();
  const commandsSeen: string[] = [];

  const send = async (
    command: PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand,
    opts?: { abortSignal?: AbortSignal },
  ) => {
    if (opts?.abortSignal?.aborted) {
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    if (command instanceof PutObjectCommand) {
      commandsSeen.push("PutObject");
      const key = `${command.input.Bucket}/${command.input.Key}`;
      const chunks: Buffer[] = [];
      const bodyStream = command.input.Body as Readable;
      for await (const chunk of bodyStream) {
        if (opts?.abortSignal?.aborted) {
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const data = Buffer.concat(chunks);
      const etag = `"${sha256Hex(data).slice(0, 32)}"`;
      const versionId = `v-${objects.size + 1}`;
      objects.set(key, {
        body: data,
        contentType: command.input.ContentType ?? "application/octet-stream",
        metadata: { ...(command.input.Metadata ?? {}) },
        etag,
        versionId,
        nativeSha256Base64: command.input.ChecksumSHA256,
      });
      return {
        $metadata: { httpStatusCode: 200 },
        ETag: etag,
        VersionId: versionId,
        ChecksumSHA256: command.input.ChecksumSHA256,
      };
    }

    if (command instanceof HeadObjectCommand) {
      commandsSeen.push("HeadObject");
      if (options.failHeadWithForbidden) {
        throw Object.assign(new Error("AccessDenied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        });
      }
      if (options.rejectNativeChecksumMode && command.input.ChecksumMode === "ENABLED") {
        throw Object.assign(new Error("ChecksumMode ENABLED is not implemented by provider"), {
          name: "NotImplemented",
          $metadata: { httpStatusCode: 501 },
        });
      }
      const key = `${command.input.Bucket}/${command.input.Key}`;
      const found = objects.get(key);
      if (!found) {
        throw Object.assign(new Error("NotFound"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {
        $metadata: { httpStatusCode: 200 },
        ContentType: found.contentType,
        ContentLength: found.body.length,
        Metadata: found.metadata,
        ETag: found.etag,
        VersionId: found.versionId,
        ChecksumSHA256: options.corruptReturnedChecksum
          ? hexToBase64("f".repeat(64))
          : (found.nativeSha256Base64 ?? hexToBase64(sha256Hex(found.body))),
      };
    }

    if (command instanceof GetObjectCommand) {
      commandsSeen.push("GetObject");
      if (options.rejectNativeChecksumMode && command.input.ChecksumMode === "ENABLED") {
        throw Object.assign(new Error("ChecksumMode ENABLED is not implemented by provider"), {
          name: "NotImplemented",
          $metadata: { httpStatusCode: 501 },
        });
      }
      const key = `${command.input.Bucket}/${command.input.Key}`;
      const found = objects.get(key);
      if (!found) {
        throw Object.assign(new Error("NoSuchKey"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {
        $metadata: { httpStatusCode: 200 },
        Body: Readable.from([found.body]),
        ContentType: found.contentType,
        ContentLength: found.body.length,
        Metadata: found.metadata,
        ETag: found.etag,
        VersionId: found.versionId,
        ChecksumSHA256: found.nativeSha256Base64,
      };
    }

    if (command instanceof DeleteObjectCommand) {
      commandsSeen.push("DeleteObject");
      if (options.failDeleteWithForbidden) {
        throw Object.assign(new Error("AccessDenied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        });
      }
      const key = `${command.input.Bucket}/${command.input.Key}`;
      objects.delete(key);
      return { $metadata: { httpStatusCode: 204 } };
    }

    throw new Error("Unsupported command");
  };

  return {
    executor: { send } as S3CommandExecutor,
    objects,
    commandsSeen,
  };
}

function buildProvider(
  executor: S3CommandExecutor,
  checksumSupport: S3ChecksumSupportMode = "auto",
) {
  return createS3StorageProvider(
    {
      endpoint: "https://s3.valid.example.com",
      region: "sa-east-1",
      bucket: "docuflow-bucket",
      forcePathStyle: true,
      keyPrefix: "tenant-1",
      credentials: {
        accessKeyId: "AKIATESTACCESS123",
        secretAccessKey: "super-secret-access-key-example",
      },
      timeouts: {
        connectionTimeoutMs: 2_000,
        requestTimeoutMs: 5_000,
      },
    },
    {
      client: executor,
      checksumSupport,
      dnsLookup: async () => [{ address: "52.216.10.20", family: 4 }],
    },
  );
}

describe("S3StorageProvider streaming, HEAD, checksum, and deletion", () => {
  it("supports putObject, headObject, getObject, checksum verification, and idempotent deleteObject", async () => {
    const fake = createFakeS3Client();
    const provider = buildProvider(fake.executor, "native_sha256");

    const payload = Buffer.from("Documento PDF simulado para S3");
    const checksum = sha256Hex(payload);
    const key = { value: "org/1/documents/10/versions/1/obj-1" };

    // Missing object head returns null; delete on missing key is idempotent
    expect(await provider.headObject(key)).toBeNull();
    await expect(provider.deleteObject(key)).resolves.toBeUndefined();
    await expect(provider.getObject(key)).rejects.toMatchObject({
      code: "NOT_FOUND",
      providerKind: "s3",
    });

    const stored = await provider.putObject({
      key,
      body: Readable.from([payload]),
      metadata: {
        contentType: "application/pdf",
        contentLength: payload.length,
        checksumSha256: checksum,
        customMetadata: { category: "contratos" },
      },
    });

    expect(stored.key.value).toBe(key.value);
    expect(stored.checksumSha256).toBe(checksum);
    expect(stored.etag).toBeTruthy();
    expect(stored.providerVersionId).toBe("v-1");

    const head = await provider.headObject(key);
    expect(head).toEqual({
      key,
      contentType: "application/pdf",
      contentLength: payload.length,
      checksumSha256: checksum,
      customMetadata: { category: "contratos" },
      etag: stored.etag,
      providerVersionId: "v-1",
    });

    const download = await provider.getObject(key);
    expect(download.metadata.checksumSha256).toBe(checksum);
    const chunks: Buffer[] = [];
    for await (const chunk of download.body) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks)).toEqual(payload);

    // Idempotent double delete
    await provider.deleteObject(key);
    await provider.deleteObject(key);
    expect(await provider.headObject(key)).toBeNull();
  });

  it("falls back automatically when S3-compatible provider does not support ChecksumMode=ENABLED", async () => {
    const fake = createFakeS3Client({ rejectNativeChecksumMode: true });
    const provider = buildProvider(fake.executor, "auto");

    const payload = Buffer.from("Compatibilidade sem x-amz-checksum-mode");
    const checksum = sha256Hex(payload);
    const key = { value: "org/1/documents/20/versions/1/compat-obj" };

    await provider.putObject({
      key,
      body: Readable.from([payload]),
      metadata: {
        contentType: "text/plain",
        contentLength: payload.length,
        checksumSha256: checksum,
      },
    });

    const head = await provider.headObject(key);
    expect(head?.checksumSha256).toBe(checksum);

    const downloaded = await provider.getObject(key);
    expect(downloaded.metadata.checksumSha256).toBe(checksum);
  });

  it("cleans up S3 object on checksum/length mismatch and preserves UNAUTHORIZED vs NOT_FOUND distinction", async () => {
    const fake = createFakeS3Client();
    const provider = buildProvider(fake.executor);
    const key = { value: "org/1/documents/30/versions/1/mismatch" };
    const payload = Buffer.from("conteudo-real");

    await expect(
      provider.putObject({
        key,
        body: Readable.from([payload]),
        metadata: {
          contentType: "text/plain",
          contentLength: payload.length,
          checksumSha256: "e".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH", providerKind: "s3" });

    // Divergent object was deleted immediately
    expect(fake.commandsSeen).toContain("DeleteObject");
    expect(await provider.headObject(key)).toBeNull();

    // Pre-aborted upload rejects with TIMEOUT
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.putObject({
        key,
        body: Readable.from([payload]),
        metadata: {
          contentType: "text/plain",
          contentLength: payload.length,
          checksumSha256: sha256Hex(payload),
        },
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT", providerKind: "s3" });

    // Corrupted checksum divergence between provider header and metadata triggers CHECKSUM_MISMATCH
    const corruptFake = createFakeS3Client({ corruptReturnedChecksum: true });
    const corruptProvider = buildProvider(corruptFake.executor);
    await corruptProvider.putObject({
      key,
      body: Readable.from([payload]),
      metadata: {
        contentType: "text/plain",
        contentLength: payload.length,
        checksumSha256: sha256Hex(payload),
      },
    });
    await expect(corruptProvider.headObject(key)).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
    });

    // 403 Forbidden on HEAD or DELETE MUST throw UNAUTHORIZED (never silently treat as missing/deleted)
    const forbiddenFake = createFakeS3Client({
      failHeadWithForbidden: true,
      failDeleteWithForbidden: true,
    });
    const forbiddenProvider = buildProvider(forbiddenFake.executor);
    await expect(forbiddenProvider.headObject(key)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      providerKind: "s3",
    });
    await expect(forbiddenProvider.deleteObject(key)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      providerKind: "s3",
    });
  });
});
