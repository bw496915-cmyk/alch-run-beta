import { describe, expect, it } from "vitest";

import { readFlag, readNonNegativeNumberFlag, readNumberFlag } from "../scripts/flags.ts";

/**
 * The scripts' flag parsing, tested once so the two copies cannot drift again.
 *
 * The invariant: a following flag is never a value (`--dir --allow-read-only`
 * must not probe a directory named "--allow-read-only"), and a numeric flag that
 * is present but unusable is `NaN` rather than the fallback — a typo must not
 * silently disable the bound it configures.
 */

describe("readFlag", () => {
  it("reads the value that follows the flag", () => {
    expect(readFlag(["--dir", "/tmp/x"], "dir")).toBe("/tmp/x");
  });

  it("returns the fallback when the flag is absent", () => {
    expect(readFlag(["--other"], "dir", "/tmp")).toBe("/tmp");
    expect(readFlag(["--other"], "dir")).toBeUndefined();
  });

  it("does not treat a following flag as a value", () => {
    expect(readFlag(["--dir", "--allow-read-only"], "dir")).toBeUndefined();
    expect(readFlag(["--dir", "--allow-read-only"], "dir", "/tmp")).toBe("/tmp");
  });

  it("returns undefined when the flag has no value", () => {
    expect(readFlag(["--dir"], "dir")).toBeUndefined();
  });
});

describe("readNumberFlag", () => {
  it("parses a positive number", () => {
    expect(readNumberFlag(["--window-hours", "12"], "window-hours", 48)).toBe(12);
  });

  it("falls back only when the flag is absent", () => {
    expect(readNumberFlag([], "window-hours", 48)).toBe(48);
  });

  it("is NaN for anything not a positive number, so the caller fails loudly", () => {
    expect(Number.isNaN(readNumberFlag(["--window-hours", "abc"], "window-hours", 48))).toBe(true);
    expect(Number.isNaN(readNumberFlag(["--window-hours", "0"], "window-hours", 48))).toBe(true);
    expect(Number.isNaN(readNumberFlag(["--window-hours", "-5"], "window-hours", 48))).toBe(true);
    expect(Number.isNaN(readNumberFlag(["--window-hours"], "window-hours", 48))).toBe(true);
    expect(
      Number.isNaN(readNumberFlag(["--window-hours", "--max-age-hours", "5"], "window-hours", 48)),
    ).toBe(true);
  });
});

describe("readNonNegativeNumberFlag", () => {
  it("accepts 0 (the default some flags document) and positive numbers", () => {
    expect(readNonNegativeNumberFlag(["--max", "0"], "max", 0)).toBe(0);
    expect(readNonNegativeNumberFlag(["--max", "3"], "max", 9)).toBe(3);
  });

  it("falls back when absent, and is NaN for a negative or unusable value", () => {
    expect(readNonNegativeNumberFlag([], "max", 7)).toBe(7);
    expect(Number.isNaN(readNonNegativeNumberFlag(["--max", "-1"], "max", 0))).toBe(true);
    expect(Number.isNaN(readNonNegativeNumberFlag(["--max", "abc"], "max", 0))).toBe(true);
    expect(Number.isNaN(readNonNegativeNumberFlag(["--max"], "max", 0))).toBe(true);
  });
});
