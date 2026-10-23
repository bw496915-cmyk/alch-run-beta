import { defineConfig } from "vitest/config";

/**
 * The dev-mode API suite (`test/api.test.ts`).
 *
 * Separate from `vitest.config.ts` on purpose: it boots workerd and deploys the
 * stack locally (~2 minutes), so it is not part of the offline `pnpm test` gate.
 * The default config excludes the file; this one includes only it. Run it with
 * `pnpm test:dev`.
 */
export default defineConfig({
  test: {
    include: ["test/api.test.ts"],
    // The first request through a just-booted dev worker, and `destroy` on the
    // way out, are both slow — the defaults (5s / 120s) are too small.
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
