/**
 * The Worker's runtime code.
 *
 * Bindings, four Cloudflare services:
 *   PHOTOS  -> R2 bucket    (object bodies)
 *   DB      -> D1 database  (row metadata + audit trail, via migrations/)
 *   CACHE   -> KV namespace (60s cached index)
 *   COUNTER -> Durable Object namespace (stateful request/cron counters)
 *   EVENTS  -> Queue        (producer for the audit pipeline)
 *
 * Handlers: fetch (HTTP), queue (async audit consumer), scheduled (cron).
 *
 * Bindings are described structurally rather than with
 * `@cloudflare/workers-types`, so this type-checks with a plain Node
 * toolchain. Add that package and use the real Cloudflare types (R2Bucket,
 * D1Database, KVNamespace, DurableObjectNamespace, Queue) for the full surface.
 */

/* ------------------------------------------------------------------ */
/* structural binding types                                            */
/* ------------------------------------------------------------------ */

export interface R2ObjectLike {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string };
  text(): Promise<string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface D1Result<T> {
  readonly results: ReadonlyArray<T>;
  readonly success: boolean;
}

export interface D1Statement {
  bind(...values: ReadonlyArray<string | number>): D1Statement;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<{ readonly success: boolean; readonly meta: Record<string, unknown> }>;
  first<T>(): Promise<T | null>;
}

export interface D1Like {
  prepare(query: string): D1Statement;
}

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface DurableObjectStateLike {
  readonly storage: DurableObjectStorageLike;
}

export interface DurableObjectStubLike {
  fetch(input: string | Request, init?: { method?: string; body?: string }): Promise<Response>;
}

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface QueueProducerLike {
  send(body: unknown): Promise<void>;
}

export interface QueueMessageLike {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface QueueBatchLike {
  readonly messages: ReadonlyArray<QueueMessageLike>;
}

export interface ScheduledControllerLike {
  readonly cron: string;
  readonly scheduledTime: number;
}

export interface Env {
  readonly PHOTOS: R2BucketLike;
  readonly DB: D1Like;
  readonly CACHE: KVLike;
  readonly COUNTER: DurableObjectNamespaceLike;
  readonly EVENTS: QueueProducerLike;
}

interface PhotoRow {
  readonly key: string;
  readonly bytes: number;
  readonly content_type: string;
  readonly created_at: string;
}

interface AuditRow {
  readonly id: string;
  readonly type: string;
  readonly detail: string;
  readonly at: string;
}

interface PhotoEvent {
  readonly id: string;
  readonly type: string;
  readonly key: string;
  readonly bytes: number;
  readonly at: string;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const INDEX_CACHE_KEY = "photos:index";
const CACHE_TTL_SECONDS = 60;
const COUNTER_NAME = "global";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const listPhotos = async (env: Env): Promise<ReadonlyArray<PhotoRow>> => {
  const { results } = await env.DB.prepare(
    "SELECT key, bytes, content_type, created_at FROM photos ORDER BY created_at DESC LIMIT 100",
  ).all<PhotoRow>();
  return results;
};

const counterStub = (env: Env, name = COUNTER_NAME): DurableObjectStubLike =>
  env.COUNTER.get(env.COUNTER.idFromName(name));

/* ------------------------------------------------------------------ */
/* Durable Object                                                      */
/* ------------------------------------------------------------------ */

/**
 * A plain (non-Effect) Durable Object class. Alchemy binds it by class name
 * (`Cloudflare.DurableObject("Counter", { className: "Counter" })`) and this
 * module is the Worker's `main`, so the class is exported from the entry.
 *
 * State lives in DO storage, so it survives Worker deployments and isolates.
 */
export class Counter {
  private readonly state: DurableObjectStateLike;
  private readonly env: Env;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async bump(field: string, by = 1): Promise<number> {
    const current = (await this.state.storage.get<number>(field)) ?? 0;
    const next = current + by;
    await this.state.storage.put(field, next);
    return next;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/increment":
        return json({ count: await this.bump("count"), env: this.env ? "bound" : "unbound" });
      case "/cron":
        return json({
          cronFires: await this.bump("cronFires"),
          lastCron: new Date().toISOString(),
        });
      case "/snapshot":
        return json({
          count: (await this.state.storage.get<number>("count")) ?? 0,
          cronFires: (await this.state.storage.get<number>("cronFires")) ?? 0,
        });
      default:
        return json({ error: "unknown durable object route", path: url.pathname }, 404);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // GET /stats -> Durable Object counters + audit count (three services)
    if (path === "/stats" && request.method === "GET") {
      const stub = counterStub(env);
      const counterResponse = await stub.fetch("https://counter/increment", { method: "POST" });
      const counters = (await counterResponse.json()) as { count: number };
      const audit = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_events",
      ).first<{ n: number }>();
      return json({
        durableObject: { name: COUNTER_NAME, requests: counters.count },
        d1: { auditEvents: audit?.n ?? 0 },
      });
    }

    // GET /audit -> rows written by the queue() handler, newest first
    if (path === "/audit" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, type, detail, at FROM audit_events ORDER BY at DESC LIMIT 25",
      ).all<AuditRow>();
      return json({ count: results.length, events: results });
    }

    // GET /photos -> D1 rows, served from KV when warm
    if (path === "/photos" && request.method === "GET") {
      const cached = await env.CACHE.get(INDEX_CACHE_KEY);
      if (cached !== null) {
        return json({ source: "kv", photos: JSON.parse(cached) }, 200, { "x-cache": "hit" });
      }
      const photos = await listPhotos(env);
      await env.CACHE.put(INDEX_CACHE_KEY, JSON.stringify(photos), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
      return json({ source: "d1", photos }, 200, { "x-cache": "miss" });
    }

    if (path === "/photos" && request.method === "POST") {
      return json({ error: "missing key in path: PUT /photos/<key>" }, 400);
    }

    if (path.startsWith("/photos/")) {
      const key = decodeURIComponent(path.slice("/photos/".length));
      if (key.length === 0) {
        return json({ error: "missing key in path: PUT /photos/<key>" }, 400);
      }

      if (request.method === "GET") {
        const [object, row] = await Promise.all([
          env.PHOTOS.get(key),
          env.DB.prepare(
            "SELECT key, bytes, content_type, created_at FROM photos WHERE key = ?",
          )
            .bind(key)
            .first<PhotoRow>(),
        ]);
        if (object === null) {
          return json({ error: "object not found in R2", key, row }, 404);
        }
        const body = await object.text();
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": row?.content_type ?? "text/plain; charset=utf-8",
            "x-photo-bytes": String(object.size),
            "x-photo-created": row?.created_at ?? "unknown",
          },
        });
      }

      if (request.method === "PUT") {
        const body = await request.text();
        const contentType = request.headers.get("content-type") ?? "text/plain";
        const createdAt = new Date().toISOString();

        // Object body, row metadata, cache bust — then an async audit message.
        await env.PHOTOS.put(key, body, { httpMetadata: { contentType } });
        await env.DB.prepare(
          `INSERT INTO photos (key, bytes, content_type, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             bytes = excluded.bytes,
             content_type = excluded.content_type,
             created_at = excluded.created_at`,
        )
          .bind(key, body.length, contentType, createdAt)
          .run();
        await env.CACHE.delete(INDEX_CACHE_KEY);

        const event: PhotoEvent = {
          id: crypto.randomUUID(),
          type: "photo.put",
          key,
          bytes: body.length,
          at: createdAt,
        };
        await env.EVENTS.send(event);

        return json({ key, bytes: body.length, contentType, createdAt, queued: event.id }, 201);
      }

      if (request.method === "DELETE") {
        await env.PHOTOS.delete(key);
        const deleted = await env.DB.prepare("DELETE FROM photos WHERE key = ?")
          .bind(key)
          .run();
        await env.CACHE.delete(INDEX_CACHE_KEY);
        return json({ key, deleted: deleted.success });
      }
    }

    return json({ error: "not found", method: request.method, path }, 404);
  },

  /** Queue consumer: drains the audit pipeline into D1. */
  async queue(batch: QueueBatchLike, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = message.body as PhotoEvent;
        await env.DB.prepare(
          "INSERT INTO audit_events (id, type, detail, at) VALUES (?, ?, ?, ?)",
        )
          .bind(event.id, event.type, `${event.key} (${event.bytes} bytes)`, event.at)
          .run();
        message.ack();
      } catch {
        message.retry();
      }
    }
  },

  /** Cron handler: records each fire in the Durable Object. */
  async scheduled(controller: ScheduledControllerLike, env: Env): Promise<void> {
    const stub = counterStub(env);
    await stub.fetch("https://counter/cron", { method: "POST" });
    await env.DB.prepare(
      "INSERT INTO audit_events (id, type, detail, at) VALUES (?, ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        "cron.fire",
        `${controller.cron} at ${controller.scheduledTime}`,
        new Date().toISOString(),
      )
      .run();
  },
};
