# alch-run-beta

An Alchemy project pinned to **`alchemy@2.0.0-beta.83`** — beta.84 is announced but not
installable, and its post is served only from the preview host (see
[Why beta.83](#why-beta83-not-beta84)).

One Worker over four Cloudflare services — R2 (bodies), D1 (metadata + audit), KV (cached
index), Durable Object (counters) — plus a Queue consumer and a cron handler. Deployed to a
real account.

## Layout

```
alchemy.run.ts            composition root: Stack + providers + state + outputs
migrations/               0001_init.sql (photos), 0002_audit.sql (audit_events)
src/Api.ts                Worker runtime: fetch + queue + scheduled handlers, Counter DO class
src/Photos.ts             R2 bucket        src/Db.ts        D1 database + migrations
src/Cache.ts              KV namespace     src/QueueEvents.ts  Queue + its Consumer
test/api.test.ts          offline Vitest suite, every binding faked in memory
vitest.config.ts          pins the suite to test/**/*.test.ts
.github/workflows/ci.yml  verify (typecheck + tests), plus a gated plan-only job
CONVENTIONS.md            exact-Alchemy-shape policy: allow-list, deny-list, gates
MIGRATION-beta84.md       the diff this tree needs when beta.84 publishes
REVIEW-2026-10-23.md      shape audit, corrections, defects fixed, missing layers
FAILURES.md               what broke, why, and the rules this project now follows
.alchemy/                 local state + dev logs (gitignored)
```

Provider imports live only in the modules that declare a resource; `src/Api.ts` imports nothing
from Alchemy, so the beta.84 package split is a handful of one-line rewrites.

## The API

| Route | Services | Behaviour |
| --- | --- | --- |
| `GET /health` | — | `{ ok, time }` |
| `GET /stats` | DO + D1 | Increments the DO counter; returns it with the audit-row count |
| `GET /audit` | D1 | Rows written by the `queue()` handler |
| `GET /photos` | KV → D1 | Cached index; `x-cache: hit` from KV, `miss` from D1 + refill |
| `GET /photos/<key>` | R2 + D1 | Body from R2, content-type/created-at from the D1 row |
| `PUT /photos/<key>` | R2 + D1 + KV + Queue | Body, upsert, cache bust, audit event |
| `DELETE /photos/<key>` | R2 + D1 + KV | Removes object + row, busts cache |

Three handlers: `fetch` (above), `queue` (audit consumer, per-message `ack`/`retry`, attached
by `Queues.Consumer({ scriptName: worker.workerName })`), `scheduled` (`0 3 * * *`, proven to
fire).

The `Counter` Durable Object is exported from `src/Api.ts`, extends `DurableObject` from
`cloudflare:workers` (the documented async-Worker shape), and is bound with
`Cloudflare.DurableObject<Counter>("Counter", { className: "Counter" })` so its **methods are
typed RPC** — `getByName("global").increment()` — with no URL-string dispatch. Increments run
inside `ctx.storage.transaction`, so concurrent `/stats` calls cannot lose one.

```bash
URL=https://alchrunbeta-api-deep-pass-6cjaiopzcff6bixa.utahj4754.workers.dev
curl $URL/stats                                  # DO counter increments per call
curl -X PUT --data-binary "hi" $URL/photos/hi.txt
sleep 10 && curl $URL/audit                      # the queued event, written by the consumer
```

## Live deployment

Revision 2 is live: the Durable Object, the Queue + Consumer and the cron handler were added
on 2026-10-23. Stage `deep-pass`, account `7a470541a704caaf91e71efccc78fd36`.

| Resource | Physical name | What proves it |
| --- | --- | --- |
| Worker | `alchrunbeta-api-deep-pass-6cjaiopzcff6bixa` · <https://alchrunbeta-api-deep-pass-6cjaiopzcff6bixa.utahj4754.workers.dev> | `/stats` and `/audit` answer |
| R2 bucket | `alchrunbeta-photos-deep-pass-bqzyydt4zuytxvh3` | `GET /photos/<key>` serves a body a `PUT` wrote |
| D1 database | `AlchRunBeta-Db-deep-pass-ihj3cxwbtipjaog6` | both migrations applied; `audit_events` holds consumer-written rows |
| KV namespace | `2430e2e45a8544568114b1c098146c42` | second `GET /photos` returns `x-cache: hit` |
| Queue + Consumer | `alchrunbeta-events-deep-pass-73jum5an2fzj4s3k` + `ApiAuditConsumer` | an audit row appears that no request wrote |
| Durable Object | class `Counter`, namespace `dd0b8b6bbc5d45948e7e084bb69387fa` | counter increments across calls and survives eviction (`3`→`4`) |
| Cron trigger | `0 3 * * *` on the Worker | fires — 16 `cron.fire` rows on 2026-10-23; first delivery **11m11s** after the trigger was attached ([CRON-FINDINGS.md](./CRON-FINDINGS.md)) |

Three live caveats, none of them green:

- the cron's *daily* schedule has not been observed: the 16 rows came from a temporary
  `* * * * *` trigger, so the next real signal is `0 3 * * *` at 2026-10-24 03:00 UTC — and
  `pnpm cron-health` is what will confirm it (it currently exits 1, correctly);
- one DO call returned `errorcode: 1101`; telemetry later showed Cloudflare never entered the
  object (`cpuTimeMs: 0`, no `Counter` invocation), so it was platform-side — see
  [FAILURES.md](./FAILURES.md) #7;
- the live bundle **predates** the four bug fixes below, so `bytes` accounting and the
  `PUT /photos` status code differ from `src/` until the next deploy.

The live stage also carries a temporary `* * * * *` probe trigger while the committed
`alchemy.run.ts` declares daily `0 3 * * *`. Restoring it is the closing step of the cron track.

```bash
export CLOUDFLARE_API_TOKEN=…          # see Credentials
export CLOUDFLARE_ACCOUNT_ID=7a470541a704caaf91e71efccc78fd36
export ALCHEMY_STAGE=deep-pass         # otherwise the stage is live_${USER}

pnpm deploy                            # plan → confirm → apply
pnpm drift                             # resources changed outside alchemy
pnpm destroy                           # delete the whole stage
```

State lives in `.alchemy/state/AlchRunBeta/<stage>/`, so only this checkout (or a shared state
store) can update or destroy the stage cleanly. Queue consumers reconcile on script name, so a
fresh state would try to recreate resources that already exist.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` over `alchemy.run.ts`, `src/`, `test/` |
| `pnpm test` | `vitest run` — 26 offline tests, no account, no network |
| `pnpm dev` | Local loop on workerd, HMR at <http://localhost:1337> |
| `pnpm plan` / `deploy` / `destroy` | Alchemy against `$ALCHEMY_STAGE` (or `live_${USER}`) |
| `pnpm drift` / `logs` / `check-env` / `state` | Ops: detect out-of-band changes, read or tail logs, credential preflight, list state |
| `pnpm cron-health` | Asserts the cron expression Cloudflare **delivers** matches the one configured — the one external mechanism no other check can see ([§8](./REVIEW-2026-10-23.md)) |

Flags are **per-subcommand** — `alchemy state list` takes no `--stage` — so read `--help` for
the subcommand in hand. `$ALCHEMY_STAGE` selects the stage; `dev` defaults to `dev_${USER}`.

## Testing

Offline by construction: `env` is typed by `ApiEnv` (`Cloudflare.InferEnv` from the composition
root) — real `R2Bucket`/`D1Database`/`KVNamespace`/`Queue`/`DurableObjectNamespace`, zero
hand-written interfaces — so every binding is faked in memory and cast once at the harness
boundary, where the runtime supplies the rest.

| Binding | Fake | Fidelity kept |
| --- | --- | --- |
| `PHOTOS` | `Map` | `size` is UTF-8 byte length, as R2 reports it |
| `DB` | switches on the Worker's SQL | unknown SQL throws, so a new query cannot pass silently |
| `CACHE` | `Map` | records `expirationTtl`; never expires |
| `EVENTS` | array | captures bodies |
| `COUNTER` | namespace stub | delegates to a real `new Counter(state, env)`, so DO code runs against fake storage |

`cloudflare:workers` is aliased in `vitest.config.ts` to `test/stubs/cloudflare-workers.ts` —
Node cannot resolve the Workers runtime module, while type-checking still uses the real
declaration from `@cloudflare/workers-types`.

Covered: every route above, the cache miss→hit pair (asserting a hit never reaches D1),
`queue()` ack/retry/drain-after-failure, `scheduled()` bumping the DO and writing `cron.fire`,
and `Counter` continuing from storage rather than module state.

Tests share the root `tsconfig.json` (no relaxed flags), so `pnpm typecheck` gates them too.
Four defects and one CI blocker the suite found are **fixed**, not pinned:

| Defect | Fix |
| --- | --- |
| `PUT /photos` (no key) → 404 while its message named PUT | both `PUT`/`POST` → 400, message names the method |
| `bytes` was UTF-16 code units (`"é"` stored 2, recorded 1) | `TextEncoder().encode(body).byteLength` |
| `DELETE` reported statement success for an absent key | affected-row count |
| unparseable KV value 500'd the index | treated as a cache miss |
| `onlyBuiltDependencies` is dead config on pnpm 11 → fresh install exits 1 | `allowBuilds: { workerd: true }` |

## CI

| Job | When | What |
| --- | --- | --- |
| `verify` | every push and PR | `pnpm install --frozen-lockfile`, `typecheck`, `test` — no secrets |
| `plan` | `main` only, after `verify` | `pnpm exec alchemy plan --stage "$STAGE"` — never `deploy`; applying stays a human decision |

`plan` runs on `workflow_dispatch` or when a `CLOUDFLARE_API_TOKEN` secret exists; GitHub
rejects `secrets.*` inside `if:`, so the check happens in a step and a push without the secret
skips with a notice. `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_STAGE` come from repo variables with
documented defaults.

## Credentials

`pnpm dev` and `pnpm test` need none.

`plan`, `deploy`, `drift` and `destroy` need an account, as a profile
(`alchemy profile edit --add Cloudflare`) or as env vars:

```bash
export CLOUDFLARE_API_TOKEN=…      # API token, or a `wrangler login` OAuth token
export CLOUDFLARE_ACCOUNT_ID=7a470541a704caaf91e71efccc78fd36
```

Two hard-won facts:

- **A printed scope list is not the capability set.** `wrangler whoami` lists no R2 scope, yet
  R2 bucket creation succeeds. Probe with a throwaway resource before concluding a permission
  is missing. `/user/tokens/verify` likewise rejects valid account-scoped tokens.
- **wrangler refresh tokens rotate, single-use.** Refreshing inside a copied config directory
  spends the original's token, so the copy *becomes* the session — deleting it destroys the
  only credential. Prefer a real API token.

## Verified

Local = `pnpm dev` on workerd. Live = the revision-2 deployment. **unknown** means unproven,
not a quiet pass.

| Check | Local | Live |
| --- | --- | --- |
| `GET /health` | 200 | 200 |
| `PUT /photos/<key>` writes R2 + D1 + KV bust + queue event | 201 | 201 |
| `GET /photos` miss → `source: d1`, then hit → `source: kv` | ✅ | ✅ |
| `GET /photos/<key>` body from R2, content-type from D1 | ✅ | ✅ |
| `DELETE` → object + row gone, cache busted, then 404 | — | ✅ |
| `GET /stats` → DO counter via typed RPC increments | ✅ | ✅ (8 → 9 after the RPC deploy) |
| `PUT` of a non-ASCII body records UTF-8 bytes (`"é"` → 2) | ✅ | ✅ |
| Consumer drains to D1 → `/audit` shows the event | ✅ | ✅ |
| D1 migrations applied (`photos`, `audit_events`, `__alchemy_migrations`) | ✅ | ✅ |
| **Cron fires** → `cronFires` + `cron.fire` row | ✅ (16 rows, temp `* * * * *`) | ✅ same rows, `scheduled outcome=ok` in observability |
| `alchemy plan` after deploy → all `noop` | — | ✅ rev 1 only; **unknown** after rev 2 |
| `pnpm typecheck` | exit 0 (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`) | — |
| policy gates (`CONVENTIONS.md`) | 0 hand-written interfaces, 0 URL-string RPC, 0 handlers without `ctx` | — |
| `pnpm test` | 26/26, offline | — |

Two runtime behaviours worth knowing:

- the local queue consumer drains on its own pull loop — an event reached `audit_events` about
  15s after the `PUT`. An empty `/audit` is not a broken consumer.
- a **newly attached** cron trigger does not fire on the next minute: measured first-fire
  latency was 6m42s, 6m46s and 11m11s across three scripts. Checking inside the first ~5
  minutes reads as "never fires" and is wrong — allow ~15 minutes before concluding anything
  ([CRON-FINDINGS.md](./CRON-FINDINGS.md)).

The green typecheck covers this repo's code, not every corner of Alchemy's own types: beta.84
ships #2413 because `alchemy/State` did not type-check under `exactOptionalPropertyTypes`, and
this tree avoids importing those types (it calls `Alchemy.localState()`).

## Pinned versions

| Package | Version |
| --- | --- |
| `alchemy` | `2.0.0-beta.83` (exact) |
| `effect` / `@effect/platform-node` | `4.0.6` |
| `@cloudflare/workers-types` | `5.20261022.1` (dev) |
| `typescript` / `vitest` | `5.9.3` / `5.0.5` (dev) |
| `@types/node` | `24.19.2` |
| `workerd` (transitive) | `1.20261002.1` |

`pnpm-workspace.yaml` sets `allowBuilds: { workerd: true }` and `verifyDepsBeforeRun: false`.
pnpm 11 **removed** `onlyBuiltDependencies` (silently ignored) and defaults `strictDepBuilds` to
true, so the old key made a fresh install exit 1.

beta.84 bumps Effect to `^4.0.5`; this repo already runs `4.0.6` and has been exercised on it,
so that breaking change costs nothing here.

## Why beta.83, not beta.84

The beta.84 post is served only from `main.alchemy.run` — the production URL 404s and the blog
index/RSS stop at beta.83. And nothing installable exists:

| Signal | Result |
| --- | --- |
| `alchemy` on npm | `latest` = `2.0.0-beta.83` (2026-10-12); no beta.84 |
| Split provider packages | only `0.0.0` for `@alchemy.run/{aws,cloudflare,domain,gcp,core}` |
| `@alchemy.run/{aws,cloudflare,core}@0.0.0` | a stale 2025-11-03 prototype on **Effect v3** — an abandoned prototype squatting the name |
| `@alchemy.run/{domain,gcp}@0.0.0` | 2026-10-21 publish stubs: 2 files, no code |
| The post's install route | `pkg.alchemy.run/…/2e7fdc5` 404s, as do `latest` and `2.0.0-beta.84` |

Versioning is settled though: alchemy's scoped helpers (`cloudflare-runtime`, `floci`,
`node-utils`, `frontend-frameworks`) all sit at exactly `2.0.0-beta.83`, lockstep with core, so
`@alchemy.run/cloudflare@2.0.0-beta.84` is the expected pin.

> **Trap:** never `pnpm add @alchemy.run/cloudflare` unpinned — it resolves to `0.0.0`, the
> Effect-v3 prototype, and pulls a second Effect into the tree.

```bash
npm view alchemy dist-tags
npm view @alchemy.run/cloudflare versions   # expect a real version, not just 0.0.0
```
