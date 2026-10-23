# Cron track — findings (2026-10-23, stage `deep-pass`)

**Verdict: there is no defect in the cron wiring.** The async shape
(`crons: [...]` on a plain Worker + a plain `async scheduled(controller, env)`
export from `src/Api.ts`) does fire in production on this account. The reported
"never fires" was a **measurement-window false negative**, reproduced below.

## Measured: a newly attached trigger does not fire at once

Three independent scripts give the same shape of result — first scheduled
invocation lands minutes after the trigger is created, not on the next minute.

| Script | trigger `created_on` | first scheduled invocation | latency |
| --- | --- | --- | --- |
| `alchrunbeta-api-deep-pass-…` (Alchemy, async `crons`) | 15:44:57 | 15:56:08 | 11m11s |
| Alchemy probe `cronprobeasync-probe-cron-probe-…` | 16:02:04 | 16:08:46 (`scheduledTime` 16:08:44) | 6m42s |
| wrangler probe `cron-probe-wrangler` (no Alchemy) | 15:56:16 | 16:09:20 (stale `scheduledTime` 16:01:38) | ~5–13m |
| wrangler probe `cron-longevity-probe` | 16:22:50 | 16:29:36 (`scheduledTime` 16:29:34) | 6m46s |

So: **anything that checks "did the cron fire?" inside the first ~5 minutes after
attaching `* * * * *` will correctly report nothing, and a daily `0 3 * * *`
trigger has no fire opportunity at all until the next 03:00 UTC.** The previous
pass concluded "never fires" ~10 minutes after attaching the temp cron, i.e.
before its first delivery.

## Evidence the handler really runs

Deployed script content (downloaded from the API) still exports the handler:

```
export{Counter,i as default}   # default object contains: async fetch, async queue, async scheduled
```

Cron invocations in the observability stream, and rows in D1 written by
`scheduled()` (the TEMP `* * * * *` window, 15:56:08 → 16:06:52 UTC):

```
16:00:51 scheduled ok https://…  scheduledTime 1792771248.265   (then POST https://counter/cron ok)
…
D1: SELECT COUNT(*), MIN(at), MAX(at) FROM audit_events WHERE type='cron.fire'
    {'n': 12, 'first': '2026-10-23T15:56:08.259Z', 'last': '2026-10-23T16:06:52.334Z'}
GET /audit -> count: 13, of which 12 are type "cron.fire"
GET /stats -> {"durableObject":{"requests":6},"d1":{"auditEvents":13}}
```

After the final redeploy (cron restored to `0 3 * * *` at 16:23:10) the platform
delivered four more fires that still carried the retired expression — stale
scheduler state, and useful evidence that delivery is queued rather than
trigger-time:

```
16:24:08  * * * * * at 1792772628265
16:26:06  * * * * * at 1792772688265
16:27:51  * * * * * at 1792772868265
16:28:55  * * * * * at 1792772928265      (16 cron.fire rows total)
```

## Controls (both destroyed afterwards)

1. **Plain `wrangler` probe** (`cron-probe-wrangler`, `[triggers] crons = ["* * * * *"]`,
   plain `scheduled` writing KV) — fired; KV `wrangler:lastFire` =
   `{"source":"scheduled","cron":"* * * * *","scheduledTime":1792771298116,"ranAt":"2026-10-23T16:09:20.784Z"}`.
   Account/trigger mechanism works; not an Alchemy problem.
2. **Alchemy async probe** (own stage `cron-probe`, `crons` prop + plain
   `scheduled`) — fired; `{"runtime":"alchemy","fires":"7","…"source":"scheduled"…}`,
   `fires` reached 10.
3. **Effect-native probe** (`Cloudflare.Workers.cron(...)` +
   `CronEventSourceLive`, `main: import.meta.url` inside a `Stack`): **did not
   deploy.** `ScriptStartupError: Uncaught TypeError: e.resolve is not a function
   at generateBinPath / init_workerd` — the worker bundle pulls Alchemy's
   Node-side runtime services into workerd. So the Effect-native route is not a
   drop-in replacement here, and is unnecessary: the async prop already works.
4. **Second deploy after a cron change** (async probe, `* * * * *` → `*/2 * * * *`,
   stage `cron-probe`): `[Probe] updated — Reconciling Cron Triggers (1)`, the
   schedules API showed the new expression, and the handler kept firing
   (fires 7 → 10 across 16:13:45–16:17:27). No "second deploy breaks it".

## Residual, unexplained

Delivery for `deep-pass` stopped after 16:06:52 and did not resume for the ~16
minutes observed, even after the two probe scripts were deleted — while the
triggers stayed listed. Re-deploying it at 16:23:10 produced four more (stale
`* * * * *`) fires to 16:28:55, then silence again. The longevity probe, alone in
the account, fired 10 consecutive minutes without stopping, so this is
script-/delivery-layer behaviour rather than a property of the cron shape. Not
testable further without experimenting on `deep-pass`; the next real signal is
the `0 3 * * *` fire on 2026-10-24.

## Final state

- `alchemy.run.ts:45` is back to the committed `crons: ["0 3 * * *"]` (the TEMP
  `* * * * *` is gone; the file is byte-identical to `HEAD`, so no source change
  was needed for the fix).
- `deep-pass` redeployed; `GET /accounts/…/workers/scripts/alchrunbeta-api-deep-pass-…/schedules`
  → `{"cron":"0 3 * * *"}`, `/health` 200, `/stats` serves the DO, `/audit` serves D1.
- All probe scripts, KV namespaces and stages (`cron-probe`) destroyed.

## Stale claims to correct

`README.md` (cron trigger row "attached, never fired"; "the cron has never
fired"; Verified row "Cron fires … ✖ never observed"), `REVIEW-2026-10-23.md`
(track A "open"; "handler/trigger path still unexplained") and `FAILURES.md` #8
are all falsified by the evidence above. Not edited here to avoid clobbering
concurrent documentation work.
