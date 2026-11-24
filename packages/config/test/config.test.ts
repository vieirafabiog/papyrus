import { describe, expect, it } from "vitest";
import {
  getSafeApiConfigSummary,
  parseApiConfig,
  parseUploadEnvPolicy,
  webConfigSchema,
} from "../src/index.js";

describe("Config schemas", () => {
  it("parses valid API config and redacts secrets in summary", () => {
    const config = parseApiConfig({
      NODE_ENV: "test",
      PORT: "4000",
      APP_URL: "http://localhost:5173",
      DATABASE_URL: "postgresql://user:super_secret_password@localhost:5432/papyrus",
      SESSION_SECRET: "a".repeat(32),
      ENCRYPTION_KEY: "b".repeat(32),
    });

    expect(config.port).toBe(4000);
    expect(config.nodeEnv).toBe("test");
    expect(config.proxyMaxBodyBytes).toBeGreaterThanOrEqual(config.uploadMaxBytes);

    const summary = JSON.stringify(getSafeApiConfigSummary(config));
    expect(summary).not.toContain("super_secret_password");
    expect(summary).not.toContain("a".repeat(32));
    expect(summary).not.toContain("b".repeat(32));
    expect(summary).toContain('"sessionSecretConfigured":true');
  });

  it("validates upload size, proxy body ceiling consistency, and allowed extensions", () => {
    const policy = parseUploadEnvPolicy({
      UPLOAD_MAX_BYTES: "10485760",
      PROXY_MAX_BODY_BYTES: "12582912",
      UPLOAD_ALLOWED_EXTENSIONS: "pdf, .png, .docx",
    });

    expect(policy.uploadMaxBytes).toBe(10_485_760);
    expect(policy.proxyMaxBodyBytes).toBe(12_582_912);
    expect(policy.allowedExtensions).toEqual([".pdf", ".png", ".docx"]);

    expect(() =>
      parseUploadEnvPolicy({
        UPLOAD_MAX_BYTES: "10485760",
        PROXY_MAX_BODY_BYTES: "1048576",
      }),
    ).toThrow(/PROXY_MAX_BODY_BYTES/);

    expect(() =>
      parseUploadEnvPolicy({
        UPLOAD_ALLOWED_EXTENSIONS: ".pdf,.exe",
      }),
    ).toThrow(/perigosa/);
  });

  it("rejects invalid web config URL", () => {
    const result = webConfigSchema.safeParse({ apiBaseUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });
});
