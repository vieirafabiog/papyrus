import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MasterKeyConfigError,
  loadMasterEncryptionKey,
  loadMasterKeyring,
  parseMasterKeyMaterial,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("External master key loading and validation", () => {
  it("accepts valid 32-byte hex and base64 master keys", () => {
    const keyBytes = randomBytes(32);

    const parsedHex = parseMasterKeyMaterial(keyBytes.toString("hex"));
    expect(parsedHex.equals(keyBytes)).toBe(true);

    const parsedBase64 = parseMasterKeyMaterial(keyBytes.toString("base64"));
    expect(parsedBase64.equals(keyBytes)).toBe(true);

    const parsedBase64Url = parseMasterKeyMaterial(keyBytes.toString("base64url"));
    expect(parsedBase64Url.equals(keyBytes)).toBe(true);
  });

  it("fails explicitly without leaking key material when key is missing or malformed", () => {
    expect(() => loadMasterEncryptionKey({})).toThrowError(MasterKeyConfigError);
    expect(() => loadMasterEncryptionKey({ ENCRYPTION_KEY: "   " })).toThrowError(/ausente/i);

    const malformed = [
      "replace_with_32_bytes_base64_or_hex_master_key",
      "too-short",
      "a".repeat(62),
      "z".repeat(64),
      Buffer.alloc(16, 1).toString("base64"),
    ];

    for (const candidate of malformed) {
      try {
        parseMasterKeyMaterial(candidate);
        expect.unreachable(`Expected failure for ${candidate}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MasterKeyConfigError);
        const err = error as MasterKeyConfigError;
        expect(err.code).toBe("MASTER_KEY_INVALID");
        expect(err.message).not.toContain(candidate);
      }
    }
  });

  it("loads master key from ENCRYPTION_KEY_FILE and parses previous rotation keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "papyrus-secret-"));
    tempDirs.push(dir);
    const keyFile = path.join(dir, "master.key");
    const activeBytes = randomBytes(32);
    const prevBytes = randomBytes(32);
    await writeFile(keyFile, `${activeBytes.toString("hex")}\n`, "utf8");

    const keyring = loadMasterKeyring({
      ENCRYPTION_KEY_FILE: keyFile,
      ENCRYPTION_KEY_ID: "v2",
      ENCRYPTION_PREVIOUS_KEYS: `v1:${prevBytes.toString("base64")}`,
    });

    expect(keyring.activeKeyId).toBe("v2");
    expect(keyring.activeKey.equals(activeBytes)).toBe(true);
    expect(keyring.keysById.v1?.equals(prevBytes)).toBe(true);

    expect(() =>
      loadMasterEncryptionKey({ ENCRYPTION_KEY_FILE: path.join(dir, "missing.key") }),
    ).toThrowError(MasterKeyConfigError);
  });
});
