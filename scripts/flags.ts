/**
 * Shared CLI flag parsing for the scripts in this directory.
 *
 * `preflight.ts` and `cron-health.ts` each grew their own `flag` helper and then
 * drifted: preflight learned to reject a following flag as a value, cron-health
 * did not. One helper, tested once (`test/flags.test.ts`), so the rule cannot
 * diverge again — and so a bad numeric flag fails loudly instead of silently
 * disabling the invariant it bounds.
 */

/**
 * Read `--name <value>` from `argv`.
 *
 * A following flag is not a value: `--dir --allow-read-only` yields the
 * fallback (or `undefined`), never the string `"--allow-read-only"`.
 */
export const readFlag = (
  argv: ReadonlyArray<string>,
  name: string,
  fallback?: string,
): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : fallback;
};

/**
 * A positive-number flag.
 *
 * Absent → the fallback. Present but not a positive finite number (empty,
 * `abc`, `0`, `-1`, or followed by another flag) → `NaN`, which the caller must
 * treat as a configuration error. Returning `NaN` rather than the fallback is
 * the point: a typo in `--max-age-hours` must not quietly widen the bound to
 * "never stale".
 */
export const readNumberFlag = (
  argv: ReadonlyArray<string>,
  name: string,
  fallback: number,
): number => {
  if (!argv.includes(`--${name}`)) return fallback;
  const raw = readFlag(argv, name);
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
};

/**
 * A **non-negative**-number flag (`>= 0`): same contract as {@link readNumberFlag},
 * but `0` is a valid value — for tolerances whose documented default is `0`
 * (e.g. `--max` on `scripts/queue-health.ts`). `readNumberFlag` rejects `0`, so it
 * cannot express that default.
 */
export const readNonNegativeNumberFlag = (
  argv: ReadonlyArray<string>,
  name: string,
  fallback: number,
): number => {
  if (!argv.includes(`--${name}`)) return fallback;
  const raw = readFlag(argv, name);
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
};
