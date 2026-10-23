# Goals

Where this repo goes next, each with its acceptance test. Status after PR #1 merged the
Effect-native migration (`ad99c8d`).

| # | Goal | Acceptance | Status |
| --- | --- | --- | --- |
| **G1** | **Remove the route-chain hand-roll.** `CONVENTIONS.md` deny-list #9: the `if (path === …)` chain in `src/Api.ts` should become `HttpRouter` / `HttpApi` — the docs' instrument (`/cloudflare/apis/effect-http-api`). It is the last hand-roll the deny-list names. | `tsc --noEmit` 0 errors · `pnpm test` 42 pass · `pnpm test:dev` passes · every route, status, header and body unchanged (the dev suite and the live `e2e` are the proof, not `tsc`) | in progress |
| **G2** | **Switch on the PR-preview workflow.** `.github/workflows/deploy.yml` drives the Alchemy root action: a PR deploys `staging-<pr>`, `main` deploys `prod`, a closed PR destroys its preview. The action deploys and destroys in *different* runs, so it needs a remote state store — with `localState()` the destroy sees nothing and leaks. | `Cloudflare.state()` + a one-time `alchemy provider cloudflare bootstrap`; `Secrets Store Write` on the CI token; then the triggers uncomment and a PR deploys / a close destroys with nothing left in the account | **blocked on a human** (the bootstrap needs an admin credential) |
| **G3** | **Keep the docs falsifiable.** No stale claim, no assertion presented as fact without an artifact behind it. | a fresh-eyes audit finds no claim the merged code contradicts | in progress |
| **G4** | **Accept the `deep-pass` DLQ rename.** The event-source consumer needs a literal queue name (`MessagesProps.deadLetterQueue` is a `string`), so the DLQ becomes `auditdeadletter-deep-pass` instead of the generated `alchrunbeta-auditdeadletter-deep-pass-…`. | the next `deep-pass` deploy renames it; queues are not retained, so nothing leaks | known, deliberate |

## Standing rules for whoever picks these up

- `CONVENTIONS.md` is binding; `test/policy.test.ts` enforces it.
- `main` is expected green: `tsc --noEmit`, `pnpm test`, `pnpm test:dev`, `pnpm test:e2e`, `actionlint .github/workflows/*.yml`.
- Parallel agents get **disjoint file lists**. This repo already lost a commit to two agents sharing a branch (`REVIEW-2026-10-23.md` rule 10).
- A claim is not evidence. Verify the **effect** — a deploy log, an API record, a run — not the attachment: a green `tsc` and a clean plan both said "fine" while a deploy was failing 10.9 s in.
- New dev tooling: read the pinned source under `node_modules/<pkg>/src`, not the docs. The docs lag it, and four "impossibilities" in this repo's own history turned out to be stale that way.
