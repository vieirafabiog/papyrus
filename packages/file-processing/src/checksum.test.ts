import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  ChecksumValidationError,
  PLACEHOLDER_SHA256_HEX,
  calculateStreamSha256,
  createSha256HashingTransform,
  isChecksumEqualConstantTime,
  normalizeSha256Hex,
  verifyStreamSha256,
} from "./index.js";

function sha256Hex(chunks: readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

describe("Streaming SHA-256 checksum calculation and validation", () => {
  it("computes SHA-256 across multi-chunk large streams without buffering the full payload in memory", async () => {
    const chunkSize = 64 * 1024;
    const totalChunks = 64; // 4 MiB total generated on-the-fly
    const sampleChunk = Buffer.alloc(chunkSize, 0x5a);
    const expectedHash = createHash("sha256");
    for (let i = 0; i < totalChunks; i += 1) {
      expectedHash.update(sampleChunk);
    }
    const expectedDigest = expectedHash.digest("hex");

    let producedChunks = 0;
    const largeStream = new Readable({
      read() {
        if (producedChunks >= totalChunks) {
          this.push(null);
          return;
        }
        producedChunks += 1;
        this.push(sampleChunk);
      },
    });

    const result = await calculateStreamSha256(largeStream);

    expect(result.bytesProcessed).toBe(chunkSize * totalChunks);
    expect(result.checksumSha256).toBe(expectedDigest);
    expect(producedChunks).toBe(totalChunks);
  });

  it("validates expected checksum and size accurately with case-insensitive normalization and constant-time comparison", async () => {
    const chunks = [
      Buffer.from("Primeira parte do documento ", "utf8"),
      Buffer.from("e segunda parte final.", "utf8"),
    ];
    const expected = sha256Hex(chunks);
    const expectedTotalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

    const okResult = await verifyStreamSha256(Readable.from(chunks), {
      expectedChecksumSha256: expected.toUpperCase(),
      expectedSizeBytes: expectedTotalBytes,
    });

    expect(okResult.valid).toBe(true);
    expect(okResult.checksumMatched).toBe(true);
    expect(okResult.sizeMatched).toBe(true);
    expect(okResult.actualChecksumSha256).toBe(expected);
    expect(okResult.expectedChecksumSha256).toBe(expected);
    expect(okResult.bytesProcessed).toBe(expectedTotalBytes);

    // Tampered payload fails checksum verification
    const wrongChunks = [Buffer.from("Conteúdo adulterado em trânsito.", "utf8")];
    const mismatchResult = await verifyStreamSha256(Readable.from(wrongChunks), {
      expectedChecksumSha256: expected,
    });
    expect(mismatchResult.valid).toBe(false);
    expect(mismatchResult.checksumMatched).toBe(false);

    await expect(
      verifyStreamSha256(Readable.from(wrongChunks), {
        expectedChecksumSha256: expected,
        throwOnMismatch: true,
      }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });

    // Size divergence is caught when expectedSizeBytes is given
    await expect(
      verifyStreamSha256(Readable.from(chunks), {
        expectedChecksumSha256: expected,
        expectedSizeBytes: expectedTotalBytes + 1,
        throwOnMismatch: true,
      }),
    ).rejects.toMatchObject({ code: "SIZE_MISMATCH" });

    expect(isChecksumEqualConstantTime(expected, expected.toUpperCase())).toBe(true);
    expect(isChecksumEqualConstantTime(expected, "f".repeat(64))).toBe(false);
    expect(isChecksumEqualConstantTime(expected, "short")).toBe(false);
  });

  it("enforces maxBytes bounds, rejects placeholder/invalid hashes, supports AbortSignal, and works in Transform pipelines", async () => {
    // Reject placeholder and malformed checksums fail-fast
    expect(() => normalizeSha256Hex(PLACEHOLDER_SHA256_HEX)).toThrowError(ChecksumValidationError);
    expect(normalizeSha256Hex(PLACEHOLDER_SHA256_HEX, { allowPlaceholder: true })).toBe(
      PLACEHOLDER_SHA256_HEX,
    );
    expect(() => normalizeSha256Hex("not-a-sha256")).toThrowError(ChecksumValidationError);

    // Enforces maxBytes during streaming without draining an unbounded source
    const oversizedChunks = [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2), Buffer.alloc(1024, 3)];
    await expect(
      calculateStreamSha256(Readable.from(oversizedChunks), { maxBytes: 1500 }),
    ).rejects.toMatchObject({ code: "SIZE_LIMIT_EXCEEDED" });

    // Rejects empty streams when allowEmpty is false
    await expect(
      calculateStreamSha256(Readable.from([]), { allowEmpty: false }),
    ).rejects.toMatchObject({ code: "EMPTY_STREAM" });

    // Supports AbortSignal cancellation
    const controller = new AbortController();
    controller.abort();
    await expect(
      calculateStreamSha256(Readable.from([Buffer.from("abc")]), {
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });

    // Works inside a streaming Transform pipeline and verifies expected checksum on flush
    const payload = Buffer.from("Pipeline streaming SHA-256 validation bytes", "utf8");
    const expected = sha256Hex([payload]);
    let observedDigest: string | null = null;
    const outputSink = new PassThrough();
    const collectedChunks: Buffer[] = [];
    outputSink.on("data", (chunk: Buffer) => collectedChunks.push(chunk));

    await pipeline(
      Readable.from([payload.subarray(0, 12), payload.subarray(12)]),
      createSha256HashingTransform({
        expectedChecksumSha256: expected,
        expectedSizeBytes: payload.length,
        onDigest: (res) => {
          observedDigest = res.checksumSha256;
        },
      }),
      outputSink,
    );

    expect(observedDigest).toBe(expected);
    expect(Buffer.concat(collectedChunks).equals(payload)).toBe(true);
  });
});
