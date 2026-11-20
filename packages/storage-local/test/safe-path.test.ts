import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageError } from "@docuflow/storage-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveSafeLocalPath,
  resolveSafeLocalRoot,
  validateLocalObjectKey,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Local safe path resolution", () => {
  it("resolves valid opaque object keys inside the configured root", async () => {
    const rootDir = await makeTempDir("docuflow-local-root-");
    const key =
      "org/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222/versions/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444";

    const resolved = await resolveSafeLocalPath(rootDir, key);
    expect(resolved.normalizedKey).toBe(key);
    expect(resolved.targetPath.startsWith(`${resolved.rootRealPath}${path.sep}`)).toBe(true);
    expect(resolved.parentDirPath).toBe(path.dirname(resolved.targetPath));
  });

  it("rejects path traversal, backslashes, hidden segments, control characters, and unexpected object names", async () => {
    const rootDir = await makeTempDir("docuflow-local-invalid-");
    const maliciousKeys = [
      "",
      "   ",
      " leading-space",
      "../outside",
      "org/../secret",
      "org/./file",
      "/etc/passwd",
      "org/file/",
      "org//file",
      "org\\secret",
      "org/file\u0000.pdf",
      "org/.hidden/object",
      "org/CON/object",
      "C:/windows/system32",
      "org/%2e%2e/secret",
      "org/file name with spaces",
      "org/file;rm -rf",
      `${"a/".repeat(20)}leaf`,
    ];

    for (const candidate of maliciousKeys) {
      expect(() => validateLocalObjectKey(candidate)).toThrowError(StorageError);
      await expect(resolveSafeLocalPath(rootDir, candidate)).rejects.toMatchObject({
        code: "INVALID_KEY",
        providerKind: "local",
      });
    }
  });

  it("blocks symlink escapes in both intermediate directories and leaf object targets", async () => {
    const rootDir = await makeTempDir("docuflow-local-sym-root-");
    const outsideDir = await makeTempDir("docuflow-local-outside-");
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "outside-secret");

    // 1. Intermediate directory symlink pointing outside root
    const linkDir = path.join(rootDir, "org");
    await symlink(outsideDir, linkDir);

    await expect(resolveSafeLocalPath(rootDir, "org/secret.txt")).rejects.toMatchObject({
      code: "INVALID_KEY",
      providerKind: "local",
    });

    // 2. Leaf symlink pointing outside root
    const realSubdir = path.join(rootDir, "real-org", "docs");
    await mkdir(realSubdir, { recursive: true });
    await symlink(outsideFile, path.join(realSubdir, "escaped-leaf"));

    await expect(resolveSafeLocalPath(rootDir, "real-org/docs/escaped-leaf")).rejects.toMatchObject(
      {
        code: "INVALID_KEY",
        providerKind: "local",
      },
    );

    // 3. Even an internal symlink is rejected inside local object storage
    const legitimateFile = path.join(realSubdir, "legit-obj");
    await writeFile(legitimateFile, "ok");
    await symlink(legitimateFile, path.join(realSubdir, "internal-link"));

    await expect(
      resolveSafeLocalPath(rootDir, "real-org/docs/internal-link"),
    ).rejects.toMatchObject({
      code: "INVALID_KEY",
      providerKind: "local",
    });
  });

  it("rejects relative, non-existent, or non-directory root paths and file-as-directory collisions", async () => {
    await expect(resolveSafeLocalRoot("relative/storage/path")).rejects.toMatchObject({
      code: "INVALID_KEY",
    });

    const missingDir = path.join(os.tmpdir(), "docuflow-definitely-missing-root-dir");
    await expect(resolveSafeLocalRoot(missingDir)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const parent = await makeTempDir("docuflow-local-file-root-");
    const fileInsteadOfDir = path.join(parent, "not-a-dir");
    await writeFile(fileInsteadOfDir, "x");
    await expect(resolveSafeLocalRoot(fileInsteadOfDir)).rejects.toMatchObject({
      code: "INVALID_KEY",
    });

    // Collision: object prefix segment is an existing file, and leaf key is an existing directory
    const rootDir = await makeTempDir("docuflow-local-collision-");
    await writeFile(path.join(rootDir, "org"), "blocking-file");
    await expect(resolveSafeLocalPath(rootDir, "org/child-obj")).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await mkdir(path.join(rootDir, "folder-leaf"), { recursive: true });
    await expect(resolveSafeLocalPath(rootDir, "folder-leaf")).rejects.toMatchObject({
      code: "INVALID_KEY",
    });
  });
});
