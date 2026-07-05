import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@nocturne/core": r("./packages/core/src/index.ts"),
      "@nocturne/engine": r("./packages/engine/src/index.ts"),
      "@nocturne/server": r("./packages/server/src/index.ts"),
      "@nocturne/remote": r("./packages/remote/src/index.ts"),
    },
  },
  test: {
    globals: true,
    include: ["packages/**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "e2e/**"],
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
