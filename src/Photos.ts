import * as Cloudflare from "alchemy/Cloudflare";

/**
 * One R2 bucket, nothing else. Kept in its own module so the beta.84 provider
 * split is a one-line import change here rather than a change at every use site.
 */
export const Photos = Cloudflare.R2.Bucket("Photos");
