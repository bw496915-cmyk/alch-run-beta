# alch-run-beta

**A consumer Alchemy + Cloudflare project**: one async Worker over five Cloudflare services,
declared in `alchemy.run.ts` and deployed to a real account. Pinned to **`alchemy@2.0.0-beta.83`**
(beta.84 is announced but not installable — see [Why beta.83](#why-beta83-not-beta84)).

One Worker over five Cloudflare services — R2 (bodies), D1 (metadata + audit), KV (cached index), a
Durable Object (counters), and a Queue with a dead-letter queue — plus a daily cron handler.

**New here?** Read [REVIEW-2026-10-23.md](./REVIEW-2026-10-23.md) first (what this tree is, what
was fixed, what is still missing); the evidence is in [AUDIT-2026-10-23.md](./AUDIT-2026-10-23.md),
the shape policy in [CONVENTIONS.md](./CONVENTIONS.md), and the beta.84 path in
[UPGRADE.md](./UPGRADE.md). Otherwise, read on.

[Layout](#layout) · [The API](#the-api) · [Live deployment](#live-deployment) · [Commands](#commands)
· [Testing](#testing) · [CI](#ci) · [Credentials](#credentials) · [Verified](#verified) · [Pinned
versions](#pinned-versions) · [Agents](#working-with-an-ai-coding-agent) · [License](#license)

## Layout

```
alchemy.run.ts            composition root: Stack + providers + state + outputs
migrations/               0001_init.sql (photos), 0002_audit.sql (audit_events)
src/Api.ts                the Worker (Effect-native): fetch + queue consumer + cron, routes
src/Counter.ts            the Durable Object: typed RPC counters, storage.transaction
src/Photos.ts             R2 bucket        src/Db.ts        D1 database + migrations
src/Cache.ts              KV namespace     src/QueueEvents.ts  Queue + its Consumer
test/                     eight suites: api (dev-mode), cron-health, docs, flags, manifest, policy, preflight, queue-health
e2e/stack.test.ts         deployed-stack suite: deploys, drives the live Worker, destroys (pnpm test:e2e)
scripts/preflight.ts      session preflight: probes scratch space, reports degraded
stacks/github.ts          CI credentials as code: mints a scoped token, writes repo secrets
vitest.config.ts          pins the offline suite to test/**/*.test.ts (vitest.e2e.config.ts covers e2e/)
.github/workflows/ci.yml  verify (typecheck + tests), plus a gated plan-only job
CONVENTIONS.md            exact-Alchemy-shape policy: allow-list, deny-list, gates
MIGRATION-beta84.md       the diff this tree needs when beta.84 publishes
UPGRADE.md                what to do when beta.84 publishes
AUDIT-2026-10-23.md       ground truth + attribution: claim→artifact→verdict, owners
REVIEW-2026-10-23.md      shape audit, ranked layers, incidents, rules, unused tooling
CRON-FINDINGS.md          the cron measurement-window finding
.alchemy/                 local state + dev logs (gitignored)
```

Provider imports now reach the Worker too: since the Effect-native migration `src/Api.ts` and
`src/Counter.ts` import `alchemy/Cloudflare` for the Worker/DO providers, so the beta.84 package
split is more than the resource modules. [MIGRATION-beta84.md](./MIGRATION-beta84.md) is the file
that has to be right — re-run its grep rather than trusting a count.

## The API

| Route | Services | Behaviour |
| --- | --- | --- |
| `GET /` | — | Route index: service, route list, docs link |
| `GET /health` | — | `{ ok, time }` |
| `GET /stats` | DO + D1 | **Admin-gated.** DO counter + audit-row count, each read independently (`degraded: true` if one fails) |
| `GET /audit` | D1 | **Admin-gated.** Rows written by the `queue()` handler |
| `GET /photos` | KV → D1 | Cached index, **60 s TTL**; `x-cache: hit` from KV (cold after the 60 s TTL — the key carries it and the platform deletes it at expiry, **not** isolate churn: [AUDIT-2026-10-23.md](./AUDIT-2026-10-23.md)), `miss` from D1 + refill |
| `GET /photos/:key` | R2 + D1 | Body from R2, content-type/created-at from the D1 row |
| `PUT /photos/:key` | R2 + D1 + KV + Queue | Body, upsert, cache bust, audit event |
| `DELETE /photos/:key` | R2 + D1 + KV | Removes object + row, busts cache |

Effect-native: `src/Api.ts` **is** the Worker (`main: import.meta.url`), its bindings are
`yield*`ed services, and the queue consumer (`consumeQueueMessages`) and the cron
(`Workers.cron`, `0 3 * * *` — deployed, and asserted by `pnpm cron-health`; the migration has not
fired it, so "proven" belongs to the pre-migration shape, not this one) are event sources — `Platform.Main` carries
`fetch` only, so they cannot be default-export handlers.

The `Counter` Durable Object lives in `src/Counter.ts`, extends
`Cloudflare.DurableObject<Counter>()` (Effect-native), and is bound by `yield* Counter` so its
**methods are typed RPC** — `counters.getByName("global").increment()` — with no URL-string
dispatch. Increments run inside `storage.transaction`, so concurrent `/stats` calls cannot lose one.

```bash
URL=https://alchrunbeta-api-deep-pass-6cjaiopzcff6bixa.utahj4754.workers.dev
AUTH="Authorization: Bearer $ADMIN_TOKEN"        # /stats and /audit are admin-gated
curl -H "$AUTH" $URL/stats                       # DO counter increments per call
curl -X PUT --data-binary "hi" $URL/photos/hi.txt
sleep 10 && curl -H "$AUTH" $URL/audit           # the queued event, written by the consumer
```

A failing dependency **degrades** rather than 500s: `/stats` returns the half that worked
with `degraded: true`, and any unexpected throw becomes a named `503`. Audit events that
exhaust their retries land in the `AuditDeadLetter` queue instead of vanishing. `ADMIN_TOKEN`
is a Worker secret (`Config.Redacted`); it is required at plan/deploy time, so set
`$ADMIN_TOKEN` locally and as a repo secret in CI.

## Live deployment

Revision 2 is live: the Durable Object, the Queue + Consumer and the cron handler were added
on 2026-10-23. Stage `deep-pass`, account `7a470541a704caaf91e71efccc78fd36`.

| Resource | Physical name | What proves it |
| --- | --- | --- |
| Worker | `alchrunbeta-api-deep-pass-6cjaiopzcff6bixa` · <https://alchrunbeta-api-deep-pass-6cjaiopzcff6bixa.utahj4754.workers.dev> | `/health` answers; `/stats` + `/audit` are admin-gated (401 without the token) |
| R2 bucket | `alchrunbeta-photos-deep-pass-bqzyydt4zuytxvh3` | `GET /photos/:key` serves a body a `PUT` wrote |
| D1 database | `AlchRunBeta-Db-deep-pass-ihj3cxwbtipjaog6` | both migrations applied; `audit_events` holds consumer-written rows |
| KV namespace | `2430e2e45a8544568114b1c098146c42` | a second `GET /photos` **within 60 s** returns `x-cache: hit`; cold otherwise (the KV TTL, verified: the namespace is empty between bursts) |
| Queue + Consumer | `alchrunbeta-events-deep-pass-73jum5an2fzj4s3k` + `ApiAuditConsumer` | an audit row appears that no request wrote |
| Dead-letter queue | `alchrunbeta-auditdeadletter-deep-pass-tee5ns7ofvt6mr5r` | the consumer's `deadLetterQueue` — an event that exhausts its 3 retries lands here instead of being dropped. **It has no consumer, so nothing drains or alerts it**; verified by pushing a malformed message (`backlog_count: 2`, `consumers: []`). Draining/alerting it is an open follow-up |
| Durable Object | class `Counter`, namespace `dd0b8b6bbc5d45948e7e084bb69387fa` | counter increments across calls and survives eviction (`3`→`4`) |
| Cron trigger | `0 3 * * *` on the Worker | fires — 16 `cron.fire` rows on 2026-10-23; first delivery **11m11s** after the trigger was attached ([CRON-FINDINGS.md](./CRON-FINDINGS.md)) |
| Runtime compat | `compatibility_date: 2026-08-31`, `compatibility_flags: ["new_module_registry"]` | shipped on the version (`GET …/services/{name}/environments/production`) — recorded here because the docs never named it |

Two live caveats:

- the cron's *daily* schedule has not been **observed**: the 16 `cron.fire` rows came from a
  temporary `* * * * *` trigger, and the 2026-10-23 redeploy removed it, so the committed schedule
  is the only one attached. The *delivery* side is now green, though: `pnpm cron-health`'s
  "delivered expression matches configured" step passes (`cron health` run `40096223844`) — what is
  still unobserved is a fire at 03:00 UTC;
- one DO call returned `errorcode: 1101`; telemetry later showed Cloudflare never entered the
  object (`cpuTimeMs: 0`, no `Counter` invocation), so it was platform-side — see
  [REVIEW-2026-10-23.md](./REVIEW-2026-10-23.md) §9 #7.

The live bundle last matched `src/` on 2026-10-23 (the four bug fixes, the `AuditDeadLetter` queue,
the admin gate, the degrade-to-503 path). **It no longer does:** the Effect-native migration and the
`HttpRouter` change have not been redeployed to `deep-pass`, so until the next deploy (expected with
the DLQ rename, [`GOALS.md`](./GOALS.md) G4) read the table above as the pre-migration bundle.

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
| `pnpm test` | `vitest run` — 42 offline tests in seven suites (logic/docs/policy/ops), no account, no network. It does **not** exercise bindings — see Testing |
| `pnpm test:dev` | `vitest.dev.config.ts` — `test/api.test.ts` on workerd, driving the Worker over HTTP. Currently unreliable here ([`GOALS.md`](./GOALS.md) G8) |
| `pnpm api-probe` | `scripts/api-probe.ts` — **30** route/status/header/body assertions against a **running** `pnpm dev` server. Offline, no account, no deploy; the dependable route coverage while the dev harness is unreliable. CI runs it in the `api routes` job |
| `pnpm test:e2e` | The deployed-stack suite (`e2e/stack.test.ts`): deploys a `test_$USER` stage, drives the live Worker over HTTP, destroys. Needs an account (`CLOUDFLARE_API_TOKEN` + `ADMIN_TOKEN`) — [REVIEW §4 #7](./REVIEW-2026-10-23.md) |
| `pnpm dev` | Local loop on workerd, HMR at <http://localhost:1337> |
| `pnpm plan` / `deploy` / `destroy` | Alchemy against `$ALCHEMY_STAGE` (or `live_${USER}`) |
| `pnpm drift` / `logs` / `check-env` / `state` | Ops: detect out-of-band changes, read or tail logs, credential preflight, list state |
| `pnpm cron-health` | Asserts the cron expression Cloudflare **delivers** matches the one configured — the one external mechanism no other check can see ([§8](./REVIEW-2026-10-23.md)) |
| `pnpm queue-health` | Asserts the dead-letter queue is empty — the silent-sink invariant ([AUDIT-2026-10-23.md](./AUDIT-2026-10-23.md) §5) |
| `pnpm preflight` | Probes scratch space at session start: writes a nonce, reads it back, removes it, and reports `scratch: ok | READ-ONLY`. A read-only `/tmp` is an environment failure, not a network error ([REVIEW-2026-10-23.md](./REVIEW-2026-10-23.md) rule 11) |

Flags are **per-subcommand** — `alchemy state list` takes no `--stage` — so read `--help` for
the subcommand in hand. `$ALCHEMY_STAGE` selects the stage; `dev` defaults to `dev_${USER}`.

Common options: `--stage`, `--profile`, `--env-file` (defaults `.env`), `--yes`, `--no-input`,
`--config`. Exit codes are script-safe (`0` completed, `1` failed — including a declined plan,
`130` cancelled), and the interactive TUI is suppressed under `--no-input`, `ALCHEMY_PLAIN=1`,
`CI=1`, a non-TTY, or an agent env var — which is why CI runs `plan --no-input`. The full command
tree is in [REVIEW-2026-10-23.md §12.2](./REVIEW-2026-10-23.md).

## Testing

Three suites, and they are **not** interchangeable — say which one you mean. There are no
in-memory binding fakes any more: an Effect-native Worker has no `env` object, so there is nothing
to fake and nothing to cast. The old fakes and the `cloudflare:workers` stub were deleted with the
migration.

**Offline — `pnpm test`** (7 suites, 42 tests). Logic, docs, policy and ops-check tests: the manifest
guard, the conventions gates, the cron/queue-health logic, the flag parser. It touches **no
binding**, so it cannot see a route. Green in CI on every push.

**Dev-mode — `pnpm test:dev`** (`test/api.test.ts`, `vitest.dev.config.ts`). The integration suite:
`Test.make({ dev: true })` runs the Worker on workerd and drives it over HTTP. Excluded from
`vitest.config.ts` because it boots a runtime. **It is not currently reliable in this checkout** —
see `GOALS.md` **G8**: the harness logs `[Api] Started → http://localhost:1337/` but sometimes
nothing listens and the first test hangs. A hang is a defect to report, not a pass.

**Deployed — `pnpm test:e2e`** (`e2e/stack.test.ts`). Deploys a `test_$USER` stage, drives the live
Worker over HTTP, destroys. The strongest behavioural evidence, and it runs in
`.github/workflows/e2e.yml`.

`test/manifest.test.ts` requires the expected suite set exactly and keeps the declared test count at
or above a floor, so deleting a suite or its tests is a failing diff rather than one fewer green
check (its limits — declarations, not executions — are stated in the file). `test/docs.test.ts`
records what it cannot see next to the test that cannot see it.

Routes, statuses, headers and bodies are covered by the **dev-mode** and **deployed** suites. The
offline suites cannot see a binding at all — do not cite them as route coverage.

Tests share the root `tsconfig.json` (no relaxed flags), so `pnpm typecheck` gates them too.
Four defects and one CI blocker the suite found are **fixed**, not pinned:

| Defect | Fix |
| --- | --- |
| `PUT /photos` (no key) → 404 while its message named PUT | both `PUT`/`POST` → 400, message names the method |
| `bytes` was UTF-16 code units (`"é"` stored 2, recorded 1) | `TextEncoder().encode(body).byteLength` |
| `DELETE` reported statement success for an absent key | affected-row count |
| unparseable KV value 500'd the index | treated as a cache miss |
| `onlyBuiltDependencies` is dead config on pnpm 11 → fresh install exits 1 | `allowBuilds: { workerd: true }` |

Beyond the offline suite, **`pnpm test:e2e`** runs `e2e/stack.test.ts` — the one layer the fakes
cannot reach. It uses `alchemy/Test/Vitest` (`Test.make`) to deploy this Stack to an isolated
`test_$USER` stage, drives `/health` and both sides of the admin gate over the live URL
(`getWhenReady` rides out the `workers.dev` cold-start window), and destroys. It lives outside
`test/` so the offline gate and `test/manifest.test.ts` stay exactly as they are, and it needs a
real account. `Db`/`Photos` retain only on a non-`test_` stage, so that suite's `destroy` leaves
nothing behind. CI runs it in `.github/workflows/e2e.yml` on an isolated `test_<pr>` stage — the one
workflow that applies, and only ever to a stage that gets destroyed.

## CI

| Job | When | What |
| --- | --- | --- |
| `verify` | every push and PR | `pnpm install --frozen-lockfile`, `typecheck`, `test` — no secrets |
| `plan` | `main` only, after `verify` | `pnpm exec alchemy plan --stage "$STAGE"` — never `deploy`; applying stays a human decision |

`plan` runs on `workflow_dispatch` or when a `CLOUDFLARE_API_TOKEN` secret exists; GitHub
rejects `secrets.*` inside `if:`, so the check happens in a step and a push without the secret
skips with a notice. `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_STAGE` come from repo variables with
documented defaults.

One workflow **does** apply, deliberately narrow (`.github/workflows/e2e.yml`):

| Job | When | What |
| --- | --- | --- |
| `deployed` | push / PR to `main`, or manual | `pnpm test:e2e` — deploys a throwaway `test_<pr>` stage to the account, drives the live Worker, and destroys it. It never touches a real stage, so `plan`'s "applying stays a human decision" still holds for every real one |

The stage **must** start with `test_` — `Db`/`Photos` retain on every other stage (`src/Db.ts`), so
any other name would leak a database and a bucket per run. `e2e.yml` pins `test_<pr>` (or
`test_<run_id>` off a PR) and re-runs the destroy in an `always()` step, so a killed test worker
cannot leak.

`.github/workflows/deploy.yml` is the **prod + PR-preview** path: it drives the Alchemy root action
(`alchemy-run/alchemy@main`), which deploys `prod` from `main`, deploys `staging-<pr>` for each pull
request, and destroys that preview when the PR is closed. It is **dispatch-only for now**: the action
deploys and destroys in *different* workflow runs, so it needs a remote state store first. The move
is prepared behind one switch — `state: REMOTE_STATE ? Cloudflare.state() : Alchemy.localState()` in
`alchemy.run.ts`, with both harnesses reading the same `REMOTE_STATE` — and it defaults **off**
(`ALCHEMY_REMOTE_STATE` unset), so `pnpm dev`, `pnpm test:dev` and `pnpm test:e2e` keep their local
store until the bootstrap exists. `Cloudflare.state()` takes no arguments on this pin. Enabling is
four ordered steps, all spelled out in the workflow header: (1) `alchemy provider cloudflare
bootstrap` once, with a credential that has `Workers Scripts Write` + `Secrets Store Write`; (2)
re-mint the CI token so it carries `Secrets Store Write` (now in `stacks/github.ts`; reading the
state-store token back requires a Secrets Store *binding*, and binding needs Write); (3) set
`ALCHEMY_REMOTE_STATE: "1"` on the `deploy` job only; (4) replace the `on:` block. `Db`/`Photos`
already treat `staging-*` as ephemeral, so the preview tears down cleanly once it is on.

## Credentials

`pnpm dev` and `pnpm test` need none.

`plan`, `deploy`, `drift` and `destroy` need an account, as a profile
(`alchemy profile edit --add Cloudflare`) or as env vars:

```bash
export CLOUDFLARE_API_TOKEN=…      # API token, or a `wrangler login` OAuth token
export CLOUDFLARE_ACCOUNT_ID=7a470541a704caaf91e71efccc78fd36
```

CI needs the same two variables. Rather than copy-paste the token into the GitHub UI, the
Alchemy-recommended *credentials as code* flow lives in `stacks/github.ts`: it mints a scoped
Cloudflare token and writes it, with the account id, into this repo as Actions secrets
([CI guide](https://alchemy.run/environments/ci)). Deploy it once, from an `admin` profile —
only that profile needs token-management rights; `default` stays narrowly scoped:

```bash
alchemy profile create admin
alchemy profile edit --profile admin          # Cloudflare: API Token/Key, NOT OAuth
alchemy deploy --config stacks/github.ts --profile admin
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
| `PUT /photos/:key` writes R2 + D1 + KV bust + queue event | 201 | 201 |
| `GET /photos` miss → `source: d1`, then hit → `source: kv` | ✅ | ✅ |
| `GET /photos/:key` body from R2, content-type from D1 | ✅ | ✅ |
| `DELETE` → object + row gone, cache busted, then 404 | — | ✅ |
| `GET /stats` → DO counter via typed RPC increments | ✅ | ✅ (8 → 9 after the RPC deploy) |
| `PUT` of a non-ASCII body records UTF-8 bytes (`"é"` → 2) | ✅ | ✅ |
| Consumer drains to D1 → `/audit` shows the event | ✅ | ✅ |
| D1 migrations applied (`photos`, `audit_events`, `__alchemy_migrations`) | ✅ | ✅ |
| **Cron fires** → `cronFires` + `cron.fire` row | ✅ (16 rows, temp `* * * * *`) | ✅ same rows, `scheduled outcome=ok` in observability |
| `alchemy plan` after deploy → all `noop` | — | ✅ rev 1 only; **unknown** after rev 2 |
| `pnpm typecheck` | exit 0 (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`) | — |
| policy gates (`CONVENTIONS.md`) | 0 hand-written interfaces, 0 URL-string RPC, 0 handlers without `ctx` | — |
| `pnpm test` | 74/74 in eight suites, offline | — |

Two runtime behaviours worth knowing:

- the local queue consumer drains on its own pull loop — an event reached `audit_events` about
  15s after the `PUT`. An empty `/audit` is not a broken consumer.
- a **newly attached** cron trigger does not fire on the next minute — allow ~15 minutes before
  concluding "never fires" ([CRON-FINDINGS.md](./CRON-FINDINGS.md)).

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
| `@effect/vitest` | `4.0.6` (dev) — the `e2e/` harness |
| `@types/node` | `24.19.2` |
| `workerd` (transitive) | `1.20261002.1` |

**Floor: `alchemy@2.0.0-beta.82`.** That release opened the Durable Object `exports` deploy flow
(#2135), and Cloudflare does not allow a Worker back onto the legacy `migrations` flow, so a
pre-beta.82 pin fails its first redeploy (see `MIGRATION-beta84.md` §"One-way door"). This pin,
beta.83, is above the floor; `test/docs.test.ts` asserts the floor and keeps the `versionId`
workaround in step with the pin.

`pnpm-workspace.yaml` sets `allowBuilds: { workerd: true }` and `verifyDepsBeforeRun: false`.
pnpm 11 **removed** `onlyBuiltDependencies` (silently ignored) and defaults `strictDepBuilds` to
true, so the old key made a fresh install exit 1.

beta.84 bumps Effect to `^4.0.5`; this repo already runs `4.0.6` and has been exercised on it,
so that breaking change costs nothing here.

## Why beta.83, not beta.84

beta.84 is announced but **not installable**: `alchemy@latest` is still `2.0.0-beta.83`, and every
`@alchemy.run/*` package is only `0.0.0` — a stale Effect-v3 prototype squatting the names. The
release post is served only from the preview host `main.alchemy.run`; the production URL 404s. Full
signal table and the package-split diff: [MIGRATION-beta84.md](./MIGRATION-beta84.md).

> **Trap:** never `pnpm add @alchemy.run/cloudflare` unpinned — `latest` resolves to `0.0.0`, the
> Effect-v3 prototype, and pulls a second Effect into the tree.

```bash
npm view alchemy dist-tags
npm view @alchemy.run/cloudflare versions   # expect a real version, not just 0.0.0
```

## Working with an AI coding agent

[`AGENTS.md`](./AGENTS.md) is the agent entry point, and
[`.agents/skills/alch-run-beta/SKILL.md`](./.agents/skills/alch-run-beta/SKILL.md) is the same
orientation wired as an OpenCode skill. [`CONVENTIONS.md`](./CONVENTIONS.md) is binding. Paste this
to start:

```text
You are working in alch-run-beta — a consumer Alchemy + Cloudflare project pinned to
alchemy@2.0.0-beta.83. Read AGENTS.md, .agents/skills/alch-run-beta/SKILL.md and CONVENTIONS.md
first. Keep changes consistent with the pinned shapes; run `pnpm typecheck`, `pnpm test` and
`actionlint` before proposing a commit; ask before adding a dependency or changing the shape policy.
```

## License

[Apache-2.0](./LICENSE).
