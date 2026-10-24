import { defineConfig } from "vitest/config";

/**
 * Scopes the suite to `test/` deliberately.
 *
 * The repo root also holds directories that are not source: `.alchemy/` (state and
 * dev logs), `.home/` (the workspace-local HOME used to run the Alchemy CLI), the
 * pnpm store, and whatever scratch directories a probe leaves behind. None of them
 * should be able to contribute a test to `pnpm test` — a stray `*.test.ts` would
 * silently join the gate.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The dev-mode API suite (`test/api.test.ts`) boots workerd and deploys the
    // stack locally — ~2 minutes, and not offline-gate material. It runs via
    // `pnpm test:dev`. Excluded here rather than moved so the file stays where
    // readers expect the API tests.
    exclude: ["**/node_modules/**", "**/dist/**", "test/api.test.ts"],
    // Every fake is in memory, so anything slower than this is a hang, not a test.
    testTimeout: 5_000,
  },
});
