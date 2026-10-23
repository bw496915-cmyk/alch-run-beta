# Upgrading this repo

**The next version is a structural change, not a bump.** As of **2026-10-23** the split is
merged upstream but unpublished:

| Signal | Value |
| --- | --- |
| Our pin | `alchemy@2.0.0-beta.83` (installed and pinned) |
| npm `latest` | `2.0.0-beta.83` — no `2.0.0-beta.84` exists |
| `main` vs our tag | **126 commits ahead** |
| `packages/` on `main` | the split, complete: `alchemy` (core) plus `aws`, `cloudflare`, `gcp`, `domain`, `sql`, `redis`, `docker`, `kubernetes`, `fly`, `railway`, `hetzner`, `neon`, `planetscale`, `prisma`, `turso`, `stripe`, `github`, `git`, `acme`, `axiom`, `doppler`, `infisical`, `better-auth`, and helpers (`cloudflare-runtime`, `node-utils`, `frontend-frameworks`, `pkg`) |

So "let's just bump the pin" is the failure mode this file exists to prevent: the next release
adopts ~20 new packages and moves every provider out of `alchemy/*`, and the repo's import layout
has to move with it (`alchemy/Cloudflare` → `@alchemy.run/cloudflare`).

## Do this instead

1. Read `MIGRATION-beta84.md`. Its provenance note explains why the Durable Object `exports`
   door is **beta.82 (#2135)**, not beta.84 — the real pin floor is `≥ beta.82`, already met.
2. Before the first deploy on the new pin: every machine and CI job that deploys must be upgraded
   together, and that deploy must go out at **100% traffic** (no `version.traffic`), or it fails
   with `WorkerVersionConfigError`.
3. Expect the import rewrite to be the whole diff: `MIGRATION-beta84.md` enumerates the six files.
   `src/Api.ts` needs nothing — it imports no provider.
4. Re-check the workarounds with expiry conditions in `CONVENTIONS.md`; at minimum
   [#2235](https://github.com/alchemy-run/alchemy/issues/2235) (`versionId` / `deploymentId`
   outputs) is closed upstream and can be reverted.

## Verify, don't assume

```bash
npm view alchemy dist-tags                     # a real beta.84+ before starting
npm view @alchemy.run/cloudflare versions       # …and a real version on the scoped package
node scripts/cron-health.ts                     # the schedule still delivers what we configured
```
