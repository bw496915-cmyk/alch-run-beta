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

This repo is **Effect-native**: `Cloudflare.Worker<Api>()("Api", { main: import.meta.url }, …)` with
bindings as `yield*`ed services, the queue consumer and the cron as event sources, and
`HttpServerResponse` for every reply. Do **not** hand-roll what the platform provides:

- no hand-written binding types — there is no `env` to type, because a binding is
  `yield* Cloudflare.R2.ReadWriteBucket(Photos)` and hands back the real client;
- `HttpServerResponse.json` over `new Response(JSON.stringify(...))`;
- typed DO RPC (`counters.getByName("global").increment()`), never a `fetch` router on the DO;
- DO read-modify-write inside `storage.transaction`;
- the queue consumer and the cron go through `consumeQueueMessages` / `Workers.cron` —
  `Platform.Main` carries `fetch` only, so they cannot be default-export handlers.

The async-Worker shapes stay **allow-listed** (`CONVENTIONS.md`): they are the canonical other
example, so reverting is not a violation — but nothing here uses them. The policy is enforced by
`test/policy.test.ts`.

## Gates (run all four)

```sh
./node_modules/.bin/tsc --noEmit          # types (the repo's `pnpm typecheck` runs the same)
./node_modules/.bin/vitest run            # 74 tests / 8 suites, offline
actionlint .github/workflows/*.yml        # workflow lint
pnpm cron-health                          # delivered-vs-configured cron (needs a Cloudflare token)
```

A fifth, `pnpm test:e2e` (`e2e/stack.test.ts`, `vitest.e2e.config.ts`), deploys a `test_$USER` stage
and destroys it — it needs an account, so it is not part of the offline gate. CI runs it in
`.github/workflows/e2e.yml` on an isolated `test_<pr>` stage, the one workflow that applies.

`test/manifest.test.ts` holds a **test-count floor** (currently 74) and the exact suite set —
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

`README.md` (routes, live state, commands) · `CONVENTIONS.md` (shape policy) · `AUDIT-2026-10-23.md`
(ground truth + attribution) · `REVIEW-2026-10-23.md` (shape audit, incidents, 15 rules) ·
`MIGRATION-beta84.md` / `UPGRADE.md` · `CRON-FINDINGS.md`.
