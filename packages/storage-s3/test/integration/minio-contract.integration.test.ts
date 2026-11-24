import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  StorageError,
  buildStorageProviderContractScenarios,
  requireSignedDownloadTargetProvider,
  requireSignedUploadTargetProvider,
} from "@papyrus/storage-core";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type S3StorageConfigInput, createS3StorageProvider } from "../../src/index.js";

const MINIO_IMAGE = "cgr.dev/chainguard/minio:latest";
const MINIO_ACCESS_KEY = "papyrusminio";
const MINIO_SECRET_KEY = "PapyrusMinioPassword2026!";
const MINIO_BUCKET = "papyrus-integration";

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function makeMinioConfig(
  endpoint: string,
  bucket = MINIO_BUCKET,
  secretKey = MINIO_SECRET_KEY,
): S3StorageConfigInput {
  return {
    endpoint,
    region: "us-east-1",
    bucket,
    forcePathStyle: true,
    keyPrefix: "integration-tenant",
    tls: {
      allowInsecureHttp: true,
      rejectUnauthorized: false,
    },
    credentials: {
      accessKeyId: MINIO_ACCESS_KEY,
      secretAccessKey: secretKey,
    },
    timeouts: {
      connectionTimeoutMs: 5_000,
      requestTimeoutMs: 15_000,
    },
  };
}

describe("S3StorageProvider integration against MinIO", () => {
  let container: StartedTestContainer | null = null;
  let endpoint = "";

  const scenarios = buildStorageProviderContractScenarios();

  beforeAll(async () => {
    const externalEndpoint = process.env.MINIO_ENDPOINT?.trim();
    if (externalEndpoint) {
      endpoint = externalEndpoint;
    } else {
      container = await new GenericContainer(MINIO_IMAGE)
        .withEnvironment({
          MINIO_ROOT_USER: MINIO_ACCESS_KEY,
          MINIO_ROOT_PASSWORD: MINIO_SECRET_KEY,
        })
        .withCommand(["server", "/data", "--address", ":9000"])
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000).forStatusCode(200))
        .start();

      endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    }

    const setupClient = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
      },
    });

    await setupClient.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
    setupClient.destroy();
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  describe("Shared StorageProvider contract suite on MinIO", () => {
    for (const [index, scenario] of scenarios.entries()) {
      it(scenario.name, async () => {
        const provider = createS3StorageProvider(makeMinioConfig(endpoint), {
          securityPolicy: { allowPrivateEndpoints: true },
          healthVerifyReadWrite: true,
        });
        await scenario.run({
          provider,
          keyPrefix: `org/contract-org/documents/minio-doc-${index + 1}`,
        });
      });
    }
  });

  describe("Shared StorageProvider contract suite on MinIO (signed targets enabled)", () => {
    for (const [index, scenario] of scenarios.entries()) {
      it(scenario.name, async () => {
        const provider = createS3StorageProvider(makeMinioConfig(endpoint), {
          securityPolicy: { allowPrivateEndpoints: true },
          enableSignedTargets: true,
          healthVerifyReadWrite: true,
        });
        await scenario.run({
          provider,
          keyPrefix: `org/contract-org/documents/minio-signed-doc-${index + 1}`,
        });
      });
    }
  });

  it("uploads and downloads via real SigV4 presigned targets against MinIO", async () => {
    const provider = createS3StorageProvider(makeMinioConfig(endpoint), {
      securityPolicy: { allowPrivateEndpoints: true },
      enableSignedTargets: true,
    });

    const uploadProvider = requireSignedUploadTargetProvider(provider);
    const downloadProvider = requireSignedDownloadTargetProvider(provider);

    const payload = Buffer.from("Conteúdo real enviado via URL assinada para o MinIO!");
    const key = { value: "org/1/documents/presigned-1/versions/1/file-bin" };

    const uploadTarget = await uploadProvider.createSignedUploadTarget({
      key,
      contentType: "text/plain",
      contentLength: payload.length,
      expiresInSeconds: 120,
    });

    const putRes = await fetch(uploadTarget.url, {
      method: uploadTarget.method,
      headers: uploadTarget.headers,
      body: payload,
    });
    expect(putRes.ok).toBe(true);

    const downloadTarget = await downloadProvider.createSignedDownloadTarget({
      key,
      expiresInSeconds: 120,
      downloadName: "contrato-minio.txt",
    });

    const getRes = await fetch(downloadTarget.url, { method: downloadTarget.method });
    expect(getRes.ok).toBe(true);
    expect(getRes.headers.get("content-disposition")).toContain('filename="contrato-minio.txt"');
    const downloadedBytes = Buffer.from(await getRes.arrayBuffer());
    expect(downloadedBytes).toEqual(payload);

    await provider.deleteObject(key);
  });

  it("handles bad credentials, missing bucket, unreachable endpoint, and persists objects across MinIO restart", async () => {
    // 1. Bad secret key fails closed with UNAUTHORIZED and unhealthy status
    const badCredsProvider = createS3StorageProvider(
      makeMinioConfig(endpoint, MINIO_BUCKET, "WrongMinioSecretKey9999!"),
      { securityPolicy: { allowPrivateEndpoints: true } },
    );
    const badHealth = await badCredsProvider.checkHealth();
    expect(badHealth.healthy).toBe(false);
    await expect(
      badCredsProvider.headObject({ value: "org/1/documents/x/versions/1/y" }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      providerKind: "s3",
    });

    // 2. Missing bucket fails health check cleanly
    const missingBucketProvider = createS3StorageProvider(
      makeMinioConfig(endpoint, "non-existent-papyrus-bucket"),
      { securityPolicy: { allowPrivateEndpoints: true } },
    );
    const missingBucketHealth = await missingBucketProvider.checkHealth();
    expect(missingBucketHealth.healthy).toBe(false);

    // 3. Unreachable port yields normalized UNAVAILABLE / TIMEOUT error
    const unreachableProvider = createS3StorageProvider(makeMinioConfig("http://127.0.0.1:19999"), {
      securityPolicy: { allowPrivateEndpoints: true },
    });
    const unreachableHealth = await unreachableProvider.checkHealth();
    expect(unreachableHealth.healthy).toBe(false);
    await expect(
      unreachableProvider.headObject({ value: "org/1/documents/x/versions/1/y" }),
    ).rejects.toBeInstanceOf(StorageError);

    // 4. Persist object, restart MinIO container, and verify object still streams cleanly
    const providerBeforeRestart = createS3StorageProvider(makeMinioConfig(endpoint), {
      securityPolicy: { allowPrivateEndpoints: true },
    });
    const persistentKey = { value: "org/1/documents/restart-doc/versions/1/persistent-obj" };
    const persistentPayload = Buffer.from("Dados persistidos antes do restart do MinIO");
    const persistentChecksum = sha256Hex(persistentPayload);

    await providerBeforeRestart.putObject({
      key: persistentKey,
      body: Readable.from([persistentPayload]),
      metadata: {
        contentType: "application/octet-stream",
        contentLength: persistentPayload.length,
        checksumSha256: persistentChecksum,
      },
    });

    if (container) {
      await container.restart();
      endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    }

    const providerAfterRestart = createS3StorageProvider(makeMinioConfig(endpoint), {
      securityPolicy: { allowPrivateEndpoints: true },
      healthVerifyReadWrite: true,
    });

    const healthAfter = await providerAfterRestart.checkHealth();
    expect(healthAfter.healthy).toBe(true);

    const headAfter = await providerAfterRestart.headObject(persistentKey);
    expect(headAfter?.contentLength).toBe(persistentPayload.length);
    expect(headAfter?.checksumSha256).toBe(persistentChecksum);

    const downloadAfter = await providerAfterRestart.getObject(persistentKey);
    const readChunks: Buffer[] = [];
    for await (const chunk of downloadAfter.body) {
      readChunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(readChunks)).toEqual(persistentPayload);
  }, 120_000);
});
