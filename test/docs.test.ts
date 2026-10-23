import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Enforces the documentation rules that were previously prose only — chiefly
 * `FAILURES.md` rule 12: *never cite an issue as "closed" without its
 * `state_reason` and the PR or commit that closed it.*
 *
 * The rule exists because `state: closed` renders identically for fixed,
 * duplicate and wontfix, and only one of those lets a workaround expire. A
 * workaround table whose expiry cannot be trusted is worse than no table: it
 * reads as scheduled maintenance while being permanently stale.
 *
 * What this file cannot see — stated, not implied, in the same form as the
 * allow-list's mutation result in `test/policy.test.ts`:
 *
 *   - **Form, not truth.** A fabricated issue number with a plausible
 *     `state_reason` and a PR reference passes every pattern below. Whether the
 *     PR merged, or the release really lists the fix, needs the changelog or a
 *     human.
 *   - **"Readable length" catches terse, not verbose-vague.** The row checks a
 *     `beta.N`/`#N` reference plus `expires.length >= 60`, so a long sentence
 *     that commits to nothing passes. Mutation transcript — executed
 *     2026-10-23, not recalled: the workaround row's expiry was replaced with a
 *     265-character sentence naming #2241 while promising only that the row
 *     "will be revisited and a decision will be made", and
 *
 *         pnpm test
 *         Test Files  6 passed (6)
 *              Tests  54 passed (54)
 *
 *     stayed green. It was reverted with `git checkout -- CONVENTIONS.md` —
 *     never a `/tmp` copy (rule 11's corollary). The limit is real, and it is
 *     recorded next to the test so a green run is not mistaken for a verified
 *     expiry.
 */

const DOCS = readdirSync(".", { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort();

const read = (file: string): string => readFileSync(file, "utf8");

/** A line that cites an issue and also claims it is closed. */
const CLOSURE_CLAIM = /closed/i;
const ISSUE_REF = /(issues\/\d+|#\d{3,})/;
/** Evidence that the closure kind was actually established. */
const CLOSURE_EVIDENCE = /state_reason|state:?\s*(completed|not_planned|duplicate)/i;
/** Evidence of what closed it: a PR/issue number, a merge, or a commit sha. */
const CLOSING_REF = /(merged(?:\s+\w+)*\s+(?:PR\s*)?#\d+|PR\s*#\d+|merge commit|`[0-9a-f]{7,40}`)/i;

interface Row {
  readonly line: number;
  readonly cells: ReadonlyArray<string>;
}

/** Rows of the markdown table under a given heading, excluding header/separator. */
const tableRows = (file: string, heading: string): ReadonlyArray<Row> => {
  const lines = read(file).split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];

  const rows: Row[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim().startsWith("|")) {
      if (rows.length > 0) break; // table ended
      continue; // still in prose between heading and table
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator
    if (cells[0]?.toLowerCase() === "workaround") continue; // header
    rows.push({ line: i + 1, cells });
  }
  return rows;
};

describe("documentation rules", () => {
  it("cites no issue as closed without a state_reason and what closed it", () => {
    const offences: string[] = [];

    for (const file of DOCS) {
      read(file)
        .split("\n")
        .forEach((line, index) => {
          if (!CLOSURE_CLAIM.test(line) || !ISSUE_REF.test(line)) return;
          const missing: string[] = [];
          if (!CLOSURE_EVIDENCE.test(line)) missing.push("state_reason");
          if (!CLOSING_REF.test(line)) missing.push("the PR/commit that closed it");
          if (missing.length > 0) {
            offences.push(`${file}:${index + 1} missing ${missing.join(" + ")}`);
          }
        });
    }

    expect(offences, "FAILURES.md rule 12: state_reason + closing PR/commit required").toEqual([]);
  });

  it("gives every workaround a verified closure and a concrete expiry trigger", () => {
    const rows = tableRows(
      "CONVENTIONS.md",
      "### Upstream workarounds in this repo, with expiry conditions",
    );

    expect(rows.length, "the workaround table disappeared — keep it, even when empty").toBeGreaterThan(0);

    const offences: string[] = [];
    for (const { line, cells } of rows) {
      const [workaround = "", issue = "", closure = "", expires = ""] = cells;

      if (cells.length !== 4) {
        offences.push(`CONVENTIONS.md:${line} has ${cells.length} cells, expected 4`);
        continue;
      }
      if (!CLOSURE_EVIDENCE.test(closure)) {
        offences.push(`CONVENTIONS.md:${line} closure lacks state_reason (fixed/duplicate/wontfix?)`);
      }
      if (!CLOSING_REF.test(closure)) {
        offences.push(`CONVENTIONS.md:${line} closure names no PR/commit — evidence, not the flag`);
      }
      // "when the fix ships" is not a trigger; a release or a PR number is.
      if (!/beta\.\d+|#\d+/.test(expires)) {
        offences.push(`CONVENTIONS.md:${line} expiry is not concrete (needs a release or PR number)`);
      }
      if (expires.length < 60) {
        offences.push(`CONVENTIONS.md:${line} expiry is too terse to act on (${expires.length} chars)`);
      }
      if (!ISSUE_REF.test(issue)) {
        offences.push(`CONVENTIONS.md:${line} cites no upstream issue number`);
      }
      if (workaround.length < 20) {
        offences.push(`CONVENTIONS.md:${line} workaround is unreadably terse`);
      }
    }

    expect(offences).toEqual([]);
  });

  it("keeps the docs it enforces present", () => {
    for (const required of ["CONVENTIONS.md", "FAILURES.md", "REVIEW-2026-10-23.md", "UPGRADE.md"]) {
      expect(DOCS, `${required} is missing`).toContain(required);
    }
  });

  /**
   * The pin and the #2235 workaround move together, so the expiry in
   * `CONVENTIONS.md` is not a paragraph someone has to remember:
   *
   *   - the pin may not drop below `2.0.0-beta.82`, the release that moved
   *     Durable Objects onto the declarative `exports` map (#2135) — a pre-beta.82
   *     pin fails its first redeploy, and Cloudflare does not allow going back
   *     (MIGRATION-beta84.md §One-way door);
   *   - while the pin is below beta.84, `versionId`/`deploymentId` must stay out
   *     of the outputs (they are `undefined` on a non-versioned deploy, which is
   *     how #2235 hid: the type carried both fields);
   *   - the moment the pin reaches a release expected to carry #2241, this test
   *     fails and *is* the instruction: confirm the changelog, re-add both
   *     outputs, and assert them in the deploy output.
   *
   * Honest limit: offline this can only assert that the outputs are *declared*.
   * "Defined" needs a real deploy — `__stack_output__.json` after `pnpm deploy`,
   * which UPGRADE.md step 4 reads.
   */
  it("keeps the pin above the exports-era floor and the versionId workaround in step with it", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    const pin = pkg.dependencies?.alchemy ?? "";
    const match = /^2\.0\.0-beta\.(\d+)$/.exec(pin);
    expect(match, `alchemy pin "${pin}" is not a 2.0.0-beta.N release`).not.toBeNull();
    const beta = Number(match?.[1] ?? "0");
    const stack = read("alchemy.run.ts");

    expect(beta, "pin is below the exports-era floor, alchemy@2.0.0-beta.82").toBeGreaterThanOrEqual(82);

    // Property syntax only: the comment in alchemy.run.ts names both fields and
    // must not count as having surfaced them.
    const surfaced = /(?:versionId|deploymentId)\s*:/.test(stack);

    if (beta < 84) {
      expect(
        surfaced,
        "pin is below beta.84; versionId/deploymentId must stay out of the outputs — " +
          "on this pin they are undefined, which is #2235 (CONVENTIONS.md workarounds)",
      ).toBe(false);
    } else {
      expect(
        surfaced,
        "pin is ≥ beta.84: confirm the changelog lists #2241, re-add versionId and " +
          "deploymentId to the stack outputs, and assert they are DEFINED in " +
          "__stack_output__.json after deploy — not merely present on the type",
      ).toBe(true);
      expect(stack, "versionId output is missing").toMatch(/versionId\s*:/);
      expect(stack, "deploymentId output is missing").toMatch(/deploymentId\s*:/);
    }
  });
});
