import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function getPackageName(id: string): string | null {
  const normalized = id.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/node_modules/");
  if (idx === -1) {
    return null;
  }
  const rest = normalized.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  const first = parts[0];
  if (!first) {
    return null;
  }
  if (first.startsWith("@")) {
    const second = parts[1];
    return second ? `${first}/${second}` : first;
  }
  return first;
}

const UI_FRAMEWORK_PACKAGES = new Set<string>([
  "react",
  "react-dom",
  "scheduler",
  "react-router",
  "react-router-dom",
  "@emotion/react",
  "@emotion/styled",
  "@emotion/cache",
  "@emotion/sheet",
  "@emotion/serialize",
  "@emotion/utils",
  "@emotion/weak-memoize",
  "@emotion/memoize",
  "@emotion/unitless",
  "@emotion/is-prop-valid",
  "@emotion/use-insertion-effect-with-fallbacks",
  "stylis",
]);

function resolveManualChunk(id: string): string | undefined {
  const pkg = getPackageName(id);
  if (!pkg) {
    return undefined;
  }
  if (pkg === "@mui/icons-material") {
    return "vendor-mui-icons";
  }
  if (UI_FRAMEWORK_PACKAGES.has(pkg) || pkg.startsWith("@mui/") || pkg.startsWith("@popperjs/")) {
    return "vendor-ui";
  }
  if (pkg.startsWith("@tanstack/")) {
    return "vendor-query";
  }
  if (pkg === "zod") {
    return "vendor-zod";
  }
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: resolveManualChunk,
      },
    },
  },
});
