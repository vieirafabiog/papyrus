import { describe, expect, it } from "vitest";
import { getSafeApiConfigSummary, parseApiConfig, webConfigSchema } from "../src/index.js";

describe("Config schemas", () => {
  it("parses valid API config and redacts secrets in summary", () => {
    const config = parseApiConfig({
      NODE_ENV: "test",
      PORT: "4000",
      APP_URL: "http://localhost:5173",
      DATABASE_URL: "postgresql://user:super_secret_password@localhost:5432/docuflow",
      SESSION_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "b".repeat(32),
    });

    expect(config.port).toBe(4000);
    expect(config.nodeEnv).toBe("test");

    const summary = JSON.stringify(getSafeApiConfigSummary(config));
    expect(summary).not.toContain("super_secret_password");
    expect(summary).not.toContain("a".repeat(32));
    expect(summary).not.toContain("b".repeat(32));
    expect(summary).toContain('"sessionSecretConfigured":true');
  });

  it("rejects invalid web config URL", () => {
    const result = webConfigSchema.safeParse({ apiBaseUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });
});
