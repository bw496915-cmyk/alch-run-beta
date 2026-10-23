# Migrating this repo to `alchemy@2.0.0-beta.84`

**Status: not runnable yet.** Checked 2026-10-23, five independent signals:

> The release post is served from the **preview host** `main.alchemy.run`, not the production
> domain: `https://alchemy.run/blog/2026-10-22-beta-84/` returns **404**, the blog index and
> RSS feed stop at beta.83, and `https://main.alchemy.run/blog/2026-10-22-beta-84/` returns
> **200**. Any citation of this release should link the `main.` URL or readers will land on a
> 404.

| Signal | Finding |
| --- | --- |
| `alchemy` `dist-tags.latest` | `2.0.0-beta.83`, published 2026-10-12 — no beta.84 |
| `@alchemy.run/{aws,cloudflare,domain,gcp,core}` | only `0.0.0` |
| `@alchemy.run/{aws,cloudflare,core}@0.0.0` | a stale 2025-11-03 prototype depending on **Effect v3** (`cloudflare`: `effect@^3.17`, `aws`: `effect@^3.18`) — NOT the beta.84 package |
| `@alchemy.run/{domain,gcp}@0.0.0` | 2026-10-21 publish stubs: 2 files, 669 / 696 bytes |
| The post's install route (`https://pkg.alchemy.run/<pkg>/2e7fdc5`) | HTTP 404 `{"error":"alchemy@2e7fdc5 not found"}`; `latest` and `2.0.0-beta.84` paths 404 too |

`@alchemy.run/domain` and `@alchemy.run/gcp` were reserved on 2026-10-21 — the day before
the post — one of them described as a "Temporary package placeholder for staged
publishing". The release was staged; the artifacts did not land. The RSS feed still ends
at beta.83 as well.

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

### One-way door: Durable Object deploy flow

**This repo is already through it.** Beta.83 does *not* use the legacy `migrations` flow for
account-level scripts: it re-uploads Cloudflare's declarative `exports` map on every deploy.
Verified on the live script, not inferred from the source:

```
GET /accounts/<acct>/workers/scripts/<name>/versions/<id>
  → exports: {"Counter":{"type":"durable-object","storage":"sqlite"}}
```

The same map is present on both live versions (including the cron-only redeploy), and the
`new_sqlite_classes: ["Counter"]` line in the *first* deploy log is the older bookkeeping, not
the deployment mechanism. Cloudflare does not let a Worker return to the `migrations` flow once
it has deployed with `exports`, so the one-way door applies **today**, not at beta.84.

Practical rule: do not roll this stage back to an Alchemy release that predates the `exports`
flow — its first redeploy would fail. Rolling back *within* the exports era (beta.83 → beta.83)
is fine.

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
`workerName`, not `name`:

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

## About the post's `pkg.alchemy.run` install command

The release post installs prerelease builds by URL rather than by version
(`bun add https://pkg.alchemy.run/alchemy/2e7fdc5 …`). Today that route is not a way
around the missing npm publish either — every path tried 404s:

```bash
curl -s https://pkg.alchemy.run/alchemy/2e7fdc5          # {"error":"alchemy@2e7fdc5 not found"}
curl -s -o /dev/null -w '%{http_code}\n' https://pkg.alchemy.run/alchemy/latest   # 404
```

If you find the proxy serving a commit sha later but npm still lags, that URL form is the
sanctioned install path — swap it into `package.json` as an exact URL dependency, then
re-run `pnpm typecheck` before trusting it.
