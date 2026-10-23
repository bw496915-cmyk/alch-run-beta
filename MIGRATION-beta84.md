# Migrating this repo to `alchemy@2.0.0-beta.84`

> **Provenance note (added 2026-10-23, after reading the source changelog).** This filename is
> historical and now slightly wrong. It documents *two* things with different origins: the
> **Durable Object `exports` door**, which opened in **beta.82 (#2135)** — two releases before
> this file's name — and the **package split**, which is beta.84. The pre-correction version of
> this file attributed the door to beta.84, which is exactly the provenance drift that produced
> the wrong pin floor. Read §"One-way door" for the corrected version; the filename is kept so
> existing references (README, REVIEW) still resolve.

**Status: not runnable yet.** Checked 2026-10-23, five independent signals:

> The release post is served from the **preview host** `main.alchemy.run`, not the production
> domain: `https://alchemy.run/blog/2026-10-22-beta-84/` returns **404**, the production blog
> index stops at beta.83, and `https://main.alchemy.run/blog/2026-10-22-beta-84/` returns
> **200**. The production **RSS feed disagrees**: `alchemy.run/blog/rss.xml` already lists the
> beta.84 item, carries the full post, and links it to that 404 URL — so the release is
> discoverable through the feed before its page exists. Any citation of this release should
> link the `main.` URL or readers will land on a 404.

| Signal | Finding |
| --- | --- |
| `alchemy` `dist-tags.latest` | `2.0.0-beta.83`, published 2026-10-12 — no beta.84 |
| `@alchemy.run/{aws,cloudflare,domain,gcp,core}` | only `0.0.0` |
| `@alchemy.run/{aws,cloudflare,core}@0.0.0` | a stale 2025-11-03 prototype depending on **Effect v3** (`cloudflare`: `effect@^3.17`, `aws`: `effect@^3.18`) — NOT the beta.84 package |
| `@alchemy.run/{domain,gcp}@0.0.0` | 2026-10-21 publish stubs: 2 files, 669 / 696 bytes |
| The post's install route (`https://pkg.alchemy.run/<pkg>/2e7fdc5`) | HTTP 404 `{"error":"alchemy@2e7fdc5 not found"}`; `latest` and `2.0.0-beta.84` paths 404 too |

`@alchemy.run/domain` and `@alchemy.run/gcp` were reserved on 2026-10-21 — the day before
the post — one of them described as a "Temporary package placeholder for staged
publishing". The release was staged; the artifacts did not land. The production blog index
still ends at beta.83, but the production RSS feed already carries the beta.84 item (see the
note above) — so "not published" is true of npm and of the page, not of the feed.

> **Do not `pnpm add @alchemy.run/cloudflare` without an exact version.** `latest` is
> `0.0.0`, a year-old Effect-v3 prototype; installing it would pull a second, incompatible
> Effect into `node_modules` and make the failure look like a beta.84 bug.

Confirm before starting:

```bash
npm view alchemy dist-tags
npm view @alchemy.run/cloudflare versions
```

You want a real version on **both**. If only `alchemy` moved, the import rewrite cannot
resolve, and if only the scoped packages are there, the core is still beta.83.

---

## The entire diff for this tree: 6 files

Five of them change one import line each; `src/Api.ts` changes not at all.

### 1. `package.json`

```diff
   "dependencies": {
-    "alchemy": "2.0.0-beta.83",
+    "alchemy": "2.0.0-beta.84",
+    "@alchemy.run/cloudflare": "2.0.0-beta.84",
     "@effect/platform-node": "4.0.6",
     "effect": "4.0.6"
   },
```

The scoped provider package version should match `alchemy` exactly. That is now evidence,
not a guess: alchemy's existing scoped helpers (`@alchemy.run/cloudflare-runtime`,
`floci`, `node-utils`, `frontend-frameworks`) all sit at `2.0.0-beta.83`, lockstep with
the core package. Still read the real number off the registry at migration time.

Also add the package *before* anything else: the CLI discovers a provider's auth, state
store and `alchemy provider` commands through a new **Contributions module**, keyed off
your project's dependencies. Without `@alchemy.run/cloudflare` in `package.json`, even
`--backend cloudflare` and Cloudflare profile auth are unavailable.

### 2. `alchemy.run.ts`

```diff
 import * as Alchemy from "alchemy";
-import * as Cloudflare from "alchemy/Cloudflare";
+import * as Cloudflare from "@alchemy.run/cloudflare";
 import * as Effect from "effect/Effect";
```

`import * as Alchemy from "alchemy"` stays: core (`Stack`, `localState`, `Output`, …)
remains in the `alchemy` package.

### 3. `src/Photos.ts`, `src/Db.ts`, `src/Cache.ts`, `src/QueueEvents.ts`

The same one-line swap in each of the four resource modules:

```diff
-import * as Cloudflare from "alchemy/Cloudflare";
+import * as Cloudflare from "@alchemy.run/cloudflare";
```

`Cloudflare.R2.Bucket`, `Cloudflare.D1.Database`, `Cloudflare.KV.Namespace` and
`Cloudflare.Queues.Queue` all arrive through that one import, so the split costs one line
per module that declares a resource.

### 4. `src/Api.ts` — no change

The Worker imports nothing from Alchemy. It talks to `env.PHOTOS`, `env.DB`, `env.CACHE`,
`env.COUNTER` and `env.EVENTS`, which are bindings, not provider imports. It also exports
the plain `Counter` Durable Object class, which is bound from `alchemy.run.ts`, so the
package split does not reach into it either.

### 5. `migrations/*.sql` — no change

Plain SQL. The `migrations` prop on `Cloudflare.D1.Database` is a path, and beta.84 does not
touch it.

### That is all

```bash
# should print exactly five lines: alchemy.run.ts, src/{Db,Cache,Photos,QueueEvents}.ts
rg -n 'from "alchemy/' alchemy.run.ts src/
```

---

## The release's breaking changes, and whether each one applies here

| beta.84 breaking change | Applies here? | Why |
| --- | --- | --- |
| Providers moved into `@alchemy.run/*` packages | **Yes** | 5 import lines across 5 files (the `package.json` entry is the sixth file); every provider import is already concentrated here |
| State commands moved under `alchemy state` | No, not yet | `alchemy state` already exists on beta.83 (`list`/`read`/`delete`, `--backend`); beta.84 adds a `bootstrap` subcommand. Neither is wired here — see the version table below |
| **Effect bumped to `^4.0.5`** (#2372) | No | `effect@4.0.6` already satisfies it, and beta.83 has been exercised on it |
| `AWS.Lambda.isBindingHost` removed; AWS hosts now get IAM grants | No | No AWS resources in this stack |
| Distilled error classes are no longer Effect Schemas | No | No distilled SDK error handling in this code |
| Prisma/Neon env values use the runtime wire format (`{"_tag":"Redacted",…}`) | No | No Prisma or Neon providers |
| AWS framework sites default to Web Functions | No | No AWS |

### State store commands: what exists *today* on beta.83

Easy to get backwards, so here is the pinned reality (`alchemy --help` output, not docs):

| Command | beta.83 (this repo) | beta.84 |
| --- | --- | --- |
| `alchemy provider cloudflare bootstrap` | **exists** — the only way to bootstrap a Cloudflare state store today | removed; prints the replacement and exits 1 |
| `alchemy state bootstrap --backend cloudflare` | **does not exist** (`alchemy state --help` lists only `list`, `read`, `delete`) | the new form |
| `Cloudflare.state()` | takes **no arguments** (`state: () => Layer<State, …>`) | gains `{ name }` / `{ workerName }` named stores |

So on beta.83, moving this repo from `Alchemy.localState()` to a shared state store means
`Cloudflare.state()` **plus** a one-time `alchemy provider cloudflare bootstrap`. beta.84 then
rewrites that one command. Nothing here wires either, which is why the upgrade is inert — but
do not "fix" a beta.83 project by writing the beta.84 form into it; it fails as an unknown
command.

### One-way door: Durable Object deploy flow — **opened in beta.82 (#2135)**

**This repo is already through it, and it closed before our pin.** The upstream changelog files
the change under v2.0.0-beta.82: *"Deploy Durable Objects with declarative exports (#2135)"*. So
beta.83 does *not* use the legacy `migrations` flow for account-level scripts — it re-uploads
Cloudflare's declarative `exports` map on every deploy. Verified on the live script, not
inferred:

```
GET /accounts/<acct>/workers/services/<name>/environments/production
  → script.exports: {"Counter":{"type":"durable-object","storage":"sqlite"}}
```

The same map is present on both live versions (including the cron-only redeploy), and the
`new_sqlite_classes: ["Counter"]` line in the *first* deploy log is the older bookkeeping, not
the deployment mechanism. Cloudflare does not let a Worker return to the `migrations` flow once
it has deployed with `exports`.

**The real pin floor is therefore `alchemy@2.0.0-beta.82`, not beta.84** — anywhere the stack
deploys (laptops, CI, preview jobs), and it must be in place *before* the next deploy. Rolling
back to a pre-beta.82 release would fail on its first redeploy; rolling back within the exports
era (beta.83 → beta.83) is fine.

Two operational rules that come with it, the second of which the beta.84 notes describe against
*its* upgrade path but which applies to any export-era upgrade:

- **Removing a Durable Object binding no longer deletes its namespace** while the class is still
  exported. To delete the namespace, remove the class from the code (our `destroy` removes the
  whole Worker, which does delete it — deleting only the binding would not).
- **The first deploy after an upgrade must go out at 100% traffic.** Under gradual deployment,
  remove `version.traffic` for that one deploy; otherwise it fails with
  `WorkerVersionConfigError`. Previews still use `migrations`, so a preview Worker is not a
  probe for this behaviour. This is a property of the export-era deploy flow, not of one
  release: `REVIEW-2026-10-23.md` rule 15 makes it a standing rule for every future pin bump.

### Also available on beta.83 and currently unused

These exist in the pinned CLI and cost nothing to adopt (wired into `package.json` scripts):

```bash
pnpm check-env        # alchemy provider check-env — CI preflight, exits 1 if creds/env missing
pnpm drift            # alchemy drift — detects resources changed/deleted outside alchemy
pnpm logs --tail      # alchemy logs — past entries by default, live with --tail
```

### Relocations *within* packages at beta.84

The split also moved a few exports between modules. None of them appear in this tree, but
they are listed so the next reader does not have to re-derive them:

| beta.83 | beta.84 |
| --- | --- |
| `ACME.Cloudflare.ZoneSolver` | `Cloudflare.ACME.ZoneSolver` |
| `Stripe.Cloudflare.ConsumeEventsLive` | `Stripe.ConsumeEventsLive` |
| `GitHub.Cloudflare.RepositoryEventSourceLive` | `GitHub.RepositoryEventSourceLive` |
| `alchemy/Server` → `ServerHost` | `alchemy/Runtime/Process` → `ServerHost` |
| `alchemy/SQL/LibSQL` → `LibSQL` | `@alchemy.run/sql/SQLite` → `LibSQL` |

`Alchemy.localState()` and `inMemoryState()` are unaffected: the post states that
`alchemy` keeps the engine, the CLI, and the local and in-memory state stores. Only cloud
state stores (`Cloudflare.state()`, `AWS.state()`, the new `GCP.state()`) move into their
provider packages — and beta.84 grows a named-store option. On beta.83 `Cloudflare.state()`
takes **no arguments**; the named form is beta.84-era, and the live docs name the field
`workerName`, not `name` (the post itself writes `Cloudflare.state({ name: "team-a" })` and
`AWS.state({ name })`, so post and docs disagree — confirm against the shipped `.d.ts` at
migration time):

```ts
state: Cloudflare.state({ workerName: "alchemy-state-store-team-a" }),
```

```bash
alchemy state bootstrap --backend cloudflare
```

Optional at beta.84, not needed for this stack: `Cloudflare.Hyperdrive.lookup`,
`localUploads` on R2 buckets, Worker website builds receiving `env`.

## How to verify the migration

```bash
pnpm install
pnpm typecheck          # expect exit 0, no new errors
git diff --stat         # expect exactly 6 changed files (+ pnpm-lock.yaml)
pnpm dev                # local loop: 1337, same routes, D1+KV+R2 emulated
```

Then, with a real account configured:

```bash
pnpm plan               # expect "Plan: 0 to create" against an existing stage,
                        # or 2 to create on a fresh one
```

## If it breaks

- **`Cannot find package '@alchemy.run/cloudflare'`** — the scoped package is not
  published yet; stay on beta.83.
- **Install succeeds but typecheck drowns in Effect errors** — you resolved the `0.0.0`
  prototype instead of a beta.84 pin. Confirm with:

  ```bash
  node -e 'console.log(require("./node_modules/@alchemy.run/cloudflare/package.json").version)'
  pnpm why effect   # a second Effect copy means the prototype came in
  ```

- **`providers()` / `state()` not exported** — beta.84 may split those helpers
  differently. Inspect the real export map rather than guessing:

  ```bash
  node -e 'const p=require("./node_modules/@alchemy.run/cloudflare/package.json");console.log(Object.keys(p.exports))'
  ```

- **Local state survives the upgrade** — `.alchemy/` and stage names (`live_<user>`,
  `dev_<user>`) are unchanged, so `pnpm dev` should not need a clean slate.
- No rollback complexity: `git checkout -- . && pnpm install` returns to beta.83,
  because nothing in this repo depends on beta.84-only features.

## About the post's install command

The post exists in **two copies that disagree**, and neither installs beta.84 today.

The copy in the production RSS feed installs prerelease builds by URL rather than by
version (`bun add https://pkg.alchemy.run/alchemy/2e7fdc5 …`). That route is not a way
around the missing npm publish either — every path tried 404s:

```bash
curl -s https://pkg.alchemy.run/alchemy/2e7fdc5          # {"error":"alchemy@2e7fdc5 not found"}
curl -s -o /dev/null -w '%{http_code}\n' https://pkg.alchemy.run/alchemy/latest   # 404
```

The copy served from `main.alchemy.run` instead says
`bun add alchemy@latest @alchemy.run/cloudflare@latest @alchemy.run/aws@latest`. That is
worse than the URL form: `latest` is `2.0.0-beta.83` for `alchemy` and `0.0.0` for
`@alchemy.run/cloudflare`, so it installs the beta.83 core beside the Effect-v3 prototype —
exactly the mixed tree the trap above warns about. Pin `2.0.0-beta.84` explicitly on both,
or use the URL form once the proxy serves it.

If you find the proxy serving a commit sha later but npm still lags, that URL form is the
sanctioned install path — swap it into `package.json` as an exact URL dependency, then
re-run `pnpm typecheck` before trusting it.

## Post and docs errata (upstream inconsistencies)

Recorded so our citations do not propagate them. All are upstream — not ours to fix here.

- **The current docs disagree with each other about the import.** alchemy's repo `README` imports
  `@alchemy.run/cloudflare` (the split), while the `getting-started` page still imports
  `alchemy/Cloudflare` (the pre-split path). Read against this tree that is corroboration, not a
  surprise: the split is current and the docs lag in places. The same `getting-started` page also
  shows `state: Cloudflare.state()` **with no arguments** — matching this repo's claim that the
  named `{ workerName }` form is beta.84-era, not beta.83 (see §"State store commands").
- **Service counts disagree.** The binding-coverage paragraphs say "~2,850 AWS bindings
  across **205 services**" and "192 GCP bindings across **57 services**"; the distilled
  import table says AWS has **438 services** and GCP **318**. If the two sets measure
  different things (SDK services vs. services with bindings), the post should say so — as
  written the same word carries two values.
- **The perf ranges are rounded past their own data.** "5–100× less overhead per call"
  against GCP `storage.getBuckets` 674 → 6.2 µs (~109×); "3–22× less memory" against
  Cloudflare 76 MB → 3.2 MB (~24×). Widen the range or drop the caps.
