---
name: alch-run-beta
description: Work in the alch-run-beta repository — a consumer Alchemy + Cloudflare Workers project pinned to alchemy 2.0.0-beta.83 (one async Worker over R2 + D1 + KV + Queue + a Durable Object + a daily cron). Use when editing this repo's src/, scripts/, test/, .github/workflows/, or docs, running its gates, or preparing the beta.84 upgrade.
---

# alch-run-beta

A **consumer** project — it uses Alchemy and Cloudflare, it does not provide them.
One async Worker (`src/Api.ts`) over five services, declared in `alchemy.run.ts` and
deployed to the `deep-pass` stage of a real account.

| Route | Services |
| --- | --- |
| `GET /` | route index (JSON) |
| `GET /health` | liveness |
| `GET /stats`, `GET /audit` | **admin-gated** (`Authorization: Bearer $ADMIN_TOKEN`) |
| `GET /photos`, `GET /photos/:key`, `PUT`/`DELETE /photos/:key` | KV / D1 / R2 / Queue |

## The pin, and the upgrade

Pinned to **`alchemy@2.0.0-beta.83`** (`effect@4.0.6`, `@cloudflare/workers-types`). beta.84 is
**not published** — re-check `registry.npmjs.org/-/package/alchemy/dist-tags` and
`…/@alchemy.run%2Fcloudflare/dist-tags` before starting. The upgrade is a six-file import rewrite
(`alchemy/Cloudflare` → `@alchemy.run/cloudflare`), and it is a **one-way door**: the first deploy
on the new pin must go out at **100% traffic** or it fails with `WorkerVersionConfigError`; see
`MIGRATION-beta84.md` and `UPGRADE.md`. Do not "just bump" the pin.

## Shape — `CONVENTIONS.md` is binding

Async-Worker style is the allow-listed shape. Do **not** hand-roll what the platform provides:

- no hand-written binding types (`…Like` interfaces) — `env` is `Cloudflare.InferEnv<typeof bindings>`;
- `Response.json` over `new Response(JSON.stringify(...))`; the one `new Response(object.body, …)`
  streams an R2 object on purpose;
- typed DO RPC (`getByName(...).increment()`), never a `fetch` router on the DO;
- DO read-modify-write inside `ctx.storage.transaction`;
- `fetch`/`scheduled` take `ctx: ExecutionContext`;
- per-message `queue` `ack()`/`retry()` (allow-listed), not a whole-body try/catch.

The policy is enforced by `test/policy.test.ts` in three layers; adding a `src/` declaration
without a justified `ALLOWED_DECLARATIONS` entry fails.

## Gates (run all four)

```sh
./node_modules/.bin/tsc --noEmit          # types (the repo's `pnpm typecheck` runs the same)
./node_modules/.bin/vitest run            # 68 tests / 7 suites, offline
actionlint .github/workflows/*.yml        # workflow lint
pnpm cron-health                          # delivered-vs-configured cron (needs a Cloudflare token)
```

`test/manifest.test.ts` holds a **test-count floor** (currently 68) and the exact suite set —
adding tests means raising `MIN_TESTS` in the same diff; removing is the review gate.

## Credentials

- **Local:** `alchemy profile edit --add Cloudflare` (a profile, not env vars). `ADMIN_TOKEN` is
  **required at plan/deploy** (`Config.Redacted`); it lives in the gitignored `.env`.
- **CI:** env vars only — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_TOKEN` (repo
  secrets). `stacks/github.ts` mints the scoped CI token and writes those secrets; deploy it once
  under an `admin` profile.
- **Never commit** `.env`, `.alchemy/`, or any token. Never rotate secrets or force-push (`main`
  has a `non_fast_forward` + `deletion` ruleset) without being asked.

## Behaviour to preserve

Four fixed defects (`bytes` = UTF-8 length; `PUT`/`POST /photos` → 400; `DELETE` reports affected
rows; an unparseable KV value is a cache miss), plus: audit writes are idempotent
(`ON CONFLICT(id) DO NOTHING`), the consumer has a `deadLetterQueue` (`AuditDeadLetter`), `fetch`
degrades to a named `503`, `/stats` reports `degraded` when one dependency fails, and `Db`/`Photos`
carry `RemovalPolicy.retain()`.

## Tooling

Bun/Node, not npm (`.github/workflows` use pnpm). Invoke repo binaries as
`./node_modules/.bin/<tool>`. `gh` is wrapped by a broken 1Password shell function — run it as
`command gh`.

## Docs map

`README.md` (routes, live state, commands) · `CONVENTIONS.md` (shape policy) · `REVIEW-2026-10-23.md`
(shape audit + the ranked missing layers) · `FAILURES.md` (15 rules) · `MIGRATION-beta84.md` /
`UPGRADE.md` · `CRON-FINDINGS.md`.
