import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "apps/web/vitest.config.ts",
  "packages/ui/vitest.config.ts",
  {
    test: {
      name: "docuflow-unit",
      environment: "node",
      passWithNoTests: true,
      testTimeout: 15_000,
      include: ["packages/**/*.{test,spec}.{ts,tsx}", "apps/**/*.{test,spec}.{ts,tsx}"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "apps/web/**",
        "packages/ui/**",
        "**/test/integration/**",
        "packages/database/test/**",
      ],
    },
  },
]);
