import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";

/**
 * Metadata lives in D1; `migrations` makes alchemy apply ./migrations on deploy
 * (and hash them, so an unchanged migration is not re-run).
 *
 * `RemovalPolicy.retain()` keeps the database when a rename or `destroy` would
 * otherwise delete it — data outlives the stack definition (REVIEW §4 #2).
 */
export const Db = Cloudflare.D1.Database("Db", {
  migrations: "./migrations",
}).pipe(RemovalPolicy.retain());
