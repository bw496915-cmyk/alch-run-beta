#!/usr/bin/env node
/**
 * Session preflight: is this environment usable, and is it degraded?
 *
 * `REVIEW-2026-10-23.md` rule 11 (this script is its enforcer): a scratch directory that
 * cannot be written fails at the WRITE, and that failure looks like an empty
 * network response — a report can then read complete while missing whatever
 * could not be staged. Probe at session start, not after the first write fails.
 *
 * The probe is deliberately self-checking (rule 14): it writes a nonce, reads it
 * back, compares, removes the file and confirms the removal. A probe that only
 * asserts "the write call did not throw" would repeat the bug it exists to catch.
 *
 * Usage:
 *   node scripts/preflight.ts [--dir <path>] [--allow-read-only]
 *
 *   --dir <path>        scratch directory to probe (default: $TMPDIR, else /tmp)
 *   --allow-read-only   exit 0 even when scratch is unusable — a deliberate
 *                       exception, for runs that genuinely need no scratch space
 *
 * Exit codes: 0 usable (or allowed), 1 degraded/unusable. No network, no
 * credentials, no git mutation: a dirty worktree is reported, never a failure
 * (parallel agents legitimately leave one).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { classifyProbe, type Probe, type Verdict } from "./preflight-logic.ts";
import { readFlag } from "./flags.ts";

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "usage: node scripts/preflight.ts [--dir <path>] [--allow-read-only]",
      "",
      "Probes scratch space at session start (REVIEW-2026-10-23.md rule 11) and classifies",
      "a failure as an environment failure rather than a network error or a bad",
      "command. Exits 1 when scratch is unusable, unless --allow-read-only is given.",
    ].join("\n"),
  );
  process.exit(0);
}

const SCRATCH_DIR = readFlag(argv, "dir") ?? process.env.TMPDIR ?? "/tmp";
const ALLOW_READ_ONLY = argv.includes("--allow-read-only");

const probeScratch = (dir: string): Probe => {
  const expected = randomUUID();
  const file = join(dir, `.dsh-preflight-${process.pid}-${expected.slice(0, 8)}`);
  let writeError: string | null = null;
  let readBack: string | null = null;
  let removed = false;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, expected, "utf8");
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? "EUNKNOWN" : "EUNKNOWN");
    writeError = `${String(code)}: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Only a write that was not rejected outright can hide a silent write.
  if (writeError === null) {
    try {
      readBack = readFileSync(file, "utf8");
    } catch {
      // The write claimed success and the file is unreadable: let classifyProbe
      // report that, never "ok".
      readBack = null;
    }

    try {
      rmSync(file);
    } catch {
      // Fall through: `removed` is confirmed by effect below, not by the call.
    }
    removed = existsSync(file) === false;
  }

  return { dir, writeError, readBack, expected, removed };
};

const gitStatus = (): string => {
  const result = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  // `error` is set only when git cannot be spawned. Outside a repository git
  // exits 128 with empty stdout, which would otherwise read as "clean".
  if (result.error !== undefined || result.status !== 0) return "(not a git checkout)";
  const lines = (result.stdout ?? "").split("\n").filter((line) => line.trim().length > 0);
  return lines.length === 0 ? "clean" : `dirty (${lines.length} path${lines.length === 1 ? "" : "s"})`;
};

const pnpmVersion = (): string => {
  const result = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  return result.status === 0 && result.stdout ? result.stdout.trim() : "(not installed)";
};

const pin = (): string => {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.alchemy ?? "(no alchemy dependency)";
  } catch {
    return "(package.json unreadable)";
  }
};

const verdict: Verdict = classifyProbe(probeScratch(SCRATCH_DIR));

const label = (name: string): string => name.padEnd(9);

const DEGRADED_HINT =
  "scratch is unusable: staging, /tmp backups and `curl -o` fail silently — report degraded, " +
  "do not retry as a network error";

console.log(`${label("scratch")} ${SCRATCH_DIR}  ${verdict.status === "ok" ? "ok" : `${verdict.status.toUpperCase()} — ${verdict.detail}`}`);
console.log(`${label("repo")} ${gitStatus()}`);
console.log(`${label("node")} ${process.version}   pnpm ${pnpmVersion()}`);
console.log(`${label("pin")} alchemy ${pin()}  (floor and #2235 expiry: test/docs.test.ts)`);

if (verdict.status !== "ok") {
  console.error(`\nPREFLIGHT DEGRADED — ${DEGRADED_HINT}`);
  if (!ALLOW_READ_ONLY) {
    console.error("--allow-read-only to proceed without scratch");
    process.exit(1);
  }
  console.log("PREFLIGHT DEGRADED (allowed)");
  process.exit(0);
}

console.log("\nPREFLIGHT ok");
