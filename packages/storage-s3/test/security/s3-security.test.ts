import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  type StorageConnectionDescriptor,
  StorageError,
  createStorageProviderRegistry,
  requireSignedDownloadTargetProvider,
  requireSignedUploadTargetProvider,
} from "@papyrus/storage-core";
import { describe, expect, it } from "vitest";
import {
  type S3CommandExecutor,
  createS3StorageProvider,
  parseS3StorageConfig,
  sanitizeS3ConfigSummary,
  validateS3EndpointResolution,
  validateS3EndpointUrl,
} from "../../src/index.js";

const SECRET_ACCESS_KEY = "SuperSecretS3KeyShouldNeverLeak!2026";
const SESSION_TOKEN = "FwoGZXIvYXdzEBYaDExampleSessionTokenSecret";

const BASE_PUBLIC_S3_CONFIG = {
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "papyrus-security-bucket",
  forcePathStyle: true,
  keyPrefix: "tenant-sec",
  credentials: {
    accessKeyId: "AKIASECURITYTEST1234",
    secretAccessKey: SECRET_ACCESS_KEY,
    sessionToken: SESSION_TOKEN,
  },
};

const BASE_SIGNED_S3_CONFIG = {
  ...BASE_PUBLIC_S3_CONFIG,
  credentials: {
    accessKeyId: "AKIASECURITYTEST1234",
    secretAccessKey: SECRET_ACCESS_KEY,
  },
};

describe("S3 storage security suite (Step 16.06)", () => {
  it("blocks SSRF endpoints including metadata services, loopback, RFC1918, CGNAT, internal hostnames, and DNS rebinding", async () => {
    const blockedEndpoints = [
      "http://s3.us-east-1.amazonaws.com",
      "https://user:password@s3.us-east-1.amazonaws.com",
      "https://s3.us-east-1.amazonaws.com?redirect=http://127.0.0.1",
      "https://s3.us-east-1.amazonaws.com#fragment",
      "http://169.254.169.254",
      "https://169.254.169.254",
      "https://[::ffff:169.254.169.254]",
      "https://[fd00:ec2::254]",
      "https://metadata.google.internal",
      "https://metadata.goog",
      "https://instance-data",
      "https://127.0.0.1:9000",
      "https://10.0.0.12:9000",
      "https://172.16.10.5:9000",
      "https://192.168.1.50:9000",
      "https://100.64.1.10:9000",
      "https://[::1]:9000",
      "https://[fc00::10]:9000",
      "https://[fe80::1]:9000",
      "https://localhost:9000",
      "https://minio.local:9000",
      "https://storage.internal:9000",
      "https://minio:9000",
      "ftp://files.example.com",
    ];

    for (const endpoint of blockedEndpoints) {
      expect(() => validateS3EndpointUrl(endpoint)).toThrowError(StorageError);
      expect(() =>
        parseS3StorageConfig({
          ...BASE_PUBLIC_S3_CONFIG,
          endpoint,
        }),
      ).toThrowError(StorageError);
    }

    // Metadata IP deve permanecer bloqueado mesmo com allowPrivateEndpoints ou allowedHosts explícitos
    expect(() =>
      validateS3EndpointUrl("http://169.254.169.254", {
        allowInsecureHttp: true,
        allowPrivateEndpoints: true,
        allowedHosts: ["169.254.169.254"],
      }),
    ).toThrowError(StorageError);

    // DNS rebinding: hostname público resolvendo para IP interno ou de metadados
    for (const resolvedIp of ["127.0.0.1", "169.254.169.254", "10.20.30.40", "fc00::1"]) {
      await expect(
        validateS3EndpointResolution("https://s3.partner-storage.example.com", {}, async () => [
          { address: resolvedIp, family: resolvedIp.includes(":") ? 6 : 4 },
        ]),
      ).rejects.toMatchObject({
        name: "StorageError",
        code: "UNAUTHORIZED",
      });
    }
  });

  it("never exposes credentials in sanitized summaries, StorageError logs, or presigned URLs", async () => {
    const parsed = parseS3StorageConfig({
      ...BASE_PUBLIC_S3_CONFIG,
      tls: {
        rejectUnauthorized: true,
        allowInsecureHttp: false,
        caCertificatePem: "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
      },
    });

    const summary = sanitizeS3ConfigSummary(parsed);
    const serializedSummary = JSON.stringify(summary);
    expect(summary.hasCredentials).toBe(true);
    expect(summary.tls.hasCustomCa).toBe(true);
    expect(serializedSummary).not.toContain(SECRET_ACCESS_KEY);
    expect(serializedSummary).not.toContain(SESSION_TOKEN);
    expect(serializedSummary).not.toContain(BASE_PUBLIC_S3_CONFIG.credentials.accessKeyId);
    expect(serializedSummary).not.toContain("BEGIN CERTIFICATE");

    // StorageError sanitiza credenciais e assinaturas se erro bruto incluir segredos
    const sanitizedError = new StorageError(
      "UNAUTHORIZED",
      `Falha ao conectar https://admin:topsecret@s3.example.com secretAccessKey=${SECRET_ACCESS_KEY} x-amz-signature=deadbeef`,
      "s3",
    );
    expect(sanitizedError.message).not.toContain("topsecret");
    expect(sanitizedError.message).not.toContain(SECRET_ACCESS_KEY);
    expect(sanitizedError.message).not.toContain("deadbeef");
    expect(sanitizedError.message).toContain("[REDACTED]");

    // Presigner comprometido que vaze secretAccessKey ou sessionToken na URL é bloqueado fail-closed
    const leakyUploadProvider = createS3StorageProvider(BASE_PUBLIC_S3_CONFIG, {
      enableSignedTargets: true,
      signedTargetsOptions: {
        presign: async () => `https://s3.us-east-1.amazonaws.com/obj?leak=${SECRET_ACCESS_KEY}`,
      },
    });
    await expect(
      requireSignedUploadTargetProvider(leakyUploadProvider).createSignedUploadTarget({
        key: { value: "org/1/documents/2/versions/1/obj" },
        contentType: "application/pdf",
        contentLength: 100,
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "UNAUTHORIZED",
    });
  });

  it("enforces short TTL bounds, single-key safety, header sanitization, and expiration errors on signed URLs", async () => {
    const fixedNow = new Date("2026-11-23T18:00:00.000Z");
    const provider = createS3StorageProvider(BASE_SIGNED_S3_CONFIG, {
      enableSignedTargets: true,
      signedTargetsOptions: {
        now: () => fixedNow,
        minExpiresInSeconds: 15,
        maxExpiresInSeconds: 120,
        maxUploadBytes: 1024,
      },
    });

    const uploadSigner = requireSignedUploadTargetProvider(provider);
    const downloadSigner = requireSignedDownloadTargetProvider(provider);

    // TTL fora do intervalo [15, 120] ou não inteiro é rejeitado
    for (const invalidTtl of [-10, 0, 14, 121, 30.5]) {
      await expect(
        uploadSigner.createSignedUploadTarget({
          key: { value: "org/1/documents/2/versions/1/obj" },
          contentType: "application/pdf",
          contentLength: 512,
          expiresInSeconds: invalidTtl,
        }),
      ).rejects.toMatchObject({ name: "StorageError", code: "CONFLICT" });

      await expect(
        downloadSigner.createSignedDownloadTarget({
          key: { value: "org/1/documents/2/versions/1/obj" },
          expiresInSeconds: invalidTtl,
        }),
      ).rejects.toMatchObject({ name: "StorageError", code: "CONFLICT" });
    }

    // Traversal na chave ou injeção CRLF em Content-Type são rejeitados antes de assinar
    for (const badKey of ["../escape", "org\\escape", "/leading/slash", "org/.hidden/obj"]) {
      await expect(
        downloadSigner.createSignedDownloadTarget({
          key: { value: badKey },
          expiresInSeconds: 60,
        }),
      ).rejects.toMatchObject({ name: "StorageError", code: "INVALID_KEY" });
    }

    await expect(
      uploadSigner.createSignedUploadTarget({
        key: { value: "org/1/documents/2/versions/1/obj" },
        contentType: "application/pdf\r\nX-Injected: evil",
        contentLength: 512,
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ name: "StorageError", code: "INVALID_KEY" });

    // URL gerada possui expiração exata, X-Amz-Expires na query e nenhuma credencial secreta
    const downloadTarget = await downloadSigner.createSignedDownloadTarget({
      key: { value: "org/1/documents/2/versions/1/obj" },
      expiresInSeconds: 45,
      downloadName: '../../malicious\r\n"name";evil.pdf',
    });
    expect(downloadTarget.expiresAt.toISOString()).toBe("2026-11-23T18:00:45.000Z");
    const parsedUrl = new URL(downloadTarget.url);
    expect(parsedUrl.searchParams.get("X-Amz-Expires")).toBe("45");
    expect(downloadTarget.url).not.toContain(SECRET_ACCESS_KEY);
    expect(downloadTarget.url).not.toContain(SESSION_TOKEN);

    // Simula resposta S3 de URL assinada expirada/recusada (403 ExpiredToken / AccessDenied)
    const expiredRespondingProvider = createS3StorageProvider(BASE_PUBLIC_S3_CONFIG, {
      client: {
        async send() {
          throw Object.assign(new Error("Request has expired"), {
            name: "AccessDenied",
            Code: "AccessDenied",
            $metadata: { httpStatusCode: 403 },
          });
        },
      },
    });

    await expect(
      expiredRespondingProvider.getObject({ value: "org/1/documents/2/versions/1/obj" }),
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "UNAUTHORIZED",
    });
  });

  it("blocks S3 object operations and signed target issuance when connection is deactivated", async () => {
    const activeConnection: StorageConnectionDescriptor = {
      id: "conn-s3-sec-1",
      organizationId: "org-sec-1",
      name: "S3 Corporativo",
      kind: "s3",
      status: "ACTIVE",
      nonSecretConfig: {
        endpoint: BASE_PUBLIC_S3_CONFIG.endpoint,
        region: BASE_PUBLIC_S3_CONFIG.region,
        bucket: BASE_PUBLIC_S3_CONFIG.bucket,
        forcePathStyle: true,
      },
      encryptedSecretRef: "vault://s3-sec-1",
    };

    let currentConnection = activeConnection;
    const objects = new Map<string, Buffer>();

    const registry = createStorageProviderRegistry({
      secretResolver: {
        async resolveSecret() {
          return {
            accessKeyId: BASE_PUBLIC_S3_CONFIG.credentials.accessKeyId,
            secretAccessKey: SECRET_ACCESS_KEY,
          };
        },
      },
      connectionLookup: {
        async findById(connectionId) {
          return connectionId === currentConnection.id ? currentConnection : null;
        },
      },
    });

    registry.registerFactory("s3", ({ connection, resolvedSecret }) =>
      createS3StorageProvider(
        {
          endpoint: String(connection.nonSecretConfig.endpoint),
          region: String(connection.nonSecretConfig.region),
          bucket: String(connection.nonSecretConfig.bucket),
          forcePathStyle: Boolean(connection.nonSecretConfig.forcePathStyle),
          credentials: {
            accessKeyId: String(resolvedSecret?.accessKeyId ?? ""),
            secretAccessKey: String(resolvedSecret?.secretAccessKey ?? ""),
          },
        },
        {
          enableSignedTargets: true,
          client: {
            async send(command: PutObjectCommand | HeadObjectCommand) {
              if (command instanceof PutObjectCommand) {
                const key = command.input.Key ?? "";
                const chunks: Buffer[] = [];
                const body = command.input.Body;
                if (body && typeof body === "object" && Symbol.asyncIterator in body) {
                  for await (const chunk of body as AsyncIterable<Buffer | string>) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                  }
                }
                objects.set(key, Buffer.concat(chunks));
                return { $metadata: { httpStatusCode: 200 }, ETag: '"etag-1"' };
              }
              if (command instanceof HeadObjectCommand) {
                const key = command.input.Key ?? "";
                const buf = objects.get(key);
                if (!buf) {
                  throw Object.assign(new Error("NotFound"), {
                    name: "NotFound",
                    $metadata: { httpStatusCode: 404 },
                  });
                }
                return {
                  $metadata: { httpStatusCode: 200 },
                  ContentLength: buf.byteLength,
                  ContentType: "application/pdf",
                  ETag: '"etag-1"',
                };
              }
              return { $metadata: { httpStatusCode: 200 } };
            },
          } as S3CommandExecutor,
        },
      ),
    );

    const activeProvider = await registry.resolveByConnectionId(activeConnection.id);
    const pdfPayload = Buffer.from("%PDF-1.7\nS3 Active\n%%EOF\n", "utf8");
    const checksumSha256 = createHash("sha256").update(pdfPayload).digest("hex");
    await activeProvider.putObject({
      key: { value: "org/1/documents/1/versions/1/obj-s3" },
      body: Readable.from(pdfPayload),
      metadata: {
        contentType: "application/pdf",
        contentLength: pdfPayload.byteLength,
        checksumSha256,
      },
    });

    // Conexão S3 desativada bloqueia resolução e emissão de URLs assinadas
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
  });
});
