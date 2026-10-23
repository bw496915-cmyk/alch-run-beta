import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

/**
 * Metadata lives in D1; `migrations` makes alchemy apply ./migrations on deploy
 * (and hash them, so an unchanged migration is not re-run).
 *
 * Retention is **conditional** — the documented `retain(<bool>)` form. A real
 * deployment (`prod`, `deep-pass`) keeps its database across a rename or
 * `destroy`; the *ephemeral* stages are torn down: the deployed suite's `test_*`
 * stages and the GitHub Action's `staging-<pr>` previews. Otherwise every test
 * run — and every PR — would leak a database. (REVIEW §4 #2.)
 */
export const Db = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  return yield* Cloudflare.D1.Database("Db", {
    migrations: "./migrations",
  }).pipe(RemovalPolicy.retain(!(stage.startsWith("test_") || stage.startsWith("staging-"))));
});
