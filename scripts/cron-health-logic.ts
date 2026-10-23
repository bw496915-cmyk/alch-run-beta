/**
 * The decision logic of the cron health check, kept free of network and process
 * concerns so it can be unit-tested. `scripts/cron-health.ts` supplies the two
 * observations; this decides.
 */

export interface Delivery {
  /** When the platform delivered the invocation. */
  readonly at: Date;
  /** The expression the platform actually delivered (`controller.cron`). */
  readonly cron: string;
  readonly version: string;
  readonly outcome: string;
}

export interface Evaluation {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly advisories: ReadonlyArray<string>;
}

/**
 * Gate on the NEWEST delivery only.
 *
 * A retired expression's last fires legitimately linger inside any lookback
 * window, so failing on every mismatching row would fail for a day after each
 * schedule change. The invariant is: *what the scheduler most recently delivered
 * must be something we configured.* Older mismatches are advisory — they are
 * what a replay looks like after the fact.
 */
export const evaluate = (input: {
  readonly configured: ReadonlyArray<string>;
  readonly delivered: ReadonlyArray<Delivery>;
  /** End of the observation window. */
  readonly to: Date;
  readonly maxAgeHours: number;
  readonly windowHours: number;
}): Evaluation => {
  const { configured, delivered, to, maxAgeHours, windowHours } = input;
  const failures: string[] = [];
  const advisories: string[] = [];

  if (configured.length === 0) {
    failures.push("no cron trigger is configured on the Worker");
  }

  const sorted = [...delivered].sort((a, b) => a.at.getTime() - b.at.getTime());
  const newest = sorted.at(-1);

  if (newest === undefined) {
    failures.push(
      `no scheduled delivery in the last ${windowHours}h — the trigger never fired, or the window ` +
        `is too short (a freshly attached trigger takes 6-11 minutes; a daily one up to 24h)`,
    );
    return { ok: failures.length === 0, failures, advisories };
  }

  if (configured.length > 0 && !configured.includes(newest.cron)) {
    failures.push(
      `newest delivery used "${newest.cron}", which is not configured (${JSON.stringify(configured)})` +
        ` — the platform is replaying a retired schedule`,
    );
  }

  const ageHours = (to.getTime() - newest.at.getTime()) / 3_600_000;
  if (ageHours > maxAgeHours) {
    failures.push(
      `newest delivery is ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h) — delivery has stalled`,
    );
  }

  if (newest.outcome !== "ok") {
    failures.push(`newest scheduled invocation finished "${newest.outcome}", not ok`);
  }

  const retired = sorted.filter((event) => !configured.includes(event.cron));
  if (retired.length > 0) {
    const last = retired.at(-1);
    advisories.push(
      `${retired.length} of ${sorted.length} deliveries in this window used a retired expression` +
        (last ? ` (last at ${last.at.toISOString()})` : "") +
        `; harmless once the newest delivery is current, anomalous if it is not`,
    );
  }

  return { ok: failures.length === 0, failures, advisories };
};
