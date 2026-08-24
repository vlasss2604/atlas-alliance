import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Тот же алиас, что в tsconfig ("@/*" -> "./*")
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Provider credentials inherited from the developer's ambient shell
    // must never decide how a test behaves — see tests/setup-provider-env.ts.
    setupFiles: ["tests/setup-provider-env.ts"],
    // Тесты БД делят одну базу atlas_test — строго последовательно.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
