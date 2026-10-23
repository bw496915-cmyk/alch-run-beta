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
});
