# Conventions — exact Alchemy shape only

**Rule: infrastructure and runtime code uses the shapes the *pinned* Alchemy documents.
Hand-rolled substitutes are denied, even when they compile.**

A hand-roll is anything that re-implements what the framework or platform already provides:
a structural `interface` describing a Cloudflare binding, a `new Response(JSON.stringify(…))`,
a URL-string RPC into a Durable Object, a non-atomic read-modify-write on DO storage, or a
shell wrapper around a command the CLI already has.

Pinned: `alchemy@2.0.0-beta.83`, `effect@4.0.6`, `@cloudflare/workers-types@5.20261022.1`.
Floor: **`alchemy@2.0.0-beta.82`** — that release moved Durable Objects onto the declarative
`exports` deploy flow (#2135) and Cloudflare does not allow going back, so a pre-beta.82 pin fails
its first redeploy (`MIGRATION-beta84.md` §"One-way door"; asserted by `test/docs.test.ts`).

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
| `crons: ["0 3 * * *"]` + plain `async scheduled(controller, env, ctx)` | cron page note; `Worker.d.ts:704-716`; **proven to fire** on this account ([CRON-FINDINGS.md](./CRON-FINDINGS.md)) — and the Effect-native `Workers.cron` + `CronEventSourceLive` route also deploys here (re-verified 2026-10-23; the earlier "failed to deploy" was a stale record), so this row is a **style choice, not a forced one** |
| `Queues.Consumer("Id", { queueId, scriptName: worker.workerName })` | `Queues/Consumer.d.ts:76-114` |
| raw `env.DB.prepare(…)` on a typed `D1Database` | it *is* the D1 API; no wrapper wanted |

Effect-native equivalents (`Workers.cron` + `CronEventSourceLive`, `consumeQueueMessages` +
`EventSourceLive`, `DurableObject<Self>()(…)`, `R2.ReadWriteBucket`, `D1.QueryDatabase`,
`KV.ReadWriteNamespace`, `Queues.WriteQueue`, `HttpServerResponse`) are equally canonical
**when the Worker is Effect-native**, and now that `Workers.cron` deploys there both styles are
genuinely open. One consequence to weigh before choosing: the pin's `Platform.Main` is
**`{ fetch? }` only** — no `queue`, no `scheduled`. So an Effect-native Worker carries the queue
consumer and the cron as *event sources* (`consumeQueueMessages` + `EventSourceLive`; `cron` +
`CronEventSourceLive`), never as handlers on a default export. Choosing them is a style decision,
not a compliance one.

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
| `alchemy.run.ts` does **not** surface `versionId` / `deploymentId` in the stack outputs | [#2235](https://github.com/alchemy-run/alchemy/issues/2235) "Full Worker deployments return no versionId or deploymentId", filed 2026-10-13 against `alchemy@2.0.0-beta.83` | **fixed**, not duplicate/wontfix: `state_reason: completed`, closed 2026-10-20 by sam-goodwin via merged PR [#2241](https://github.com/alchemy-run/alchemy/pull/2241) *fix(cloudflare): return full deployment identities* (merge commit `68a04c07f4`, merged into `main` 2026-10-20T07:57Z) | the pin reaches a release whose changelog lists **#2241** — expected **beta.84**, unpublished as of 2026-10-23, whose notes already say "a full Worker deploy returns its versionId and deploymentId (#2241)". Then delete the workaround, re-add both outputs, and assert they are **defined in the deploy output** — read `__stack_output__.json` after `pnpm deploy` (`UPGRADE.md` step 4), not merely present on the type: the type carried both fields while the create/update path never set them, which is exactly why this bug hid. `test/docs.test.ts` fails the moment the pin reaches beta.84, with that instruction in the failure message |

---

## Deny-list — hand-rolls, with the canonical replacement

| # | Hand-roll | Canonical replacement | Source |
| --- | --- | --- | --- |
| 1 | 14 structural binding `interface`s (`R2ObjectLike`, `D1Like`, `KVLike`, `QueueBatchLike`, `DurableObjectNamespaceLike`, `ScheduledControllerLike`, `Env`, …) | `export type WorkerEnv = Cloudflare.InferEnv<typeof worker>` + `import type { WorkerEnv } from "../alchemy.run.ts"`, with `@cloudflare/workers-types` in `tsconfig.types` (without it `InferEnv` silently resolves to `any` — verified) | workers page "Async Workers"; `InferEnv.d.ts:40-45` |
| 2 | `const json = (b, s) => new Response(JSON.stringify(b, null, 2), …)` | `Response.json(body, { status })` (platform API) — or `HttpServerResponse.json` in an Effect-native Worker | Web/Workers standard |
| 3 | `stub.fetch("https://counter/increment")` string RPC | typed namespace call: `env.COUNTER.getByName("global").increment()` (async DO) or `counters.getByName("global").increment()` (Effect DO) | `DurableObject.d.ts:885` |
| 4 | `get` then `put` on DO storage across two awaits | wrap in `state.blockConcurrencyWhile(async () => …)` (or `storage.transaction`); both are absent from a hand-written storage type, which is exactly how the bug hid | `DurableObjectStorage` in workers-types |
| 5 | dropping the third handler argument (`fetch(request, env)`, `scheduled(controller, env)`) | take `ctx: ExecutionContext` and use `ctx.waitUntil(...)` for work that must outlive the response (our KV refill and audit writes were inline because `ctx` did not exist) | `ExecutionContext` in workers-types |
| 6 | wrapping the **whole** `queue()` body in `try { … } catch { message.retry() }`, so the first failure abandons the rest of the batch | the allow-listed per-message form — `try { … } catch { message.retry() }` *inside* the loop (see the allow-list above), so one poison message does not block the others; `maxRetries` applies per message. Letting the throw surface is the alternative when the batch is idempotent — `audit_events.id` is a PK, so a whole-batch retry would re-insert rows | queues page; `Queues/Consumer.d.ts` settings |
| 7 | hand-written queue/DO/R2 client shapes limiting the surface (`QueueProducerLike.send` only, no `sendBatch`/`metrics`; `R2BucketLike.get` without `onlyIf`/range) | the real `Queue`/`R2Bucket`/`DurableObjectNamespace` from `InferEnv` | `InferEnv.d.ts:45` |
| 8 | `scripts/alch.sh` — bash re-implementing CLI flags | `package.json` scripts calling the `alchemy` CLI (done, wrapper deleted with its CI step) | CLI page |
| 9 | `if (path === "/x" && request.method === "GET")` chains growing past ~4 routes | keep the small chain; past that, an Effect-native router (`HttpRouter` / `HttpApi`) is the documented instrument | APIs pages |

> **Deny-list #9, decided (2026-10-23, after the attribution audit).** This repo keeps the async
> `if (path === …)` chain **on purpose**: the async-Worker style is the allow-listed shape, and
> adopting `HttpRouter` / `HttpApi` would move the Worker to the Effect-native style — changing the
> allow-list, the three policy gates, and the DO/queue wiring. The chain (~8 branches) is a recorded
> choice, not an oversight; the router is the instrument if the API grows well past that, or if the
> repo ever goes Effect-native. See `REVIEW-2026-10-23.md` §4.

> **Deny-list note — output formatting (2026-10-23).** The `scripts/` used to render timestamps by
> hand. They now use the canonical formatter, `alchemy/Cli/Format` (`formatLocalTimestamp`; it also
> ships `formatElapsed` and `TAIL_COLORS`), reachable through the package's `./*` export. That costs
> the ops scripts the dependency-free property they had: `.github/workflows/cron-health.yml` now
> installs before it runs — the price of not hand-rolling, which is the policy. `padEnd`/`toFixed`
> on plain strings and numbers are language builtins, not hand-rolls. `alchemy/Util/Terminal`
> (`paint`/`truncate`/`colorsEnabled`) and `Cli/CliKit` stay unused: the scripts print plain,
> unbranded lines, and colour is not wanted in a health check's CI log.

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
| hand-built JSON responses | `rg -n 'new Response\(JSON' src/` | **0** (was 2) — `Response.json` everywhere. One `new Response(body, …)` remains and is correct: it streams the stored R2 object body with custom headers, which is the platform API, not a JSON hand-roll |
| URL-string DO RPC | `rg -c 'https://(counter\|do)\b' src/` | **0** (was 2) — the DO exposes typed RPC methods, called as `getByName(…).increment()` |
| handlers without `ctx` | `rg -n 'async (fetch\|scheduled)\(.*env: ApiEnv\)' src/` | **0** (was 2) — both take `ctx: ExecutionContext` |
| bash wrapper | `test -e scripts/alch.sh` | **gone** — the CLI is driven from `package.json` scripts, and `.github/workflows/ci.yml` calls `alchemy plan` directly |

**The TS2589 deviation is gone (re-checked 2026-10-23).** `ApiEnv` was
`Cloudflare.InferEnv<typeof bindings>` because applying the helper to the Worker was recorded as
hitting TS2589 ("type instantiation is excessively deep") once a Durable Object binding was
present, `DurableObjectLike`'s default `Shape = any` sending the mapped type recursive. Tested
against the canonical async example (`examples/cloudflare-worker-async`, which types
`InferEnv<typeof Worker>`): the Worker form now compiles clean, and `test/policy.test.ts` layer 3
still proves every member is the real platform type and not `any`. The file is back to
`InferEnv<typeof Api>`, and the policy test pins *that* — so a diff restoring the bindings form
fails there instead of shipping.

## Refactor backlog

Done: interfaces deleted (14 → 0), `env` typed by `InferEnv`, handlers take `ctx`,
`Response.json`, DO on `extends DurableObject` with `ctx.storage.transaction`, typed RPC
instead of URL dispatch.

All four backlog items are done: interfaces deleted, `env` typed by `InferEnv`, handlers take
`ctx`, gates encoded as `test/policy.test.ts` (three layers, mutation-checked), and the shell
wrapper deleted with its CI step repointed at the CLI.
