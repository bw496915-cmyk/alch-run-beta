/**
 * Route probe — the dependable behavioural check for the API.
 *
 * **Why this exists next to `test/api.test.ts`.** That suite is the framework's
 * instrument (`Test.make({ dev: true })`), and its provider session runs behind
 * alchemy's RPC sidecar. In this environment the sidecar intermittently never
 * brings the Worker's HTTP server up: the deploy logs `[Api] Started →
 * http://localhost:1337/` and nothing ever listens, so the first test hangs
 * (`GOALS.md` **G8**). The *CLI* path does not have that failure mode —
 * `alchemy dev` binds 127.0.0.1:1337 every time. This probe drives that server.
 *
 * It is not a replacement for the harness or for `pnpm test:e2e` (which proves
 * the deployed bundle); it is the check that covers the routes, statuses,
 * headers and bodies the offline gate cannot see at all — 30 assertions, no
 * sidecar, no account, no deploy.
 *
 * ```sh
 * pnpm dev &          # or: ALCHEMY_STAGE=dev_probe pnpm dev
 * pnpm api-probe      # PROBE_URL overrides the default http://127.0.0.1:1337
 * ```
 *
 * Node-runnable, like the other ops scripts: global `fetch` + `node:fs` only.
 * Exits 0 only if every check passes; 1 on a failed check; 2 when the admin
 * token is missing (the admin-gated checks cannot be faked).
 */
import { readFileSync } from "node:fs";

const BASE = (process.env.PROBE_URL ?? "http://127.0.0.1:1337").replace(/\/$/, "");

const readToken = (): string | undefined => {
  const fromEnv = process.env.ADMIN_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const dotenvPath = new URL("../.env", import.meta.url).pathname;
    return /^ADMIN_TOKEN=(.*)$/m.exec(readFileSync(dotenvPath, "utf8"))?.[1]?.trim();
  } catch {
    return undefined;
  }
};

const admin = readToken();
if (!admin) {
  console.error(
    "ADMIN_TOKEN is required: the /stats and /audit checks assert the admin gate both ways.\n" +
      "Set it in the environment or in .env (never commit it).",
  );
  process.exit(2);
}

interface Check {
  label: string;
  ok: boolean;
  detail?: unknown;
}

const results: Check[] = [];
const check = (label: string, ok: boolean, detail?: unknown): void => {
  results.push({ label, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
};

interface Res {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: any;
}

const req = async (
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<Res> => {
  const request: RequestInit = { method, redirect: "manual" };
  if (init.body !== undefined) request.body = init.body;
  if (init.headers !== undefined) request.headers = init.headers;
  const response = await fetch(BASE + path, request);
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json };
};

const auth = { authorization: `Bearer ${admin}` };

// --- the route index -------------------------------------------------------
const index = await req("GET", "/");
check("GET / -> 200", index.status === 200, index.status);
check("GET / service", index.json?.service === "alch-run-beta", index.json?.service);
check("GET / index lists GET /health", "GET /health" in (index.json?.routes ?? {}));

// --- liveness --------------------------------------------------------------
const health = await req("GET", "/health");
check("GET /health -> 200 ok", health.status === 200 && health.json?.ok === true, health.status);

// --- the admin gate, both ways --------------------------------------------
const statsDenied = await req("GET", "/stats");
check("GET /stats without a token -> 401", statsDenied.status === 401, statsDenied.status);
const stats = await req("GET", "/stats", { headers: auth });
check("GET /stats with the token -> 200", stats.status === 200, { status: stats.status, body: stats.json });
check("GET /stats reports `degraded`", typeof stats.json?.degraded === "boolean", stats.json);
const auditDenied = await req("GET", "/audit");
check("GET /audit without a token -> 401", auditDenied.status === 401, auditDenied.status);

// --- the R2 + D1 round trip ------------------------------------------------
const put = await req("PUT", "/photos/hello.txt", {
  body: "Hello, World!",
  headers: { "content-type": "text/plain" },
});
check("PUT /photos/hello.txt -> 201", put.status === 201, put.status);
check(
  "PUT body shape {key, bytes, queued}",
  put.json?.key === "hello.txt" && put.json?.bytes === 13 && typeof put.json?.queued === "string",
  put.json,
);
check("PUT echoes contentType", String(put.json?.contentType ?? "").startsWith("text/plain"), put.json?.contentType);

const get = await req("GET", "/photos/hello.txt");
check("GET /photos/hello.txt -> 200", get.status === 200, get.status);
check("GET body echoes the PUT", get.text === "Hello, World!", JSON.stringify(get.text));
check("GET x-photo-bytes", get.headers["x-photo-bytes"] === "13", get.headers["x-photo-bytes"]);
check("GET content-type", (get.headers["content-type"] ?? "").startsWith("text/plain"), get.headers["content-type"]);
check(
  "GET x-photo-created",
  typeof get.headers["x-photo-created"] === "string" && get.headers["x-photo-created"] !== "undefined",
  get.headers["x-photo-created"],
);

// --- the KV cache pair (a hit must never reach D1) -------------------------
const miss = await req("GET", "/photos");
check("GET /photos cold -> x-cache: miss", miss.status === 200 && miss.headers["x-cache"] === "miss", {
  status: miss.status,
  cache: miss.headers["x-cache"],
  source: miss.json?.source,
});
check("GET /photos miss comes from d1", miss.json?.source === "d1", miss.json?.source);
const hit = await req("GET", "/photos");
check("GET /photos warm -> x-cache: hit from kv", hit.headers["x-cache"] === "hit" && hit.json?.source === "kv", {
  cache: hit.headers["x-cache"],
  source: hit.json?.source,
});

// --- the 400s that name the method ----------------------------------------
const putNoKey = await req("PUT", "/photos", { body: "x" });
check(
  "PUT /photos without a key -> 400 naming PUT",
  putNoKey.status === 400 && putNoKey.json?.error?.includes("PUT"),
  putNoKey.json,
);
const postNoKey = await req("POST", "/photos", { body: "x" });
check(
  "POST /photos without a key -> 400 naming POST",
  postNoKey.status === 400 && postNoKey.json?.error?.includes("POST"),
  postNoKey.json,
);

// --- routing edge cases ----------------------------------------------------
const putStats = await req("PUT", "/stats", { body: "x" });
check("PUT /stats -> 404 (no such route)", putStats.status === 404, putStats.status);
const slash = await req("GET", "/photos/a/b");
check(
  "GET /photos/a/b -> 404 for the object key a/b",
  slash.status === 404 && slash.json?.key === "a/b",
  { status: slash.status, key: slash.json?.key },
);

// --- delete reports affected rows -----------------------------------------
const del = await req("DELETE", "/photos/hello.txt");
check("DELETE -> {deleted: true}", del.status === 200 && del.json?.deleted === true, del.json);
const delAgain = await req("DELETE", "/photos/hello.txt");
check("DELETE again -> {deleted: false}", delAgain.status === 200 && delAgain.json?.deleted === false, delAgain.json);
const gone = await req("GET", "/photos/hello.txt");
check("GET the deleted key -> 404", gone.status === 404, gone.status);

// --- the fall-through ------------------------------------------------------
const notFound = await req("GET", "/nope");
check(
  "GET /nope -> 404 fall-through {error, method, path}",
  notFound.status === 404 &&
    notFound.json?.error === "not found" &&
    notFound.json?.method === "GET" &&
    notFound.json?.path === "/nope",
  notFound.json,
);
const delBase = await req("DELETE", "/photos");
check("DELETE /photos -> 404 fall-through", delBase.status === 404, { status: delBase.status, body: delBase.json });

// --- method handling -------------------------------------------------------
const head = await req("HEAD", "/health");
check("HEAD /health -> 200", head.status === 200, head.status);
const postHealth = await req("POST", "/health");
check("POST /health -> 200 (method-agnostic)", postHealth.status === 200 && postHealth.json?.ok === true, postHealth.status);

// --- report ----------------------------------------------------------------
for (const r of results) {
  const suffix = r.ok ? "" : `  :: ${JSON.stringify(r.detail)}`;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}${suffix}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed against ${BASE}`);
process.exit(passed === results.length ? 0 : 1);
