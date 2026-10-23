import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * The counters, Effect-native: one `global` instance, incremented over typed RPC
 * (`counters.getByName("global").increment()`).
 *
 * The read-modify-write runs inside `storage.transaction`, so concurrent
 * `/stats` calls cannot lose an increment — the same guarantee the async version
 * had via `ctx.storage.transaction`.
 */
export default class Counter extends Cloudflare.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    const bump = (field: string, by = 1) =>
      state.storage.transaction((txn) =>
        Effect.gen(function* () {
          const next = ((yield* txn.get<number>(field)) ?? 0) + by;
          yield* txn.put(field, next);
          return next;
        }),
      );

    return Effect.succeed({
      increment: () => bump("count"),
      recordCronFire: () => bump("cronFires"),
      snapshot: () =>
        Effect.gen(function* () {
          return {
            count: (yield* state.storage.get<number>("count")) ?? 0,
            cronFires: (yield* state.storage.get<number>("cronFires")) ?? 0,
          };
        }),
    });
  }),
) {}
