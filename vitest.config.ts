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
  resolve: {
    alias: {
      // Node cannot resolve the Workers runtime module; the test stub stands in.
      "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Every fake is in memory, so anything slower than this is a hang, not a test.
    testTimeout: 5_000,
  },
});
