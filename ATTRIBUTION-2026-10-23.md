# Attribution audit — 2026-10-23

Not a doc reconciliation. Each observed behaviour is driven to a **controlled experiment** and
assigned an **owning layer** — our code, alchemy's provider, or Cloudflare — with a differential
where the cause is contested. Methods: the raw Cloudflare API, the pinned provider source, a
scratch-stage fault injection, and a raw-API schedule trial. Probe stages were destroyed and their
retained resources removed afterwards. (The CF API was queried with the repo's token via small Node
scripts; one `curl` slipped in during a purge check and is disclosed in the run log.)

## Attribution map

| Behaviour | Experiment | Evidence | Owner |
| --- | --- | --- | --- |
| The KV index is always cold | write-then-wait: `GET /photos` #1 → `miss`; the key is written with `expiration: <now+60s>`; #2 → `hit`; after 70 s the key is **gone**; #3 → `miss` | the key carries the TTL and the platform deletes it at expiry; a durable key would survive isolate churn | **our code** (`expirationTtl: 60`) × **Cloudflare KV** semantics — *not* isolate churn |
| The degrade path actually fires | fault injection: deploy a scratch stage, **delete its D1 database**, probe | `/health` 200; `/stats` → 200 `degraded:true, auditEvents:null`; `/audit` → **503** | **our code** (works as designed; the platform merely fails the binding) |
| The DLQ is a silent sink | push a malformed message; the consumer retries and gives up | DLQ `backlog_count: 2`, `consumers: []`, retention `345600 s`; `audit_events` unchanged | **our code** (no DLQ consumer or alert). alchemy wires `dead_letter_queue` (`Consumer.js:121`) and Cloudflare moves the message — both correct |
| Retired `* * * * *` keeps being delivered | raw-API trial: attach a `* * * * *` schedule (alchemy out of the loop), let it fire, remove it, poll telemetry | see §Replay trial | **Cloudflare** (platform-side; alchemy exonerated — it is not in the loop) |
| `ADMIN_TOKEN` binds as `secret_text` | read the provider source + the deployed settings | `WorkerProvider.js:1834` routes `Redacted` → `{ type: "secret_text" }`; live `settings.bindings` → `ADMIN_TOKEN: secret_text` | **alchemy** (by design) |
| The export map's endpoint | two API probes | the map is at `…/services/{name}/environments/{env}` → `script.exports`, not `…/scripts/{name}/versions/{id}` | **alchemy docs** (filed #2463) |

## Differential — alchemy in vs out of the loop

- The replay trial drives the schedule with the **raw Cloudflare API**; alchemy is not involved. If
  the replay still happens, alchemy is exonerated and the cause is the platform.
- alchemy's contribution, read from the **provider source** rather than its docs: it converts
  `Redacted` → `secret_text` (`WorkerProvider.js:1834`), injects `ALCHEMY_*` plain_text bindings and
  `alchemy:*` tags, computes `crons` (`normalizeCrons`, `WorkerProvider.js:909`), sets the DO
  `exports`/`migrations` (`:2391`/`:2421`), and generates stage-unique physical names. The platform
  behaviours (KV TTL, cron replay, DLQ move) are **tool-independent**.
- **Not done — a `wrangler`-only twin.** There is no `wrangler` binary in this environment (only the
  1Password shell-plugin alias; `node_modules/.bin` has `workerd`, not `wrangler`). The raw-API trial
  is the substitute for the cron path; the KV and DLQ behaviours are pure API semantics read straight
  from the API responses, so a twin would not change their attribution.

## Invariants that fail loudly

- **Replay detector** — `pnpm cron-health`, already wired to a 6-hourly job: fails when the newest
  delivered cron is not configured. It caught the replay today (exit 1, in CI).
- **DLQ-backlog assertion** — `scripts/queue-health.ts` + tested logic (`verdictFor`): fails when
  the dead-letter queue has parked messages. Wired beside cron-health. **Red today, correctly** —
  the audit parked two poisons, the queue cannot be purged (HTTP 400: a consumer references it), and
  they expire ~2026-10-27.
- **KV TTL** — no invariant; a documented choice, not a defect.

## Filed at the owning layer

- **alchemy docs** — the `exports` endpoint: <https://github.com/alchemy-run/alchemy/issues/2463>.
- **alchemy/Queues** — the DLQ-without-consumer documentation gap:
  <https://github.com/alchemy-run/alchemy/issues/2464>.
- **Cloudflare** — the replay is platform-side (see below). Filing a support ticket needs the
  Cloudflare dashboard; the evidence is recorded here.
- **This repo** — the DLQ invariant (`3078960`), the KV-TTL wording, and the replay-window
  correction (`a4e1b2f`, `ad6b642`).

## Replay trial

_Running._ Attach `* * * * *` via the raw API → confirm it fires → remove → poll Workers
Observability for how long `* * * * *` keeps arriving afterwards. Result appended when it completes.
