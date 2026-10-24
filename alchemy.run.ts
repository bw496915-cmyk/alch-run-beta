import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Cache } from "./src/Cache.ts";
import { Db } from "./src/Db.ts";
import { Photos } from "./src/Photos.ts";
import { Events } from "./src/QueueEvents.ts";

/**
 * Remote-state switch — REVIEW-2026-10-23.md §4 #8. The prepared path is
 * `state: Cloudflare.state()`; it is gated here so the default stays local
 * until the state store exists.
 *
 * `Cloudflare.state()` (no arguments on this pin) reads the account-wide
 * `alchemy-state-store` Worker, which does not exist until the one-time
 * bootstrap (`alchemy provider cloudflare bootstrap`). Reading its bearer
 * token back binds a Secrets Store secret, so the CI token also needs
 * `Secrets Store Write` (`stacks/github.ts`). Selecting the remote store
 * before that bootstrap makes `pnpm dev`, `pnpm test:dev` and `pnpm test:e2e`
 * die at the state-store step, so it is opt-in:
 *
 *   ALCHEMY_REMOTE_STATE=1 pnpm deploy      # only after the bootstrap
 *
 * Unset (or any value other than "1") keeps `Alchemy.localState()`. Both
 * harnesses read this same flag, so the stack and the `Test.make` store cannot
 * drift — a deploy in one store and a destroy in another is exactly the leak
 * the workflow's PR-preview path must avoid.
 */
export const REMOTE_STATE = process.env.ALCHEMY_REMOTE_STATE === "1";

/**
 * Composition root.
 *
 * The Worker is an Effect-native class (`src/Api.ts`), so it declares and binds
 * its own resources in its Init phase; the Stack yields those resources to keep
 * them in the plan and to surface their names as outputs. The queue consumer and
 * the cron are wired *inside* the Worker as event sources, so there is no
 * `Cloudflare.Queues.Consumer` and no `crons` prop here any more.
 */
export default Alchemy.Stack(
  "AlchRunBeta",
  {
    providers: Cloudflare.providers(),
    // One-line switch (see REMOTE_STATE above): local by default so the dev,
    // dev-test and e2e commands keep working before the state store exists.
    state: REMOTE_STATE ? Cloudflare.state() : Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api;
    const photos = yield* Photos;
    const db = yield* Db;
    const cache = yield* Cache;
    const events = yield* Events;
    // The Worker's Init declares its own `AuditDeadLetter` (with an explicit,
    // stage-unique name so its consumer can reference it), so the Stack must not
    // declare a second one under the same logical id with different props.

    return {
      url: worker.url.as<string>(),
      bucketName: photos.bucketName,
      databaseName: db.databaseName,
      kvNamespaceId: cache.namespaceId,
      queueName: events.queueName,
    };
  }),
);
