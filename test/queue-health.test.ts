import { describe, expect, it } from "vitest";

import { verdictFor } from "../scripts/queue-health-logic.ts";

/**
 * The dead-letter-queue assertion. The audit found the DLQ is a silent sink
 * (parked, never drained, never alerted), so "empty" is the only passing state.
 */
describe("dead-letter queue verdict", () => {
  const dlq = "alchrunbeta-auditdeadletter-deep-pass-tee5ns7ofvt6mr5r";

  it("passes an empty queue", () => {
    expect(verdictFor({ name: dlq, backlog: 0 }).ok).toBe(true);
  });

  it("fails a queue with a parked message — the sink the audit found", () => {
    const verdict = verdictFor({ name: dlq, backlog: 2 });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("nothing draining or alerting");
  });

  it("honours an explicit tolerance, and still names the queue", () => {
    expect(verdictFor({ name: dlq, backlog: 5, max: 5 }).ok).toBe(true);
    expect(verdictFor({ name: dlq, backlog: 6, max: 5 }).detail).toContain(dlq);
  });

  it("fails loudly when the backlog is unreadable rather than passing", () => {
    expect(verdictFor({ name: dlq, backlog: Number.NaN }).ok).toBe(false);
  });
});
