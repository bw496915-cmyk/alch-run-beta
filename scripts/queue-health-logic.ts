/**
 * The decision behind the dead-letter-queue assertion, kept free of network and
 * process concerns so it can be unit-tested. `scripts/queue-health.ts` supplies
 * the observations; this decides.
 *
 * Why this exists: `Queues.Consumer({ deadLetterQueue })` parks a poison message
 * after `maxRetries`, and **nothing drains or alerts the queue** — so the failure
 * is silent for the 4-day retention and then the message expires. That is the sink
 * the audit attributed to our side (alchemy wires `dead_letter_queue`, Cloudflare
 * moves the message; we never observe it). This is the invariant that fails loudly.
 */

export interface QueueVerdict {
  readonly ok: boolean;
  readonly detail: string;
}

export const verdictFor = (input: {
  readonly name: string;
  readonly backlog: number;
  /** Allowed backlog; 0 by default — any parked poison is a finding. */
  readonly max?: number;
}): QueueVerdict => {
  const max = input.max ?? 0;
  if (!Number.isFinite(input.backlog)) {
    return { ok: false, detail: `${input.name}: backlog is unreadable (not a number)` };
  }
  if (input.backlog <= max) {
    return { ok: true, detail: `${input.name}: backlog ${input.backlog} (<= ${max})` };
  }
  return {
    ok: false,
    detail:
      `${input.name}: backlog ${input.backlog} (> ${max}) — poison messages are parked with ` +
      `nothing draining or alerting them`,
  };
};
