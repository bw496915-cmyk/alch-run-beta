# Conventions — exact Alchemy shape only

**Rule: infrastructure and runtime code uses the shapes the *pinned* Alchemy documents.
Hand-rolled substitutes are denied, even when they compile.**

A hand-roll is anything that re-implements what the framework or platform already provides:
a structural `interface` describing a Cloudflare binding, a `new Response(JSON.stringify(…))`,
a URL-string RPC into a Durable Object, a non-atomic read-modify-write on DO storage, or a
shell wrapper around a command the CLI already has.

Pinned: `alchemy@2.0.0-beta.83`, `effect@4.0.6`, `@cloudflare/workers-types@5.20261022.1`.

> **Correction (2026-10-23, after the shape audit in `REVIEW-2026-10-23.md` §5).** An earlier
> draft of this file denied the async-worker shapes — the `crons` prop, a plain
> `queue(batch, env)` handler, a plain `scheduled` export. That was wrong: all three are
> documented (`Worker.d.ts:704-716` — "This is how async (non-Effect) Workers configure Cron
> Triggers" — plus the cron page note, and the queues page section "What's the difference vs.
> a native `queue()` handler?"). **Async style is not a hand-roll.** The hand-rolls in this
> repo were the *types* and the *atomicity*, not the style.

---

## Allow-list — documented async-worker shapes (do not "modernise" these)

| Shape | Where it is documented |
| --- | --- |
| `Cloudflare.Worker("id", { main: "./src/Api.ts", env: { … } })` | workers page "Async Workers"; `Worker.d.ts:700` ("`env` is the only option for async (non-Effect) Workers") |
| plain `export default { async fetch(request, env, ctx) }` | same |
| `export class Counter extends DurableObject` (from `cloudflare:workers`) exported by the entry module | `DurableObject.d.ts:870-897` |
| `env: { COUNTER: Cloudflare.DurableObject("Counter", { className: "Counter" }) }` | `DurableObject.d.ts:176-206` |
| plain `async queue(batch, env)` with per-message `ack()` / `retry()` | queues page, §"What's the difference vs. a native `queue()` handler?" |
| `crons: ["0 3 * * *"]` + plain `async scheduled(controller, env, ctx)` | cron page note; `Worker.d.ts:704-716` |
| `Queues.Consumer("Id", { queueId, scriptName: worker.workerName })` | `Queues/Consumer.d.ts:76-114` |
| raw `env.DB.prepare(…)` on a typed `D1Database` | it *is* the D1 API; no wrapper wanted |

Effect-native equivalents (`Workers.cron` + `CronEventSourceLive`, `consumeQueueMessages` +
`EventSourceLive`, `DurableObject<Self>()(…)`, `R2.ReadWriteBucket`, `D1.QueryDatabase`,
`KV.ReadWriteNamespace`, `Queues.WriteQueue`, `HttpServerResponse`) are equally canonical
**when the Worker is Effect-native**. Choosing them is a style decision, not a compliance one.

---

## Deny-list — hand-rolls, with the canonical replacement

| # | Hand-roll | Canonical replacement | Source |
| --- | --- | --- | --- |
| 1 | 14 structural binding `interface`s (`R2ObjectLike`, `D1Like`, `KVLike`, `QueueBatchLike`, `DurableObjectNamespaceLike`, `ScheduledControllerLike`, `Env`, …) | `export type WorkerEnv = Cloudflare.InferEnv<typeof worker>` + `import type { WorkerEnv } from "../alchemy.run.ts"`, with `@cloudflare/workers-types` in `tsconfig.types` (without it `InferEnv` silently resolves to `any` — verified) | workers page "Async Workers"; `InferEnv.d.ts:40-45` |
| 2 | `const json = (b, s) => new Response(JSON.stringify(b, null, 2), …)` | `Response.json(body, { status })` (platform API) — or `HttpServerResponse.json` in an Effect-native Worker | Web/Workers standard |
| 3 | `stub.fetch("https://counter/increment")` string RPC | typed namespace call: `env.COUNTER.getByName("global").increment()` (async DO) or `counters.getByName("global").increment()` (Effect DO) | `DurableObject.d.ts:885` |
| 4 | `get` then `put` on DO storage across two awaits | wrap in `state.blockConcurrencyWhile(async () => …)` (or `storage.transaction`); both are absent from a hand-written storage type, which is exactly how the bug hid | `DurableObjectStorage` in workers-types |
| 5 | dropping the third handler argument (`fetch(request, env)`, `scheduled(controller, env)`) | take `ctx: ExecutionContext` and use `ctx.waitUntil(...)` for work that must outlive the response (our KV refill and audit writes were inline because `ctx` did not exist) | `ExecutionContext` in workers-types |
| 6 | `try { … } catch { message.retry() }` around the whole body | let the throw surface: the platform retries the batch and the consumer's `maxRetries` applies; catch only what you can classify | `Queues/Consumer.d.ts` settings |
| 7 | hand-written queue/DO/R2 client shapes limiting the surface (`QueueProducerLike.send` only, no `sendBatch`/`metrics`; `R2BucketLike.get` without `onlyIf`/range) | the real `Queue`/`R2Bucket`/`DurableObjectNamespace` from `InferEnv` | `InferEnv.d.ts:45` |
| 8 | `scripts/alch.sh` — bash re-implementing CLI flags | `package.json` scripts calling the `alchemy` CLI. **Retained for now**: `.github/workflows/ci.yml` invokes it, so it is deleted together with that CI step, not before | CLI page |
| 9 | `if (path === "/x" && request.method === "GET")` chains growing past ~4 routes | keep the small chain; past that, an Effect-native router (`HttpRouter` / `HttpApi`) is the documented instrument | APIs pages |

## Gates

A change is rejected if any of these hits in `src/` or `alchemy.run.ts`:

```bash
rg -n "interface \w+Like|interface Env\b" src/ alchemy.run.ts   # hand-written binding types
rg -n "new Response\(" src/                                     # Response.json instead
rg -n "https://(counter|do)\b" src/                             # URL-string RPC into a DO
rg -n "async (fetch|scheduled)\(.*env: Env\)" src/            # missing ctx: ExecutionContext
rg -n "storage\.put\(" -A2 src/ | rg -B2 "storage\.get"         # suspicious read-modify-write
test ! -e scripts/alch.sh                                       # CLI driven from package.json
```

Measured baseline before the refactor — every count must reach 0 except the last, which goes
with its CI step:

| Gate | Command | Hits |
| --- | --- | --- |
| hand-written binding interfaces | `rg -c 'interface \w+Like\|interface Env\b' src/ alchemy.run.ts` | 14 |
| hand-built JSON responses | `rg -c 'new Response\(' src/` | 2 |
| URL-string DO RPC | `rg -c 'https://(counter\|do)\b' src/` | 2 |
| handlers without `ctx` | `rg -n 'async (fetch\|scheduled)\(.*env: Env\)' src/` | 2 (`fetch`, `scheduled`) |
| bash wrapper | `test -e scripts/alch.sh` | present |

## Refactor backlog (policy applied to this tree)

1. `alchemy.run.ts` — Worker at module scope + `export type WorkerEnv = Cloudflare.InferEnv<typeof Api>`.
2. `src/Api.ts` — delete the 14 interfaces, type `env` with `WorkerEnv`, take `ctx`, `Response.json`,
   `blockConcurrencyWhile` around the DO counter, `extends DurableObject`, `getByName`.
3. Delete `scripts/alch.sh` **and** repoint `.github/workflows/ci.yml`'s plan step at the CLI in the same change; move its flags into `package.json` scripts.
4. Encode the gates above as a test so the policy is enforced, not just documented.
