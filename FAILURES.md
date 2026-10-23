# Failures — 2026-10-23

What broke on this project's first day, split into what the environment did and what we did.
Each row ends with the file that now prevents a repeat. Two failures are unanswered and stay
that way here: the Durable Object `1101`, and the cron whose "never fires" verdict turned out to
be our own measurement window.

## One class, four instances

Four of the failures recorded in this project — two in the table below, one in the review, one in
the rules — share the same mistake: **a silent failure read as success.**

| Instance | Where it is recorded | What was read as success |
| --- | --- | --- |
| The cron window | row 8 | ten minutes of silence, reported as "never fires" |
| The no-op deploy | [REVIEW-2026-10-23.md](./REVIEW-2026-10-23.md) §7 | `Done: 0 succeeded`, read as "the fix shipped" |
| The silent `curl -o` | row 10 | a zero exit status, read as a fetched file |
| The `/tmp` backup | rule 11's corollary | a copy that did not exist, read as a revert path |

Each reads as complete because the failing step did not say it had failed. Rule 4 verifies the
effect of an attachment; rule 14 generalizes it — **any operation whose failure would be silent
must be confirmed by its artifact**, whether that is a cron invocation, a resource diff, a file,
or a read-back. `pnpm preflight` applies that standard to the environment before the first write,
and `test/manifest.test.ts` applies it to the suite itself.

## Environment failures

| # | Failure | Symptom | Cause | Status | Baked in |
| --- | --- | --- | --- | --- | --- |
| 1 | `npm` unusable | `EPERM` on `~/.npm` | cache holds root-owned files; the invoking user cannot write or repair it | never fixed — installs ran through `pnpm`, registry facts via `curl` | `package.json` pins `packageManager: pnpm@11.28.5` |
| 2 | Alchemy CLI `EPERM` | `EPERM: operation not permitted, mkdir …/.alchemy/profiles` | the sandbox allowed writes only inside the workspace; `HOME` pointed outside it | ran commands with `HOME=$PWD/.home` | `.gitignore` lists `.home/`; the caller sets `HOME` |
| 3 | pnpm refuses to purge `node_modules` | `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm will not delete `node_modules` without a TTY to confirm on | `CI=true` on invocations | `pnpm-workspace.yaml`: `verifyDepsBeforeRun: false` |
| 4 | `workerd` postinstall blocked | `ERR_PNPM_IGNORED_BUILDS: workerd@1.20261002.1`, and a fresh `pnpm install --frozen-lockfile` **exits 1** | pnpm runs no dependency scripts by default, and pnpm 11 **removed** `onlyBuiltDependencies` — the key was silently ignored while `strictDepBuilds` defaults to `true` | `allowBuilds: { workerd: true }` | `pnpm-workspace.yaml` |
| 5 | keychain reads fail | exit `128` from `security … -w`, no output | the entry's ACL needs an interactive "Allow"; a non-interactive process can never satisfy it | stopped reading it; token supplied out of band | `README` "Credentials"; the CI plan job skips with a notice when no token secret exists |
| 6 | `/user/tokens/verify` rejects a working token | `Invalid API Token` | that endpoint verifies *user*-scoped tokens; an account-scoped token can be valid and still fail it, while workers/d1/r2/kv/queues reads all returned 200 | treat as advisory; probe the endpoints actually used | README "Credentials" |
| 7 | Durable Object call fails | `errorcode: 1101`, `internal error; reference = 32g8fknruavetv9a6cnm4h38`, no stack, `logs: []` | **Cloudflare-internal**, established from Workers Observability telemetry, not from tail: the failing invocation has `cpuTimeMs: 0`, `exceptions: null`, `logs: null`, and **no `Counter` invocation event at all** — the object was never entered, so no user code ran. The same script version had served 17 requests in the previous two minutes, v2 and v3 share one etag (cron-only redeploy, identical code), and it healed with no deploy while the same instance kept its storage | **closed as platform-side** — not reproducible in 4 deploy cycles × 3 class shapes, including the exact incident pacing | README "Live deployment" |
| 8 | "Cron attached, never fires" | no error at all, because nothing had fired yet: trigger present in `schedules`, zero invocations in `tail`, zero `cron.fire` rows | **our measurement window.** A newly attached trigger's first delivery arrived **6m42s / 6m46s / 11m11s** after attach across three scripts; the verdict had been written ~10 minutes in. The handler and the async `crons` shape were correct all along | **closed** — 16 `cron.fire` rows, `scheduled outcome=ok`, [CRON-FINDINGS.md](./CRON-FINDINGS.md) | README "Live deployment"; cron findings file |
| 9 | **Two agents committed to one branch; a `git reset` discarded a commit** | `a2dad44` (the wrapper deletion) vanished from `main` twenty seconds after it landed: another agent ran `git reset 8b7b63c` while recovering its own amended commit, and its replacement commit was built on the reset base. One commit in the race also captured a half-written `package.json` | parallel agents sharing a branch, and `git reset` is not additive — a commit made in the same second as another agent's is still just a ref move away from disappearing | recovered: the object survived, worktree still held the changes, re-committed and verified by inspecting `HEAD` contents (`git show HEAD:package.json`) rather than trusting `git log` | this row, and the rule below |
| 10 | **A read-only sandbox denies even `/tmp`, silently truncating work** | `echo probe > /tmp/x` → `Operation not permitted`; a `curl -o /tmp/CH.md` earlier had failed the same way and looked like a network error | a session-level read-only policy blocks temp spills, so any step that stages output in `/tmp` fails at the *write*, not the read — and a longer report can then look complete while missing the parts that could not be staged | streamed everything inline through pipes instead of files; noted here because it is invisible unless you test it | **`pnpm preflight`** (`scripts/preflight.ts`) — probes at session start, and the report opens with `scratch: DEGRADED` when it says so; rule 11 below |
| 11 | `wrangler tail` prints nothing through a pipe | `… \| grep <pattern>` produced nothing, including for requests known to arrive | `tail` does not flush per line to a pipe; the stream never ends, so the filter sees nothing | stream to a file for a bounded window | working practice, recorded here |

**Residual anomaly — now asserted instead of described.** `deep-pass` delivery stopped after
16:06:52, stayed silent ~16 minutes, then produced four more fires carrying the **retired**
`* * * * *` expression after a redeploy (across two script versions, as the check later showed),
then went quiet at 16:28:55 — while an isolated probe fired ten consecutive minutes without
stopping. That is stale scheduler delivery in this account, not anything in the repo.

It is no longer a paragraph: `pnpm cron-health` compares the platform's *delivered* expression
against the *configured* schedule, is unit-tested (13 cases), and runs every 6 hours in CI. Its
blind spots are listed in `REVIEW-2026-10-23.md` §8 rather than left to the reader.

**Why 8 was not a shape bug.** The first hypothesis was that `crons: [...]` + a plain
`scheduled` export is undocumented for async Workers. The [`Worker.d.ts:704-716`](
../node_modules/alchemy/lib/Cloudflare/Workers/Worker.d.ts) comment and the cron doc page both
document exactly that ("This is how async (non-Effect) Workers configure Cron Triggers"). The
declaration is correct; something in the handler or the trigger path is not.

**Why 7 is not a code defect.** `error code: 1101` is the generic page for *any* uncaught
exception, so it carries no diagnostic value on its own: a deliberately broken Worker returns
the same page while telemetry shows the real message. Here telemetry shows the opposite — no
handler ran at all. Two consequences: the shape deviation (the class did not extend
`DurableObject`) was real but unrelated, and it is now fixed for API access, not as a bug fix.

**Technique worth keeping:** `wrangler tail` is not a record — it is a stream you can lose. The
Worker's persisted Workers Observability events are queryable after the fact via
`POST /accounts/<acct>/workers/observability/telemetry/query`, which is what recovered this
incident hours later.

## Authoring mistakes

| # | Mistake | Cost | Lesson | Where it lives |
| --- | --- | --- | --- | --- |
| 1 | `alchemy state list --stage <name>` | one failed command: `Unrecognized flag` | flags are per-subcommand | README "Commands" |
| 2 | `PUT /photos` (no key) returned **404** where 400 was intended | the 400 branch tested `request.method === "POST"` while its own message named `PUT /photos/<key>`, so the method a caller would misuse went unguarded | guard the methods the message names, and assert the empty-key case explicitly | `src/Api.ts`, pinned by `test/api.test.ts` |
| 3 | Commit message mangled by backticks in `git commit -m "…"` | the message lost a clause and had to be amended — **and it happened twice**, the second time after this very rule was written | write to a file, commit with `-F` | this row |
| 4 | Deleted `.home`, which held the only live session | deploy blocked mid-session until a token was supplied separately | wrangler refresh tokens rotate single-use; the refreshed copy *becomes* the session — never delete it before re-issuing credentials | README "Credentials" |
| 5 | Concluded from `wrangler whoami` that R2 scope was missing | would have built a two-service stack instead of three | a printed scope list is not the capability set — probe with a throwaway resource | README "Credentials" |

## Rules

1. Probe a capability with a throwaway resource; never trust a scope list or a token verifier.
2. Prefer a real API token over a single-use rotating OAuth session, and never delete a
   credential copy before re-issuing credentials elsewhere.
3. Commit messages go to a file (`-F`); backticks and `$` in `-m` are shell.
4. Verify the **effect**, not the attachment: a cron is proven by an invocation, a consumer by
   a row in D1 — never by a config field or an API listing.
5. Read `--help` for the subcommand in hand; flags are not shared.
6. Guard every method a message names, and test the empty-key and trailing-slash cases.
7. Send long-running streams (tail, watch, logs) to a file, not a pipe.
8. A transient, undocumented failure stays **open** with its reference recorded — do not
   promote a hypothesis to a root cause; and query persisted telemetry, not a lost stream.
9. Size the observation window to the mechanism: a fresh cron trigger can take 6–11 minutes to
   deliver its first event, so a five-minute check reports a false negative.
10. Parallel agents get their own branch or worktree; if they must share one, commits are
    serialized and `HEAD` is verified by content (`git show HEAD:<file>`) afterwards —
    `git log` alone will not tell you whose commit survived.
11. Probe scratch space at the **start** of a session, before the first write — not once a write has
    failed: `pnpm preflight` (`scripts/preflight.ts`) writes a nonce, reads it back, removes it and
    reports `scratch: ok | READ-ONLY`. A read-only session fails at the write, and that failure
    looks like an empty network response — the report then reads complete while missing whatever
    could not be staged. When it says degraded, the report opens with `scratch: DEGRADED` and the
    step is never retried as a network error or a bad command. Corollary: revert a mutation of a
    tracked file with `git checkout -- <file>` (or `git stash` when unrelated edits must survive),
    never a copy parked in `/tmp`; `/tmp` is not durable evidence, and the backup that "exists" in
    a read-only session is the same silent failure this rule is about. Commit intended edits before
    mutating a file: `git checkout -- <file>` restores the *whole* file, so an uncommitted edit goes
    with the mutation — which is how the first pass at this very rule discarded the limits block it
    had just added to `test/docs.test.ts`.
12. Never cite an issue as "closed" without its `state_reason` **and** the PR or commit that closed it:
    fixed, duplicate and wontfix all render as `state: closed`, and only one of them lets a
    workaround expire. **Enforced by `test/docs.test.ts`** — the workaround table's closure and
    expiry columns are asserted, not trusted.
13. A generic error page (`1101`) is a symptom, never evidence: check whether any handler ran
    (`cpuTimeMs`, exception objects, entrypoint events) before blaming the code.
14. Confirm every operation whose failure would be silent by its artifact, not its return code:
    `curl -o` by the file, a redirect by the target's contents, a deploy by the resource diff
    (`Done: 0 succeeded` means 0 changed — not "the fix shipped"), a write by reading it back.
    `pnpm preflight` applies the same check to the environment, and `scripts/cron-health.ts`
    classifies an unobservable endpoint as exit 2 instead of a failed assertion.
15. The first deploy on a newly pinned `alchemy` must go out at **100% traffic** (no
    `version.traffic`); under gradual deployment it fails with `WorkerVersionConfigError`. That
    belongs to the export-era deploy flow, not to one release, so it applies to every future pin
    bump — see `MIGRATION-beta84.md` §"One-way door" and `UPGRADE.md` step 2.
