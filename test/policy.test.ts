import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import Counter from "../src/Counter.ts";

/**
 * Enforces `CONVENTIONS.md` in three layers, weakest to strongest.
 *
 *   1. Behavioural greps  — cheap, and gameable by renaming.
 *   2. Declaration allow-list — fails on ANY new `interface`/`type` in `src/`,
 *      so a fifth hand-written binding fails even under a new name. The fix is
 *      an allow-list edit, which is a visible, reviewable diff.
 *   3. Type-identity assertions — compile-time. `ApiEnv` members must stay
 *      assignable in BOTH directions with the real platform types, which a
 *      hand-rolled approximation cannot satisfy however it is named.
 */

/* ------------------------------------------------------------------ */
/* layer 3: shape, checked by the compiler                             */
/* ------------------------------------------------------------------ */

/**
 * Layer 3 used to assert `ApiEnv`'s members were the real platform types
 * (`Same<ApiEnv["PHOTOS"], R2Bucket>`, `IsAny`, `Parameters<typeof Api.fetch>[2]`)
 * — the compile-time guard against a hand-written binding type.
 *
 * The Effect-native Worker has **no `env` object**: a binding is
 * `yield* Cloudflare.R2.ReadWriteBucket(Photos)`, which hands back the real
 * platform client. There is nothing left to hand-type, so that guard is now
 * **structural** and its compile-time block is gone along with the `env` it
 * checked. What remains is the Durable Object's RPC surface, asserted below —
 * and at runtime, since those methods come from the Effect the class returns
 * rather than from `Counter.prototype`.
 */

/* ------------------------------------------------------------------ */
/* layer 2: declaration allow-list                                     */
/* ------------------------------------------------------------------ */

const SOURCE_ROOTS = ["src", "alchemy.run.ts"];

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (path: string): void => {
    if (path.endsWith(".ts")) {
      out.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      walk(join(path, entry.name));
    }
  };
  for (const root of SOURCE_ROOTS) {
    if (root.endsWith(".ts")) {
      out.push(root);
    } else {
      walk(root);
    }
  }
  return out.sort();
};

const DECLARATION = /^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_]+)/gm;

const declaredNames = (): string[] => {
  const names = new Set<string>();
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(DECLARATION)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
};

/**
 * Every declaration permitted in production source, with the reason it is not a
 * hand-rolled binding type. Adding an entry is the review gate.
 */
const ALLOWED_DECLARATIONS: Record<string, string> = {
  PhotoRow: "our D1 row shape: domain data, not a Cloudflare API",
  AuditRow: "our D1 row shape",
  PhotoEvent: "our queue message body",
};

/**
 * Source with comments removed, so a doc comment that *names* a forbidden form
 * is not mistaken for the form itself.
 */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* layer 1: behavioural greps                                          */
/* ------------------------------------------------------------------ */

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /interface\s+\w+Like\b/, why: "a `…Like` structural stand-in" },
  { pattern: /new Response\(\s*JSON\.stringify/, why: "hand-built JSON — use Response.json" },
  { pattern: /https:\/\/(counter|do)\b/, why: "URL-string RPC into a Durable Object" },
  // Raw `env.DB.prepare(...)` is *not* forbidden: with `ApiEnv` it is D1Database's
  // own API. What was forbidden was the hand-typed statement interface, which the
  // declaration allow-list above covers.
];

describe("policy: exact Alchemy shape only", () => {
  it("declares nothing beyond the allow-list (a fifth hand-written binding fails here)", () => {
    const declared = declaredNames();
    const unexpected = declared.filter((name) => !(name in ALLOWED_DECLARATIONS));
    const stale = Object.keys(ALLOWED_DECLARATIONS).filter((name) => !declared.includes(name));

    expect(unexpected, `new declarations must be justified in ALLOWED_DECLARATIONS`).toEqual([]);
    expect(stale, `allow-list entries no longer declared — prune them`).toEqual([]);
  });

  it("keeps every source file free of the forbidden patterns", () => {
    const offences: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(source)) offences.push(`${file}: ${why}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("gives the Durable Object typed RPC instead of a fetch router", () => {
    const source = readFileSync("src/Counter.ts", "utf8");
    // The RPC surface comes from the Effect the class returns, so it is asserted
    // at the declaration rather than on `Counter.prototype`.
    expect(source).toContain("Cloudflare.DurableObject<Counter>()");
    expect(source).toContain("increment");
    expect(source).toContain("recordCronFire");
    expect(source).toContain("snapshot");
    expect(source, "a URL-dispatch fetch router came back").not.toMatch(/\bfetch\s*:/);
    // The generic is what types `getByName(...).increment()`.
    expect(readFileSync("src/Api.ts", "utf8")).toContain("yield* Counter");
  });

  it("binds through the Worker, not a hand-written env", () => {
    const stack = readFileSync("alchemy.run.ts", "utf8");
    // The Effect-native Worker has no `env`: no `InferEnv`, no bindings object,
    // no local Env shape — the bindings are `yield*`ed in `src/Api.ts`.
    expect(codeOnly(stack)).not.toMatch(/InferEnv|typeof bindings/);

    const worker = readFileSync("src/Api.ts", "utf8");
    expect(worker).toContain("main: import.meta.url");
    expect(worker).toContain("Cloudflare.R2.ReadWriteBucket(Photos)");
    // No local `Env` shape may sneak back in.
    expect(worker).not.toMatch(new RegExp(String.raw`\binterface\s+Env\b`));
  });
});
