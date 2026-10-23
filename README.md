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
├── MIGRATION-beta84.md       # the exact diff this tree needs when beta.84 ships
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

**Two revisions exist.** The live Worker is revision 1 (R2 + D1 + KV); the Durable
Object, Queue, Consumer and cron are built and verified locally but **not yet deployed** —
the credentials expired mid-session (see [Credentials](#credentials)).

Revision 1 is deployed to the `deep-pass` stage on account `7a470541a704caaf91e71efccc78fd36`:

| Resource | Physical name | Deployed |
| --- | --- | --- |
| Worker | `alchrunbeta-api-deep-pass-6cjaiopzcff6bixa` · <https://alchrunbeta-api-deep-pass-6cjaiopzcff6bixa.utahj4754.workers.dev> | yes (rev 1) |
| R2 bucket | `alchrunbeta-photos-deep-pass-bqzyydt4zuytxvh3` | yes |
| D1 database | `AlchRunBeta-Db-deep-pass-ihj3cxwbtipjaog6` | yes |
| KV namespace | `2430e2e45a8544568114b1c098146c42` | yes |
| Queue + Consumer | `alchrunbeta-events-…` + `ApiAuditConsumer` | **no — planned** |
| `Counter` Durable Object | class `Counter` on the Worker above | **no — planned** |
| Cron `0 3 * * *` | on the Worker above | **no — planned** |

Deploying revision 2 picks up all of the above from the same local state:

```bash
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=7a470541a704caaf91e71efccc78fd36
pnpm exec alchemy deploy --stage deep-pass --yes --no-input
```

Tear the stage down with:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=7a470541a704caaf91e71efccc78fd36 \
  pnpm exec alchemy destroy --stage deep-pass --yes
```

State for each stage is recorded under `.alchemy/state/AlchRunBeta/<stage>/`, so a stage
deployed from a different machine needs that state (or a shared state store) to be
destroyed or updated cleanly. Queue consumers reconcile against the Worker's script name,
so revision 2 must be deployed from this checkout (or with this state) — a fresh state
would try to recreate resources that already exist.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` over `alchemy.run.ts`, `src/`, `migrations/` |
| `pnpm dev` | Local loop on workerd (D1 + KV + R2 emulated), HMR at <http://localhost:1337> |
| `pnpm plan` | Diff against the current stage, apply nothing |
| `pnpm deploy` | Plan → confirm → apply |
| `pnpm destroy` | Delete everything in the stage |

Flags worth knowing: `--stage <name>`, `--profile <name>`, `--dry-run`, `--yes`,
`--no-input`. Stages default to `live_${USER}` for `plan`/`deploy` and `dev_${USER}` for
`dev`.

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

Local = `pnpm dev` on workerd. "Live" = the revision-1 deployment at the URL above;
revision 2 (DO / queue / cron) is local-only until credentials are restored.

| Check | Local | Live |
| --- | --- | --- |
| `GET /health` | 200 | 200 |
| `PUT /photos/<key>` (R2 + D1 + KV bust) | 201 | 201 |
| `GET /photos` first call → `x-cache: miss`, `source: d1` | ✅ | ✅ |
| `GET /photos` second call → `x-cache: hit`, `source: kv` | ✅ | ✅ |
| `GET /photos/<key>` → body from R2, content-type from D1 | ✅ | ✅ |
| `DELETE` → R2 + row gone, cache busted, then 404 | — | ✅ |
| `GET /stats` → DO counter increments across calls (1, 2, 3…) | ✅ | *rev 2* |
| `PUT` → queue message enqueued (`queued: <uuid>` in the 201 body) | ✅ | *rev 2* |
| Consumer drains to D1 → `GET /audit` shows the event, `auditEvents` goes 0→1 | ✅ | *rev 2* |
| D1 migrations applied (`photos`, `photos_created_at`, `audit_events`, `__alchemy_migrations`) | ✅ | rev 1 (2 tables) |
| `alchemy plan` after deploy → every resource `noop` | — | ✅ (rev 1) |
| `pnpm typecheck` | exit 0, `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` | — |

Two behaviours worth knowing when you run this yourself:

- The local queue consumer drains on its own pull loop — an event landed in `audit_events`
  about 15s after the `PUT`, not instantly. Do not read an empty `/audit` as a broken
  consumer.
- `scheduled` cannot be exercised locally in seconds. Verifying an actual cron fire needs a
  live deploy with a `* * * * *` trigger (the committed schedule is daily at 03:00 UTC).

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
