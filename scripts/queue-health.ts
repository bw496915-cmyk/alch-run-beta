#!/usr/bin/env node
/**
 * Assert that a dead-letter queue is empty — the sink the audit found.
 *
 * `Queues.Consumer({ deadLetterQueue })` stops at parking a poison message: the
 * DLQ has no consumer and no alert, so a failure is silent for the 4-day
 * retention and then the message expires. This reads the queue's own
 * `backlog_count` and fails when anything is parked.
 *
 * Usage (Node 22+, no dependencies):
 *   CLOUDFLARE_API_TOKEN=… node scripts/queue-health.ts [options]
 *
 *   --queue <substring>   queue name to match (default: auditdeadletter)
 *   --max <n>             tolerated backlog (default 0)
 *
 * Exit codes: 0 empty, 1 messages parked, 2 misconfigured or unreachable.
 */

import { readFlag, readNumberFlag } from "./flags.ts";
import { verdictFor, type QueueVerdict } from "./queue-health-logic.ts";

const argv = process.argv.slice(2);
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "7a470541a704caaf91e71efccc78fd36";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const MATCH = readFlag(argv, "queue", "auditdeadletter") ?? "auditdeadletter";
const MAX = readNumberFlag(argv, "max", 0);

if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is not set");
  process.exit(2);
}
if (!Number.isFinite(MAX)) {
  console.error("--max must be a non-negative number");
  process.exit(2);
}

const api = async <T>(path: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
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
const matched = queues.filter((q) => q.queue_name.includes(MATCH));
if (matched.length === 0) {
  console.error(`no queue matches "${MATCH}" (have: ${queues.map((q) => q.queue_name).join(", ")})`);
  process.exit(2);
}

const verdicts: QueueVerdict[] = [];
for (const queue of matched) {
  const metrics = await api<{ backlog_count?: number }>(`/queues/${queue.queue_id}/metrics`);
  verdicts.push(verdictFor({ name: queue.queue_name, backlog: metrics.backlog_count ?? 0, max: MAX }));
}

for (const verdict of verdicts) console.log(`${verdict.ok ? "ok  " : "FAIL"} ${verdict.detail}`);

if (verdicts.some((v) => !v.ok)) {
  console.error("\nFAIL — a dead-letter queue has parked messages and nothing drains or alerts it");
  process.exit(1);
}
console.log("\nOK — every matched dead-letter queue is empty");
