#!/usr/bin/env node
/**
 * Assert that the cron expression Cloudflare *delivers* matches the one we
 * *configured*.
 *
 * The scheduler is the one mechanism in this project we cannot observe from
 * inside: on 2026-10-23 the live Worker kept delivering a retired `* * * * *`
 * expression for ~16 minutes after the schedule had been changed, across a
 * redeploy. No typecheck, unit test or deploy log can see that. This can.
 *
 * Two sources, deliberately independent:
 *   configured — GET /accounts/{acct}/workers/scripts/{script}/schedules
 *   delivered  — Workers Observability telemetry, eventType=scheduled
 *                (the platform's record, not our handler's D1 rows: had the
 *                 handler been the broken part, our own rows would be missing too)
 *
 * Usage (Node 22+, no dependencies):
 *   CLOUDFLARE_API_TOKEN=… node scripts/cron-health.ts [options]
 *
 *   --stage <name>           stage whose Worker name is read from .alchemy state
 *                            (default: $ALCHEMY_STAGE, else deep-pass)
 *   --worker <name>          override the script name
 *   --window-hours <n>       telemetry lookback (default 48)
 *   --max-age-hours <n>      newest delivery may be at most this old (default 26)
 *   --from <ISO> --to <ISO>  explicit window, for back-testing a known incident
 *
 * Exit codes: 0 healthy, 1 assertion failed, 2 misconfigured or unreachable.
 */

import { spawnSync } from "node:child_process";

import { evaluate, readEnvelope, type Delivery } from "./cron-health-logic.ts";
import { readFlag, readNumberFlag } from "./flags.ts";

const argv = process.argv.slice(2);

const STAGE = readFlag(argv, "stage", process.env.ALCHEMY_STAGE ?? "deep-pass") ?? "deep-pass";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "7a470541a704caaf91e71efccc78fd36";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WINDOW_HOURS = readNumberFlag(argv, "window-hours", 48);
const MAX_AGE_HOURS = readNumberFlag(argv, "max-age-hours", 26);
const FROM = readFlag(argv, "from");
const TO = readFlag(argv, "to");

if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is not set");
  process.exit(2);
}

// A typo must not silently disable the freshness invariant: `NaN > x` is false,
// which would read as "never stale".
if (!Number.isFinite(WINDOW_HOURS) || !Number.isFinite(MAX_AGE_HOURS)) {
  console.error("--window-hours and --max-age-hours must be positive numbers");
  process.exit(2);
}

/** The Worker name recorded by the last deploy of this stage. */
const workerName = (): string => {
  const override = readFlag(argv, "worker");
  if (override) return override;
  // Let alchemy resolve the state path instead of hand-rolling the local
  // `.alchemy/state/<stack>/<stage>/<resource>.json` layout — `alchemy state read`
  // serves a remote state store too, so this keeps working if localState is swapped.
  const read = spawnSync("./node_modules/.bin/alchemy", ["state", "read", `AlchRunBeta/${STAGE}/Api`], {
    encoding: "utf8",
  });
  try {
    if (read.status !== 0 || !read.stdout) throw new Error(read.stderr?.trim() || "no state");
    return JSON.parse(read.stdout).attr.workerName as string;
  } catch (cause) {
    console.error(
      `no Worker name: pass --worker, or deploy stage "${STAGE}" first ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
    process.exit(2);
  }
};

const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
  } catch (error) {
    // Unreachable is exit 2 ("cannot observe"), never 1 ("assertion failed").
    console.error(`${path} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const body = await response.text().catch(() => "");
  const read = readEnvelope<T>(response.status, body);
  if (!read.ok) {
    console.error(`${path} failed: ${read.detail}`);
    process.exit(2);
  }
  return read.value;
};

interface ScheduledEvent {
  readonly timestamp: number;
  readonly $workers?: {
    readonly eventType?: string;
    readonly outcome?: string;
    readonly scriptVersion?: { readonly id?: string };
    readonly event?: { readonly cron?: string };
  };
  readonly $metadata?: { readonly trigger?: string };
}

const worker = workerName();

const to = TO ? new Date(TO) : new Date();
const from = FROM ? new Date(FROM) : new Date(to.getTime() - WINDOW_HOURS * 3_600_000);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
  console.error("bad window: --from/--to must be valid ISO timestamps with from < to");
  process.exit(2);
}

const schedules = await api<{ schedules?: ReadonlyArray<{ cron: string }> }>(
  `/workers/scripts/${worker}/schedules`,
);
const configured = (schedules.schedules ?? []).map((entry) => entry.cron);

const telemetry = await api<{
  events?: { events?: ReadonlyArray<ScheduledEvent> };
}>("/workers/observability/telemetry/query", {
  method: "POST",
  body: JSON.stringify({
    queryId: "cron-health",
    timeframe: { from: from.getTime(), to: to.getTime() },
    view: "events",
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }],
      limit: 500,
    },
  }),
});

const delivered: Delivery[] = (telemetry.events?.events ?? [])
  .filter((event) => event.$workers?.eventType === "scheduled")
  .map((event) => ({
    at: new Date(event.timestamp),
    cron: event.$workers?.event?.cron ?? event.$metadata?.trigger ?? "(missing)",
    version: event.$workers?.scriptVersion?.id ?? "?",
    outcome: event.$workers?.outcome ?? "?",
  }));

const verdict = evaluate({ configured, delivered, to, maxAgeHours: MAX_AGE_HOURS, windowHours: WINDOW_HOURS });

/**
 * UTC, and hand-rolled on purpose.
 *
 * `alchemy/Cli/Format` ships the canonical equivalent (`formatLocalTimestamp`,
 * `formatElapsed`, `TAIL_COLORS`), reachable through the package's `./*` export —
 * but this script is **dependency-free** and CI runs it *before* `pnpm install`
 * (the cron job installs nothing at all), so importing it would fail exactly when
 * the check is needed. UTC (not local) also lines the output up with the
 * platform's telemetry timestamps. See `CONVENTIONS.md` deny-list note.
 */
const fmt = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

console.log(`worker     ${worker}`);
console.log(`configured ${JSON.stringify(configured)}`);
console.log(`window     ${fmt(from)} -> ${fmt(to)}  (${delivered.length} delivered)`);

for (const event of [...delivered].sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-12)) {
  const mark = configured.includes(event.cron) ? " " : "x";
  console.log(`  ${mark} ${fmt(event.at)}  ${event.cron.padEnd(14)} v${event.version.slice(0, 8)} ${event.outcome}`);
}

for (const advisory of verdict.advisories) console.log(`\nnote: ${advisory}`);

if (!verdict.ok) {
  console.error("\nFAIL");
  for (const failure of verdict.failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nOK — newest delivery is configured");
