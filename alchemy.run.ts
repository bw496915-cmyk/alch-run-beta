import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { Cache } from "./src/Cache.ts";
import { Db } from "./src/Db.ts";
import { Photos } from "./src/Photos.ts";
import { Events } from "./src/QueueEvents.ts";

/**
 * Composition root.
 *
 * Every `alchemy` command (`plan`, `deploy`, `dev`, `destroy`) loads this file
 * and runs the default export.
 *
 * Pinned to alchemy 2.0.0-beta.83, which still ships every provider inside the
 * main package (`alchemy/Cloudflare`, `alchemy/AWS`, ...). See
 * MIGRATION-beta84.md for the import rewrite that 2.0.0-beta.84 requires.
 */
export default Alchemy.Stack(
  "AlchRunBeta",
  {
    providers: Cloudflare.providers(),
    // Local state file under .alchemy/ — nothing to bootstrap, nothing shared.
    // Swap for `Cloudflare.state()` when you want state stored in a bucket.
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const photos = yield* Photos;
    const db = yield* Db;
    const cache = yield* Cache;
    const events = yield* Events;

    const worker = yield* Cloudflare.Worker("Api", {
      main: "./src/Api.ts",
      env: {
        PHOTOS: photos,
        DB: db,
        CACHE: cache,
        EVENTS: events,
        // Durable Object namespace; the class is exported by src/Api.ts.
        COUNTER: Cloudflare.DurableObject("Counter", { className: "Counter" }),
      },
      // Daily housekeeping cron; the Worker's scheduled() handler records fires.
      crons: ["0 3 * * *"],
      // Workers Cache off: this API returns live D1 contents.
      cache: { enabled: false },
    });

    // Attach the Worker's queue() handler to the queue as its consumer.
    const consumer = yield* Cloudflare.Queues.Consumer("ApiAuditConsumer", {
      queueId: events.queueId,
      scriptName: worker.workerName,
      settings: { batchSize: 10, maxRetries: 3, maxWaitTimeMs: 5_000 },
    });

    return {
      url: worker.url.as<string>(),
      bucketName: photos.bucketName,
      databaseName: db.databaseName,
      kvNamespaceId: cache.namespaceId,
      queueName: events.queueName,
      consumerId: consumer.consumerId,
      crons: worker.crons,
    };
  }),
);
