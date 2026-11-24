import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { createClamAvScanner, parseClamdInstreamResponse } from "./index.js";

interface MockClamdServerHandle {
  readonly port: number;
  readonly close: () => Promise<void>;
}

function startMockClamdServer(
  handler: (params: {
    readonly command: "PING" | "INSTREAM";
    readonly receivedPayload: Buffer;
    readonly socket: net.Socket;
  }) => void | Promise<void>,
): Promise<MockClamdServerHandle> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let commandParsed = false;
      let mode: "PING" | "INSTREAM" | null = null;
      const chunks: Buffer[] = [];
      let awaitingChunkLen = true;
      let expectedChunkLen = 0;

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (!commandParsed) {
          const nulIdx = buffer.indexOf(0);
          if (nulIdx < 0) {
            return;
          }
          const cmd = buffer.subarray(0, nulIdx).toString("ascii");
          buffer = buffer.subarray(nulIdx + 1);
          commandParsed = true;
          if (cmd === "zPING") {
            mode = "PING";
            void handler({ command: "PING", receivedPayload: Buffer.alloc(0), socket });
            return;
          }
          if (cmd === "zINSTREAM") {
            mode = "INSTREAM";
          } else {
            socket.end("UNKNOWN COMMAND\0");
            return;
          }
        }

        if (mode === "INSTREAM") {
          while (true) {
            if (awaitingChunkLen) {
              if (buffer.length < 4) {
                break;
              }
              expectedChunkLen = buffer.readUInt32BE(0);
              buffer = buffer.subarray(4);
              if (expectedChunkLen === 0) {
                const payload = Buffer.concat(chunks);
                void handler({ command: "INSTREAM", receivedPayload: payload, socket });
                break;
              }
              awaitingChunkLen = false;
            } else {
              if (buffer.length < expectedChunkLen) {
                break;
              }
              chunks.push(buffer.subarray(0, expectedChunkLen));
              buffer = buffer.subarray(expectedChunkLen);
              awaitingChunkLen = true;
            }
          }
        }
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

describe("ClamAV adapter (zPING / zINSTREAM)", () => {
  const handles: MockClamdServerHandle[] = [];
  const tempDirs: string[] = [];

  afterAll(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) {
        await handle.close();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("parses clamd protocol responses fail-closed", () => {
    expect(parseClamdInstreamResponse("stream: OK\0")).toEqual({
      status: "CLEAN",
      detectedSignature: null,
      rawErrorCode: "CLAMD_OK",
    });
    expect(parseClamdInstreamResponse("stream: Eicar-Signature FOUND\n")).toEqual({
      status: "INFECTED",
      detectedSignature: "Eicar-Signature",
      rawErrorCode: "CLAMD_THREAT_FOUND",
    });
    expect(parseClamdInstreamResponse("INSTREAM size limit exceeded. ERROR\0")).toMatchObject({
      status: "ERROR",
    });
    expect(parseClamdInstreamResponse("GARBAGE")).toMatchObject({
      status: "ERROR",
    });
  });

  it("scans clean multi-chunk streams and verifies zPING health against clamd wire protocol", async () => {
    let observedStreamBytes: Buffer = Buffer.alloc(0);
    const server = await startMockClamdServer(({ command, receivedPayload, socket }) => {
      if (command === "PING") {
        socket.end("PONG\0");
        return;
      }
      observedStreamBytes = receivedPayload;
      socket.end("stream: OK\0");
    });
    handles.push(server);

    const scanner = createClamAvScanner({
      transport: "tcp",
      host: "127.0.0.1",
      port: server.port,
      chunkSizeBytes: 512,
      timeoutMs: 5_000,
    });

    const health = await scanner.checkHealth();
    expect(health.healthy).toBe(true);
    expect(health.status).toBe("AVAILABLE");

    const fileContent = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "utf8"),
      Buffer.alloc(2_048, 0x42),
      Buffer.from("\n%%EOF", "utf8"),
    ]);

    const scanResult = await scanner.scanStream({
      stream: Readable.from([fileContent.subarray(0, 700), fileContent.subarray(700)]),
      declaredSizeBytes: fileContent.length,
    });

    expect(scanResult.status).toBe("CLEAN");
    expect(scanResult.approved).toBe(true);
    expect(scanResult.disposition).toBe("APPROVE");
    expect(scanResult.retryable).toBe(false);
    expect(scanResult.bytesScanned).toBe(fileContent.length);
    expect(observedStreamBytes.equals(fileContent)).toBe(true);
  });

  it("rejects infected payloads cleanly without exposing internal signature in safeMessage", async () => {
    const server = await startMockClamdServer(({ command, socket }) => {
      if (command === "PING") {
        socket.end("PONG\0");
        return;
      }
      socket.end("stream: Win.Test.EICAR_HDB-1 FOUND\0");
    });
    handles.push(server);

    const scanner = createClamAvScanner({
      transport: "tcp",
      host: "127.0.0.1",
      port: server.port,
    });

    const payload = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR", "utf8");
    const result = await scanner.scanStream({ stream: Readable.from([payload]) });

    expect(result.status).toBe("INFECTED");
    expect(result.approved).toBe(false);
    expect(result.disposition).toBe("REJECT");
    expect(result.retryable).toBe(false);
    expect(result.detectedSignature).toBe("Win.Test.EICAR_HDB-1");
    expect(result.safeMessage).not.toContain("EICAR");
  });

  it("fails closed with explicit UNAVAILABLE and TIMEOUT states when clamd is unreachable or stalls", async () => {
    // 1. Unreachable closed port -> UNAVAILABLE + approved: false + retryable: true
    const deadServer = await startMockClamdServer(() => {});
    const closedPort = deadServer.port;
    await deadServer.close();

    const offlineScanner = createClamAvScanner({
      transport: "tcp",
      host: "127.0.0.1",
      port: closedPort,
      timeoutMs: 2_000,
    });

    const healthDown = await offlineScanner.checkHealth();
    expect(healthDown.healthy).toBe(false);
    expect(healthDown.status).toBe("UNAVAILABLE");

    const offlineScan = await offlineScanner.scanStream({
      stream: Readable.from([Buffer.from("documento teste")]),
    });
    expect(offlineScan.status).toBe("UNAVAILABLE");
    expect(offlineScan.approved).toBe(false);
    expect(offlineScan.disposition).toBe("DEFER_RETRY");
    expect(offlineScan.retryable).toBe(true);

    // 2. Hung clamd server -> TIMEOUT + approved: false + retryable: true
    const slowSockets: net.Socket[] = [];
    const hungServer = await startMockClamdServer(({ socket }) => {
      slowSockets.push(socket);
      // Intentionally do not respond
    });
    handles.push(hungServer);

    const fastTimeoutScanner = createClamAvScanner({
      transport: "tcp",
      host: "127.0.0.1",
      port: hungServer.port,
      timeoutMs: 80,
    });

    const timedOut = await fastTimeoutScanner.scanStream({
      stream: Readable.from([Buffer.from("payload lento")]),
    });
    for (const s of slowSockets) {
      s.destroy();
    }
    expect(timedOut.status).toBe("TIMEOUT");
    expect(timedOut.approved).toBe(false);
    expect(timedOut.disposition).toBe("DEFER_RETRY");
    expect(timedOut.retryable).toBe(true);

    // 3. Oversized stream blocked cleanly before exceeding limit
    const sizeGuardScanner = createClamAvScanner({
      transport: "tcp",
      host: "127.0.0.1",
      port: hungServer.port,
      maxStreamBytes: 128,
    });
    const oversized = await sizeGuardScanner.scanStream({
      stream: Readable.from([Buffer.alloc(256, 0x41)]),
      declaredSizeBytes: 256,
    });
    expect(oversized.status).toBe("ERROR");
    expect(oversized.approved).toBe(false);
    expect(oversized.disposition).toBe("REJECT");
  });

  it("supports Unix socket transport when configured", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "papyrus-clamav-unix-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "clamd.sock");

    const unixServer = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        if (chunk.includes(0) && chunk.toString("ascii").includes("zPING")) {
          socket.end("PONG\0");
        } else if (chunk.includes(Buffer.alloc(4, 0))) {
          socket.end("stream: OK\0");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      unixServer.once("error", reject);
      unixServer.listen(socketPath, () => resolve());
    });

    try {
      const unixScanner = createClamAvScanner({
        transport: "unix",
        socketPath,
        timeoutMs: 2_000,
      });
      const health = await unixScanner.checkHealth();
      expect(health.healthy).toBe(true);
      expect(health.status).toBe("AVAILABLE");

      const scan = await unixScanner.scanStream({
        stream: Readable.from([Buffer.from("unix stream ok")]),
      });
      expect(scan.status).toBe("CLEAN");
      expect(scan.approved).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        unixServer.close(() => resolve());
      });
    }
  });
});
