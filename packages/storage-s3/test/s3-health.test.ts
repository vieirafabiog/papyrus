import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  type S3CommandExecutor,
  checkS3StorageHealth,
  createS3StorageProvider,
  parseS3StorageConfig,
} from "../src/index.js";

const VALID_CONFIG = parseS3StorageConfig({
  endpoint: "https://s3.valid.example.com",
  region: "sa-east-1",
  bucket: "papyrus-health-bucket",
  forcePathStyle: true,
  keyPrefix: "tenant-1",
  credentials: {
    accessKeyId: "AKIAHEALTHKEY123456",
    secretAccessKey: "TopSecretS3HealthCredential2026!",
  },
});

describe("S3 health check", () => {
  it("verifies bucket access with HeadBucket without listing objects and supports optional R/W probe", async () => {
    const executedCommands: string[] = [];

    const executor: S3CommandExecutor = {
      async send(
        command:
          | HeadBucketCommand
          | PutObjectCommand
          | GetObjectCommand
          | HeadObjectCommand
          | DeleteObjectCommand,
      ) {
        if (command instanceof HeadBucketCommand) {
          executedCommands.push("HeadBucket");
          expect(command.input.Bucket).toBe("papyrus-health-bucket");
          return { $metadata: { httpStatusCode: 200 } };
        }
        if (command instanceof PutObjectCommand) {
          executedCommands.push("PutObject");
          expect(command.input.Key).toMatch(/^tenant-1\/\.papyrus-health-probe-/);
          return { $metadata: { httpStatusCode: 200 } };
        }
        if (command instanceof DeleteObjectCommand) {
          executedCommands.push("DeleteObject");
          return { $metadata: { httpStatusCode: 204 } };
        }
        if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
          throw Object.assign(new Error("NotFound"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        throw new Error("Unexpected command");
      },
    } as S3CommandExecutor;

    const lightweightResult = await checkS3StorageHealth({
      client: executor,
      config: VALID_CONFIG,
      dnsLookup: async () => [{ address: "52.216.10.20", family: 4 }],
    });
    expect(lightweightResult.healthy).toBe(true);
    expect(executedCommands).toEqual(["HeadBucket"]);

    executedCommands.length = 0;

    const fullResult = await checkS3StorageHealth({
      client: executor,
      config: VALID_CONFIG,
      dnsLookup: async () => [{ address: "52.216.10.20", family: 4 }],
      verifyReadWrite: true,
    });
    expect(fullResult.healthy).toBe(true);
    expect(executedCommands).toEqual(["HeadBucket", "PutObject", "DeleteObject"]);

    // Wired directly on StorageProvider.checkHealth()
    const provider = createS3StorageProvider(VALID_CONFIG, {
      client: executor,
      dnsLookup: async () => [{ address: "52.216.10.20", family: 4 }],
    });
    const providerHealth = await provider.checkHealth();
    expect(providerHealth.healthy).toBe(true);
  });

  it("reports clear unhealthy status without leaking credentials for missing bucket, bad credentials, SSRF DNS block, and probe failure", async () => {
    // 1. SSRF DNS failure
    const ssrfResult = await checkS3StorageHealth({
      client: {
        async send() {
          throw new Error("Should not call S3 when DNS fails SSRF check");
        },
      },
      config: VALID_CONFIG,
      dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    expect(ssrfResult.healthy).toBe(false);
    expect(ssrfResult.message).toMatch(/SSRF/i);

    // 2. Bucket not found (404)
    const missingBucket = await checkS3StorageHealth({
      client: {
        async send() {
          throw Object.assign(new Error("NoSuchBucket AKIAHEALTHKEY123456"), {
            name: "NoSuchBucket",
            $metadata: { httpStatusCode: 404 },
          });
        },
      },
      config: VALID_CONFIG,
      dnsLookup: async () => [{ address: "52.216.10.20", family: 4 }],
    });
    expect(missingBucket.healthy).toBe(false);
    expect(missingBucket.message).toContain("não foi encontrado");
    expect(missingBucket.message).not.toContain("AKIAHEALTHKEY123456");

    // 3. Invalid credentials / insufficient permission (403)
    const denied = await checkS3StorageHealth({
      client: {
        async send() {
          throw Object.assign(
            new Error(`AccessDenied secret=${VALID_CONFIG.credentials.secretAccessKey}`),
            {
              name: "AccessDenied",
              $metadata: { httpStatusCode: 403 },
            },
          );
        },
      },
      config: VALID_CONFIG,
      dnsLookup: async () => [{ address: "52.216.10.20", family: 4 }],
    });
    expect(denied.healthy).toBe(false);
    expect(denied.message).toContain("Credenciais S3 inválidas ou sem permissão");
    expect(denied.message).not.toContain(VALID_CONFIG.credentials.secretAccessKey);

    // 4. Write probe denied
    const probeDenied = await checkS3StorageHealth({
      client: {
        async send(cmd) {
          if (cmd instanceof HeadBucketCommand) {
            return { $metadata: { httpStatusCode: 200 } };
          }
          if (cmd instanceof PutObjectCommand) {
            throw Object.assign(new Error("AccessDenied"), {
              name: "AccessDenied",
              $metadata: { httpStatusCode: 403 },
            });
          }
          return { $metadata: { httpStatusCode: 204 } };
        },
      },
      config: VALID_CONFIG,
      dnsLookup: async () => [{ address: "52.216.10.20", family: 4 }],
      verifyReadWrite: true,
    });
    expect(probeDenied.healthy).toBe(false);
    expect(probeDenied.message).toContain("escrita/remoção");
  });
});
