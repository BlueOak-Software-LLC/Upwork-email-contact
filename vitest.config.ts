import { defineConfig } from "vitest/config";

/**
 * Vitest needs the `@/*` alias that tsconfig declares, otherwise the modules
 * under test import each other one way and the tests import them another.
 */
export default defineConfig({
  test: {
    // The SQL suite boots a real PostgreSQL engine; give the first run room.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
      // See tests/helpers/server-only.ts: the real package throws under a plain
      // Node resolution, which would block testing any server module.
      "server-only": new URL("./tests/helpers/server-only.ts", import.meta.url).pathname,
    },
  },
});
