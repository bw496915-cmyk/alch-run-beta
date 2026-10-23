import * as Cloudflare from "alchemy/Cloudflare";

/** Response cache for the photo index, so GET /photos does not always hit D1. */
export const Cache = Cloudflare.KV.Namespace("Cache");
