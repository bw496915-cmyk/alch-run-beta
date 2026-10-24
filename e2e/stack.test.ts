import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { expect } from "vitest";

import Stack, { REMOTE_STATE } from "../alchemy.run.ts";

/**
 * Deployed-stack end-to-end test — the layer the offline suite cannot reach
 * (REVIEW §4 #7). It deploys this Stack to a `test_$USER` stage (the harness
 * default, isolated from `deep-pass`), drives the live Worker over HTTP, and
 * tears it down.
 *
 * Deliberately **not** part of `pnpm test`: that suite is offline by
 * construction, and `test/` is exactly what `test/manifest.test.ts` guards. This
 * lives in `e2e/` and runs only via `pnpm test:e2e` (`vitest.e2e.config.ts`) —
 * and, in CI, `.github/workflows/e2e.yml`, which pins a `test_<pr>` stage. Both
 * need a live account — `CLOUDFLARE_API_TOKEN` and `ADMIN_TOKEN`, as CI provides
 * them.
 *
 * Retention: `Db`/`Photos` retain only on a non-`test_` stage, so this suite's
 * `destroy` really removes everything it created.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  // Matches the stack's store (alchemy.run.ts): local by default, or the
  // shared `Cloudflare.state()` store once the bootstrap has run.
  state: REMOTE_STATE ? Cloudflare.state() : Alchemy.localState(),
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

test(
  "an unknown route is a 404",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // Plain client, not `getWhenReady`: the harness retries 404/5xx through the
    // cold-start window, which is exactly the status under test here.
    const response = yield* HttpClient.get(`${url}/nope`);
    expect(response.status).toBe(404);
  }),
);

/**
 * One Cloudflare API call, as a plain async function: `Effect.gen` bodies must be
 * generator-only, so the awaits live here and are lifted with `Effect.promise`.
 */
const cfApi = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "content-type": "application/json",
      },
    },
  );
  return { status: response.status, body: await response.json().catch(() => null) };
};

/**
 * Fault injection — the only check here that sees the *contract* rather than the
 * behaviour, because every other assertion runs with healthy dependencies.
 *
 * It deletes the stage's D1 out of band and asserts that `fetch` degrades instead
 * of 500ing. This is the test that would have caught the Effect-native
 * regression unaided: `Effect.catch` recovers typed failures but not *defects*,
 * and a dead binding is a defect, so both ops routes returned a bare 500 with an
 * empty body (GOALS.md G13). No amount of healthy-path assertion can see that.
 *
 * Declared LAST deliberately: it breaks the D1, and the `afterAll` destroy
 * tolerates the drift (verified — it removes the remaining six resources).
 */
test(
  "a failing dependency degrades rather than 500s (fault injection)",
  Effect.gen(function* () {
    const { url, databaseName } = yield* stack;
    const admin = yield* Config.String("ADMIN_TOKEN");
    const auth = { headers: { authorization: `Bearer ${admin}` } };

    // Remove the dependency this stage just created.
    const listed = yield* Effect.promise(() => cfApi("/d1/database"));
    const db = (listed.body?.result ?? []).find((d: { name: string }) => d.name === databaseName);
    expect(db, `the stage's D1 (${databaseName}) should exist`).toBeDefined();
    const deleted = yield* Effect.promise(() => cfApi(`/d1/database/${db.uuid}`, { method: "DELETE" }));
    expect(deleted.status).toBe(200);

    // The admin half must SURVIVE the other's failure: 200, degraded, D1 null.
    let stats = yield* Test.executeWhenReady(HttpClientRequest.get(`${url}/stats`, auth));
    for (let i = 0; i < 12 && stats.status === 200; i++) {
      const seen = (yield* stats.json) as { degraded?: boolean };
      if (seen.degraded === true) break;
      yield* Effect.sleep("3 seconds");
      stats = yield* Test.executeWhenReady(HttpClientRequest.get(`${url}/stats`, auth));
    }
    expect(stats.status).toBe(200);
    const body = (yield* stats.json) as { degraded?: boolean; d1?: { auditEvents: unknown } };
    expect(body.degraded).toBe(true);
    expect(body.d1?.auditEvents).toBeNull();

    // The D1-only route must be the NAMED 503, not a bare 500 with no body.
    const audit = yield* HttpClient.get(`${url}/audit`, auth);
    expect(audit.status).toBe(503);
    const detail = (yield* audit.json) as { error?: string; detail?: string };
    expect(detail.error).toBe("dependency unavailable");
    expect(detail.detail).toContain("D1");
  }),
  { timeout: 300_000 },
);

// Keep the stage for fast re-runs locally: `NO_DESTROY=1 pnpm test:e2e`.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
