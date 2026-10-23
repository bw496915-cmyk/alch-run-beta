import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import type { Counter } from "./src/Api.ts";

import { Cache } from "./src/Cache.ts";
import { Db } from "./src/Db.ts";
import { Photos } from "./src/Photos.ts";
import { Events } from "./src/QueueEvents.ts";

/**
 * Composition root.
 *
 * The Worker is declared at module scope — the documented async-Worker shape —
 * so `ApiEnv` below can name the bindings the runtime actually supplies. That
 * type is what `src/Api.ts` uses instead of hand-written interfaces; without
 * `@cloudflare/workers-types` in `tsconfig.types` it would silently be `any`.
 *
 * Pinned to alchemy 2.0.0-beta.83, which still ships every provider inside the
 * main package (`alchemy/Cloudflare`, ...). See MIGRATION-beta84.md for the
 * import rewrite that 2.0.0-beta.84 requires.
 */
const bindings = {
  PHOTOS: Photos,
  DB: Db,
  CACHE: Cache,
  EVENTS: Events,
  // Durable Object namespace; the class is exported by src/Api.ts.
  COUNTER: Cloudflare.DurableObject<Counter>("Counter", { className: "Counter" }),
};

export const Api = Cloudflare.Worker("Api", {
  main: "./src/Api.ts",
  env: bindings,
  // Daily housekeeping cron; the Worker's scheduled() handler records fires.
  crons: ["0 3 * * *"],
  // Workers Cache off: this API returns live D1 contents.
  cache: { enabled: false },
});

/**
 * `env` as the runtime delivers it: real `R2Bucket`, `D1Database`, `KVNamespace`,
 * `Queue`, `DurableObjectNamespace`.
 *
 * Applied to the bindings object rather than to the Worker: `InferEnv<typeof Api>`
 * hits TS2589 ("type instantiation is excessively deep") as soon as a Durable
 * Object binding is present — the `DurableObjectLike` default `Shape = any` sends
 * the mapped type recursive. Same helper, narrower input, identical result.
 */
export type ApiEnv = Cloudflare.InferEnv<typeof bindings>;

export default Alchemy.Stack(
  "AlchRunBeta",
  {
    providers: Cloudflare.providers(),
    // Local state file under .alchemy/ — the documented default, nothing to
    // bootstrap. Swap for `Cloudflare.state()` for shared/CI state.
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Api;
    const photos = yield* Photos;
    const db = yield* Db;
    const cache = yield* Cache;
    const events = yield* Events;

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
      // `worker.versionId` / `worker.deploymentId` exist on the type but stay
      // undefined on a non-versioned deploy like this one, so they are not
      // surfaced here (beta.84 populates them for versioned deploys).
    };
  }),
);
