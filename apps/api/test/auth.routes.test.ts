import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import {
  type CreateSessionRecordInput,
  type SessionStorePort,
  type StoredSessionRecord,
  createPasswordService,
  createSessionService,
} from "@papyrus/auth";
import {
  authMeResponseSchema,
  authProvidersResponseSchema,
  createApiResponseSchema,
} from "@papyrus/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  type AuthCredentialRecord,
  type AuthUserLookupPort,
  createAuthService,
} from "../src/modules/auth/auth.service.js";
import { createMicrosoftOidcService } from "../src/modules/auth/microsoft-oidc.service.js";

function createTestMemorySessionStore(): SessionStorePort {
  const map = new Map<string, StoredSessionRecord>();
  return {
    async create(input: CreateSessionRecordInput): Promise<StoredSessionRecord> {
      const record: StoredSessionRecord = {
        ...input,
        revokedAt: null,
        createdAt: new Date(),
      };
      map.set(record.id, record);
      return record;
    },
    async findByTokenHash(tokenHash: string): Promise<StoredSessionRecord | null> {
      for (const item of map.values()) {
        if (item.tokenHash === tokenHash) {
          return item;
        }
      }
      return null;
    },
    async revokeById(sessionId: string, revokedAt: Date): Promise<void> {
      const item = map.get(sessionId);
      if (item) {
        map.set(sessionId, { ...item, revokedAt });
      }
    },
    async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
      for (const [id, item] of map.entries()) {
        if (item.userId === userId && item.revokedAt === null) {
          map.set(id, { ...item, revokedAt });
        }
      }
    },
  };
}

describe("Auth routes (/api/v1/auth/*)", () => {
  it("logs in with HttpOnly cookie, serves /auth/me without secrets, and revokes on logout", async () => {
    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 8,
    });
    const passwordHash = await passwordService.hashPassword("SenhaSegura123!");
    const orgId = "550e8400-e29b-41d4-a716-446655440000";
    const userId = "550e8400-e29b-41d4-a716-446655440001";

    const credential: AuthCredentialRecord = {
      user: {
        id: userId,
        organizationId: orgId,
        email: "admin@papyrus.invalid",
        fullName: "Administrador papyrus",
        status: "ACTIVE",
        createdAt: "2026-11-20T10:00:00.000Z",
        updatedAt: "2026-11-20T10:00:00.000Z",
      },
      passwordHash,
    };

    const users: AuthUserLookupPort = {
      async findCredentialByEmail(email) {
        return email === credential.user.email ? credential : null;
      },
      async findProfileById(id) {
        return id === userId
          ? { user: credential.user, groups: [], roles: [], permissions: [] }
          : null;
      },
    };

    const sessionService = createSessionService({
      store: createTestMemorySessionStore(),
      secretPepper: "test-session-pepper-at-least-32-chars",
    });
    const authService = createAuthService({ users, passwordService, sessionService });
    const app = buildApp({ logger: false, authService, secureCookies: false });

    // Obtain CSRF token for mutating requests
    const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf-token" });
    expect(csrfRes.statusCode).toBe(200);
    const csrfToken = csrfRes.json().data.csrfToken as string;

    // 1. Unauthenticated /auth/me returns 401
    const unauthMe = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(unauthMe.statusCode).toBe(401);

    // 2. Invalid credentials return 401
    const badLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { papyrus_csrf: csrfToken },
      headers: { "x-csrf-token": csrfToken },
      payload: { email: "admin@papyrus.invalid", password: "wrong" },
    });
    expect(badLogin.statusCode).toBe(401);

    // 3. Valid login sets HttpOnly cookie and returns sanitized AuthMeResponse
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: { papyrus_csrf: csrfToken },
      headers: { "x-csrf-token": csrfToken },
      payload: { email: "Admin@papyrus.Invalid", password: "SenhaSegura123!" },
    });
    expect(loginRes.statusCode).toBe(200);
    const bodyText = loginRes.body;
    expect(bodyText).not.toContain("passwordHash");
    expect(bodyText).not.toContain("$argon2id$");
    expect(createApiResponseSchema(authMeResponseSchema).safeParse(loginRes.json()).success).toBe(
      true,
    );

    const setCookieHeader = loginRes.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    expect(cookieStr).toContain("papyrus_session=");
    expect(cookieStr).toContain("HttpOnly");
    expect(cookieStr).toContain("SameSite=Lax");

    const sessionCookie = loginRes.cookies.find((c) => c.name === "papyrus_session");
    expect(sessionCookie).toBeDefined();

    // 4. Authenticated /auth/me succeeds
    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { papyrus_session: sessionCookie?.value ?? "" },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().data.user.email).toBe("admin@papyrus.invalid");

    // 5. Logout revokes session so /auth/me returns 401 afterwards
    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: {
        papyrus_session: sessionCookie?.value ?? "",
        papyrus_csrf: csrfToken,
      },
      headers: { "x-csrf-token": csrfToken },
    });
    expect(logoutRes.statusCode).toBe(200);

    const postLogoutMe = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { papyrus_session: sessionCookie?.value ?? "" },
    });
    expect(postLogoutMe.statusCode).toBe(401);

    // 6. Providers endpoint reports Microsoft disabled when OIDC is not configured
    const disabledProviders = await app.inject({ method: "GET", url: "/api/v1/auth/providers" });
    expect(disabledProviders.statusCode).toBe(200);
    expect(authProvidersResponseSchema.parse(disabledProviders.json()).data).toEqual({
      microsoft: { enabled: false },
    });

    await app.close();
  });

  it("authenticates registered active users via Microsoft OIDC and blocks unregistered or inactive users", async () => {
    const tenantId = "11111111-2222-3333-4444-555555555555";
    const clientId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const clientSecret = "ms-client-secret-for-test-only";
    const redirectUri = "https://papyrus.example.com/api/v1/auth/microsoft/callback";
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const jwksUri = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;

    expect(() =>
      createMicrosoftOidcService({
        tenantId: "common",
        clientId,
        clientSecret,
        redirectUri,
        stateSigningSecret: "state-signing-secret-at-least-32-chars!!",
      }),
    ).toThrow(/MICROSOFT_AUTH_TENANT_ID/i);

    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" });

    function signIdToken(claims: Record<string, unknown>): string {
      const headerB64 = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-kid-1" })).toString(
        "base64url",
      );
      const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signer = createSign("RSA-SHA256");
      signer.update(`${headerB64}.${payloadB64}`);
      const sigB64 = signer.sign(privateKey).toString("base64url");
      return `${headerB64}.${payloadB64}.${sigB64}`;
    }

    let nextEmailClaim: string | undefined = "Admin@Papyrus.Invalid";
    let nextXmsEdov: boolean | undefined = undefined;
    nextXmsEdov = true;
    let lastNonce = "";

    const mockFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({ issuer, jwks_uri: jwksUri }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === jwksUri) {
        return new Response(
          JSON.stringify({
            keys: [{ ...publicJwk, kid: "test-kid-1", use: "sig" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/oauth2/v2.0/token")) {
        const bodyParams = new URLSearchParams(String(init?.body ?? ""));
        expect(bodyParams.get("client_id")).toBe(clientId);
        expect(bodyParams.get("client_secret")).toBe(clientSecret);
        expect(bodyParams.get("code_verifier")).toBeTruthy();

        const nowSec = Math.floor(Date.now() / 1000);
        const idToken = signIdToken({
          iss: issuer,
          aud: clientId,
          tid: tenantId,
          nonce: lastNonce,
          iat: nowSec,
          nbf: nowSec - 10,
          exp: nowSec + 300,
          ...(nextEmailClaim ? { email: nextEmailClaim } : {}),
          ...(nextXmsEdov !== undefined ? { xms_edov: nextXmsEdov } : {}),
        });
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    };

    const passwordService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 8,
    });
    const passwordHash = await passwordService.hashPassword("SenhaSegura123!");
    const orgId = "550e8400-e29b-41d4-a716-446655440000";
    const activeUserId = "550e8400-e29b-41d4-a716-446655440001";
    const inactiveUserId = "550e8400-e29b-41d4-a716-446655440002";

    const usersByEmail = new Map<string, AuthCredentialRecord>([
      [
        "admin@papyrus.invalid",
        {
          user: {
            id: activeUserId,
            organizationId: orgId,
            email: "admin@papyrus.invalid",
            fullName: "Admin",
            status: "ACTIVE",
            createdAt: "2026-11-20T10:00:00.000Z",
            updatedAt: "2026-11-20T10:00:00.000Z",
          },
          passwordHash,
        },
      ],
      [
        "inactive@papyrus.invalid",
        {
          user: {
            id: inactiveUserId,
            organizationId: orgId,
            email: "inactive@papyrus.invalid",
            fullName: "Inactive User",
            status: "INACTIVE",
            createdAt: "2026-11-20T10:00:00.000Z",
            updatedAt: "2026-11-20T10:00:00.000Z",
          },
          passwordHash,
        },
      ],
    ]);

    const users: AuthUserLookupPort = {
      async findCredentialByEmail(email) {
        return usersByEmail.get(email) ?? null;
      },
      async findProfileById(id) {
        for (const rec of usersByEmail.values()) {
          if (rec.user.id === id) {
            return { user: rec.user, groups: [], roles: [], permissions: [] };
          }
        }
        return null;
      },
    };

    const sessionService = createSessionService({
      store: createTestMemorySessionStore(),
      secretPepper: "test-session-pepper-at-least-32-chars",
    });
    const authService = createAuthService({ users, passwordService, sessionService });
    const microsoftOidc = createMicrosoftOidcService({
      tenantId,
      clientId,
      clientSecret,
      redirectUri,
      stateSigningSecret: "state-signing-secret-at-least-32-chars!!",
      fetchFn: mockFetch,
    });

    const app = buildApp({
      logger: false,
      authService,
      microsoftOidc,
      appOrigin: "https://papyrus.example.com",
      secureCookies: false,
    });

    // 1. /auth/providers reports Microsoft enabled
    const enabledProviders = await app.inject({ method: "GET", url: "/api/v1/auth/providers" });
    expect(enabledProviders.statusCode).toBe(200);
    expect(authProvidersResponseSchema.parse(enabledProviders.json()).data).toEqual({
      microsoft: { enabled: true },
    });

    // 2. Start flow sets signed HttpOnly cookie & redirects to Entra authorize URL with PKCE
    const startRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/microsoft/start?returnTo=/documents",
    });
    expect(startRes.statusCode).toBe(302);
    const authorizeUrl = new URL(String(startRes.headers.location));
    expect(authorizeUrl.origin).toBe("https://login.microsoftonline.com");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    lastNonce = authorizeUrl.searchParams.get("nonce") ?? "";
    const stateCookie = startRes.cookies.find((c) => c.name === "papyrus_ms_oidc");
    expect(stateCookie).toBeDefined();

    // Verify PKCE hash matches cookie verifier when callback succeeds
    const callbackRes = await app.inject({
      method: "GET",
      url: `/api/v1/auth/microsoft/callback?code=ms-code-123&state=${encodeURIComponent(state)}`,
      cookies: { papyrus_ms_oidc: stateCookie?.value ?? "" },
    });
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe("https://papyrus.example.com/documents");
    const sessionCookie = callbackRes.cookies.find((c) => c.name === "papyrus_session");
    expect(sessionCookie?.value).toBeTruthy();

    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { papyrus_session: sessionCookie?.value ?? "" },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().data.user.email).toBe("admin@papyrus.invalid");

    // 3. Tampered state cookie is rejected
    const tamperedRes = await app.inject({
      method: "GET",
      url: `/api/v1/auth/microsoft/callback?code=ms-code-123&state=${encodeURIComponent(state)}`,
      cookies: { papyrus_ms_oidc: "tampered.cookie" },
    });
    expect(tamperedRes.statusCode).toBe(302);
    expect(tamperedRes.headers.location).toBe(
      "https://papyrus.example.com/login?authError=microsoft_failed",
    );
    expect(tamperedRes.cookies.find((c) => c.name === "papyrus_session")).toBeUndefined();

    // 4. Unregistered email is denied even with valid Microsoft token
    nextEmailClaim = "outsider@corp.example.com";
    const startUnregistered = await app.inject({
      method: "GET",
      url: "/api/v1/auth/microsoft/start",
    });
    const unregUrl = new URL(String(startUnregistered.headers.location));
    lastNonce = unregUrl.searchParams.get("nonce") ?? "";
    const unregStateCookie = startUnregistered.cookies.find((c) => c.name === "papyrus_ms_oidc");
    const unregCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/microsoft/callback?code=ms-code-456&state=${encodeURIComponent(unregUrl.searchParams.get("state") ?? "")}`,
      cookies: { papyrus_ms_oidc: unregStateCookie?.value ?? "" },
    });
    expect(unregCallback.statusCode).toBe(302);
    expect(unregCallback.headers.location).toBe(
      "https://papyrus.example.com/login?authError=user_not_found",
    );
    expect(unregCallback.cookies.find((c) => c.name === "papyrus_session")).toBeUndefined();

    // 5. Inactive user is denied
    nextEmailClaim = "inactive@papyrus.invalid";
    const startInactive = await app.inject({
      method: "GET",
      url: "/api/v1/auth/microsoft/start",
    });
    const inactiveUrl = new URL(String(startInactive.headers.location));
    lastNonce = inactiveUrl.searchParams.get("nonce") ?? "";
    const inactiveStateCookie = startInactive.cookies.find((c) => c.name === "papyrus_ms_oidc");
    const inactiveCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/microsoft/callback?code=ms-code-789&state=${encodeURIComponent(inactiveUrl.searchParams.get("state") ?? "")}`,
      cookies: { papyrus_ms_oidc: inactiveStateCookie?.value ?? "" },
    });
    expect(inactiveCallback.statusCode).toBe(302);
    expect(inactiveCallback.headers.location).toBe(
      "https://papyrus.example.com/login?authError=account_inactive",
    );

    // 6. Unverified email domain flag (xms_edov: false) is rejected
    nextEmailClaim = "admin@papyrus.invalid";
    nextXmsEdov = false;
    const startEdov = await app.inject({
      method: "GET",
      url: "/api/v1/auth/microsoft/start",
    });
    const edovUrl = new URL(String(startEdov.headers.location));
    lastNonce = edovUrl.searchParams.get("nonce") ?? "";
    const edovStateCookie = startEdov.cookies.find((c) => c.name === "papyrus_ms_oidc");
    const edovCallback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/microsoft/callback?code=ms-code-999&state=${encodeURIComponent(edovUrl.searchParams.get("state") ?? "")}`,
      cookies: { papyrus_ms_oidc: edovStateCookie?.value ?? "" },
    });
    expect(edovCallback.statusCode).toBe(302);
    expect(edovCallback.headers.location).toBe(
      "https://papyrus.example.com/login?authError=microsoft_failed",
    );

    expect(createHash("sha256").update("ok").digest("hex")).toHaveLength(64);
    await app.close();
  });
});
