import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    // Same "@/*" -> repo root alias tsconfig.json gives the app.
    alias: { "@": resolve(__dirname, ".") },
  },
  // tsconfig says "jsx": "preserve" (Next compiles JSX itself, with the
  // automatic runtime); match that so tests can render components.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
