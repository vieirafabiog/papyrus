import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
  },
});
