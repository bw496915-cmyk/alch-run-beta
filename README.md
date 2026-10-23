# alch-run-beta

An Alchemy 2.0 project pinned to **`alchemy@2.0.0-beta.83`** (deliberately not
`2.0.0-beta.84`, which is announced but unpublished — see
[Why beta.83](#why-beta83-not-beta84)), and **deployed live on Cloudflare**.

One Worker over three data services — R2 for object bodies, D1 for row metadata,
KV for a cached index — so a single request exercises real bindings from three
different products.

## Layout

```
.
├── alchemy.run.ts            # composition root: Stack + providers + state + outputs
├── migrations/
│   ├── 0001_init.sql         # photos table + index
│   └── 0002_audit.sql        # audit_events table
├── src/
│   ├── Api.ts                # Worker runtime: fetch + queue + scheduled, and the Counter DO class
│   ├── Photos.ts             # R2 bucket
│   ├── Db.ts                 # D1 database + migrations
│   ├── Cache.ts              # KV namespace
│   └── QueueEvents.ts        # Queue + its Consumer
├── tsconfig.json             # strict, no-emit typecheck
├── scripts/
│   └── alch.sh               # plan / deploy / destroy a stage without remembering flags
├── MIGRATION-beta84.md       # the exact diff this tree needs when beta.84 ships
├── REVIEW-2026-10-23.md      # shape conformance audit, failure log, parallel-work scoping
├── FAILURES.md               # what broke, why, and the rules this project now follows
└── .alchemy/                 # local state + dev logs (gitignored)
```

Every provider import lives in the modules that declare a resource, and `src/Api.ts`
imports nothing from Alchemy at all. That keeps the beta.84 package split a handful of
one-line import rewrites rather than a repo-wide pass.

## The API

| Route | Services touched | Behaviour |
| --- | --- | --- |
| `GET /health` | — | `{ ok, time }` |
| `GET /stats` | Durable Object + D1 | Increments the DO counter, returns it with the audit-row count |
| `GET /audit` | D1 | Rows written asynchronously by the `queue()` handler |
| `GET /photos` | KV → D1 | Cached index; `x-cache: hit` from KV, `miss` from D1 + refill |
| `GET /photos/<key>` | R2 + D1 | Object body with content-type/created-at from the D1 row |
| `PUT /photos/<key>` | R2 + D1 + KV + Queue | Writes body, upserts row, busts cache, enqueues an audit event |
| `DELETE /photos/<key>` | R2 + D1 + KV | Removes object + row, busts the cache |

Three handlers on one Worker:

- **`fetch`** — the routes above.
- **`queue`** — the audit consumer; writes each batch into D1 (`ack`/`retry` per message).
  Attached to the queue by `Cloudflare.Queues.Consumer("ApiAuditConsumer", { scriptName: worker.workerName })`.
- **`scheduled`** — the `0 3 * * *` cron; bumps the DO's `cronFires` counter and records a row.
  Wired, but never yet observed to fire — see [Live deployment](#live-deployment).

The **`Counter`** Durable Object is a plain (non-Effect) class exported from `src/Api.ts`
and bound with `Cloudflare.DurableObject("Counter", { className: "Counter" })`. Its state
lives in DO storage, so it survives deployments.

```bash
URL=https://alchrunbeta-api-deep-pass-6cjaiopzcff6bixa.utahj4754.workers.dev
curl $URL/stats                 # DO counter goes up on every call
curl -X PUT --data-binary "hi" $URL/photos/hi.txt
sleep 10 && curl $URL/audit     # the queued event, written by the consumer
```

## Live deployment

**Two revisions have shipped, and revision 2 is live.** Revision 1 was the Worker over
R2 + D1 + KV. Revision 2 (2026-10-23) added the `Counter` Durable Object, the Queue with its
Consumer, and the `scheduled` handler with a cron trigger.

Two things on the live stage are **still unproven**, and neither should be read as green:

- the cron trigger is attached but has **never been observed to fire**;
- one call on the Durable Object path returned a transient `errorcode: 1101`.

Both are tracked, with the evidence and the open investigations, in
[FAILURES.md](./FAILURES.md) and [REVIEW-2026-10-23.md](./REVIEW-2026-10-23.md).

Stage `deep-pass`, account `7a470541a704caaf91e71efccc78fd36`:

| Resource | Physical name | Live | What proves it |
| --- | --- | --- | --- |
| Worker | `alchrunbeta-api-deep-pass-6cjaiopzcff6bixa` · <https://alchrunbeta-api-deep-pass-6cjaiopzcff6bixa.utahj4754.workers.dev> | yes (rev 2) | the rev-2 routes `/stats` and `/audit` answer at that URL |
| R2 bucket | `alchrunbeta-photos-deep-pass-bqzyydt4zuytxvh3` | yes (rev 1) | `GET /photos/<key>` serves a body written by `PUT` |
| D1 database | `AlchRunBeta-Db-deep-pass-ihj3cxwbtipjaog6` | yes | both migrations applied — `audit_events` exists and holds rows the consumer wrote |
| KV namespace | `2430e2e45a8544568114b1c098146c42` | yes (rev 1) | second `GET /photos` returns `x-cache: hit`, `source: kv` |
| Queue + Consumer | `alchrunbeta-events-deep-pass-73jum5an2fzj4s3k` + `ApiAuditConsumer` (`b47f1db419e44d9aba6d9d65ab2abdbe`) | yes (rev 2) | an audit row appears in D1 after a `PUT` — written by the `queue()` handler, not by the request |
| `Counter` Durable Object | class `Counter`, namespace `dd0b8b6bbc5d45948e7e084bb69387fa` | yes (rev 2) | `/stats` incremented the counter across calls, and storage kept its value (`3` → `4`) across the failed call |
| Cron trigger | on the Worker above | **attached, never fired** | the trigger is listed by the `schedules` API; `wrangler tail` shows zero `scheduled()` invocations and no `cron.fire` row exists. See [FAILURES.md](./FAILURES.md) #8 |

> **Schedule mismatch, on purpose, for now.** The committed `alchemy.run.ts` declares the
> daily `0 3 * * *` cron, but the deployment that is live carries a `* * * * *` probe
> trigger — the temporary value used to try to make the handler fire. Restoring the daily
> schedule is the closing step of the cron track in
> [REVIEW-2026-10-23.md](./REVIEW-2026-10-23.md) §3, not a config the live stage is meant to keep.

Redeploying picks up everything above from the same local state:

```bash
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=7a470541a704caaf91e71efccc78fd36
pnpm exec alchemy deploy --stage deep-pass --yes --no-input
```

`./scripts/alch.sh deploy` does the same thing (and refuses to run without a token, printing
the scopes it needs). Tear the stage down with:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=7a470541a704caaf91e71efccc78fd36 \
  pnpm exec alchemy destroy --stage deep-pass --yes
```

State for each stage is recorded under `.alchemy/state/AlchRunBeta/<stage>/`, so a stage
deployed from a different machine needs that state (or a shared state store) to be
destroyed or updated cleanly. Queue consumers reconcile against the Worker's script name,
so a redeploy must come from this checkout (or with this state) — a fresh state would try to
recreate resources that already exist.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` over `alchemy.run.ts`, `src/`, `migrations/` |
| `pnpm dev` | Local loop on workerd (D1 + KV + R2 emulated), HMR at <http://localhost:1337> |
| `pnpm plan` | Diff against the current stage, apply nothing |
| `pnpm deploy` | Plan → confirm → apply |
| `pnpm destroy` | Delete everything in the stage |
| `./scripts/alch.sh <plan\|deploy\|destroy>` | The same three commands for one stage (default `deep-pass`, `STAGE=…` overrides), refusing to run without `CLOUDFLARE_API_TOKEN` |

Flags worth knowing: `--stage <name>`, `--profile <name>`, `--dry-run`, `--yes`,
`--no-input`. Stages default to `live_${USER}` for `plan`/`deploy` and `dev_${USER}` for
`dev`. Flags are **per-subcommand** — `alchemy state list` takes no `--stage` — so read
`--help` for the subcommand in hand rather than assuming this list travels.

## Credentials

`pnpm dev` needs none — everything runs locally on workerd.

`plan`, `deploy` and `destroy` need a Cloudflare account, configured either as a profile
(`alchemy profile edit --add Cloudflare`, OAuth) or as environment variables:

```bash
export CLOUDFLARE_API_TOKEN=…      # API token, or a `wrangler login` OAuth token
export CLOUDFLARE_ACCOUNT_ID=7a470541a704caaf91e71efccc78fd36
```

A `wrangler login` OAuth token works directly as `CLOUDFLARE_API_TOKEN` (that is what
deployed this stack). Note that `wrangler whoami` lists its scopes *without* any R2 entry
yet R2 bucket creation still succeeds — the printed scope list is not the full picture, so
probe rather than infer.

**Lesson learned the hard way:** wrangler's OAuth **refresh tokens rotate** (single use).
Refreshing inside a copied config directory spends the refresh token held by the original,
and deleting the copy then leaves no usable session at all — which is exactly how the
credentials died mid-session here. If you need credentials to outlive a single command,
use a real API token (`wrangler login` → dashboard → *My Profile → API Tokens*) or run
`alchemy profile edit --add Cloudflare` to give Alchemy its own OAuth profile.

## Verified

Local = `pnpm dev` on workerd. Live = the revision-2 deployment at the URL above. A cell
that says **unknown** is unproven, not a quiet pass; every live claim below is either
exercised over HTTP against that URL or recorded in
[REVIEW-2026-10-23.md](./REVIEW-2026-10-23.md).

| Check | Local | Live | Note |
| --- | --- | --- | --- |
| `GET /health` | 200 | 200 | rev 1, still answering after rev 2 |
| `PUT /photos/<key>` (R2 + D1 + KV bust) | 201 | 201 | rev 1 |
| `GET /photos` first call → `x-cache: miss`, `source: d1` | ✅ | ✅ | rev 1 |
| `GET /photos` second call → `x-cache: hit`, `source: kv` | ✅ | ✅ | rev 1 |
| `GET /photos/<key>` → body from R2, content-type from D1 | ✅ | ✅ | rev 1 |
| `DELETE` → R2 + row gone, cache busted, then 404 | — | ✅ | rev 1 |
| `GET /stats` → DO counter increments across calls | ✅ | ✅ **with one exception** | rev 2; one call returned `errorcode: 1101`, then the counter continued `3` → `4` — see [FAILURES.md](./FAILURES.md) #7 |
| `PUT` → queue message enqueued (`queued: <uuid>` in the 201 body) | ✅ | ✅ | rev 2 |
| Consumer drains to D1 → `GET /audit` shows the event, `auditEvents` goes 0→1 | ✅ | ✅ | rev 2 — proven by a row in `audit_events` that no request wrote |
| D1 migrations applied (`photos`, `photos_created_at`, `audit_events`, `__alchemy_migrations`) | ✅ | ✅ | rev 2 added `audit_events`; the consumer writes to it |
| **Cron fires** → `scheduled()` bumps DO `cronFires`, writes a `cron.fire` row | **not testable in seconds** | **✖ never observed** | the trigger is attached and the handler still never ran — [FAILURES.md](./FAILURES.md) #8, open |
| `alchemy plan` after deploy → every resource `noop` | — | **unknown** | ✅ after revision 1 only; not re-checked after revision 2 |
| `pnpm typecheck` | exit 0, `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` | — | last recorded run 2026-10-22; docs changes do not touch it |

**Still unproven on the live stage**, stated plainly so nobody inherits a false green:

- the cron has never fired — an attached trigger is not a working trigger;
- the `1101` on the DO path has no root cause, only one occurrence and a working retry;
- the post-revision-2 `alchemy plan … noop` check has not been run.

Two behaviours worth knowing when you run this yourself:

- The local queue consumer drains on its own pull loop — an event landed in `audit_events`
  about 15s after the `PUT`, not instantly. Do not read an empty `/audit` as a broken
  consumer.
- `scheduled` cannot be exercised locally in seconds, and a `* * * * *` trigger deployed
  live did not fire either, so a cron fire is currently untested at both levels — treat the
  cron as an open question rather than a feature.

One caveat on that green typecheck: it covers *this* repo's code, not every corner of
Alchemy's own types. beta.84 ships #2413 precisely to make `alchemy/State` type-check under
`exactOptionalPropertyTypes`; this tree never imports those types (it calls
`Alchemy.localState()`), which is why it comes out clean.

## Pinned versions

| Package | Version |
| --- | --- |
| `alchemy` | `2.0.0-beta.83` (exact) |
| `effect` | `4.0.6` |
| `@effect/platform-node` | `4.0.6` |
| `typescript` | `5.9.3` |
| `@types/node` | `24.19.2` |
| `workerd` (transitive) | `1.20261002.1` |

`pnpm-workspace.yaml` pins `onlyBuiltDependencies: [workerd]` so local emulation works, and
`minimumReleaseAgeExclude` for the two Effect packages pnpm flagged as very fresh.

beta.84 also bumps Effect to `^4.0.5` (#2372). This repo already resolves `4.0.6` and has
been exercised on it (install, typecheck, local loop, live deploy), so that breaking
change costs nothing here.

## Why beta.83, not beta.84

The [2.0.0-beta.84 release post](https://alchemy.run/blog/2026-10-22-beta-84/) is live,
but as of **2026-10-23** nothing in it can be installed. Four independent checks agree:

| Signal | Result |
| --- | --- |
| `alchemy` on npm | `latest` = `2.0.0-beta.83`, published 2026-10-12 — no beta.84 |
| Split provider packages | only `0.0.0` exists for `@alchemy.run/{aws,cloudflare,domain,gcp,core}` |
| What `@alchemy.run/{aws,cloudflare,core}@0.0.0` is | a **stale 2025-11-03 prototype depending on Effect v3** (`cloudflare` wants `effect@^3.17`, `aws` wants `effect@^3.18`) — an abandoned prototype squatting the name |
| What `@alchemy.run/{domain,gcp}@0.0.0` is | a 2026-10-21 publish stub: 2 files, 669 / 696 bytes, no code |
| The post's own install route | `https://pkg.alchemy.run/…/2e7fdc5` 404s `{"error":"alchemy@2e7fdc5 not found"}`; `latest` and `2.0.0-beta.84` paths 404 too |

`@alchemy.run/domain` and `@alchemy.run/gcp` were reserved on **2026-10-21**, the day
before the post, one of them described as a "Temporary package placeholder for staged
publishing". The publish was staged; the artifacts never landed.

What *is* proven is how the split will be versioned: alchemy's existing scoped helpers
(`@alchemy.run/cloudflare-runtime`, `floci`, `node-utils`, `frontend-frameworks`) all sit
at exactly `2.0.0-beta.83` — lockstep with the core package. So
`@alchemy.run/cloudflare@2.0.0-beta.84` is the expected pin, not a guess.

> **Trap:** never `pnpm add @alchemy.run/cloudflare` without an exact version. It resolves
> to `0.0.0`, the Effect-v3 prototype, and pulls a second Effect into the tree.

Check the state of the world before migrating:

```bash
npm view alchemy dist-tags
npm view @alchemy.run/cloudflare versions   # expect a real version, not just 0.0.0
```
