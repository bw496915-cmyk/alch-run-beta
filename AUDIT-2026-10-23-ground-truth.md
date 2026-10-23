# Ground-truth audit — 2026-10-23

The repo's docs are treated as **claims to falsify**, not evidence. Every verdict below comes from
an arbiter outside this repo: the Cloudflare API's own records, black-box HTTP against the live
Worker, a clean-room `deploy`/`destroy` on a throwaway stage, the pinned package, or the compiler.

## 1. Reconciliation — claim → platform artifact → verdict

| Claim (source) | Platform artifact | Verdict |
| --- | --- | --- |
| Stage `deep-pass`, account `7a470…`, Worker up | `GET …/workers/scripts/…/settings` tags `alchemy:stage:deep-pass`; `GET /health` → 200 | ✅ |
| Bindings R2/D1/KV/Queue/DO | `settings.bindings`: `PHOTOS:r2_bucket …bqzyydt4zuytxvh3`, `DB:d1 665fcd33…`, `CACHE:kv_namespace 2430e2e45…`, `EVENTS:queue …73jum5an2fzj4s3k`, `COUNTER:durable_object_namespace dd0b8b6b…` | ✅ all match the README |
| cron `0 3 * * *`; probe trigger removed | `GET …/schedules` → exactly `[{ "cron": "0 3 * * *" }]` | ✅ |
| Consumer's `deadLetterQueue` | `GET /queues/{events}` → `consumers[0].dead_letter_queue = …auditdeadletter…` | ✅ |
| "both migrations applied" | D1 `__alchemy_migrations` → `0001_init.sql`, `0002_audit.sql` | ✅ |
| UTF-8 byte-accounting fix | D1 `photos` row `utf8.txt bytes=2`; R2 object size 2 | ✅ |
| DO increments are atomic | 30 concurrent `/stats` → DO counter delta 31, **lost 0** | ✅ |
| `/stats` + `/audit` are admin-gated | black-box: no token → **401**, `Bearer` → **200** | ✅ |
| The deployed bundle carries the layers | content 24,627 B contains `/photos/:key`, `degraded`, `dependency unavailable`, `ON CONFLICT(id) DO NOTHING` | ✅ |
| `ADMIN_TOKEN` is a secret | `settings.bindings` → `ADMIN_TOKEN: "secret_text"`; bundle contains no token literal, no `cfat_`, no `sk-` | ✅ |
| The admin token is absent from **state** | `.alchemy/state/AlchRunBeta/deep-pass/Api.json` → `props.env.ADMIN_TOKEN.__redacted__` is the exact 64-hex token (`sha256` matches `.env`) | ❌ **refuted** — the local alchemy state serialises the secret in the clear. Gitignored, but plaintext on disk (and printed by `alchemy state read`) |
| DO export map is observable | `GET …/workers/services/{name}/environments/production` → `exports: {"Counter":{"type":"durable-object","storage":"sqlite"}}` | ✅ (see §3.1) |
| **REVIEW §7: exports at `GET …/workers/scripts/{name}/versions/{id}`** | that version's `resources.script` keys are `["etag","handlers","named_handlers","last_deployed_from"]` — **no `exports`** | ❌ **refuted** |
| cron `0 3 * * *` "fires" | docs: first real daily fire is `2026-10-24 03:00 UTC` | ⏳ unproven until then |
| KV index cache answers `x-cache: hit` | KV namespace holds **zero keys** (`photos:index` → 10009 not found) | ⚠️ only true within the 60 s TTL; cold otherwise |
| Compatibility surface | `compatibility_date: 2026-08-31`, `compatibility_flags: ["new_module_registry"]` | ⚠️ unclaimed in the docs |
| DLQ: "lands here instead of being dropped" | after 2 poisons the DLQ reports `backlog_count: 2`, and `consumers: []` | ⚠️ true, but nothing drains or alerts it |
| A retired `* * * * *` is replayed for a bounded window | **controlled trial** (raw-API attach at 21:00Z, remove at 21:06Z): the scheduler replayed it **~6 min** after removal (21:07:01Z…21:12:01Z), then stopped — within the documented ~16 min. Separately, telemetry showed `* * * * *` at 19:10Z and 19:54Z (n = 1) | ⚠️ owner is **Cloudflare** (alchemy not in the loop). The window is **not** an order of magnitude longer; the 19:10/19:54 samples are an open anomaly |

## 2. Failure plane — forced, not asserted

| Test | Method | Result |
| --- | --- | --- |
| Clean-slate reproducibility | `ALCHEMY_STAGE=retain-probe alchemy deploy` | 7 resources created from nothing, 9.6 s ✅ |
| Poison → DLQ | pushed a malformed message; read queue metrics | consumer retried and gave up; **DLQ `backlog_count: 2`**; `audit_events` stayed at 19 ✅ |
| `RemovalPolicy.retain()` across `destroy` | `destroy` the probe stage, then list account resources | **DB + R2 survive; KV + Queue deleted** ✅ |
| DO atomicity | 30 concurrent `/stats` | 0 lost increments ✅ |
| Admin gate | black-box HTTP | 401 / 200 ✅ |
| Degrade-to-503 / partial `degraded` | — | **unit-proven only**; not forced live (breaking the D1 binding needs a separate stage) ⚠️ |

## 3. Minimal repros (filed upstream)

1. **Docs endpoint mismatch** — filed: <https://github.com/alchemy-run/alchemy/issues/2463>.
   `GET /accounts/{acct}/workers/scripts/{name}/versions/{id}` returns
   a script resource with **no `exports`**; the export map is at
   `GET /accounts/{acct}/workers/services/{name}/environments/{env}` → `script.exports`.
2. **A DLQ with no consumer is a silent sink** — filed:
   <https://github.com/alchemy-run/alchemy/issues/2464>. `Queues.Consumer` accepts
   `deadLetterQueue` but the DLQ has no consumer, no alert, and a 4-day retention — a poison event
   is functionally dropped after 4 days with no signal.
3. **`expirationTtl: 60` makes the index cache effectively always cold** across isolate churn; the
   README's "second call → `x-cache: hit`" is a within-60 s claim (repo-side, corrected in the
   README — not an upstream defect).

## 4. Cost / latency / limits (from the platform)

| Metric | Value |
| --- | --- |
| Observability, 24 h | 50 events, **50/50 `outcome: ok`**, total `cpuTimeMs` 43.0, max per-invocation **4 ms** |
| D1 | `size_after` 40,960 B (40 KB); 4 photos + 19 audit rows |
| R2 | 4 objects, largest 20 B, Standard |
| Queue | `max_retries: 3`, `retry_delay: 0`, `message_retention_period: 345600 s` (4 days) |
| Worker bundle | 24,627 B |
| Schedules | 1 |

## 5. Verdict

- **Confirmed from platform truth:** bindings, schedules, DLQ wiring, migrations, DO atomicity,
  the admin gate, the secret envelope, the shipped layer strings, `retain` semantics, and
  clean-slate reproducibility.
- **Refuted:** REVIEW §7's `exports` endpoint (corrected in the same commit).
- **Unproven (not false):** the daily cron fire (pending `2026-10-24 03:00 UTC`); the live
  degrade-503 path.
- **Flagged:** the DLQ is an unmonitored sink; the KV cache is 60 s-cold; the compatibility
  date/flags are undocumented.
