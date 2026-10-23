/**
 * Credentials as code — the Alchemy-documented CI credential path
 * (alchemy.run/environments/ci).
 *
 * This is a **separate, one-time stack**, not part of the app stack. Deploy it
 * once from a machine with an `admin` profile; it mints a scoped Cloudflare API
 * token and writes it, plus the account id, into the GitHub repo as Actions
 * secrets. Nothing is copy-pasted into the GitHub UI, and the token's scope is
 * reviewable in this file.
 *
 * One-time setup, then deploy:
 *
 *   alchemy profile create admin
 *   alchemy profile edit --profile admin          # Cloudflare: API Token/Key, NOT OAuth
 *   alchemy deploy --config stacks/github.ts --profile admin
 *
 * The `admin` credential must be able to create API tokens
 * (`API Tokens > Write`); a standard "Edit Cloudflare Workers" token cannot
 * mint other tokens. Re-run only to rotate the token or change its permissions.
 *
 * The app stack (`alchemy.run.ts`) keeps using the `default` profile; only this
 * stack needs `admin`.
 */

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const OWNER = "brendadeeznuts1111";
const REPOSITORY = "alch-run-beta";

export default Alchemy.Stack(
  "github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    // Local state, like the app stack — this stack is deployed once from one
    // checkout. Swap for `Cloudflare.state()` if it must run from CI too (that
    // needs a one-time `alchemy provider cloudflare bootstrap`).
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // Resolved from the profile this stack is deployed with — no
    // CLOUDFLARE_ACCOUNT_ID env var needed for the local deploy.
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    // Exactly what the app stack touches: Workers, KV, R2, D1, Queues, plus the
    // account settings and tail access the ops scripts use. Trim further if a
    // permission turns out unused.
    const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("CIToken", {
      name: "alch-run-beta-ci",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers KV Storage Write",
            "Workers R2 Storage Write",
            "D1 Write",
            "Queues Write",
            "Account Settings Write",
            "Workers Tail Read",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });

    yield* GitHub.Secret("cf-api-token", {
      owner: OWNER,
      repository: REPOSITORY,
      name: "CLOUDFLARE_API_TOKEN",
      value: apiToken.value,
    });

    yield* GitHub.Secret("cf-account-id", {
      owner: OWNER,
      repository: REPOSITORY,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: Redacted.make(accountId),
    });
  }),
);
