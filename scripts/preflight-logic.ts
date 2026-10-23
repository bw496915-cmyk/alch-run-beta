/**
 * The decision logic of the session preflight, kept free of filesystem and
 * process concerns so it can be unit-tested. `scripts/preflight.ts` performs one
 * probe; this classifies the result.
 *
 * The classification exists because a scratch directory that cannot be written
 * fails at the WRITE, not at the read. A later step that meant to stage a file
 * then reads as an empty network response or a flaky command, and the report
 * looks complete while missing whatever could not be staged. `REVIEW-2026-10-23.md`
 * rule 11 states the rule; `pnpm preflight` is its enforcer.
 */

export interface Probe {
  /** Directory the probe targeted. */
  readonly dir: string;
  /** `String(error)` when the write threw, else `null`. */
  readonly writeError: string | null;
  /** What the file contained on read-back, or `null` when the read failed. */
  readonly readBack: string | null;
  /** The nonce that was written. */
  readonly expected: string;
  /** Whether the probe file was verified absent afterwards. */
  readonly removed: boolean;
}

export type Verdict =
  | { readonly status: "ok" }
  | { readonly status: "read-only"; readonly detail: string }
  | { readonly status: "unusable"; readonly detail: string }
  | { readonly status: "silent-write"; readonly detail: string }
  | { readonly status: "leaked"; readonly detail: string };

/** Filesystem errors that mean "this directory refuses writes", not "this run was unlucky". */
const READ_ONLY_CODES: ReadonlyArray<string> = ["EPERM", "EACCES", "EROFS"];

/**
 * The classifications are deliberately distinct:
 *
 *   read-only   the session is degraded — staging, `/tmp` backups and `curl -o`
 *               will fail silently; report it as an environment failure, never
 *               retry it as a network error or a bad command.
 *   unusable    the write failed for another reason (ENOSPC, ENOTDIR, …), so the
 *               scratch space is broken rather than forbidden.
 *   silent-write the write reported success and did not take effect — the exact
 *               failure `REVIEW-2026-10-23.md` rule 14 describes, caught in the one place
 *               it is cheap to catch.
 *   leaked      the probe file could not be confirmed gone, so a later run may
 *               read scratch that predates it.
 */
export const classifyProbe = (probe: Probe): Verdict => {
  if (probe.writeError !== null) {
    const code = /^([A-Z]+):/.exec(probe.writeError)?.[1] ?? "";
    const detail = `cannot write to ${probe.dir}: ${probe.writeError}`;
    return READ_ONLY_CODES.includes(code)
      ? { status: "read-only", detail }
      : { status: "unusable", detail };
  }

  if (probe.readBack !== probe.expected) {
    return {
      status: "silent-write",
      detail:
        `wrote ${probe.dir} and the read-back did not match — the write reported ` +
        `success without taking effect`,
    };
  }

  if (!probe.removed) {
    return {
      status: "leaked",
      detail: `the probe file survived cleanup in ${probe.dir}; a later run may read stale scratch`,
    };
  }

  return { status: "ok" };
};
