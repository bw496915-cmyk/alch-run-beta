import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Canonical Alchemy Durable Object (see CONVENTIONS.md): an Effect-native class
 * with typed methods, not a plain class with URL-dispatched `fetch` handlers.
 *
 * Two nested Effects are the documented shape:
 *   - outer (Construction) resolves shared services and the instance state ref
 *   - inner returns the instance's public API, and is the only place the
 *     state's RuntimeContext-coloured methods (`storage.get` / `storage.put`)
 *     can run
 *
 * Docs: https://alchemy.run/cloudflare/compute/durable-objects/
 */
export default class Counter extends Cloudflare.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const read = (key: string) =>
        state.storage.get<number>(key).pipe(Effect.map((value) => value ?? 0));

      return {
        /** Bump and return the request counter. */
        increment: () =>
          Effect.gen(function* () {
            const next = (yield* read("count")) + 1;
            yield* state.storage.put("count", next);
            return next;
          }),

        /** Record one cron fire and return the running total. */
        recordCronFire: () =>
          Effect.gen(function* () {
            const next = (yield* read("cronFires")) + 1;
            yield* state.storage.put("cronFires", next);
            return next;
          }),

        /** Both counters, without mutating anything. */
        snapshot: () =>
          Effect.gen(function* () {
            return {
              count: yield* read("count"),
              cronFires: yield* read("cronFires"),
            };
          }),
      };
    });
  }),
) {}
