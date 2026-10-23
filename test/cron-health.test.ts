import { describe, expect, it } from "vitest";

import { evaluate, type Delivery } from "../scripts/cron-health-logic.ts";

/**
 * The cron scheduler is the one mechanism in this project that is external and
 * unobservable from inside the Worker, so its assertion is tested here rather
 * than trusted to a script nobody exercises. Each case below is a shape the
 * live account has actually produced.
 */

const at = (iso: string): Date => new Date(iso);
const to = at("2026-10-23T17:00:00Z");

const delivery = (iso: string, cron: string, outcome = "ok", version = "v1"): Delivery => ({
  at: at(iso),
  cron,
  version,
  outcome,
});

const run = (
  configured: ReadonlyArray<string>,
  delivered: ReadonlyArray<Delivery>,
  overrides: Partial<{ maxAgeHours: number; windowHours: number; to: Date }> = {},
) =>
  evaluate({
    configured,
    delivered,
    to: overrides.to ?? to,
    maxAgeHours: overrides.maxAgeHours ?? 26,
    windowHours: overrides.windowHours ?? 48,
  });

describe("cron health", () => {
  it("passes when the newest delivery matches a configured expression", () => {
    const verdict = run(["0 3 * * *"], [delivery("2026-10-23T03:00:04Z", "0 3 * * *")]);

    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("fails when the newest delivery uses a retired expression (the 2026-10-23 replay)", () => {
    const verdict = run(
      ["0 3 * * *"],
      [
        delivery("2026-10-23T16:27:51Z", "* * * * *", "ok", "d549945f"),
        delivery("2026-10-23T16:28:56Z", "* * * * *", "ok", "d549945f"),
      ],
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toContain("not configured");
    // The retired rows are also reported, but as a note, not the failure.
    expect(verdict.advisories.join(" ")).toContain("retired expression");
  });

  it("does not fail on a retired expression once a current delivery has superseded it", () => {
    const verdict = run(
      ["0 3 * * *"],
      [
        delivery("2026-10-23T16:28:56Z", "* * * * *", "ok", "d549945f"),
        delivery("2026-10-24T03:00:02Z", "0 3 * * *", "ok", "e1f2a3b4"),
      ],
      { to: at("2026-10-24T03:05:00Z") },
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.advisories.length).toBe(1);
  });

  it("fails when delivery has stalled beyond the freshness bound", () => {
    const verdict = run(["0 3 * * *"], [delivery("2026-10-21T03:00:00Z", "0 3 * * *")]);

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toContain("h old");
  });

  it("fails when nothing was delivered at all, and says the window may be too short", () => {
    const verdict = run(["0 3 * * *"], []);

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toContain("no scheduled delivery");
    expect(verdict.failures.join(" ")).toContain("6-11 minutes");
  });

  it("fails when the Worker has no cron configured", () => {
    const verdict = run([], [delivery("2026-10-23T03:00:00Z", "0 3 * * *")]);

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toContain("no cron trigger is configured");
  });

  it("fails when the newest invocation did not finish ok", () => {
    const verdict = run(["0 3 * * *"], [delivery("2026-10-23T03:00:00Z", "0 3 * * *", "exception")]);

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(" ")).toContain("not ok");
  });

  it("is order-independent: a sorted and an unsorted input agree", () => {
    const a = delivery("2026-10-23T03:00:00Z", "0 3 * * *");
    const b = delivery("2026-10-23T16:28:56Z", "* * * * *");

    expect(run(["0 3 * * *"], [a, b])).toEqual(run(["0 3 * * *"], [b, a]));
  });
});
