import { describe, expect, it, vi } from "vitest";
import { createWorkerRuntime, type WorkerLogger } from "../src/worker.js";

describe("Worker runtime", () => {
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
});
