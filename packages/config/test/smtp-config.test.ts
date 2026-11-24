import { describe, expect, it } from "vitest";
import { getSafeSmtpConfigSummary, parseOptionalSmtpEnvConfig } from "../src/index.js";

describe("Optional SMTP environment configuration", () => {
  it("returns null when SMTP_HOST is omitted", () => {
    const parsed = parseOptionalSmtpEnvConfig({});
    expect(parsed).toBeNull();
    expect(getSafeSmtpConfigSummary(parsed)).toEqual({ enabled: false });
  });

  it("parses explicit SMTP variables and redacts password in safe summary", () => {
    const parsed = parseOptionalSmtpEnvConfig({
      SMTP_HOST: "mail.empresa.local",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      SMTP_USER: "papyrus@empresa.local",
      SMTP_PASS: "SuperSecretSmtpPass!123",
      SMTP_FROM: "papyrus <noreply@empresa.local>",
    });

    expect(parsed).toEqual({
      host: "mail.empresa.local",
      port: 587,
      securityMode: "STARTTLS",
      username: "papyrus@empresa.local",
      password: "SuperSecretSmtpPass!123",
      from: "papyrus <noreply@empresa.local>",
      timeoutMs: 10_000,
    });

    const summary = getSafeSmtpConfigSummary(parsed);
    expect(summary).toEqual({
      enabled: true,
      host: "mail.empresa.local",
      port: 587,
      securityMode: "STARTTLS",
      from: "papyrus <noreply@empresa.local>",
      authConfigured: true,
      timeoutMs: 10_000,
    });
    expect(JSON.stringify(summary)).not.toContain("SuperSecretSmtpPass");
  });

  it("rejects header injection sequences in SMTP_HOST and SMTP_FROM", () => {
    expect(() =>
      parseOptionalSmtpEnvConfig({
        SMTP_HOST: "mail.empresa.local\r\nBcc: attacker@evil.invalid",
        SMTP_FROM: "noreply@empresa.local",
      }),
    ).toThrow();
  });
});
