import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { expect } from "vitest";

import Stack from "../alchemy.run.ts";

/**
 * Deployed-stack end-to-end test — the layer the offline suite cannot reach
 * (REVIEW §4 #7). It deploys this Stack to a `test_$USER` stage (the harness
 * default, isolated from `deep-pass`), drives the live Worker over HTTP, and
 * tears it down.
 *
 * Deliberately **not** part of `pnpm test`: that suite is offline by
 * construction, and `test/` is exactly what `test/manifest.test.ts` guards. This
 * lives in `e2e/` and runs only via `pnpm test:e2e` (`vitest.e2e.config.ts`),
 * which needs a live account — `CLOUDFLARE_API_TOKEN` and `ADMIN_TOKEN`, as CI
 * provides them.
 *
 * Retention: `Db`/`Photos` retain only on a non-`test_` stage, so this suite's
 * `destroy` really removes everything it created.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
});

/** Deploy once for the file; each test `yield*`s the outputs. */
const stack = beforeAll(deploy(Stack), { timeout: 300_000 });

test(
  "the Worker answers /health once the edge converges",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");

    const response = yield* Test.getWhenReady(`${url}/health`);
    expect(response.status).toBe(200);
  }),
);

test(
  "the ops endpoints are admin-gated",
  Effect.gen(function* () {
    const { url } = yield* stack;

    // No token → 401. `getWhenReady` retries only 404/5xx, so a deliberate 401
    // is observed immediately rather than retried away.
    const denied = yield* Test.getWhenReady(`${url}/stats`);
    expect(denied.status).toBe(401);

    // The configured token → 200. Both directions, so a gate that always
    // refuses fails here too.
    const token = yield* Config.String("ADMIN_TOKEN");
    const allowed = yield* Test.executeWhenReady(
      HttpClientRequest.get(`${url}/stats`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(allowed.status).toBe(200);
  }),
);

// Keep the stage for fast re-runs locally: `NO_DESTROY=1 pnpm test:e2e`.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
