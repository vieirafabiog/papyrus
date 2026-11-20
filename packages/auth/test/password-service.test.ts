import { describe, expect, it } from "vitest";
import { createPasswordService } from "../src/index.js";

describe("PasswordService (Argon2id)", () => {
  it("hashes with unique salts and verifies matching vs non-matching passwords", async () => {
    const service = createPasswordService({
      memoryCost: 16_384,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 8,
    });

    const hashA = await service.hashPassword("SenhaSegura!2026");
    const hashB = await service.hashPassword("SenhaSegura!2026");

    expect(hashA).toMatch(/^\$argon2id\$/);
    expect(hashB).toMatch(/^\$argon2id\$/);
    expect(hashA).not.toBe(hashB);

    expect(await service.verifyPassword("SenhaSegura!2026", hashA)).toBe(true);
    expect(await service.verifyPassword("SenhaErrada!2026", hashA)).toBe(false);
    expect(await service.verifyPassword("", hashA)).toBe(false);
    expect(await service.verifyPassword("SenhaSegura!2026", "malformed-hash")).toBe(false);
  });

  it("enforces password length bounds and detects rehash requirements", async () => {
    const legacyService = createPasswordService({
      memoryCost: 8_192,
      timeCost: 2,
      parallelism: 1,
      minPasswordLength: 10,
    });

    await expect(legacyService.hashPassword("curta")).rejects.toThrow();
    await expect(legacyService.hashPassword("a".repeat(300))).rejects.toThrow();

    const oldHash = await legacyService.hashPassword("SenhaForte!2026");
    expect(legacyService.needsRehash(oldHash)).toBe(false);

    const upgradedService = createPasswordService({
      memoryCost: 32_768,
      timeCost: 3,
      parallelism: 1,
      minPasswordLength: 10,
    });
    expect(upgradedService.needsRehash(oldHash)).toBe(true);
    expect(upgradedService.needsRehash("not-argon2id")).toBe(true);
  });
});
