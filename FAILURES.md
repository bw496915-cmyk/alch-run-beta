# Failures — 2026-10-23

What broke on this project's first day, split into what the environment did and what we did.
Each row ends with the file that now prevents a repeat. Two failures are unanswered and stay
that way here: the Durable Object `1101` and the cron that never fired.

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
| 8 | Cron attached, never fired | no error: trigger present in `schedules`, zero scheduled invocations in `tail`, zero `cron.fire` rows, `cronFires` never advanced | **not established.** The original shape hypothesis was **falsified** (see below), so this is handler/runtime, not declaration | **open** — track A | README "Live deployment" |
| 9 | `wrangler tail` prints nothing through a pipe | `… \| grep <pattern>` produced nothing, including for requests known to arrive | `tail` does not flush per line to a pipe; the stream never ends, so the filter sees nothing | stream to a file for a bounded window | working practice, recorded here |

**Why 8 is not a shape bug.** The first hypothesis was that `crons: [...]` + a plain
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
9. A generic error page (`1101`) is a symptom, never evidence: check whether any handler ran
   (`cpuTimeMs`, exception objects, entrypoint events) before blaming the code.
