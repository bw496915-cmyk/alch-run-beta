# alch-run-beta

A working Alchemy 2.0 project, pinned to **`alchemy@2.0.0-beta.83`** — deliberately not
`2.0.0-beta.84`, which is announced but not yet published to npm (see
[Why beta.83](#why-beta83-not-beta84)).

One Cloudflare Worker in front of one R2 bucket. It type-checks, and the full local
loop (`alchemy dev` → workerd → real R2 binding) has been exercised end to end.

## Layout

```
.
├── alchemy.run.ts        # composition root: Stack + providers + state + outputs
├── src/
│   ├── Api.ts            # Worker runtime code (bundled as the Worker's main)
│   └── Photos.ts         # one Resource, in its own module
├── tsconfig.json         # strict, no-emit typecheck
├── MIGRATION-beta84.md   # the exact diff this tree needs when beta.84 ships
└── .alchemy/             # local state + dev logs (gitignored)
```

Two deliberate choices, both to keep the beta.84 move small:

- **Every provider import lives in exactly two files** (`alchemy.run.ts`, `src/Photos.ts`).
  beta.84 moves providers into their own packages, so the split is
  `"alchemy/Cloudflare"` → `"@alchemy.run/cloudflare"` on two lines, not a repo-wide rewrite.
- **`src/Api.ts` imports nothing from Alchemy.** Worker code talks to bindings, not to
  providers, so it is untouched by the split.

## Requirements

- Node **24.11.1+** (verified on 26.11.1)
- pnpm

```bash
pnpm install     # already run
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` over `alchemy.run.ts` and `src/` |
| `pnpm dev` | Local loop: bucket + Worker on workerd, HMR at <http://localhost:1337> |
| `pnpm plan` | Diff against the current stage, apply nothing |
| `pnpm deploy` | Plan → confirm → apply |
| `pnpm destroy` | Delete everything in the stage |

Extra CLI flags worth knowing: `--stage <name>`, `--profile <name>`,
`--dry-run` (deploy), `--no-input` (no prompts/TUI, for scripts).

Stages default to `live_${USER}` for `plan`/`deploy` and `dev_${USER}` for `dev`.

## The API

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{ ok, time }` |
| `GET /photos` | Lists up to 100 keys in the bucket |
| `PUT /photos/<key>` | Writes the request body under `<key>` |
| anything else | 404 JSON |

```bash
curl localhost:1337/health
curl -X PUT --data-binary "hi" localhost:1337/photos/hello.txt   # 201
curl localhost:1337/photos                                       # {"count":1,"keys":["hello.txt"],...}
```

## Deploying needs credentials

`plan`, `deploy` and `destroy` talk to the real Cloudflare API. Until an account is
configured they fail — by design — with:

```
error: Provider 'Cloudflare' is not configured in profile 'default'.
       Run `alchemy profile edit --profile default --add Cloudflare`.
```

Two ways to fix that:

1. **Interactive profile (OAuth):** `alchemy profile edit --add Cloudflare`
2. **Env vars (CI):** `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`

`alchemy dev` needs neither: everything runs locally on workerd.

## State

This project uses `Alchemy.localState()` — a state file under `.alchemy/`, nothing to
bootstrap and nothing shared between machines. That is the friendliest setup for
evaluating a beta.

For a shared or CI-visible state store, switch `state:` in `alchemy.run.ts` to
`Cloudflare.state()` (bucket-backed). On beta.84+ the bootstrap command moves to
`alchemy state bootstrap --backend cloudflare`; see `MIGRATION-beta84.md`.

## Verified in this repo

Run on Node 26.11.1 / pnpm 11.28.5:

| Check | Result |
| --- | --- |
| `pnpm install` | 159 packages, exit 0 |
| `pnpm typecheck` | exit 0, `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` |
| `alchemy --version` | `alchemy v2.0.0-beta.83` |
| `alchemy state list` | exit 0 (local backend, empty) |
| `alchemy dev` | plan `2 to create`, bucket + Worker created (local), served `http://localhost:1337` |
| Worker routes | `/health` 200 · `PUT /photos/hello.txt` 201 · `GET /photos` lists it · unknown path 404 · missing key 400 |
| HMR | Worker rebuilt and reloaded on edit in ~69ms |

**Not verified — nothing here has been deployed to Cloudflare.** `plan` and
`deploy --dry-run` both stop at the credentials gate above, which is the expected
boundary without an account.

One caveat on that green typecheck: it covers *this* repo's code, not every corner of
Alchemy's own types. beta.84 ships a fix (#2413) whose whole purpose is making
`alchemy/State` type-check under `exactOptionalPropertyTypes` — a sign that strictness
this high was not universally clean in beta.83. This tree never imports `alchemy/State`
types directly (it calls `Alchemy.localState()`), which is why it comes out clean.

## Pinned versions

| Package | Version |
| --- | --- |
| `alchemy` | `2.0.0-beta.83` (exact) |
| `effect` | `4.0.6` |
| `@effect/platform-node` | `4.0.6` |
| `typescript` | `5.9.3` |
| `@types/node` | `24.19.2` |
| `workerd` (transitive) | `1.20261002.1` |

`pnpm-workspace.yaml` pins `onlyBuiltDependencies: [workerd]` so local emulation works,
and `minimumReleaseAgeExclude` for the two Effect packages pnpm flagged as very fresh.

beta.84 also bumps Effect to `^4.0.5` (#2372). This repo already resolves `4.0.6`, so that
breaking change costs nothing here — and beta.83 has been exercised on 4.0.6 (install,
typecheck, and the live dev loop), so the bump is not a hidden risk either.

## Why beta.83, not beta.84

The [2.0.0-beta.84 release post](https://alchemy.run/blog/2026-10-22-beta-84/) is live,
but as of **2026-10-23** nothing in it can be installed. Four separate checks agree:

| Signal | Result |
| --- | --- |
| `alchemy` on npm | `latest` = `2.0.0-beta.83`, published 2026-10-12 — no beta.84 |
| Split provider packages | only `0.0.0` exists for `@alchemy.run/{aws,cloudflare,domain,gcp,core}` |
| What `@alchemy.run/{aws,cloudflare,core}@0.0.0` is | a **stale 2025-11-03 prototype that depends on Effect v3** (`cloudflare` wants `effect@^3.17`, `aws` wants `effect@^3.18`) — an abandoned prototype squatting the name, not the beta.84 package |
| What `@alchemy.run/{domain,gcp}@0.0.0` is | a 2026-10-21 publish stub: 2 files, 669 / 696 bytes, no code |
| The post's own install route | its command uses `https://pkg.alchemy.run/…/2e7fdc5`; that proxy 404s `{"error":"alchemy@2e7fdc5 not found"}`, and so do `latest` and `2.0.0-beta.84` paths |

The timing is the tell: `@alchemy.run/domain` and `@alchemy.run/gcp` were reserved on
**2026-10-21**, the day before the post, one of them explicitly described as a
"Temporary package placeholder for staged publishing". The publish was staged; the
artifacts never landed.

> **Trap:** never `pnpm add @alchemy.run/cloudflare` without an exact version today. It
> resolves to `0.0.0`, an Effect-v3 prototype from a year earlier, and will pull a second
> copy of Effect into the tree.

What *is* already proven is how the split will be versioned: alchemy's own scoped helper
packages (`@alchemy.run/cloudflare-runtime`, `floci`, `node-utils`,
`frontend-frameworks`) all sit at exactly `2.0.0-beta.83` — lockstep with the core
package. So `@alchemy.run/cloudflare@2.0.0-beta.84` is the expected pin, not a guess.

beta.84 also rewrites imports (`alchemy/Cloudflare` → `@alchemy.run/cloudflare`), so a
project scaffolded against the beta.84 API would not even resolve today. This repo takes
the opposite trade: build on the published version, keep the split a two-line diff.

Check the state of the world before migrating:

```bash
npm view alchemy dist-tags
npm view @alchemy.run/cloudflare versions   # expect a real version, not just 0.0.0
```
