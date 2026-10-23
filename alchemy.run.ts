import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";
import { Cache } from "./src/Cache.ts";
import { Db } from "./src/Db.ts";
import { Photos } from "./src/Photos.ts";
import { Events } from "./src/QueueEvents.ts";

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
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api;
    const photos = yield* Photos;
    const db = yield* Db;
    const cache = yield* Cache;
    const events = yield* Events;
    // Failed audit messages land here after `maxRetries` instead of vanishing.
    const deadLetter = yield* Cloudflare.Queues.Queue("AuditDeadLetter");

    return {
      url: worker.url.as<string>(),
      bucketName: photos.bucketName,
      databaseName: db.databaseName,
      kvNamespaceId: cache.namespaceId,
      queueName: events.queueName,
      deadLetterQueueName: deadLetter.queueName,
    };
  }),
);
