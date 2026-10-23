import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Metadata lives in D1; `migrations` makes alchemy apply ./migrations on deploy
 * (and hash them, so an unchanged migration is not re-run).
 */
export const Db = Cloudflare.D1.Database("Db", {
  migrations: "./migrations",
});
