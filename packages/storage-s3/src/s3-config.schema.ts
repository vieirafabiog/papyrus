import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { StorageError } from "@papyrus/storage-core";
import { z } from "zod";

const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_LOOKALIKE_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

export interface S3EndpointSecurityPolicy {
  readonly allowInsecureHttp?: boolean | undefined;
  readonly allowPrivateEndpoints?: boolean | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
}

export const s3TlsConfigSchema = z.object({
  rejectUnauthorized: z.boolean().default(true),
  allowInsecureHttp: z.boolean().default(false),
  caCertificatePem: z.string().trim().min(1).max(65_536).optional(),
});

export const s3CredentialsSchema = z.object({
  accessKeyId: z
    .string()
    .trim()
    .min(3, "accessKeyId deve possuir ao menos 3 caracteres.")
    .max(256)
    .refine((val) => !/\s/.test(val), "accessKeyId não pode conter espaços."),
  secretAccessKey: z
    .string()
    .min(8, "secretAccessKey deve possuir ao menos 8 caracteres.")
    .max(512),
  sessionToken: z.string().min(1).max(4096).optional(),
});

export const s3TimeoutsSchema = z.object({
  connectionTimeoutMs: z.number().int().min(500).max(60_000).default(5_000),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

export const s3BucketSchema = z
  .string()
  .trim()
  .min(3, "Nome do bucket S3 deve possuir ao menos 3 caracteres.")
  .max(63, "Nome do bucket S3 deve possuir no máximo 63 caracteres.")
  .refine((val) => BUCKET_NAME_PATTERN.test(val), {
    message: "Nome do bucket S3 deve conter apenas letras minúsculas, dígitos, pontos e hífens.",
  })
  .refine((val) => !val.includes(".."), {
    message: "Nome do bucket S3 não pode conter pontos consecutivos.",
  })
  .refine((val) => !IPV4_LOOKALIKE_PATTERN.test(val), {
    message: "Nome do bucket S3 não pode ter formato de endereço IP.",
  });

export const s3RegionSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .refine((val) => REGION_PATTERN.test(val), {
    message: "Região S3 inválida (exemplo: us-east-1, sa-east-1).",
  });

function normalizeHostname(rawHost: string): string {
  const lowered = rawHost.toLowerCase();
  if (lowered.startsWith("[") && lowered.endsWith("]")) {
    return lowered.slice(1, -1);
  }
  return lowered;
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const parsed = Number.parseInt(part, 10);
    if (parsed < 0 || parsed > 255) {
      return null;
    }
    nums.push(parsed);
  }
  if (nums.length !== 4) {
    return null;
  }
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0];
}

function isCloudMetadataIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isCloudMetadataIp(normalized.slice(7));
  }
  if (normalized === "fd00:ec2::254") {
    return true;
  }
  const octets = parseIpv4Octets(normalized);
  if (!octets) {
    return false;
  }
  // Link-local 169.254.0.0/16 (includes AWS/GCP/Azure metadata 169.254.169.254)
  return octets[0] === 169 && octets[1] === 254;
}

/**
 * Classifies whether an IPv4 or IPv6 literal is non-public (loopback, RFC1918,
 * CGNAT, link-local, ULA, unspecified, multicast, or reserved).
 */
export function isRestrictedIpAddress(rawIp: string): boolean {
  const normalized = rawIp.toLowerCase().split("%")[0] ?? "";
  if (normalized.startsWith("::ffff:")) {
    return isRestrictedIpAddress(normalized.slice(7));
  }

  const version = isIP(normalized);
  if (version === 4) {
    const octets = parseIpv4Octets(normalized);
    if (!octets) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) {
      return true;
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 192 && b === 0) {
      return true;
    }
    if (a === 198 && (b === 18 || b === 19)) {
      return true;
    }
    if (a >= 224) {
      return true;
    }
    return false;
  }

  if (version === 6) {
    if (normalized === "::" || normalized === "::1") {
      return true;
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return true;
    }
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return true;
    }
    if (normalized.startsWith("ff")) {
      return true;
    }
    return false;
  }

  return true;
}

function isHostExplicitlyAllowed(hostname: string, policy: S3EndpointSecurityPolicy): boolean {
  if (!policy.allowedHosts || policy.allowedHosts.length === 0) {
    return false;
  }
  const normalized = hostname.toLowerCase();
  return policy.allowedHosts.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

/**
 * Validates S3 endpoint URL syntax and enforces SSRF safety rules before outbound requests.
 */
export function validateS3EndpointUrl(
  rawEndpoint: string,
  policy: S3EndpointSecurityPolicy = {},
): URL {
  const trimmed = rawEndpoint.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    throw new StorageError(
      "INVALID_KEY",
      "Endpoint S3 ausente ou fora do tamanho permitido.",
      "s3",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new StorageError("INVALID_KEY", "Endpoint S3 não é uma URL válida.", "s3");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new StorageError(
      "INVALID_KEY",
      "Endpoint S3 deve utilizar protocolo HTTPS ou HTTP autorizado.",
      "s3",
    );
  }

  if (parsed.protocol === "http:" && !policy.allowInsecureHttp) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Endpoint S3 sem TLS (HTTP) exige habilitação explícita em ambiente controlado.",
      "s3",
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new StorageError(
      "UNAUTHORIZED",
      "Endpoint S3 não pode embutir credenciais na URL.",
      "s3",
    );
  }

  if (parsed.search !== "" || parsed.hash !== "") {
    throw new StorageError(
      "INVALID_KEY",
      "Endpoint S3 não pode conter query string ou fragmento.",
      "s3",
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new StorageError("INVALID_KEY", "Endpoint S3 deve informar um hostname válido.", "s3");
  }

  // Always block cloud instance metadata addresses regardless of override flags.
  if (METADATA_HOSTNAMES.has(hostname) || (isIP(hostname) !== 0 && isCloudMetadataIp(hostname))) {
    throw new StorageError(
      "UNAUTHORIZED",
      "Endpoint S3 aponta para endereço de metadados bloqueado por política SSRF.",
      "s3",
    );
  }

  const explicitlyAllowedHost = isHostExplicitlyAllowed(hostname, policy);
  const allowPrivate = policy.allowPrivateEndpoints === true || explicitlyAllowedHost;

  if (!allowPrivate) {
    if (isIP(hostname) !== 0 && isRestrictedIpAddress(hostname)) {
      throw new StorageError(
        "UNAUTHORIZED",
        "Endpoint S3 aponta para endereço IP interno ou reservado bloqueado por política SSRF.",
        "s3",
      );
    }

    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      (!hostname.includes(".") && isIP(hostname) === 0)
    ) {
      throw new StorageError(
        "UNAUTHORIZED",
        "Hostname interno ou não qualificado bloqueado por política de segurança SSRF.",
        "s3",
      );
    }
  }

  return parsed;
}

export type DnsLookupAllFn = (
  hostname: string,
  options: { all: true },
) => Promise<readonly LookupAddress[]>;

/**
 * Resolves the endpoint hostname via DNS and verifies none of the returned IP
 * addresses violate the configured SSRF policy (preventing DNS rebinding attacks).
 */
export async function validateS3EndpointResolution(
  endpointUrl: string | URL,
  policy: S3EndpointSecurityPolicy = {},
  lookupFn: DnsLookupAllFn = (host, opts) => dnsLookup(host, opts),
): Promise<void> {
  const url =
    typeof endpointUrl === "string" ? validateS3EndpointUrl(endpointUrl, policy) : endpointUrl;
  const hostname = normalizeHostname(url.hostname);

  if (isIP(hostname) !== 0) {
    if (isCloudMetadataIp(hostname)) {
      throw new StorageError(
        "UNAUTHORIZED",
        "Endpoint S3 aponta para endereço de metadados bloqueado.",
        "s3",
      );
    }
    if (
      !policy.allowPrivateEndpoints &&
      !isHostExplicitlyAllowed(hostname, policy) &&
      isRestrictedIpAddress(hostname)
    ) {
      throw new StorageError(
        "UNAUTHORIZED",
        "Endereço IP do endpoint S3 bloqueado por política SSRF.",
        "s3",
      );
    }
    return;
  }

  let addresses: readonly LookupAddress[];
  try {
    addresses = await lookupFn(hostname, { all: true });
  } catch {
    throw new StorageError(
      "UNAVAILABLE",
      "Não foi possível resolver o hostname do endpoint S3 via DNS.",
      "s3",
    );
  }

  if (addresses.length === 0) {
    throw new StorageError(
      "UNAVAILABLE",
      "Nenhum endereço retornado na resolução DNS do endpoint S3.",
      "s3",
    );
  }

  const allowPrivate =
    policy.allowPrivateEndpoints === true || isHostExplicitlyAllowed(hostname, policy);

  for (const record of addresses) {
    if (isCloudMetadataIp(record.address)) {
      throw new StorageError(
        "UNAUTHORIZED",
        "Hostname do endpoint S3 resolve para endereço de metadados bloqueado por SSRF.",
        "s3",
      );
    }
    if (!allowPrivate && isRestrictedIpAddress(record.address)) {
      throw new StorageError(
        "UNAUTHORIZED",
        "Hostname do endpoint S3 resolve para endereço IP interno bloqueado por política SSRF.",
        "s3",
      );
    }
  }
}

const rawS3StorageConfigSchema = z.object({
  endpoint: z.string().trim().min(1).max(512),
  region: s3RegionSchema,
  bucket: s3BucketSchema,
  forcePathStyle: z.boolean().default(false),
  keyPrefix: z
    .string()
    .trim()
    .max(256)
    .optional()
    .transform((val) => (val ? val.replace(/^\/+|\/+$/g, "") : undefined))
    .refine(
      (val) => val === undefined || (!val.includes("..") && !val.includes("\\")),
      "Prefixo de chave S3 inválido.",
    ),
  tls: s3TlsConfigSchema.default({}),
  credentials: s3CredentialsSchema,
  timeouts: s3TimeoutsSchema.default({}),
});

export type S3StorageConfig = z.infer<typeof rawS3StorageConfigSchema>;
export type S3StorageConfigInput = z.input<typeof rawS3StorageConfigSchema>;

export function createS3StorageConfigSchema(
  securityPolicy: S3EndpointSecurityPolicy = {},
): z.ZodType<S3StorageConfig, z.ZodTypeDef, S3StorageConfigInput> {
  return rawS3StorageConfigSchema.superRefine((data, ctx) => {
    const effectivePolicy: S3EndpointSecurityPolicy = {
      ...securityPolicy,
      allowInsecureHttp: securityPolicy.allowInsecureHttp ?? data.tls.allowInsecureHttp,
    };

    try {
      validateS3EndpointUrl(data.endpoint, effectivePolicy);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoint"],
        message:
          error instanceof Error
            ? error.message
            : "Endpoint S3 rejeitado pela validação de segurança.",
      });
    }
  });
}

export const s3StorageConfigSchema = createS3StorageConfigSchema();

export function parseS3StorageConfig(
  rawInput: unknown,
  securityPolicy: S3EndpointSecurityPolicy = {},
): S3StorageConfig {
  const schema = createS3StorageConfigSchema(securityPolicy);
  const result = schema.safeParse(rawInput);
  if (!result.success) {
    const firstMessage = result.error.issues[0]?.message ?? "Configuração S3 inválida.";
    throw new StorageError("INVALID_KEY", firstMessage, "s3");
  }
  return result.data;
}

export interface SanitizedS3ConfigSummary {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly forcePathStyle: boolean;
  readonly keyPrefix?: string | undefined;
  readonly tls: {
    readonly rejectUnauthorized: boolean;
    readonly allowInsecureHttp: boolean;
    readonly hasCustomCa: boolean;
  };
  readonly timeouts: {
    readonly connectionTimeoutMs: number;
    readonly requestTimeoutMs: number;
  };
  readonly hasCredentials: boolean;
}

export function sanitizeS3ConfigSummary(config: S3StorageConfig): SanitizedS3ConfigSummary {
  return {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    forcePathStyle: config.forcePathStyle,
    ...(config.keyPrefix ? { keyPrefix: config.keyPrefix } : {}),
    tls: {
      rejectUnauthorized: config.tls.rejectUnauthorized,
      allowInsecureHttp: config.tls.allowInsecureHttp,
      hasCustomCa: config.tls.caCertificatePem !== undefined,
    },
    timeouts: {
      connectionTimeoutMs: config.timeouts.connectionTimeoutMs,
      requestTimeoutMs: config.timeouts.requestTimeoutMs,
    },
    hasCredentials:
      config.credentials.accessKeyId.length > 0 && config.credentials.secretAccessKey.length > 0,
  };
}
