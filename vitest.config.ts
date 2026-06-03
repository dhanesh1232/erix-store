import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Reads tsconfig.json#paths and exposes "@/..." to the test runner,
    // matching what tsc + tsc-alias do for the production build.
    tsconfigPaths(),
  ],
  resolve: {
    alias: {
      // Explicit fallback so test files can use "@/..." even if the
      // tsconfig-paths plugin isn't applied for some reason.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "client/src/**/*.ts", "worker/src/**/*.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
    },
  },
});
