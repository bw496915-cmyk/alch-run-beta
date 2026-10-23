import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";

/**
 * One R2 bucket, nothing else. Kept in its own module so the beta.84 provider
 * split is a one-line import change here rather than a change at every use site.
 *
 * `RemovalPolicy.retain()` keeps the bucket when a rename or `destroy` would
 * otherwise delete it (REVIEW §4 #2) — the object bodies are the user's data.
 */
export const Photos = Cloudflare.R2.Bucket("Photos").pipe(RemovalPolicy.retain());
