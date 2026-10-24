#!/usr/bin/env node
/**
 * Assert that a dead-letter queue is empty — the sink the audit found.
 *
 * The event-source consumer (`consumeQueueMessages`, with a `deadLetterQueue` prop) stops at parking a poison message: the
 * DLQ has no consumer and no alert, so a failure is silent for the 4-day
 * retention and then the message expires. This reads the queue's own
 * `backlog_count` and fails when anything is parked.
 *
 * Usage (needs `pnpm install` — this script imports `alchemy/Cli/Format`):
 *   CLOUDFLARE_API_TOKEN=… node scripts/queue-health.ts [options]
 *
 *   --queue <substring>   queue name to match (default: auditdeadletter)
 *   --max <n>             tolerated backlog (default 0)
 *   --purge               purge a non-empty DLQ, wait for it to complete, then
 *                         re-check. One-way and opt-in: the guard's job is to
 *                         *notice* parked messages, not to hide them. For
 *                         clearing artifacts this repo created — e.g. the
 *                         malformed messages pushed to verify the sink itself.
 *
 * Exit codes: 0 empty, 1 messages parked, 2 misconfigured or unreachable.
 */

import { readFlag, readNonNegativeNumberFlag } from "./flags.ts";
import { verdictFor, type QueueVerdict } from "./queue-health-logic.ts";

const argv = process.argv.slice(2);
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "7a470541a704caaf91e71efccc78fd36";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const MATCH = readFlag(argv, "queue", "auditdeadletter") ?? "auditdeadletter";
// `0` is the default and a valid value, so this is the non-negative parser.
const MAX = readNonNegativeNumberFlag(argv, "max", 0);
const PURGE = argv.includes("--purge");

if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is not set");
  process.exit(2);
}
if (!Number.isFinite(MAX)) {
  console.error("--max must be a non-negative number");
  process.exit(2);
}

const api = async <T>(path: string, method: "GET" | "POST" = "GET", payload?: unknown): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch (error) {
    console.error(`${path} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const body = (await response.json().catch(() => ({ success: false }))) as {
    success: boolean;
    result?: T;
    errors?: unknown;
  };
  if (!body.success) {
    console.error(`${path} failed: ${JSON.stringify(body.errors ?? [])}`);
    process.exit(2);
  }
  return body.result as T;
};

interface Queue {
  readonly queue_id: string;
  readonly queue_name: string;
}

const queues = await api<Queue[]>("/queues");
if (!Array.isArray(queues)) {
  console.error(`/queues returned a non-array result`);
  process.exit(2);
}
const matched = queues.filter((q) => q.queue_name.includes(MATCH));
if (matched.length === 0) {
  console.error(`no queue matches "${MATCH}" (have: ${queues.map((q) => q.queue_name).join(", ")})`);
  process.exit(2);
}

const collect = async (): Promise<QueueVerdict[]> => {
  const verdicts: QueueVerdict[] = [];
  for (const queue of matched) {
    const metrics = await api<{ backlog_count?: number }>(`/queues/${queue.queue_id}/metrics`);
    verdicts.push(verdictFor({ name: queue.queue_name, backlog: metrics.backlog_count ?? 0, max: MAX }));
  }
  return verdicts;
};

let verdicts = await collect();

if (PURGE && verdicts.some((v) => !v.ok)) {
  // `POST /queues/{id}/purge` removes every message. The body is REQUIRED — `{}`
  // is a 400 "Invalid request body" — and `delete_messages_permanently: true` is
  // what actually empties the queue. A purge is asynchronous, so this waits on
  // the status endpoint at the same path, which answers `{started_at, complete}`
  // — a *boolean* `complete`, where the API reference documents a `completed`
  // string. Both facts are from the live account, not the reference.
  const purged = matched.filter((_, i) => !verdicts[i]?.ok);
  for (const queue of purged) {
    await api(`/queues/${queue.queue_id}/purge`, "POST", { delete_messages_permanently: true });
    console.log(`purge started for ${queue.queue_name}`);
  }
  const deadline = Date.now() + 60_000;
  let running = purged.length;
  while (running > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    running = 0;
    for (const queue of purged) {
      const status = await api<{ complete?: boolean }>(`/queues/${queue.queue_id}/purge`);
      if (status.complete !== true) running++;
    }
  }
  if (running > 0) {
    console.error("purge did not report complete within 60s — re-run to confirm");
    process.exit(2);
  }
  verdicts = await collect();
}

for (const verdict of verdicts) console.log(`${verdict.ok ? "ok  " : "FAIL"} ${verdict.detail}`);

if (verdicts.some((v) => !v.ok)) {
  console.error("\nFAIL — a dead-letter queue has parked messages");
  process.exit(1);
}
console.log("\nOK — dead-letter queues empty");
