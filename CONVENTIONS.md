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
| `crons: ["0 3 * * *"]` + plain `async scheduled(controller, env, ctx)` | cron page note; `Worker.d.ts:704-716`; **proven to fire** on this account ([CRON-FINDINGS.md](./CRON-FINDINGS.md)) — and the Effect-native `Workers.cron` alternative failed to deploy here, so this is not a "modernise it later" candidate |
| `Queues.Consumer("Id", { queueId, scriptName: worker.workerName })` | `Queues/Consumer.d.ts:76-114` |
| raw `env.DB.prepare(…)` on a typed `D1Database` | it *is* the D1 API; no wrapper wanted |

Effect-native equivalents (`Workers.cron` + `CronEventSourceLive`, `consumeQueueMessages` +
`EventSourceLive`, `DurableObject<Self>()(…)`, `R2.ReadWriteBucket`, `D1.QueryDatabase`,
`KV.ReadWriteNamespace`, `Queues.WriteQueue`, `HttpServerResponse`) are equally canonical
**when the Worker is Effect-native**. Choosing them is a style decision, not a compliance one.

### Provenance and scope of this policy

The same *verify-the-effect* standard appears upstream in Alchemy's own contributor skill
[`alchemy-provider`](https://github.com/alchemy-run/alchemy/pull/1903) (added 2026-10-22):
"The live API is the only authority", "coverage is 1:1 with the API, operation by operation",
"a service with resources but no bindings is half done", "cost is not a scoping reason".

**Our policy is narrower than that skill, deliberately: consume, don't build.** The 1:1
operation-coverage mandate and the "cost is not a scoping reason" rule apply to *provider
authors* implementing hundreds of resources against a live API. They do not apply to consumer
code like this repo, which should use a small, documented slice of the platform correctly. Cite
that skill for the shared principle (trust the effect over the claim), never for a coverage
target; applying its mandate here would mean implementing resources nobody asked for.

### Upstream workarounds in this repo, with expiry conditions

A workaround that outlives its cause quietly becomes a design choice, so each one names the
condition under which it should be reverted. **`test/docs.test.ts` asserts this table**: every row
must carry a verified closure (`state_reason` plus the PR/commit) and a concrete expiry trigger
(a release or PR number — "when the fix ships" is rejected).

| Workaround | Upstream issue | Closure (verified, not assumed) | Expires when |
| --- | --- | --- | --- |
| `alchemy.run.ts` does **not** surface `versionId` / `deploymentId` in the stack outputs | [#2235](https://github.com/alchemy-run/alchemy/issues/2235) "Full Worker deployments return no versionId or deploymentId", filed 2026-10-13 against `alchemy@2.0.0-beta.83` | **fixed**, not duplicate/wontfix: `state_reason: completed`, closed 2026-10-20 by sam-goodwin via merged PR [#2241](https://github.com/alchemy-run/alchemy/pull/2241) *fix(cloudflare): return full deployment identities* (merge commit `68a04c07f4`, merged into `main` 2026-10-20T07:57Z) | the pin reaches a release whose changelog lists **#2241** — expected **beta.84**, unpublished as of 2026-10-23, whose notes already say "a full Worker deploy returns its versionId and deploymentId (#2241)". Then delete the workaround, re-add both outputs, and assert they are **defined in the deploy output**, not merely present on the type: the type carried both fields while the create/update path never set them, which is exactly why this bug hid |

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
| 8 | `scripts/alch.sh` — bash re-implementing CLI flags | `package.json` scripts calling the `alchemy` CLI (done, wrapper deleted with its CI step) | CLI page |
| 9 | `if (path === "/x" && request.method === "GET")` chains growing past ~4 routes | keep the small chain; past that, an Effect-native router (`HttpRouter` / `HttpApi`) is the documented instrument | APIs pages |

## Gates

These are enforced by `test/policy.test.ts` (part of `pnpm test`), in three layers:

| Layer | Mechanism | Fails when |
| --- | --- | --- |
| 3. Shape | compile-time: every `ApiEnv` member must be mutually assignable with the real `R2Bucket` / `D1Database` / `KVNamespace<string>` / `Queue<unknown>` / `DurableObjectNamespace<Counter>`, each checked for `any` collapse; `fetch`/`scheduled` must take a third `ExecutionContext` parameter; `Counter` must expose `increment`/`snapshot` | someone replaces the inferred env with a stand-in — **whatever it is called** |
| 2. Existence | every `interface`/`type` declaration in `src/` and `alchemy.run.ts` must appear in `ALLOWED_DECLARATIONS`, each with a written reason | **any** new declaration appears, or an allow-list entry goes stale |
| 1. Behaviour | greps for a `…Like` stand-in, `new Response(JSON.stringify`, and `https://counter`-style RPC | one of those specific patterns returns |

Layer 2 is the one that answers "what if someone adds a *fifth* hand-written interface under a
name nobody thought of". Verified by mutation: inserting `interface DatabaseShim { … }` into
`src/Api.ts` leaves `tsc` green and passes the greps, and layer 2 alone fails with
`new declarations must be justified in ALLOWED_DECLARATIONS: expected [ 'DatabaseShim' ] to deeply equal []`.
Adding it to the allow-list is the review gate — a visible diff, not a silent regression.

The gate itself is guarded by **`test/manifest.test.ts`**, because a suite that enforces rules
about documents and source enforced nothing about its *own* existence: deleting
`test/docs.test.ts` or `test/policy.test.ts`, or deleting their `it(…)` blocks, left `pnpm test`
green with fewer assertions. The manifest keeps the expected suite set exact and the declared test
count at or above a floor, so either removal is a failing diff; `.github/workflows/ci.yml` asserts
the manifest file itself exists, since a deleted manifest would simply mean one fewer suite.

The shell-level greps below remain useful when reading a diff by hand:

A change is rejected if any of these hits in `src/` or `alchemy.run.ts`:

```bash
rg -n "interface \w+Like|interface Env\b" src/ alchemy.run.ts   # hand-written binding types
rg -n "new Response\(" src/                                     # Response.json instead
rg -n "https://(counter|do)\b" src/                             # URL-string RPC into a DO
rg -n "async (fetch|scheduled)\(.*env: Env\)" src/            # missing ctx: ExecutionContext
rg -n "storage\.put\(" -A2 src/ | rg -B2 "storage\.get"         # suspicious read-modify-write
test ! -e scripts/alch.sh                                       # CLI driven from package.json
```

Measured after the refactor (baseline in brackets):

| Gate | Command | Hits |
| --- | --- | --- |
| hand-written binding interfaces | `rg -c 'interface \w+Like\|interface Env\b' src/ alchemy.run.ts` | **0** (was 14) |
| hand-built JSON responses | `rg -n 'new Response\(JSON' src/` | **0** (was 2) — `Response.json` everywhere. One `new Response(body, …)` remains and is correct: it returns an R2 object *stream* with custom headers, which is the platform API, not a JSON hand-roll |
| URL-string DO RPC | `rg -c 'https://(counter\|do)\b' src/` | **0** (was 2) — the DO exposes typed RPC methods, called as `getByName(…).increment()` |
| handlers without `ctx` | `rg -n 'async (fetch\|scheduled)\(.*env: ApiEnv\)' src/` | **0** (was 2) — both take `ctx: ExecutionContext` |
| bash wrapper | `test -e scripts/alch.sh` | **gone** — the CLI is driven from `package.json` scripts, and `.github/workflows/ci.yml` calls `alchemy plan` directly |

**One deviation remains, and it is forced by the compiler:** `ApiEnv` is
`Cloudflare.InferEnv<typeof bindings>` rather than `InferEnv<typeof Api>`. Applying the helper
to the Worker hits TS2589 ("type instantiation is excessively deep") the moment a Durable
Object binding is present, because `DurableObjectLike`'s default `Shape = any` sends the mapped
type recursive. Same helper, narrower input, identical result — recorded here so nobody
"fixes" it back.

## Refactor backlog

Done: interfaces deleted (14 → 0), `env` typed by `InferEnv`, handlers take `ctx`,
`Response.json`, DO on `extends DurableObject` with `ctx.storage.transaction`, typed RPC
instead of URL dispatch.

All four backlog items are done: interfaces deleted, `env` typed by `InferEnv`, handlers take
`ctx`, gates encoded as `test/policy.test.ts` (three layers, mutation-checked), and the shell
wrapper deleted with its CI step repointed at the CLI.
