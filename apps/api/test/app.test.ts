import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("API app", () => {
  it("responds to GET /api/v1/health/live", async () => {
    const app = buildApp({ logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
