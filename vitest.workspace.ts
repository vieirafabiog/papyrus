import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "docuflow",
      passWithNoTests: true,
      include: ["packages/**/*.{test,spec}.{ts,tsx}", "apps/**/*.{test,spec}.{ts,tsx}"],
    },
  },
]);
