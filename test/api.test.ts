/**
 * Offline unit tests for the Worker in `src/Api.ts`.
 *
 * No network, no Cloudflare account, no workerd: the bindings are hand-written
 * structural interfaces (`Env`), so this file fakes each one in memory.
 *
 *   PHOTOS  -> FakeR2      Map of key -> { text, contentType }
 *   DB      -> FakeD1      switches on the handful of normalised SQL strings the
 *                          Worker actually issues; unknown SQL throws loudly so a
 *                          new query in src/Api.ts cannot pass silently
 *   CACHE   -> FakeKV      Map, TTL recorded but not expired
 *   EVENTS  -> FakeQueue   captures `send` bodies
 *   COUNTER -> FakeDoNamespace
 *                          `idFromName`/`get` return a stub whose `fetch`
 *                          delegates to a real `new Counter(state, env)`, so DO
 *                          behaviour is exercised rather than mocked
 *
 * The fakes also stand in for Cloudflare's real semantics where the Worker relies
 * on them: R2 `size` is the UTF-8 byte length, `DELETE` reports only that the
 * statement succeeded, D1 errors throw out of `run()`.
 *
 * Run with `pnpm test` (single pass) or `pnpm test:watch`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import Api, {
  Counter,
  type D1Like,
  type D1Result,
  type D1Statement,
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type DurableObjectStubLike,
  type Env,
  type KVLike,
  type QueueBatchLike,
  type QueueMessageLike,
  type QueueProducerLike,
  type R2BucketLike,
  type R2ObjectLike,
  type ScheduledControllerLike,
} from "../src/Api.ts";

/* ------------------------------------------------------------------ */
/* literals mirrored from src/Api.ts                                   */
/* ------------------------------------------------------------------ */

/** `INDEX_CACHE_KEY` in src/Api.ts. */
const INDEX_CACHE_KEY = "photos:index";
/** `CACHE_TTL_SECONDS` in src/Api.ts. */
const CACHE_TTL_SECONDS = 60;

/** The D1 statements the Worker issues, normalised to single-space form. */
const SQL = {
  listPhotos:
    "SELECT key, bytes, content_type, created_at FROM photos ORDER BY created_at DESC LIMIT 100",
  countAudit: "SELECT COUNT(*) AS n FROM audit_events",
  listAudit: "SELECT id, type, detail, at FROM audit_events ORDER BY at DESC LIMIT 25",
  getPhoto: "SELECT key, bytes, content_type, created_at FROM photos WHERE key = ?",
  insertPhoto: "INSERT INTO photos",
  deletePhoto: "DELETE FROM photos WHERE key = ?",
  insertAudit: "INSERT INTO audit_events (id, type, detail, at) VALUES (?, ?, ?, ?)",
} as const;

interface PhotoRow {
  key: string;
  bytes: number;
  content_type: string;
  created_at: string;
}

interface AuditRow {
  id: string;
  type: string;
  detail: string;
  at: string;
}

interface PhotoEvent {
  id: string;
  type: string;
  key: string;
  bytes: number;
  at: string;
}

const normaliseSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ */
/* D1 fake                                                             */
/* ------------------------------------------------------------------ */

class FakeD1Statement implements D1Statement {
  readonly db: FakeD1;
  readonly sql: string;
  values: ReadonlyArray<string | number> = [];

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: ReadonlyArray<string | number>): D1Statement {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      results: this.db.selectRows(this.sql, this.values) as unknown as ReadonlyArray<T>,
      success: true,
    };
  }

  async run(): Promise<{ readonly success: boolean; readonly meta: Record<string, unknown> }> {
    return this.db.runMutation(this.sql, this.values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.selectRows(this.sql, this.values)[0];
    return row === undefined ? null : (row as unknown as T);
  }
}

class FakeD1 implements D1Like {
  readonly photos = new Map<string, PhotoRow>();
  readonly audit: AuditRow[] = [];
  /** Every normalised statement seen, in order — useful for cache assertions. */
  readonly statements: string[] = [];
  /** How many times the index-listing query reached "D1". */
  listCalls = 0;
  /** When true, `INSERT INTO audit_events` throws like a locked/unavailable D1. */
  failAuditInsert = false;

  prepare(query: string): D1Statement {
    const sql = normaliseSql(query);
    this.statements.push(sql);
    return new FakeD1Statement(this, sql);
  }

  selectRows(sql: string, values: ReadonlyArray<string | number>): ReadonlyArray<unknown> {
    if (sql === SQL.listPhotos) {
      this.listCalls += 1;
      return [...this.photos.values()]
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .slice(0, 100);
    }
    if (sql === SQL.countAudit) {
      return [{ n: this.audit.length }];
    }
    if (sql === SQL.listAudit) {
      return [...this.audit]
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, 25);
    }
    if (sql === SQL.getPhoto) {
      const key = values[0];
      const row = typeof key === "string" ? this.photos.get(key) : undefined;
      return row === undefined ? [] : [row];
    }
    throw new Error(`FakeD1: unhandled SELECT (did src/Api.ts gain a query?): ${sql}`);
  }

  runMutation(
    sql: string,
    values: ReadonlyArray<string | number>,
  ): { readonly success: boolean; readonly meta: Record<string, unknown> } {
    if (sql.startsWith(SQL.insertPhoto)) {
      const [key, bytes, contentType, createdAt] = values;
      const row: PhotoRow = {
        key: String(key),
        bytes: Number(bytes),
        content_type: String(contentType),
        created_at: String(createdAt),
      };
      // ON CONFLICT(key) DO UPDATE — the Worker relies on the upsert.
      this.photos.set(row.key, row);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql === SQL.deletePhoto) {
      const key = String(values[0]);
      const existed = this.photos.delete(key);
      return { success: true, meta: { changes: existed ? 1 : 0 } };
    }
    if (sql === SQL.insertAudit) {
      if (this.failAuditInsert) {
        throw new Error("D1_ERROR: simulated database unavailable");
      }
      const [id, type, detail, at] = values;
      this.audit.push({
        id: String(id),
        type: String(type),
        detail: String(detail),
        at: String(at),
      });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`FakeD1: unhandled statement (did src/Api.ts gain a query?): ${sql}`);
  }
}

/* ------------------------------------------------------------------ */
/* R2 fake                                                             */
/* ------------------------------------------------------------------ */

const r2Object = (text: string, contentType: string): R2ObjectLike => {
  const bytes = encoder.encode(text);
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    // Real R2 reports the object size in bytes, not JS string length.
    size: bytes.byteLength,
    httpMetadata: { contentType },
    text: async () => text,
  };
};

class FakeR2 implements R2BucketLike {
  readonly objects = new Map<string, { text: string; contentType: string }>();

  async get(key: string): Promise<R2ObjectLike | null> {
    const object = this.objects.get(key);
    return object === undefined ? null : r2Object(object.text, object.contentType);
  }

  async put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType: string } },
  ): Promise<unknown> {
    const contentType = options?.httpMetadata?.contentType ?? "text/plain";
    this.objects.set(key, { text: value, contentType });
    return { key, size: encoder.encode(value).byteLength };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* KV fake                                                             */
/* ------------------------------------------------------------------ */

class FakeKV implements KVLike {
  readonly store = new Map<string, string>();
  /** Every write, with the TTL the Worker asked for (expiry itself is ignored). */
  readonly writes: Array<{ key: string; expirationTtl: number | undefined }> = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.writes.push({ key, expirationTtl: options?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Queue fakes                                                         */
/* ------------------------------------------------------------------ */

class FakeQueue implements QueueProducerLike {
  readonly sent: unknown[] = [];

  async send(body: unknown): Promise<void> {
    this.sent.push(body);
  }
}

class FakeQueueMessage implements QueueMessageLike {
  readonly body: unknown;
  acks = 0;
  retries = 0;

  constructor(body: unknown) {
    this.body = body;
  }

  ack(): void {
    this.acks += 1;
  }

  retry(): void {
    this.retries += 1;
  }
}

const makeBatch = (...messages: ReadonlyArray<QueueMessageLike>): QueueBatchLike => ({ messages });

/* ------------------------------------------------------------------ */
/* Durable Object fakes                                                */
/* ------------------------------------------------------------------ */

class FakeDoStorage implements DurableObjectStorageLike {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}

const requestFrom = (
  input: string | Request,
  init?: { method?: string; body?: string },
): Request => (typeof input === "string" ? new Request(input, init) : input);

/**
 * Stands in for `DurableObjectNamespace`. One real `Counter` instance per
 * storage per name, exactly like the runtime: the stub's `fetch` delegates to it.
 */
class FakeDoNamespace implements DurableObjectNamespaceLike {
  readonly storages = new Map<string, FakeDoStorage>();
  readonly counters = new Map<string, Counter>();
  envProvider: () => Env = () => {
    throw new Error("FakeDoNamespace: env not bound yet");
  };

  idFromName(name: string): DurableObjectIdLike {
    return { toString: () => name };
  }

  get(id: DurableObjectIdLike): DurableObjectStubLike {
    const counter = this.counterFor(id.toString());
    return {
      fetch: (input, init) => counter.fetch(requestFrom(input, init)),
    };
  }

  counterFor(name: string): Counter {
    const existing = this.counters.get(name);
    if (existing !== undefined) {
      return existing;
    }
    let storage = this.storages.get(name);
    if (storage === undefined) {
      storage = new FakeDoStorage();
      this.storages.set(name, storage);
    }
    const state: DurableObjectStateLike = { storage };
    const counter = new Counter(state, this.envProvider());
    this.counters.set(name, counter);
    return counter;
  }
}

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface Harness {
  env: Env;
  r2: FakeR2;
  d1: FakeD1;
  kv: FakeKV;
  queue: FakeQueue;
  counter: FakeDoNamespace;
}

const createHarness = (): Harness => {
  const r2 = new FakeR2();
  const d1 = new FakeD1();
  const kv = new FakeKV();
  const queue = new FakeQueue();
  const counter = new FakeDoNamespace();
  const env: Env = {
    PHOTOS: r2,
    DB: d1,
    CACHE: kv,
    COUNTER: counter,
    EVENTS: queue,
  };
  counter.envProvider = () => env;
  return { env, r2, d1, kv, queue, counter };
};

let harness: Harness = createHarness();

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  Api.fetch(new Request(`https://api.test${path}`, init), harness.env);

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const putPhoto = (key: string, body: string, contentType = "text/plain"): Promise<Response> =>
  fetchWorker(`/photos/${key}`, { method: "PUT", body, headers: { "content-type": contentType } });

/**
 * Pins a row's `created_at`. Two PUTs inside one millisecond would otherwise make
 * `ORDER BY created_at DESC` order-dependent on Map insertion order.
 */
const setCreatedAt = (key: string, at: string): void => {
  const row = harness.d1.photos.get(key);
  if (row !== undefined) {
    harness.d1.photos.set(key, { ...row, created_at: at });
  }
};

beforeEach(() => {
  harness = createHarness();
});

/* ------------------------------------------------------------------ */
/* fetch: health + unknown routes                                      */
/* ------------------------------------------------------------------ */

describe("GET /health", () => {
  it("returns 200 and an ISO timestamp without touching a binding", async () => {
    const response = await fetchWorker("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await readJson<{ ok: boolean; time: string }>(response);
    expect(body.ok).toBe(true);
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
    // No binding was consulted at all.
    expect(harness.d1.statements).toEqual([]);
    expect(harness.kv.writes).toEqual([]);
  });
});

describe("unknown routes", () => {
  it("returns 404 for a path the Worker does not serve", async () => {
    const response = await fetchWorker("/nope");

    expect(response.status).toBe(404);
    expect(await readJson<{ error: string; path: string }>(response)).toMatchObject({
      error: "not found",
      path: "/nope",
    });
  });

  it("normalises a trailing slash before routing", async () => {
    const response = await fetchWorker("/health/");

    expect(response.status).toBe(200);
    expect((await readJson<{ ok: boolean }>(response)).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* fetch: PUT /photos/<key>                                            */
/* ------------------------------------------------------------------ */

describe("PUT /photos/<key>", () => {
  it("returns 201 and writes R2, D1, the KV cache bust and the Queue", async () => {
    // A warm index that the write must invalidate.
    harness.kv.store.set(INDEX_CACHE_KEY, JSON.stringify([]));

    const response = await putPhoto("x", "hi");

    expect(response.status).toBe(201);
    const body = await readJson<{
      key: string;
      bytes: number;
      contentType: string;
      createdAt: string;
      queued: string;
    }>(response);
    expect(body).toMatchObject({ key: "x", bytes: 2, contentType: "text/plain" });
    expect(typeof body.queued).toBe("string");

    // 1. R2 body
    expect(harness.r2.objects.get("x")).toEqual({ text: "hi", contentType: "text/plain" });
    // 2. D1 row (subset — created_at is asserted below)
    const row = harness.d1.photos.get("x");
    expect(row).toBeDefined();
    expect(row).toMatchObject({ key: "x", bytes: 2, content_type: "text/plain" });
    expect(row?.created_at).toBe(body.createdAt);
    // 3. KV cache bust
    expect(harness.kv.store.has(INDEX_CACHE_KEY)).toBe(false);
    // 4. Queue message
    expect(harness.queue.sent).toHaveLength(1);
    expect(harness.queue.sent[0]).toMatchObject({
      id: body.queued,
      type: "photo.put",
      key: "x",
      bytes: 2,
    });
  });

  it("upserts an existing key instead of failing on a duplicate", async () => {
    await putPhoto("dup", "one");
    const response = await putPhoto("dup", "second");

    expect(response.status).toBe(201);
    expect(harness.d1.photos.size).toBe(1);
    expect(harness.d1.photos.get("dup")?.bytes).toBe(6);
    expect(harness.r2.objects.get("dup")?.text).toBe("second");
  });

  it("honours the request content-type in R2 and D1", async () => {
    await putPhoto("photo.png", "binary", "image/png");

    expect(harness.r2.objects.get("photo.png")?.contentType).toBe("image/png");
    expect(harness.d1.photos.get("photo.png")?.content_type).toBe("image/png");
  });
});

/* ------------------------------------------------------------------ */
/* fetch: GET /photos (KV cache in front of D1)                        */
/* ------------------------------------------------------------------ */

describe("GET /photos", () => {
  it("misses the cache, reads D1, refills KV; the second call hits KV and skips D1", async () => {
    await putPhoto("a", "one");
    await putPhoto("b", "two");
    setCreatedAt("a", "2026-10-23T00:00:00.000Z");
    setCreatedAt("b", "2026-10-23T00:00:01.000Z");

    const first = await fetchWorker("/photos");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("miss");
    const firstBody = await readJson<{ source: string; photos: ReadonlyArray<PhotoRow> }>(first);
    expect(firstBody.source).toBe("d1");
    expect(firstBody.photos.map((photo) => photo.key)).toEqual(["b", "a"]);

    // The miss refilled the cache with the Worker's 60s TTL.
    expect(harness.kv.writes.at(-1)).toEqual({
      key: INDEX_CACHE_KEY,
      expirationTtl: CACHE_TTL_SECONDS,
    });
    expect(harness.d1.listCalls).toBe(1);

    const second = await fetchWorker("/photos");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("hit");
    const secondBody = await readJson<{ source: string; photos: ReadonlyArray<PhotoRow> }>(second);
    expect(secondBody.source).toBe("kv");
    expect(secondBody.photos.map((photo) => photo.key)).toEqual(["b", "a"]);
    // A cache hit never reaches D1.
    expect(harness.d1.listCalls).toBe(1);
  });

  it("returns an empty list and still populates the cache when there are no rows", async () => {
    const response = await fetchWorker("/photos");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-cache")).toBe("miss");
    expect((await readJson<{ photos: ReadonlyArray<PhotoRow> }>(response)).photos).toEqual([]);
    expect(harness.kv.store.has(INDEX_CACHE_KEY)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* fetch: GET /photos/<key>                                            */
/* ------------------------------------------------------------------ */

describe("GET /photos/<key>", () => {
  it("serves the R2 body with content-type and created-at from the D1 row", async () => {
    await putPhoto("doc.txt", "hello", "text/plain");

    const response = await fetchWorker("/photos/doc.txt");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-photo-bytes")).toBe("5");
    expect(response.headers.get("x-photo-created")).toBe(
      harness.d1.photos.get("doc.txt")?.created_at ?? "",
    );
    expect(await response.text()).toBe("hello");
  });

  it("returns 404 when the key is missing", async () => {
    const response = await fetchWorker("/photos/absent");

    expect(response.status).toBe(404);
    expect(await readJson<{ error: string; key: string }>(response)).toMatchObject({
      error: "object not found in R2",
      key: "absent",
    });
  });

  it("still serves an object whose D1 row is gone, with fallback headers", async () => {
    // Simulates out-of-band R2 content (or a half-applied delete).
    harness.r2.objects.set("orphan", { text: "loose", contentType: "text/plain" });

    const response = await fetchWorker("/photos/orphan");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("loose");
    expect(response.headers.get("x-photo-created")).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* fetch: DELETE /photos/<key>                                          */
/* ------------------------------------------------------------------ */

describe("DELETE /photos/<key>", () => {
  it("removes the object and row and busts the cache", async () => {
    await putPhoto("x", "hi");
    const warm = await fetchWorker("/photos");
    expect(warm.headers.get("x-cache")).toBe("miss");

    const response = await fetchWorker("/photos/x", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await readJson<{ key: string; deleted: boolean }>(response)).toEqual({
      key: "x",
      deleted: true,
    });
    expect(harness.r2.objects.has("x")).toBe(false);
    expect(harness.d1.photos.has("x")).toBe(false);
    expect(harness.kv.store.has(INDEX_CACHE_KEY)).toBe(false);

    // The next index read is a miss again and no longer lists the row.
    const after = await fetchWorker("/photos");
    expect(after.headers.get("x-cache")).toBe("miss");
    expect((await readJson<{ photos: ReadonlyArray<PhotoRow> }>(after)).photos).toEqual([]);
    expect((await fetchWorker("/photos/x")).status).toBe(404);
  });

  it("reports deleted: false for an absent key (affected-row count, not statement success)", async () => {
    const response = await fetchWorker("/photos/never", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await readJson<{ deleted: boolean }>(response)).toEqual({
      key: "never",
      deleted: false,
    });
  });
});

/* ------------------------------------------------------------------ */
/* fetch: missing-key guard                                            */
/* ------------------------------------------------------------------ */

describe("missing key", () => {
  it("POST /photos returns 400 naming the method used", async () => {
    const response = await fetchWorker("/photos", { method: "POST" });

    expect(response.status).toBe(400);
    expect(await readJson<{ error: string }>(response)).toEqual({
      error: "missing key in path: POST /photos/<key>",
    });
  });

  it("PUT /photos (no key) returns 400, not 404 — the guarded method matches the message", async () => {
    const response = await putPhoto("", "hi");

    expect(response.status).toBe(400);
    expect(await readJson<{ error: string }>(response)).toEqual({
      error: "missing key in path: PUT /photos/<key>",
    });
    // Nothing was written on the rejected path.
    expect(harness.r2.objects.size).toBe(0);
    expect(harness.d1.photos.size).toBe(0);
    expect(harness.queue.sent).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* queue() — the audit consumer                                        */
/* ------------------------------------------------------------------ */

describe("queue()", () => {
  const event = (id: string, key = "x"): PhotoEvent => ({
    id,
    type: "photo.put",
    key,
    bytes: 2,
    at: "2026-10-23T00:00:00.000Z",
  });

  it("writes one audit_events row per message and acks each", async () => {
    const messages = [new FakeQueueMessage(event("e1")), new FakeQueueMessage(event("e2", "y"))];

    await Api.queue(makeBatch(...messages), harness.env);

    expect(harness.d1.audit).toHaveLength(2);
    expect(harness.d1.audit[0]).toEqual({
      id: "e1",
      type: "photo.put",
      detail: "x (2 bytes)",
      at: "2026-10-23T00:00:00.000Z",
    });
    expect(messages.map((message) => message.acks)).toEqual([1, 1]);
    expect(messages.map((message) => message.retries)).toEqual([0, 0]);
  });

  it("retries (never acks) when the D1 insert throws", async () => {
    harness.d1.failAuditInsert = true;
    const message = new FakeQueueMessage(event("e1"));

    await Api.queue(makeBatch(message), harness.env);

    expect(message.acks).toBe(0);
    expect(message.retries).toBe(1);
    expect(harness.d1.audit).toHaveLength(0);
  });

  it("keeps draining the batch after one message fails", async () => {
    harness.d1.failAuditInsert = true;
    const messages = [
      new FakeQueueMessage(event("e1")),
      new FakeQueueMessage(event("e2")),
      new FakeQueueMessage(event("e3")),
    ];

    await Api.queue(makeBatch(...messages), harness.env);

    expect(messages.map((message) => message.retries)).toEqual([1, 1, 1]);
    expect(messages.map((message) => message.acks)).toEqual([0, 0, 0]);
  });

  it("drains the pipeline end to end: PUT -> queue() -> GET /audit", async () => {
    const put = await putPhoto("flow", "hi");
    expect(put.status).toBe(201);
    const queued = (await readJson<{ queued: string }>(put)).queued;

    const message = new FakeQueueMessage(harness.queue.sent[0]);
    await Api.queue(makeBatch(message), harness.env);

    const audit = await fetchWorker("/audit");
    expect(audit.status).toBe(200);
    expect(
      await readJson<{ count: number; events: ReadonlyArray<AuditRow> }>(audit),
    ).toMatchObject({
      count: 1,
      events: [{ id: queued, type: "photo.put", detail: "flow (2 bytes)" }],
    });
  });
});

/* ------------------------------------------------------------------ */
/* scheduled() — the cron handler                                      */
/* ------------------------------------------------------------------ */

describe("scheduled()", () => {
  const controller: ScheduledControllerLike = {
    cron: "* * * * *",
    scheduledTime: 1_760_000_000_000,
  };

  it("bumps the DO cron counter and records a cron.fire row", async () => {
    await Api.scheduled(controller, harness.env);

    const stub = harness.counter.get(harness.counter.idFromName("global"));
    const snapshot = await readJson<{ count: number; cronFires: number }>(
      await stub.fetch("https://counter/snapshot"),
    );
    expect(snapshot).toEqual({ count: 0, cronFires: 1 });

    expect(harness.d1.audit).toHaveLength(1);
    expect(harness.d1.audit[0]).toMatchObject({ type: "cron.fire" });
    expect(harness.d1.audit[0]?.detail).toBe("* * * * * at 1760000000000");
  });

  it("accumulates cronFires across fires in DO storage", async () => {
    await Api.scheduled(controller, harness.env);
    await Api.scheduled(controller, harness.env);

    const stub = harness.counter.get(harness.counter.idFromName("global"));
    const snapshot = await readJson<{ cronFires: number }>(
      await stub.fetch("https://counter/snapshot"),
    );
    expect(snapshot.cronFires).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Counter Durable Object                                              */
/* ------------------------------------------------------------------ */

describe("Counter Durable Object", () => {
  it("increments across calls through the namespace stub", async () => {
    const stub = harness.counter.get(harness.counter.idFromName("global"));
    const increment = async (): Promise<Response> =>
      stub.fetch("https://counter/increment", { method: "POST" });

    expect(await readJson<{ count: number }>(await increment())).toEqual({
      count: 1,
      env: "bound",
    });
    expect((await readJson<{ count: number }>(await increment())).count).toBe(2);
    expect((await readJson<{ count: number }>(await increment())).count).toBe(3);
  });

  it("keeps state in DO storage, so a new instance continues the sequence", async () => {
    const storage = new FakeDoStorage();
    const state: DurableObjectStateLike = { storage };
    const increment = (counter: Counter): Promise<Response> =>
      counter.fetch(new Request("https://counter/increment"));

    const first = new Counter(state, harness.env);
    expect(await readJson<{ count: number }>(await increment(first))).toMatchObject({ count: 1 });

    // A fresh instance over the *same* storage — what an isolate restart gives you.
    const second = new Counter(state, harness.env);
    expect(await readJson<{ count: number }>(await increment(second))).toMatchObject({ count: 2 });

    // A fresh storage starts at zero: nothing is held at module scope.
    const other = new Counter({ storage: new FakeDoStorage() }, harness.env);
    expect(await readJson<{ count: number }>(await increment(other))).toMatchObject({ count: 1 });

    // And the first instance's storage really is the one that moved.
    expect(await storage.get<number>("count")).toBe(2);
  });

  it("returns 404 for an unknown durable object route", async () => {
    const stub = harness.counter.get(harness.counter.idFromName("global"));
    const response = await stub.fetch("https://counter/nope");

    expect(response.status).toBe(404);
    expect(await readJson<{ error: string }>(response)).toMatchObject({
      error: "unknown durable object route",
    });
  });
});

/* ------------------------------------------------------------------ */
/* GET /stats — Durable Object + D1 together                          */
/* ------------------------------------------------------------------ */

describe("GET /stats", () => {
  it("increments the DO counter and reports the audit row count", async () => {
    await Api.queue(
      makeBatch(
        new FakeQueueMessage({
          id: "e1",
          type: "photo.put",
          key: "k",
          bytes: 1,
          at: "2026-10-23T00:00:00.000Z",
        }),
      ),
      harness.env,
    );

    const first = await readJson<{
      durableObject: { name: string; requests: number };
      d1: { auditEvents: number };
    }>(await fetchWorker("/stats"));
    expect(first.durableObject).toEqual({ name: "global", requests: 1 });
    expect(first.d1.auditEvents).toBe(1);

    const second = await readJson<{ durableObject: { requests: number } }>(
      await fetchWorker("/stats"),
    );
    expect(second.durableObject.requests).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* defects the fakes expose                                            */
/* ------------------------------------------------------------------ */

describe("byte accounting", () => {
  it("records UTF-8 byte length, matching what R2 actually stores", async () => {
    // "é" is one UTF-16 code unit but two UTF-8 bytes.
    const response = await putPhoto("utf8", "é");
    expect(response.status).toBe(201);

    const stored = await harness.r2.get("utf8");
    expect(stored?.size).toBe(2);
    expect(harness.d1.photos.get("utf8")?.bytes).toBe(2);
    expect(harness.queue.sent.at(-1)).toMatchObject({ bytes: 2 });
  });
});
