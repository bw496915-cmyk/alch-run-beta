# AGENTS.md

Orientation for AI coding agents working in **alch-run-beta** — a *consumer* Alchemy + Cloudflare
project (it uses Alchemy; it does not provide it), pinned to **`alchemy@2.0.0-beta.83`**.

Read, in this order:

1. [`.agents/skills/alch-run-beta/SKILL.md`](./.agents/skills/alch-run-beta/SKILL.md) — the repo at a
   glance: routes, the pin, the gates, credentials, behaviour to preserve.
2. [`CONVENTIONS.md`](./CONVENTIONS.md) — **binding**. The allow-list (async-Worker shapes), the
   deny-list (hand-rolls and their canonical replacements), and the three policy gates.
3. [`README.md`](./README.md) — commands, live state, testing, CI.
4. [`REVIEW-2026-10-23.md`](./REVIEW-2026-10-23.md) (audit, incidents, the 15 rules) and
   [`AUDIT-2026-10-23.md`](./AUDIT-2026-10-23.md) (ground truth + attribution) — why the tree looks
   the way it does.
5. [`UPGRADE.md`](./UPGRADE.md) / [`MIGRATION-beta84.md`](./MIGRATION-beta84.md) — before touching
   the pin. It is a **one-way door** at beta.82+ and the first deploy must go out at 100% traffic.

## Gates — run before proposing a commit

```sh
./node_modules/.bin/tsc --noEmit     # pnpm typecheck
./node_modules/.bin/vitest run       # pnpm test  (74 tests / 8 suites, offline)
actionlint .github/workflows/*.yml
```

`test/manifest.test.ts` keeps the suite set exact and a test-count floor (74): adding a suite or
tests is a visible edit there.

A fifth, `pnpm test:e2e` (`e2e/stack.test.ts`, `vitest.e2e.config.ts`), deploys a `test_$USER` stage,
drives the live Worker, and destroys it. It needs an account (`CLOUDFLARE_API_TOKEN` + `ADMIN_TOKEN`)
and is deliberately outside `test/` so the offline gate stays offline.

## Ground rules

- Use the pinned framework's documented shapes; a hand-rolled substitute is denied —
  `CONVENTIONS.md` is the policy, `test/policy.test.ts` enforces it.
- `pnpm` here, not npm/yarn/npx. Run repo binaries as `./node_modules/.bin/<tool>`.
- Never commit `.env`, `.alchemy/`, or a token; never force-push — `main` is protected
  (`deletion` + `non_fast_forward`).
- Ask before adding a dependency or changing the shape policy.
