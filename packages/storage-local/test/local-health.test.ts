import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLocalStorageHealth, createLocalStorageProvider } from "../src/index.js";

const tempDirs: string[] = [];
const permissionRestores: Array<() => Promise<void>> = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (permissionRestores.length > 0) {
    const restore = permissionRestores.pop();
    if (restore) {
      await restore();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Local filesystem health check", () => {
  it("verifies existence, controlled R/W probe, available space, leaves no probe files, and hides host path", async () => {
    const rootDirectory = await makeTempDir("docuflow-health-secret-mount-");
    const result = await checkLocalStorageHealth({ rootDirectory });

    expect(result.healthy).toBe(true);
    expect(result.checkedAt).toBeInstanceOf(Date);
    expect(result.message).not.toContain(rootDirectory);
    expect(result.message).not.toContain("docuflow-health-secret-mount");
    expect(typeof result.availableBytes).toBe("number");
    expect(result.availableBytes ?? 0).toBeGreaterThan(0);

    // Probe temp file was removed cleanly
    const remaining = await readdir(rootDirectory);
    expect(remaining).toEqual([]);

    // Works identically via StorageProvider.checkHealth()
    const provider = createLocalStorageProvider({ rootDirectory });
    const providerHealth = await provider.checkHealth();
    expect(providerHealth.healthy).toBe(true);
    expect(providerHealth.message).not.toContain(rootDirectory);
  });

  it("reports unhealthy without leaking host paths when directory is missing, not a dir, lacks permissions, or lacks space", async () => {
    // 1. Missing directory
    const missingPath = path.join(os.tmpdir(), "docuflow-nonexistent-mount-99999");
    const missingResult = await checkLocalStorageHealth({ rootDirectory: missingPath });
    expect(missingResult.healthy).toBe(false);
    expect(missingResult.message).not.toContain(missingPath);
    expect(missingResult.message).not.toContain("docuflow-nonexistent-mount");

    // 2. Path points to a regular file
    const parentDir = await makeTempDir("docuflow-health-file-");
    const filePath = path.join(parentDir, "regular-file.bin");
    await writeFile(filePath, "data");
    const fileResult = await checkLocalStorageHealth({ rootDirectory: filePath });
    expect(fileResult.healthy).toBe(false);
    expect(fileResult.message).not.toContain(filePath);
    expect(fileResult.message).not.toContain("regular-file.bin");

    // 3. Insufficient free space against configured threshold
    const rootDirectory = await makeTempDir("docuflow-health-space-");
    const tightThresholdResult = await checkLocalStorageHealth({
      rootDirectory,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(tightThresholdResult.healthy).toBe(false);
    expect(tightThresholdResult.message).not.toContain(rootDirectory);

    // 4. Read-only directory fails permissions/write check safely
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (!isRoot) {
      await chmod(rootDirectory, 0o555);
      permissionRestores.push(async () => {
        await chmod(rootDirectory, 0o750);
      });
      const readOnlyResult = await checkLocalStorageHealth({ rootDirectory });
      expect(readOnlyResult.healthy).toBe(false);
      expect(readOnlyResult.message).not.toContain(rootDirectory);
    }
  });
});
