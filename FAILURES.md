# Failures — 2026-10-23

What went wrong on this project's first day, split into what the environment did to us and
what we did to ourselves, so the next person does not pay for it twice. Companion to
[REVIEW-2026-10-23.md](./REVIEW-2026-10-23.md) §2, which logged each item as it happened;
this file carries the detail and points at the file that now prevents a repeat.

Nothing here is a defect in `src/` or `alchemy.run.ts`: every code path that was exercised
did what it was written to do. Two failures (the Durable Object `1101` and the silent cron)
are platform behaviour we do not yet have a root cause for, and both are recorded as open
rather than explained away.

## Environment failures

Not caused by this repo. Recorded with the text that was actually produced; where only the
error code survived, that is said explicitly instead of reconstructing a transcript.

| # | Failure | Symptom (verbatim) | Cause | Status / workaround | Baked into the repo? |
| --- | --- | --- | --- | --- | --- |
| 1 | `npm` unusable | `EPERM` operating on `~/.npm` — the retained record is the code plus the offending directory, not a full npm transcript | `~/.npm` contains root-owned files, so the invoking user can neither write nor repair the cache | never fixed; installs ran through `pnpm` and registry facts were read with direct `curl` | partly — `package.json` pins `"packageManager": "pnpm@11.28.5"`, so no project command routes through npm; `~/.npm` itself is untouched |
| 2 | Alchemy CLI `EPERM` | `EPERM: operation not permitted, mkdir` on `$HOME/.alchemy/profiles` (Node's message for the denied create) | the file sandbox in force allowed writes only inside the workspace, and `HOME` pointed outside it, so the CLI could not create its own profile directory | ran every Alchemy command with `HOME=$PWD/.home`, a workspace-local home | partly — `.gitignore` lists `.home/` so a local home can be used without polluting the tree; no script exports `HOME`, the caller does |
| 3 | pnpm refuses to purge `node_modules` | `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` — "Aborted removal of modules directory due to no TTY" (code and message are pnpm's own for this condition) | pnpm wanted to delete and rebuild `node_modules` and will not do that without a TTY to confirm on; the session had none | `CI=true` on the invocation, plus `verifyDepsBeforeRun: false` | yes — `pnpm-workspace.yaml`, `verifyDepsBeforeRun: false` |
| 4 | pnpm blocks `workerd`'s install script | `ERR_PNPM_IGNORED_BUILDS` — "Ignored build scripts: workerd" | pnpm runs no dependency postinstall scripts by default, and `workerd` needs its postinstall to materialise the binary, so the local emulator cannot start | `onlyBuiltDependencies: [workerd]`, then `pnpm rebuild workerd` | yes — `pnpm-workspace.yaml`, `onlyBuiltDependencies: [workerd]` |
| 5 | macOS keychain reads fail | exit status `128` from `security … -w`, with no secret on stdout | the keychain entry's ACL requires an interactive "Allow"; a non-interactive process can never satisfy it, so the read fails, and it fails quietly rather than erroring usefully | stopped reading the keychain; the account token was supplied out of band as `CLOUDFLARE_API_TOKEN` | yes, as a hard requirement — `scripts/alch.sh` exits unless `CLOUDFLARE_API_TOKEN` is set, and prints the exact scope list to create |
| 6 | `/user/tokens/verify` rejects a working token | `Invalid API Token` from `GET /client/v4/user/tokens/verify` | that endpoint verifies user-scoped tokens; an account-scoped token can be entirely valid and still fail it. The same token returned 200 on the workers / d1 / r2 / kv / queues reads the stack actually needs | treat `verify` as advisory only; probe the endpoints the stack uses instead of trusting a verifier | yes — README "Credentials" ("the printed scope list is not the full picture, so probe rather than infer") and the scope list in `scripts/alch.sh` |
| 7 | Durable Object call returns a platform error | `errorcode: 1101` — `internal error; reference = …` (platform error page, no Worker stack, the Worker's own log capture was empty: `logs: []`) | **not established.** The same call path worked before and after, and the counter kept its value (`3` → `4`), so namespace binding and DO storage are intact | **open.** One occurrence, self-healed on retry; tracked as its own investigation (REVIEW §3 track B: plain-class DO shape vs the documented Effect-native class) | no — recorded as an open issue in README "Live deployment" and REVIEW §1/§2 |
| 8 | Cron trigger attached, never fired | no error at all — the `* * * * *` trigger appears in the `schedules` API response, `wrangler tail` shows zero scheduled invocations, `scheduled()` wrote zero rows (`audit_events` has no `cron.fire` row, and the DO's `cronFires` never advanced) | **not established.** Leading hypothesis (REVIEW §1): the `crons` *prop* on an async Worker is not the documented declaration — the docs show `Cloudflare.Workers.cron(…)` + `CronEventSourceLive`, Effect-native | **open.** Tracked as REVIEW §3 track A (own `cron-probe` stage; restore the committed daily cron last) | no — the repo still declares `crons: [ … ]`; the open status is recorded in README "Live deployment" |
| 9 | `wrangler tail` prints nothing through a pipe | `wrangler tail … \| grep <pattern>` produced no output at all, including for requests known to have reached the Worker | `tail` streams to stdout without flushing per line when stdout is a pipe, and a line-buffering filter downstream therefore sees nothing — the stream never ends, so nothing arrives | run the stream into a file for a bounded window and read the file afterwards | no — a working practice, recorded here and in REVIEW §2 |

Two of the nine are still open, and both matter more than the rest: **7** (a `1101` with no
stack and no cause) and **8** (a trigger that is attached and yet provably inert). Neither is
a green light, and neither is closed by the other working.

## Authoring mistakes

Ours, all correctable, three of them self-inflicted damage rather than wasted commands.

| # | Mistake | What it cost | Lesson | Where the lesson lives |
| --- | --- | --- | --- | --- |
| 1 | Ran `alchemy state list --stage <name>` | one failed command, `Unrecognized flag` — that subcommand has no `--stage` | flags are per-subcommand; read `--help` for the subcommand in hand instead of assuming a global flag set is shared | README "Commands" now says so outright — flags are per-subcommand, and the "Flags worth knowing" list does not travel |
| 2 | `PUT /photos/` returned `404` where `400` was intended | the trailing slash was stripped after route matching, so an empty key fell through to the `/photos/<key>` branch and missed everything; caught and fixed in the same pass | normalise the path (strip trailing slashes, fall back to `/`) **before** route matching and key extraction, then assert the empty-key case explicitly | `src/Api.ts` — `path` normalisation at the top of `fetch()`, plus explicit "missing key in path" `400` branches for `POST /photos` and for an empty key under `/photos/` |
| 3 | Commit message mangled by backticks inside `git commit -m "…"` | the shell substituted the backticked text, the message lost a clause, and it had to be amended | write the message to a file and use `git commit -F <file>`; treat backticks and `$` in a `-m` string as shell, not text | here, as a process rule; commit messages on this repo are written to a file and passed with `-F` |
| 4 | Deleted a copied credential directory (`.home`) that held the only live session | the deploy session died mid-run: revision 2 (DO / queue / cron) could not be deployed in that session, and the live verification stalled until a token was supplied separately | wrangler **refresh tokens rotate, single-use** — refreshing inside a copied config directory spends the original's token, so the copy *becomes* the only session. Never delete a credential copy until a session has been re-issued elsewhere (a real API token, or a separate Alchemy profile) | README "Credentials" ("Lesson learned the hard way…") and the header comment in `scripts/alch.sh` |
| 5 | Concluded from `wrangler whoami` that the R2 scope was missing | nothing shipped wrong, but acting on it would have dropped R2 from the stack — a weaker demo over two services instead of three | a printed scope list is not the capability set. Probe with a throwaway resource (create a bucket, then delete the probe) before concluding a permission is absent | README "Credentials" ("the printed scope list is not the full picture, so probe rather than infer") |

## Rules this project now follows

1. Probe a capability with a throwaway resource; never trust a printed scope list or a
   token-verify endpoint as authority.
2. Never delete a credential copy until a live session has been re-issued somewhere else —
   and prefer a real API token over a single-use, rotating OAuth session.
3. Write commit messages to a file and commit with `-F`; treat backticks and `$` as shell.
4. Verify the **effect**, not the attachment: a cron is proven by an invocation, a consumer
   by a row in D1 — not by a config field or an API response that lists it.
5. Read `--help` for the subcommand in hand; flags are not shared between subcommands.
6. Normalise the path before matching it, and test the empty-key and trailing-slash cases.
7. Give long-running stream commands (tail, watch, logs) a file as their sink; a piped line
   filter on an unbuffered stream reads as "nothing happened".
8. When a failure is undocumented and transient, record its exact reference and re-test
   before diagnosing — and leave the question open while it is open (`1101`).
