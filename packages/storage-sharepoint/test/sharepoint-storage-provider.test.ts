import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { StorageError } from "@papyrus/storage-core";
import { describe, expect, it, vi } from "vitest";
import {
  createSharePointStorageProvider,
  parseSharePointStorageConfig,
  validateSharePointObjectKey,
} from "../src/index.js";

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function createBaseConfig() {
  return {
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    siteUrl: "https://contoso.sharepoint.com/sites/Documentos",
    libraryName: "Documentos",
    baseFolderPath: "Papyrus/Files",
    credentials: {
      clientSecret: "super-secret-azure-ad-value-123",
    },
  };
}

describe("@papyrus/storage-sharepoint", () => {
  it("validates Entra ID and SharePoint config strictly and blocks SSRF/non-HTTPS/traversal", () => {
    const parsed = parseSharePointStorageConfig(createBaseConfig());
    expect(parsed.siteHostname).toBe("contoso.sharepoint.com");
    expect(parsed.sitePath).toBe("/sites/Documentos");
    expect(parsed.baseFolderPath).toBe("Papyrus/Files");

    expect(() =>
      parseSharePointStorageConfig({
        ...createBaseConfig(),
        siteUrl: "http://contoso.sharepoint.com/sites/Documentos",
      }),
    ).toThrow(StorageError);

    expect(() =>
      parseSharePointStorageConfig({
        ...createBaseConfig(),
        siteUrl: "https://169.254.169.254/latest/meta-data",
      }),
    ).toThrow(StorageError);

    expect(() =>
      parseSharePointStorageConfig({
        ...createBaseConfig(),
        baseFolderPath: "../escape",
      }),
    ).toThrow(StorageError);

    expect(() => validateSharePointObjectKey("org/1/../../etc/passwd")).toThrow(StorageError);
  });

  it("authenticates via OAuth2, caches token, resolves site/library, and runs simple + resumable uploads, headObject, getObject, deleteObject", async () => {
    let tokenCalls = 0;
    const stored = new Map<string, { readonly bytes: Buffer; readonly provideSha256: boolean }>();
    const chunkRanges: string[] = [];

    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("/oauth2/v2.0/token")) {
        tokenCalls += 1;
        return new Response(JSON.stringify({ access_token: "graph-token-xyz", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/sites/contoso.sharepoint.com:/sites/Documentos")) {
        return new Response(
          JSON.stringify({
            id: "site-id-1",
            webUrl: "https://contoso.sharepoint.com/sites/Documentos",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/sites/site-id-1/drives")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "drive-id-1",
                name: "Documentos",
                webUrl: "https://contoso.sharepoint.com/sites/Documentos/Documentos",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/drives/drive-id-1/root?$select=id,name")) {
        return new Response(JSON.stringify({ id: "root-id", name: "root" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith(":/createUploadSession") && method === "POST") {
        const match = /root:\/(.+):\/createUploadSession$/.exec(url);
        const itemPath = match?.[1] ?? "";
        return new Response(
          JSON.stringify({
            uploadUrl: `https://upload.sharepoint.com/session/${encodeURIComponent(itemPath)}`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.startsWith("https://upload.sharepoint.com/session/") && method === "PUT") {
        const itemPath = decodeURIComponent(
          url.replace("https://upload.sharepoint.com/session/", ""),
        );
        const headers = new Headers(init?.headers);
        const range = headers.get("Content-Range") ?? "";
        chunkRanges.push(range);
        const bodyBuf = Buffer.from(init?.body as Uint8Array);
        const prev = stored.get(itemPath)?.bytes ?? Buffer.alloc(0);
        const merged = Buffer.concat([prev, bodyBuf]);
        stored.set(itemPath, { bytes: merged, provideSha256: false });

        const rangeMatch = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
        const end = Number(rangeMatch?.[2] ?? 0);
        const total = Number(rangeMatch?.[3] ?? 0);
        if (end + 1 === total) {
          return new Response(JSON.stringify({ id: "item-large", eTag: '"etag-large"' }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ nextExpectedRanges: [`${end + 1}-`] }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/drives/drive-id-1/root:/") &&
        url.endsWith(":/content") &&
        method === "PUT"
      ) {
        const match = /root:\/(.+):\/content$/.exec(url);
        const itemPath = match?.[1] ?? "";
        const bodyBuf = Buffer.from(init?.body as Uint8Array);
        stored.set(itemPath, { bytes: bodyBuf, provideSha256: true });
        return new Response(JSON.stringify({ id: "item-small", eTag: '"etag-small"' }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.startsWith("https://download.sharepoint.com/file/")) {
        const itemPath = decodeURIComponent(
          url.replace("https://download.sharepoint.com/file/", ""),
        );
        const entry = stored.get(itemPath);
        if (!entry) {
          return new Response(null, { status: 404 });
        }
        return new Response(new Uint8Array(entry.bytes), { status: 200 });
      }

      if (url.includes("/drives/drive-id-1/root:/") && method === "GET") {
        const cleanUrl = url.split("?")[0] ?? "";
        const match = /root:\/(.+)$/.exec(cleanUrl);
        const itemPath = match?.[1] ?? "";
        const entry = stored.get(itemPath);
        if (!entry) {
          return new Response(null, { status: 404 });
        }
        return new Response(
          JSON.stringify({
            id: "item-id",
            size: entry.bytes.length,
            eTag: '"etag-1"',
            file: {
              mimeType: "application/pdf",
              hashes: entry.provideSha256 ? { sha256Hash: sha256Hex(entry.bytes) } : {},
            },
            "@microsoft.graph.downloadUrl": `https://download.sharepoint.com/file/${encodeURIComponent(itemPath)}`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/drives/drive-id-1/root:/") && method === "DELETE") {
        const match = /root:\/(.+)$/.exec(url);
        const itemPath = match?.[1] ?? "";
        if (!stored.has(itemPath)) {
          return new Response(null, { status: 404 });
        }
        stored.delete(itemPath);
        return new Response(null, { status: 204 });
      }

      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });

    const provider = createSharePointStorageProvider(createBaseConfig(), {
      fetchFn: mockFetch,
      simpleUploadMaxBytes: 16,
      chunkSizeBytes: 10,
    });

    // 1. Health check
    const health = await provider.checkHealth();
    expect(health.healthy).toBe(true);
    expect(tokenCalls).toBe(1);

    // 2. Simple upload (<= 16 bytes)
    const smallPayload = Buffer.from("hello-sp", "utf8");
    const smallKey = { value: "org/1/documents/d1/versions/v1/f1" };
    const putSmall = await provider.putObject({
      key: smallKey,
      body: Readable.from([smallPayload]),
      metadata: {
        contentType: "text/plain",
        contentLength: smallPayload.length,
        checksumSha256: sha256Hex(smallPayload),
      },
    });
    expect(putSmall.checksumSha256).toBe(sha256Hex(smallPayload));
    expect(tokenCalls).toBe(1); // Token cached

    // 3. Resumable chunked upload (> 16 bytes, chunks of 10) + headObject streaming SHA-256 fallback
    const largePayload = Buffer.from("0123456789abcdefghijklmno", "utf8"); // 25 bytes -> 10 + 10 + 5
    const largeKey = { value: "org/1/documents/d2/versions/v1/f2" };
    const putLarge = await provider.putObject({
      key: largeKey,
      body: Readable.from([largePayload]),
      metadata: {
        contentType: "application/pdf",
        contentLength: largePayload.length,
        checksumSha256: sha256Hex(largePayload),
      },
    });
    expect(putLarge.contentLength).toBe(25);
    expect(chunkRanges).toEqual(["bytes 0-9/25", "bytes 10-19/25", "bytes 20-24/25"]);

    const headLarge = await provider.headObject(largeKey);
    expect(headLarge?.checksumSha256).toBe(sha256Hex(largePayload));

    // 4. Streaming download
    const downloaded = await provider.getObject(smallKey);
    const readChunks: Buffer[] = [];
    for await (const chunk of downloaded.body) {
      readChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(readChunks).toString("utf8")).toBe("hello-sp");

    // 5. Idempotent delete
    await provider.deleteObject(smallKey);
    await provider.deleteObject(smallKey);
    expect(await provider.headObject(smallKey)).toBeNull();
  });
});
