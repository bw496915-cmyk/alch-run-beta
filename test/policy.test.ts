import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../alchemy.run.ts";
import Api, { Counter } from "../src/Api.ts";

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

type Assert<T extends true> = T;
/** Mutual assignability: neither side may be a narrower stand-in. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Detects `any` — which is what `InferEnv` silently degrades to without workers-types. */
type IsAny<T> = 0 extends 1 & T ? true : false;

// Every binding must be the real Cloudflare type, in both directions.
type _photos = Assert<Same<ApiEnv["PHOTOS"], R2Bucket>>;
type _db = Assert<Same<ApiEnv["DB"], D1Database>>;
type _cache = Assert<Same<ApiEnv["CACHE"], KVNamespace<string>>>;
type _events = Assert<Same<ApiEnv["EVENTS"], Queue<unknown>>>;
type _counter = Assert<Same<ApiEnv["COUNTER"], DurableObjectNamespace<Counter>>>;

// …and none of them may collapse to `any`, which would make the four above vacuous.
type _noAnyPhotos = Assert<IsAny<ApiEnv["PHOTOS"]> extends false ? true : false>;
type _noAnyDb = Assert<IsAny<ApiEnv["DB"]> extends false ? true : false>;
type _noAnyCounter = Assert<IsAny<ApiEnv["COUNTER"]> extends false ? true : false>;

// Handlers keep the third argument; dropping `ctx` is how background work was lost before.
type _fetchTakesCtx = Assert<Parameters<typeof Api.fetch>["length"] extends 3 ? true : false>;
type _scheduledTakesCtx = Assert<
  Parameters<typeof Api.scheduled>["length"] extends 3 ? true : false
>;
type _fetchCtxIsExecutionContext = Assert<
  Parameters<typeof Api.fetch>[2] extends ExecutionContext ? true : false
>;

// The Durable Object speaks typed RPC. (`fetch` is inherited as optional from the
// base class, so "no URL router" is asserted at runtime below, not in types.)
type _doRpc = Assert<"increment" extends keyof Counter ? true : false>;
type _doSnapshot = Assert<"snapshot" extends keyof Counter ? true : false>;

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
  ApiEnv: "the inferred env type from Cloudflare.InferEnv — the point of the policy",
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

  it("gives the Durable Object RPC methods instead of a fetch router", () => {
    const own = (name: string): boolean =>
      Object.prototype.hasOwnProperty.call(Counter.prototype, name);

    expect(own("increment")).toBe(true);
    expect(own("recordCronFire")).toBe(true);
    expect(own("snapshot")).toBe(true);
    expect(own("fetch"), "a URL-dispatch fetch router came back").toBe(false);

    // The generic is what types `getByName(...).increment()`: without it the
    // namespace falls back to `Shape = any` and the RPC is untyped without ever
    // failing layer 3, so the binding shape is asserted rather than assumed.
    expect(readFileSync("alchemy.run.ts", "utf8")).toContain("DurableObject<Counter>(");
  });

  it("types env from the bindings, not from a local interface", () => {
    const stack = readFileSync("alchemy.run.ts", "utf8");
    expect(stack).toContain("Cloudflare.InferEnv<typeof bindings>");
    // Applying InferEnv to the Worker itself hits TS2589 once a DO binding is
    // present (the DurableObjectLike default `Shape = any` recurses). That
    // narrower input is the documented workaround (CONVENTIONS.md §Gates), so a
    // diff "restoring" the Worker form fails here instead of shipping. Comments
    // are stripped first: the file *explains* the workaround in prose, and that
    // prose must not count as the code.
    expect(codeOnly(stack)).not.toMatch(/InferEnv<typeof (Api|worker)>/);

    const worker = readFileSync("src/Api.ts", "utf8");
    expect(worker).toContain('import type { ApiEnv } from "../alchemy.run.ts"');
    // No local `Env` shape may sneak back in beside the imported one.
    expect(worker).not.toMatch(new RegExp(String.raw`\binterface\s+Env\b`));
  });
});
