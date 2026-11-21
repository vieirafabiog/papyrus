import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { type WorkerLogger, createWorkerHealthServer, createWorkerRuntime } from "../src/worker.js";

describe("Worker runtime & health probes (Step 14.07)", () => {
  it("starts, reports local health, and stops gracefully", async () => {
    const logger: WorkerLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const runtime = createWorkerRuntime(logger);

    expect(runtime.getHealth()).toEqual({
      status: "stopped",
      startedAt: null,
      uptimeMs: 0,
    });

    await runtime.start();
    const runningHealth = runtime.getHealth();
    expect(runningHealth.status).toBe("running");
    expect(runningHealth.startedAt).not.toBeNull();
    expect(runningHealth.uptimeMs).toBeGreaterThanOrEqual(0);

    await runtime.stop("SIGTERM");
    expect(runtime.getHealth()).toEqual({
      status: "stopped",
      startedAt: null,
      uptimeMs: 0,
    });
  });

  it("separates worker liveness and readiness over HTTP without leaking internal details", async () => {
    let dbOk = false;
    const runtime = createWorkerRuntime({
      logger: { info: vi.fn(), error: vi.fn() },
      checkDatabase: async () => {
        if (!dbOk) {
          throw new Error("postgresql://worker:secret@db.internal/prod");
        }
        return { healthy: true };
      },
      now: () => new Date("2026-11-21T20:10:00.000Z"),
    });

    const healthServer = await createWorkerHealthServer({
      runtime,
      host: "127.0.0.1",
      port: 0,
    });
    const addr = healthServer.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Stopped -> both live (503) and ready (503)
      const stoppedReady = await fetch(`${baseUrl}/health/ready`);
      expect(stoppedReady.status).toBe(503);

      await runtime.start();

      // Running with failing DB -> live 200, ready 503 without internal error strings
      const liveRes = await fetch(`${baseUrl}/health/live`);
      expect(liveRes.status).toBe(200);
      expect(await liveRes.json()).toEqual({ status: "ok" });

      const readyDegraded = await fetch(`${baseUrl}/health/ready`);
      expect(readyDegraded.status).toBe(503);
      const degradedText = await readyDegraded.text();
      expect(JSON.parse(degradedText)).toEqual({
        status: "not_ready",
        checkedAt: "2026-11-21T20:10:00.000Z",
        checks: {
          runtime: "ok",
          database: "degraded",
        },
      });
      expect(degradedText).not.toContain("secret");
      expect(degradedText).not.toContain("db.internal");

      // DB recovers -> ready 200
      dbOk = true;
      const readyOk = await fetch(`${baseUrl}/health/ready`);
      expect(readyOk.status).toBe(200);
      expect(await readyOk.json()).toEqual({
        status: "ready",
        checkedAt: "2026-11-21T20:10:00.000Z",
        checks: {
          runtime: "ok",
          database: "ok",
        },
      });
    } finally {
      await healthServer.close();
      await runtime.stop("SIGTERM");
    }
  });
});
