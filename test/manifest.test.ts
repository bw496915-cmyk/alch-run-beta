import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The manifest hole: the suite is only as good as the files that run it.
 *
 * `docs.test.ts` and `policy.test.ts` enforce rules about *documents* and
 * *source*; nothing enforced that they themselves exist and still contain their
 * tests. Deleting either file, or deleting its `it(...)` blocks, left
 * `pnpm test` green with fewer assertions — the same silent failure read as
 * success that `FAILURES.md` rule 14 describes, in the gate itself. So the
 * allow-list can only be emptied by a diff that also deletes a named, tested
 * file, and a suite cannot shrink without a visible edit here.
 *
 * What this file can see:
 *   - the expected suite set, exactly. A new suite is a manifest edit; a missing
 *     suite — `docs.test.ts` or `policy.test.ts` included — is a failure.
 *   - the declared test count against a floor. A silent drop fails; raising the
 *     floor is a one-line, reviewable diff.
 *
 * What this file cannot see — stated rather than implied:
 *   - declarations, not executed tests. A test whose body stopped asserting
 *     anything is invisible, and so is one that now runs under `describe.skip`
 *     with its `it(` still spelled the same way.
 *   - `it.skip(...)` and `it.each(...)` are deliberately *not* counted (the
 *     pattern needs the parenthesis directly after `it`/`test`). Converting a
 *     test to either form trips this gate loudly rather than passing quietly;
 *     the counter must learn the new form in the same diff.
 *   - a nested `it` indented deeper than the suite's two spaces is not counted,
 *     for the same reason: undercounting fails loudly, never silently.
 *
 * Self-protection: this file is the one file vitest cannot protect by running
 * it. `.github/workflows/ci.yml` `verify` asserts it exists before the suite
 * runs, because a deleted manifest would simply mean one fewer suite.
 */

const TEST_DIR = "test";

const EXPECTED_SUITES: ReadonlyArray<string> = [
  "test/api.test.ts",
  "test/cron-health.test.ts",
  "test/docs.test.ts",
  "test/flags.test.ts",
  "test/manifest.test.ts",
  "test/policy.test.ts",
  "test/preflight.test.ts",
];

/**
 * The floor, not the current count: 54 when this file landed (41 + preflight's
 * 5 + the five envelope cases + these three), raised to 55 with the
 * pin/workaround guard in `docs.test.ts`, to 63 with `flags.test.ts` (7) and the
 * queue-redelivery case. Raise it deliberately when adding tests; lowering it is
 * the review gate.
 */
const MIN_TESTS = 67;

/** A suite's own declarations: two-space `it(` / `test(` at the start of a line. */
const DECLARED_TEST = /^ {2}(?:it|test)\(/gm;

const walk = (dir: string): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
};

/** Paths in the same form as `EXPECTED_SUITES`: forward slashes, sorted. */
const suites = (): ReadonlyArray<string> =>
  walk(TEST_DIR)
    .map((path) => path.split(sep).join("/"))
    .sort();

const countDeclaredTests = (files: ReadonlyArray<string>): number =>
  files.reduce(
    (total, file) => total + (readFileSync(file, "utf8").match(DECLARED_TEST) ?? []).length,
    0,
  );

describe("suite manifest", () => {
  it("contains exactly the expected suites — a removal or an addition is a manifest edit", () => {
    expect(suites()).toEqual(EXPECTED_SUITES);
  });

  it("cannot lose tests without this floor being lowered in a visible diff", () => {
    const files = suites();
    const declared = countDeclaredTests(files);

    expect(
      files,
      "a suite disappeared between the manifest and the count",
    ).not.toEqual([]);
    expect(
      declared,
      `${declared} declared tests is below the floor of ${MIN_TESTS}. ` +
        "If tests were removed deliberately, lower MIN_TESTS in this file — " +
        "that diff is the review gate.",
    ).toBeGreaterThanOrEqual(MIN_TESTS);
  });

  it("counts the way the suite declares tests, and no looser", () => {
    const count = (source: string): number => (source.match(DECLARED_TEST) ?? []).length;

    const declared = `describe("x", () => {\n  it("a", () => {});\n  test("b", () => {});\n});`;
    expect(count(declared)).toBe(2);

    // A commented-out test is not a test, and must not prop the count up.
    expect(count(`//   it("commented out", () => {});`)).toBe(0);
    // Skipped and parameterised forms are not counted on purpose (limits above).
    expect(count(`  it.skip("skipped", () => {});`)).toBe(0);
    expect(count(`  it.each([1], "each", () => {});`)).toBe(0);
  });
});
