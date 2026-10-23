# Conventions — exact Alchemy shape only

**Rule: infrastructure and runtime code is written in the shapes Alchemy documents for the
pinned version. Hand-rolled substitutes are denied, even when they compile.**

A hand-roll is anything that re-implements what the framework already provides: a
structural `interface` describing a Cloudflare binding, a `new Response(JSON.stringify(…))`,
a `stub.fetch("https://…")` string RPC, a `try`/`catch` retry loop where the Effect error
channel exists, or a shell wrapper around a command the CLI already has.

Why this is not style-pedantry: three of the bugs in this repo's first day came from
hand-rolls. The DO `1101` and the silent cron both live in code the docs only ever show in
Effect-native form, and a hand-written `Env` interface is why the DO call failed without a
type error. The hand-rolls are not neutral — they hide exactly the failures the framework's
types would have caught.

Pinned: `alchemy@2.0.0-beta.83`, `effect@4.0.6`. When the pin moves, the shapes move with
it (see `MIGRATION-beta84.md`) — the canonical instrument is always the one the *pinned*
docs show, not the one in a newer blog post.

---

## Denied → use instead

| # | Hand-roll in this repo | Canonical instrument | Doc / type |
| --- | --- | --- | --- |
| 1 | 16 structural `interface`s in `src/Api.ts` (`R2ObjectLike`, `D1Like`, `KVLike`, `QueueBatchLike`, `DurableObjectNamespaceLike`, `Env`, …) | `Cloudflare.InferEnv<typeof Worker>` for async workers; typed binding services for Effect-native workers | `Cloudflare/Workers/InferEnv.d.ts`; [secrets](https://alchemy.run/environments/secrets/) |
| 2 | `const json = (body, status) => new Response(JSON.stringify(body), …)` | `HttpServerResponse.json(body, { status })` | `effect/http/HttpServerResponse` |
| 3 | `export default { async fetch(request, env) { … } }` with string path matching | Effect-native worker: `Cloudflare.Worker("Api", { main: import.meta.url }, Effect.gen(…)` returning `{ fetch }`, reading `HttpServerRequest`; `effect/http-api` `HttpApi` for anything larger | [workers](https://alchemy.run/cloudflare/compute/workers/), [effect-http-api](https://alchemy.run/cloudflare/apis/effect-http-api) |
| 4 | plain DO class + URL-dispatch RPC (`stub.fetch("https://counter/increment")`) | `export default class Counter extends Cloudflare.DurableObject<Counter>()("Counter", Effect.gen(…))` with **typed methods**, called as `counters.getByName("global").increment()` | [durable objects](https://alchemy.run/cloudflare/compute/durable-objects/) |
| 5 | `crons: ["0 3 * * *"]` prop + plain `async scheduled(controller, env)` | `yield* Cloudflare.Workers.cron("0 3 * * *", (controller) => …)` + `Effect.provide(Cloudflare.Workers.CronEventSourceLive)` | [cron](https://alchemy.run/cloudflare/messaging/cron/) |
| 6 | plain `async queue(batch, env)` with manual `message.ack()` / `message.retry()` | `Cloudflare.Queues.consumeQueueMessages(queue, (stream) => Stream.runForEach(stream, …))` + `EventSourceLive`; reserve `Queues.Consumer` for attaching a worker whose handler lives elsewhere | [queues](https://alchemy.run/cloudflare/messaging/queues/) |
| 7 | raw SQL strings + `env.DB.prepare(…).bind(…).run()` and hand-written row types | `Cloudflare.D1.QueryDatabase(Db)` typed client; `alchemy/SQL/D1` (`sql` tagged template) or `alchemy/Drizzle` for schema-first | [D1](https://alchemy.run/cloudflare/data/d1/) |
| 8 | `try { … } catch { message.retry() }` | Effect error channel: `Effect.catchTag`, `Effect.retry`, `Effect.orDie` when the failure is genuinely fatal | `effect/Effect` |
| 9 | `env.CACHE.get/put` string juggling | `Cloudflare.KV.ReadWriteNamespace(Cache)` + `KV.ReadWriteNamespaceBinding` | `Cloudflare/KV/ReadWriteNamespace.d.ts` |
| 10 | `scripts/alch.sh` — a bash wrapper re-implementing flags | `alchemy` CLI through `package.json` scripts (`pnpm plan`, `pnpm deploy`, `pnpm drift`, `pnpm logs`, `pnpm check-env`) | [CLI](https://alchemy.run/cli/) |
| 11 | Manual `if (path === "/x" && request.method === "GET")` route table | `HttpRouter` from `effect/http` (or `HttpApi` groups) | `effect/http` |

### Explicitly fine (not hand-rolls)

- Domain data shapes (`type PhotoRow = { key: string; bytes: number; … }`) — that is *our*
  data, not a Cloudflare API. Keep them, but derive them from the schema where possible.
- `Alchemy.Stack("Name", { providers, state }, Effect.gen(…))`, module-level resource
  declarations, `RemovalPolicy` decorations, `Config.Redacted` env bindings — all canonical.

---

## Gates (review checklist)

A change is rejected if any of these returns a hit in `src/` or `alchemy.run.ts`:

```bash
rg -n "interface \w+Like|interface Env\b" src/ alchemy.run.ts   # hand-written binding types
rg -n "new Response\(" src/                                      # HTTP responses outside HttpServerResponse
rg -n "stub\.fetch\(|https://counter|https://do" src/            # string RPC into a Durable Object
rg -n "crons:\s*\[" alchemy.run.ts                               # cron via prop instead of Workers.cron
rg -n "async (queue|scheduled)\(" src/                           # native handlers instead of EventSources
rg -n "\.prepare\(\s*[\"'\`]" src/                               # raw SQL instead of the typed client
```

Two more, once the refactor lands:

```bash
test ! -e scripts/alch.sh        # CLI driven from package.json scripts
rg -n "try \{" src/ | wc -l      # 0 — failures travel the Effect error channel
```

## Refactor backlog (this policy applied to the current tree)

Tracked in `REVIEW-2026-10-23.md`; ordered so each step keeps the stack deployable:

1. `src/Counter.ts` — DO becomes `Cloudflare.DurableObject<Counter>()("Counter", …)` with
   `increment()` / `snapshot()` / `recordCronFire()` as typed methods.
2. `src/Api.ts` — becomes a `Cloudflare.Worker<Api>()` class: `Effect.gen` construction
   resolving typed bindings (`R2.ReadWriteBucket`, `D1.QueryDatabase`,
   `KV.ReadWriteNamespace`, `Queues.WriteQueue`) with the matching `…Binding` layers, then
   an Effect `fetch` handler using `HttpServerRequest` / `HttpServerResponse`.
3. `alchemy.run.ts` — Worker declared at module scope or as an Effect class, yielding
   `Counter`; cron moves to `Workers.cron` + `CronEventSourceLive`; consumer moves to
   `consumeQueueMessages` + `EventSourceLive`; `RemovalPolicy.retain()` on the D1 database
   and R2 bucket; `deadLetterQueue` on the consumer.
4. Delete `scripts/alch.sh`; move its four flags into `package.json` scripts.
5. Add the gate greps above as a test so the policy is enforced, not just documented.
