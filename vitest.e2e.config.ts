import { defineConfig } from "vitest/config";

/**
 * The deployed-stack suite (`e2e/`).
 *
 * Separate from `vitest.config.ts` on purpose: `pnpm test` must stay offline,
 * and `test/` must stay exactly the suite `test/manifest.test.ts` guards. This
 * config needs credentials, deploys to a real account, and tears down — so it is
 * run explicitly with `pnpm test:e2e`, never as part of the offline gate.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Node cannot resolve the Workers runtime module; the test stub stands in.
      "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["e2e/**/*.test.ts"],
    // A real deploy and destroy are minutes, not milliseconds.
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
