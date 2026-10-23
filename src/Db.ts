import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

/**
 * Metadata lives in D1; `migrations` makes alchemy apply ./migrations on deploy
 * (and hash them, so an unchanged migration is not re-run).
 *
 * Retention is **conditional** — the documented `retain(stack.stage === "prod")`
 * form. A real deployment (`deep-pass`) keeps its database across a rename or
 * `destroy`; the `test_*` stages the deployed-stack suite (`e2e/`) runs on are
 * destroyed like anything else, or every test run would leak a database.
 * (REVIEW §4 #2; the rule is `stage.startsWith("test_")`.)
 */
export const Db = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  return yield* Cloudflare.D1.Database("Db", {
    migrations: "./migrations",
  }).pipe(RemovalPolicy.retain(!stage.startsWith("test_")));
});
