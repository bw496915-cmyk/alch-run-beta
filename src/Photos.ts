import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

/**
 * One R2 bucket, nothing else. Kept in its own module so the beta.84 provider
 * split is a one-line import change here rather than a change at every use site.
 *
 * Retention is **conditional** (the documented `retain(<bool>)` form): the
 * object bodies are the user's data, so a real stage keeps the bucket across a
 * rename or `destroy`, while the ephemeral stages — `test_*` (the `e2e/` suite)
 * and `staging-<pr>` (the GitHub Action's previews) — are torn down. See `Db.ts`
 * and REVIEW §4 #2.
 */
export const Photos = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  return yield* Cloudflare.R2.Bucket("Photos").pipe(
    RemovalPolicy.retain(!(stage.startsWith("test_") || stage.startsWith("staging-"))),
  );
});
