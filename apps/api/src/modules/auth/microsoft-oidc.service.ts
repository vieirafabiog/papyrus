import {
  type JsonWebKey,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

const TENANT_ID_PATTERN = /^[0-9a-zA-Z.-]{3,128}$/;
const DISALLOWED_MULTI_TENANT_ALIASES = new Set(["common", "consumers", "organizations"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 60;
const DISCOVERY_CACHE_TTL_MS = 60 * 60_000;
const JWKS_CACHE_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type MicrosoftOidcErrorCode =
  | "INVALID_STATE"
  | "TOKEN_EXCHANGE_FAILED"
  | "INVALID_ID_TOKEN"
  | "EMAIL_MISSING";

export class MicrosoftOidcError extends Error {
  public readonly code: MicrosoftOidcErrorCode;

  public constructor(code: MicrosoftOidcErrorCode, message: string) {
    super(message);
    this.name = "MicrosoftOidcError";
    this.code = code;
  }
}

export interface MicrosoftOidcConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly stateSigningSecret: string;
  readonly loginBaseUrl?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
}

export interface MicrosoftAuthStartResult {
  readonly authorizationUrl: string;
  readonly signedStateCookie: string;
  readonly maxAgeSeconds: number;
}

export interface MicrosoftAuthCallbackResult {
  readonly email: string;
  readonly returnTo: string;
}

export interface MicrosoftOidcService {
  createAuthorizationRequest(returnToPath?: string | null): MicrosoftAuthStartResult;
  completeCallback(input: {
    readonly code: string;
    readonly state: string;
    readonly signedStateCookie: string | undefined;
  }): Promise<MicrosoftAuthCallbackResult>;
}

interface SignedOidcStatePayload {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
  readonly exp: number;
}

interface OpenIdDiscoveryDocument {
  readonly issuer: string;
  readonly jwks_uri: string;
}

interface JwkKey extends JsonWebKey {
  readonly kid?: string | undefined;
  readonly use?: string | undefined;
}

interface JwksDocument {
  readonly keys: readonly JwkKey[];
}

interface JwtHeader {
  readonly alg?: string | undefined;
  readonly kid?: string | undefined;
}

interface MicrosoftIdTokenPayload {
  readonly aud?: string | readonly string[] | undefined;
  readonly iss?: string | undefined;
  readonly exp?: number | undefined;
  readonly nbf?: number | undefined;
  readonly nonce?: string | undefined;
  readonly tid?: string | undefined;
  readonly email?: string | undefined;
  readonly preferred_username?: string | undefined;
  readonly xms_edov?: boolean | undefined;
}

function safeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function sanitizeReturnToPath(rawPath: string | null | undefined): string {
  if (
    typeof rawPath === "string" &&
    rawPath.startsWith("/") &&
    !rawPath.startsWith("//") &&
    !rawPath.includes("\\") &&
    rawPath.length <= 512
  ) {
    return rawPath;
  }
  return "/";
}

function decodeBase64UrlJson<T>(segment: string): T {
  const decoded = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(decoded) as T;
}

function extractVerifiedEmail(payload: MicrosoftIdTokenPayload): string | null {
  if (payload.xms_edov === false) {
    return null;
  }
  const candidates: readonly (string | undefined)[] = [
    payload.email,
    typeof payload.preferred_username === "string" &&
    !payload.preferred_username.toLowerCase().includes("#ext#")
      ? payload.preferred_username
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = candidate.trim().toLowerCase();
      if (normalized.length <= 255 && EMAIL_PATTERN.test(normalized)) {
        return normalized;
      }
    }
  }
  return null;
}

export function createMicrosoftOidcService(config: MicrosoftOidcConfig): MicrosoftOidcService {
  const tenantId = config.tenantId.trim();
  const clientId = config.clientId.trim();
  const clientSecret = config.clientSecret.trim();
  const redirectUri = config.redirectUri.trim();
  const loginBaseUrl = (config.loginBaseUrl ?? "https://login.microsoftonline.com").replace(
    /\/+$/,
    "",
  );
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const nowFn = config.now ?? (() => Date.now());

  if (
    !TENANT_ID_PATTERN.test(tenantId) ||
    DISALLOWED_MULTI_TENANT_ALIASES.has(tenantId.toLowerCase())
  ) {
    throw new Error(
      "MICROSOFT_AUTH_TENANT_ID inválido: informe o ID ou domínio corporativo do locatário (não utilize common/consumers/organizations).",
    );
  }
  if (clientId.length < 3 || clientSecret.length < 4) {
    throw new Error("MICROSOFT_AUTH_CLIENT_ID ou MICROSOFT_AUTH_CLIENT_SECRET inválido.");
  }

  const signingKey = createHash("sha256")
    .update(`papyrus-ms-oidc-state-v1:${config.stateSigningSecret}`)
    .digest();

  let discoveryCache: { readonly doc: OpenIdDiscoveryDocument; readonly expiresAt: number } | null =
    null;
  let jwksCache: {
    readonly jwksUri: string;
    readonly keys: readonly JwkKey[];
    readonly expiresAt: number;
  } | null = null;

  function signStatePayload(payload: SignedOidcStatePayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", signingKey).update(encoded).digest("base64url");
    return `${encoded}.${sig}`;
  }

  function verifyStateCookie(cookieValue: string | undefined): SignedOidcStatePayload {
    if (!cookieValue) {
      throw new MicrosoftOidcError("INVALID_STATE", "Cookie de estado OIDC ausente.");
    }
    const dotIndex = cookieValue.indexOf(".");
    if (dotIndex <= 0 || dotIndex !== cookieValue.lastIndexOf(".")) {
      throw new MicrosoftOidcError("INVALID_STATE", "Formato do cookie de estado OIDC inválido.");
    }
    const encoded = cookieValue.slice(0, dotIndex);
    const providedSig = cookieValue.slice(dotIndex + 1);
    const expectedSig = createHmac("sha256", signingKey).update(encoded).digest("base64url");
    if (!safeEqualUtf8(providedSig, expectedSig)) {
      throw new MicrosoftOidcError("INVALID_STATE", "Assinatura do estado OIDC inválida.");
    }

    let parsed: SignedOidcStatePayload;
    try {
      parsed = decodeBase64UrlJson<SignedOidcStatePayload>(encoded);
    } catch {
      throw new MicrosoftOidcError("INVALID_STATE", "Conteúdo do estado OIDC corrompido.");
    }

    if (
      typeof parsed.state !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.codeVerifier !== "string" ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= nowFn()
    ) {
      throw new MicrosoftOidcError("INVALID_STATE", "Estado OIDC expirado ou inválido.");
    }
    return parsed;
  }

  async function fetchDiscoveryDocument(): Promise<OpenIdDiscoveryDocument> {
    const now = nowFn();
    if (discoveryCache && discoveryCache.expiresAt > now) {
      return discoveryCache.doc;
    }

    const url = `${loginBaseUrl}/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`;
    const response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new MicrosoftOidcError(
        "INVALID_ID_TOKEN",
        "Não foi possível obter os metadados OpenID Connect da Microsoft.",
      );
    }
    const doc = (await response.json()) as Partial<OpenIdDiscoveryDocument>;
    if (typeof doc.issuer !== "string" || typeof doc.jwks_uri !== "string") {
      throw new MicrosoftOidcError(
        "INVALID_ID_TOKEN",
        "Documento OpenID Connect da Microsoft incompleto.",
      );
    }
    const validDoc: OpenIdDiscoveryDocument = {
      issuer: doc.issuer,
      jwks_uri: doc.jwks_uri,
    };
    discoveryCache = { doc: validDoc, expiresAt: now + DISCOVERY_CACHE_TTL_MS };
    return validDoc;
  }

  async function findJwkByKid(jwksUri: string, kid: string, forceRefresh = false): Promise<JwkKey> {
    const now = nowFn();
    if (!forceRefresh && jwksCache && jwksCache.jwksUri === jwksUri && jwksCache.expiresAt > now) {
      const cached = jwksCache.keys.find((key) => key.kid === kid && key.kty === "RSA");
      if (cached) {
        return cached;
      }
    }

    const response = await fetchFn(jwksUri, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new MicrosoftOidcError(
        "INVALID_ID_TOKEN",
        "Não foi possível consultar as chaves públicas JWKS da Microsoft.",
      );
    }
    const jwks = (await response.json()) as Partial<JwksDocument>;
    if (!Array.isArray(jwks.keys)) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Conjunto JWKS da Microsoft inválido.");
    }
    jwksCache = {
      jwksUri,
      keys: jwks.keys,
      expiresAt: now + JWKS_CACHE_TTL_MS,
    };

    const match = jwks.keys.find((key) => key.kid === kid && key.kty === "RSA");
    if (!match) {
      throw new MicrosoftOidcError(
        "INVALID_ID_TOKEN",
        "Chave pública correspondente ao token Microsoft não encontrada.",
      );
    }
    return match;
  }

  async function verifyIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<MicrosoftIdTokenPayload> {
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Formato JWT do id_token inválido.");
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64 || !signatureB64) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Segmentos do id_token incompletos.");
    }

    let header: JwtHeader;
    let payload: MicrosoftIdTokenPayload;
    try {
      header = decodeBase64UrlJson<JwtHeader>(headerB64);
      payload = decodeBase64UrlJson<MicrosoftIdTokenPayload>(payloadB64);
    } catch {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Não foi possível decodificar o id_token.");
    }

    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) {
      throw new MicrosoftOidcError(
        "INVALID_ID_TOKEN",
        "Algoritmo ou identificador de chave do id_token não suportado.",
      );
    }

    const discovery = await fetchDiscoveryDocument();
    let jwk = await findJwkByKid(discovery.jwks_uri, header.kid, false);

    const signedData = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
    const signature = Buffer.from(signatureB64, "base64url");

    let signatureValid = verify(
      "RSA-SHA256",
      signedData,
      createPublicKey({ key: jwk, format: "jwk" }),
      signature,
    );
    if (!signatureValid) {
      jwk = await findJwkByKid(discovery.jwks_uri, header.kid, true);
      signatureValid = verify(
        "RSA-SHA256",
        signedData,
        createPublicKey({ key: jwk, format: "jwk" }),
        signature,
      );
    }
    if (!signatureValid) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Assinatura do id_token inválida.");
    }

    const nowSec = Math.floor(nowFn() / 1000);
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS <= nowSec) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Token da Microsoft expirado.");
    }
    if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > nowSec) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Token da Microsoft ainda não válido.");
    }

    const audienceMatches = Array.isArray(payload.aud)
      ? payload.aud.includes(clientId)
      : payload.aud === clientId;
    if (!audienceMatches) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Audiência do id_token divergente.");
    }

    if (UUID_PATTERN.test(tenantId)) {
      if (typeof payload.tid !== "string" || payload.tid.toLowerCase() !== tenantId.toLowerCase()) {
        throw new MicrosoftOidcError(
          "INVALID_ID_TOKEN",
          "Locatário (tid) do token não autorizado.",
        );
      }
    }

    const expectedIssuer =
      discovery.issuer.includes("{tenantid}") && typeof payload.tid === "string"
        ? discovery.issuer.replace("{tenantid}", payload.tid)
        : discovery.issuer;
    if (typeof payload.iss !== "string" || payload.iss !== expectedIssuer) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Emissor (iss) do id_token inválido.");
    }

    if (typeof payload.nonce !== "string" || !safeEqualUtf8(payload.nonce, expectedNonce)) {
      throw new MicrosoftOidcError("INVALID_ID_TOKEN", "Nonce do id_token divergente.");
    }

    return payload;
  }

  return {
    createAuthorizationRequest(returnToPath?: string | null): MicrosoftAuthStartResult {
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const returnTo = sanitizeReturnToPath(returnToPath);

      const signedStateCookie = signStatePayload({
        state,
        nonce,
        codeVerifier,
        returnTo,
        exp: nowFn() + STATE_TTL_MS,
      });

      const authorizeUrl = new URL(
        `${loginBaseUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`,
      );
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("response_mode", "query");
      authorizeUrl.searchParams.set("scope", "openid profile email");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("nonce", nonce);
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("prompt", "select_account");

      return {
        authorizationUrl: authorizeUrl.toString(),
        signedStateCookie,
        maxAgeSeconds: Math.floor(STATE_TTL_MS / 1000),
      };
    },

    async completeCallback(input: {
      readonly code: string;
      readonly state: string;
      readonly signedStateCookie: string | undefined;
    }): Promise<MicrosoftAuthCallbackResult> {
      const stateRecord = verifyStateCookie(input.signedStateCookie);
      if (!safeEqualUtf8(input.state, stateRecord.state)) {
        throw new MicrosoftOidcError("INVALID_STATE", "Parâmetro state divergente.");
      }

      const tokenUrl = `${loginBaseUrl}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: redirectUri,
        code_verifier: stateRecord.codeVerifier,
        scope: "openid profile email",
      });

      const tokenResponse = await fetchFn(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!tokenResponse.ok) {
        throw new MicrosoftOidcError(
          "TOKEN_EXCHANGE_FAILED",
          "Falha ao trocar o código de autorização com a Microsoft.",
        );
      }

      const tokenJson = (await tokenResponse.json()) as {
        readonly id_token?: unknown;
      };
      if (typeof tokenJson.id_token !== "string" || tokenJson.id_token.length === 0) {
        throw new MicrosoftOidcError(
          "INVALID_ID_TOKEN",
          "Resposta da Microsoft não retornou id_token.",
        );
      }

      const payload = await verifyIdToken(tokenJson.id_token, stateRecord.nonce);
      const email = extractVerifiedEmail(payload);
      if (!email) {
        throw new MicrosoftOidcError(
          "EMAIL_MISSING",
          "A conta Microsoft não forneceu um endereço de e-mail válido.",
        );
      }

      return {
        email,
        returnTo: sanitizeReturnToPath(stateRecord.returnTo),
      };
    },
  };
}
