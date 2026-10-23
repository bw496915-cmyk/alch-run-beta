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
 * `env` is typed by `ApiEnv` from the composition root (`Cloudflare.InferEnv`),
 * so it is the real `R2Bucket` / `D1Database` / `KVNamespace` /
 * `DurableObjectNamespace` / `Queue` — not a hand-written approximation.
 */

import { DurableObject } from "cloudflare:workers";

import type { ApiEnv } from "../alchemy.run.ts";

/* ------------------------------------------------------------------ */
/* domain shapes (ours, not Cloudflare's)                              */
/* ------------------------------------------------------------------ */

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
  Response.json(body, { status, headers });

/** A KV value that no longer parses is stale cache, not a request failure. */
const parseCachedIndex = (raw: string): ReadonlyArray<PhotoRow> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<PhotoRow>) : null;
  } catch {
    return null;
  }
};

const listPhotos = async (env: ApiEnv): Promise<ReadonlyArray<PhotoRow>> => {
  const db: D1Database = env.DB;
  const { results } = await db.prepare(
    "SELECT key, bytes, content_type, created_at FROM photos ORDER BY created_at DESC LIMIT 100",
  ).all<PhotoRow>();
  return results;
};

const counterStub = (env: ApiEnv, name = COUNTER_NAME) => env.COUNTER.getByName(name);

/**
 * One audit row, idempotently. Queues delivers at least once, so a redelivered
 * message must not re-insert (the id is the PK) nor fail the retry — a duplicate
 * is a no-op, not a `D1_ERROR` that burns the retry budget.
 */
const insertAuditEvent = async (
  env: ApiEnv,
  event: {
    readonly id: string;
    readonly type: string;
    readonly detail: string;
    readonly at: string;
  },
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO audit_events (id, type, detail, at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(event.id, event.type, event.detail, event.at)
    .run();
};

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
export class Counter extends DurableObject<ApiEnv> {
  /**
   * Read-modify-write under a storage transaction: concurrent requests all
   * address the "global" object, and a plain get-then-put can lose an increment.
   */
  private async bump(field: string, by = 1): Promise<number> {
    return this.ctx.storage.transaction(async (txn) => {
      const next = ((await txn.get<number>(field)) ?? 0) + by;
      await txn.put(field, next);
      return next;
    });
  }

  /** Called over DO RPC: `env.COUNTER.getByName("global").increment()`. */
  async increment(): Promise<number> {
    return this.bump("count");
  }

  /** Records one cron fire and returns the running total. */
  async recordCronFire(): Promise<number> {
    return this.bump("cronFires");
  }

  /** Both counters, without mutating anything. */
  async snapshot(): Promise<{ count: number; cronFires: number }> {
    return {
      count: (await this.ctx.storage.get<number>("count")) ?? 0,
      cronFires: (await this.ctx.storage.get<number>("cronFires")) ?? 0,
    };
  }
}

/**
 * Guard for the ops endpoints. `ADMIN_TOKEN` is a Worker secret
 * (`Config.Redacted` in `alchemy.run.ts` → `secret_text`). With none configured
 * the endpoint is refused rather than silently opened (REVIEW §4 #5).
 */
const requireAdmin = (request: Request, env: ApiEnv): Response | null => {
  const token = env.ADMIN_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    return json({ error: "admin endpoints are not configured (ADMIN_TOKEN unset)" }, 503);
  }
  const presented =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-admin-token") ??
    "";
  return presented === token ? null : json({ error: "unauthorized" }, 401);
};

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

/**
 * Route table. `fetch` wraps this so an unexpected dependency failure degrades
 * to a named 503 instead of an opaque 500 (REVIEW §4 #4).
 */
const route = async (request: Request, env: ApiEnv): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // GET /stats -> Durable Object counters + audit count (three services).
    // Admin-gated; each dependency is read independently so one failing does not
    // take the other (REVIEW §4 #4/#5).
    if (path === "/stats" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const [requests, audit] = await Promise.all([
        counterStub(env)
          .increment()
          .catch(() => null),
        env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events")
          .first<{ n: number }>()
          .catch(() => null),
      ]);
      return json({
        durableObject: { name: COUNTER_NAME, requests },
        d1: { auditEvents: audit?.n ?? null },
        degraded: requests === null || audit === null,
      });
    }

    // GET /audit -> rows written by the queue() handler, newest first (admin-gated).
    if (path === "/audit" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const { results } = await env.DB.prepare(
        "SELECT id, type, detail, at FROM audit_events ORDER BY at DESC LIMIT 25",
      ).all<AuditRow>();
      return json({ count: results.length, events: results });
    }

    // GET /photos -> D1 rows, served from KV when warm
    if (path === "/photos" && request.method === "GET") {
      const cached = await env.CACHE.get(INDEX_CACHE_KEY);
      if (cached !== null) {
        const parsed = parseCachedIndex(cached);
        if (parsed !== null) {
          return json({ source: "kv", photos: parsed }, 200, { "x-cache": "hit" });
        }
      }
      const photos = await listPhotos(env);
      await env.CACHE.put(INDEX_CACHE_KEY, JSON.stringify(photos), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
      return json({ source: "d1", photos }, 200, { "x-cache": "miss" });
    }

    if (path === "/photos" && (request.method === "PUT" || request.method === "POST")) {
      return json({ error: `missing key in path: ${request.method} /photos/<key>` }, 400);
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
        // Stream the object body: it is the platform API, and it keeps binary
        // bytes intact (reading `.text()` would re-encode them as UTF-8).
        return new Response(object.body, {
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
        const byteLength = new TextEncoder().encode(body).byteLength;
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
          .bind(key, byteLength, contentType, createdAt)
          .run();
        await env.CACHE.delete(INDEX_CACHE_KEY);

        const event: PhotoEvent = {
          id: crypto.randomUUID(),
          type: "photo.put",
          key,
          bytes: byteLength,
          at: createdAt,
        };
        await env.EVENTS.send(event);

        return json({ key, bytes: byteLength, contentType, createdAt, queued: event.id }, 201);
      }

      if (request.method === "DELETE") {
        await env.PHOTOS.delete(key);
        const deleted = await env.DB.prepare("DELETE FROM photos WHERE key = ?")
          .bind(key)
          .run();
        await env.CACHE.delete(INDEX_CACHE_KEY);
        return json({ key, deleted: Number(deleted.meta.changes ?? 0) > 0 });
      }
    }

    return json({ error: "not found", method: request.method, path }, 404);
};

export default {
  /**
   * Degrade, don't 500 (REVIEW §4 #4): an unexpected dependency failure names
   * itself and returns 503, so a client can tell "try again" from "bad request".
   */
  async fetch(request: Request, env: ApiEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      return json(
        {
          error: "dependency unavailable",
          detail: error instanceof Error ? error.message : String(error),
        },
        503,
      );
    }
  },

  /** Queue consumer: drains the audit pipeline into D1. */
  async queue(batch: MessageBatch<PhotoEvent>, env: ApiEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = message.body as PhotoEvent;
        await insertAuditEvent(env, {
          id: event.id,
          type: event.type,
          detail: `${event.key} (${event.bytes} bytes)`,
          at: event.at,
        });
        message.ack();
      } catch {
        message.retry();
      }
    }
  },

  /** Cron handler: records each fire in the Durable Object. */
  async scheduled(controller: ScheduledController, env: ApiEnv, ctx: ExecutionContext): Promise<void> {
    await counterStub(env).recordCronFire();
    await insertAuditEvent(env, {
      id: crypto.randomUUID(),
      type: "cron.fire",
      detail: `${controller.cron} at ${controller.scheduledTime}`,
      at: new Date().toISOString(),
    });
  },
};
