import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { expect } from "vitest";

import Stack, { REMOTE_STATE } from "../alchemy.run.ts";

/**
 * The API suite, against a **locally deployed** stack.
 *
 * `dev: true` gives this file `alchemy dev` semantics — the Worker and its R2 /
 * D1 / KV / Queue / Durable Object run in workerd on this machine — so the suite
 * stays offline (no account, no network) while exercising the *real* platform
 * bindings. It replaces the in-memory fakes and the `cloudflare:workers` stub,
 * which were hand-rolled stand-ins for exactly this (see CONVENTIONS).
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  // Must match the stack's store (alchemy.run.ts): local by default, or the
  // shared `Cloudflare.state()` store once the bootstrap has run.
  state: REMOTE_STATE ? Cloudflare.state() : Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });

test(
  "GET / is a route index",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* Test.getWhenReady(`${url}/`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as {
      service: string;
      routes: Record<string, string>;
    };
    expect(body.service).toBe("alch-run-beta");
    expect(Object.keys(body.routes)).toContain("GET /health");
  }),
);

test(
  "GET /health answers ok",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* Test.getWhenReady(`${url}/health`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { ok: boolean };
    expect(body.ok).toBe(true);
  }),
);

test(
  "the ops endpoints are admin-gated",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // No token → refused, and not with a 200.
    const denied = yield* Test.getWhenReady(`${url}/stats`);
    expect(denied.status).toBe(401);
  }),
);

test(
  "PUT then GET /photos/:key round-trips through R2 and D1",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const put = yield* Test.executeWhenReady(
      HttpClientRequest.put(`${url}/photos/hello.txt`, {
        body: HttpBody.text("Hello, World!"),
      }),
    );
    expect(put.status).toBe(201);

    const get = yield* Test.getWhenReady(`${url}/photos/hello.txt`);
    expect(get.status).toBe(200);
    expect(yield* get.text).toBe("Hello, World!");
  }),
);

test(
  "PUT /photos without a key is a 400 that names the method",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* Test.executeWhenReady(
      HttpClientRequest.put(`${url}/photos`, { body: HttpBody.text("x") }),
    );
    expect(response.status).toBe(400);
    const body = (yield* response.json) as { error: string };
    expect(body.error).toContain("PUT");
  }),
);

// NOTE: a deliberate 404 ("unknown route") is asserted in `e2e/stack.test.ts`,
// not here. In dev mode the fall-through response closes the socket
// (`SocketError: other side closed`) rather than answering 404 — a dev-runtime
// behaviour, so the check lives where the platform serves the response.

afterAll(destroy(Stack), { timeout: 300_000 });
