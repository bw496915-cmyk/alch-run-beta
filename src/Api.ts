import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { Cache } from "./Cache.ts";
import Counter from "./Counter.ts";
import { Db } from "./Db.ts";
import { Photos } from "./Photos.ts";
import { Events } from "./QueueEvents.ts";

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

const INDEX_CACHE_KEY = "photos:index";
const CACHE_TTL_SECONDS = 60;
const COUNTER_NAME = "global";

const json = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) =>
  HttpServerResponse.json(body, init);

/**
 * The Worker, Effect-native.
 *
 * `main: import.meta.url` — this module *is* the Worker. Bindings are
 * `yield*`ed services rather than an `env` object, so every call is typed by the
 * real platform client; the queue consumer and the cron are *event sources*
 * (`consumeQueueMessages`, `cron`), because `Platform.Main` carries `fetch`
 * only. Retention and the degrade/audit semantics are unchanged from the async
 * version.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Photos);
    const db = yield* Cloudflare.D1.QueryDatabase(Db);
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(Cache);
    const events = yield* Events;
    const queue = yield* Cloudflare.Queues.WriteQueue(events);
    const counters = yield* Counter;
    // The event-source consumer's `deadLetterQueue` is a plain `string`, not an
    // `Input<string>`, so it cannot take the generated `queueName` the way the
    // async `Queues.Consumer` resource can (a Resource's props are Input-wrapped).
    // So the queue gets an explicit name and the consumer is handed the same
    // literal. Two things the name must respect: `QueueProps.name` is used
    // verbatim (no interpolation), and Cloudflare rejects underscore names
    // (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`) — while stage ids may contain `_`
    // (`test_nolarose`). Hence the sanitising, and the stage in the name keeps it
    // unique per stage.
    const { stage } = yield* Alchemy.Stack;
    const deadLetterName = `auditdeadletter-${stage.replace(/_/g, "-")}`;
    yield* Cloudflare.Queues.Queue("AuditDeadLetter", { name: deadLetterName });
    // `Config.Redacted` registers the binding at deploy time and yields the value
    // at runtime. The default keeps the old "unconfigured → 503" behaviour
    // instead of failing the deploy.
    const adminToken = yield* Config.Redacted("ADMIN_TOKEN").pipe(
      Config.withDefault(Redacted.make("")),
    );

    /** One audit row, idempotently (the id is the PK, so a redelivery is a no-op). */
    const insertAuditEvent = (event: {
      readonly id: string;
      readonly type: string;
      readonly detail: string;
      readonly at: string;
    }) =>
      db
        .prepare(
          `INSERT INTO audit_events (id, type, detail, at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(event.id, event.type, event.detail, event.at)
        .run()
        .pipe(Effect.asVoid);

    // Consumer: the audit pipeline, as an event source. A failing message
    // retries; `maxRetries` then parks it on the dead-letter queue.
    yield* Cloudflare.Queues.consumeQueueMessages<PhotoEvent>(
      events,
      {
        batchSize: 10,
        maxRetries: 3,
        maxWaitTime: "5 seconds",
        deadLetterQueue: deadLetterName,
      },
      (stream) =>
        Stream.runForEach(stream, (message) =>
          insertAuditEvent({
            id: message.body.id,
            type: message.body.type,
            detail: `${message.body.key} (${message.body.bytes} bytes)`,
            at: message.body.at,
          }),
        ),
    );

    // Daily housekeeping: the cron is an event source too.
    yield* Cloudflare.Workers.cron("0 3 * * *", (controller) =>
      Effect.gen(function* () {
        yield* counters.getByName(COUNTER_NAME).recordCronFire();
        yield* insertAuditEvent({
          id: crypto.randomUUID(),
          type: "cron.fire",
          detail: `${controller.cron} at ${controller.scheduledTime}`,
          at: new Date().toISOString(),
        });
      }),
    );

    const requireAdmin = (
      authorization: string | undefined,
      xAdminToken: string | undefined,
    ) => {
      const expected = Redacted.value(adminToken);
      if (expected.length === 0) {
        return json(
          { error: "admin endpoints are not configured (ADMIN_TOKEN unset)" },
          { status: 503 },
        );
      }
      const presented = authorization?.replace(/^Bearer\s+/i, "") ?? xAdminToken ?? "";
      return presented === expected
        ? Effect.succeed(null)
        : json({ error: "unauthorized" }, { status: 401 });
    };

    const listPhotos = db
      .prepare(
        "SELECT key, bytes, content_type, created_at FROM photos ORDER BY created_at DESC LIMIT 100",
      )
      .all<PhotoRow>();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = request.url.replace(/\/+$/, "") || "/";
        const method = request.method;

        if (path === "/") {
          return yield* json({
            service: "alch-run-beta",
            routes: {
              "GET /": "this index",
              "GET /health": "liveness",
              "GET /stats": "DO + D1 counters; admin: Authorization: Bearer ADMIN_TOKEN",
              "GET /audit": "audit rows; admin",
              "GET /photos": "photo index (KV-cached)",
              "GET /photos/:key": "R2 body + D1 metadata",
              "PUT /photos/:key": "store a body, upsert metadata, enqueue an audit event",
              "DELETE /photos/:key": "remove the object + row",
            },
            docs: "https://github.com/bw496915-cmyk/alch-run-beta",
          });
        }

        if (path === "/health") {
          return yield* json({ ok: true, time: new Date().toISOString() });
        }

        // Both ops endpoints are admin-gated; each dependency is read
        // independently so one failing does not take the other.
        if ((path === "/stats" || path === "/audit") && method === "GET") {
          const denied = yield* requireAdmin(
            request.headers["authorization"],
            request.headers["x-admin-token"],
          );
          if (denied !== null) return denied;

          if (path === "/stats") {
            const [requests, audit] = yield* Effect.all(
              [
                counters
                  .getByName(COUNTER_NAME)
                  .increment()
                  .pipe(Effect.catch(() => Effect.succeed(null))),
                db
                  .prepare("SELECT COUNT(*) AS n FROM audit_events")
                  .first<{ n: number }>()
                  .pipe(Effect.catch(() => Effect.succeed(null))),
              ],
              { concurrency: "unbounded" },
            );
            return yield* json({
              durableObject: { name: COUNTER_NAME, requests },
              d1: { auditEvents: audit?.n ?? null },
              degraded: requests === null || audit === null,
            });
          }

          const { results } = yield* db
            .prepare("SELECT id, type, detail, at FROM audit_events ORDER BY at DESC LIMIT 25")
            .all<AuditRow>();
          return yield* json({ count: results.length, events: results });
        }

        if (path === "/photos" && method === "GET") {
          const cached = yield* kv.get(INDEX_CACHE_KEY);
          if (cached !== null) {
            const parsed = (() => {
              try {
                const value: unknown = JSON.parse(cached);
                return Array.isArray(value) ? (value as ReadonlyArray<PhotoRow>) : null;
              } catch {
                return null;
              }
            })();
            if (parsed !== null) {
              return yield* json({ source: "kv", photos: parsed }, { headers: { "x-cache": "hit" } });
            }
          }
          const { results } = yield* listPhotos;
          yield* kv.put(INDEX_CACHE_KEY, JSON.stringify(results), {
            expirationTtl: CACHE_TTL_SECONDS,
          });
          return yield* json({ source: "d1", photos: results }, { headers: { "x-cache": "miss" } });
        }

        if (path === "/photos" && (method === "PUT" || method === "POST")) {
          return yield* json({ error: `missing key in path: ${method} /photos/<key>` }, { status: 400 });
        }

        if (path.startsWith("/photos/")) {
          const key = decodeURIComponent(path.slice("/photos/".length));
          if (key.length === 0) {
            return yield* json({ error: "missing key in path: PUT /photos/<key>" }, { status: 400 });
          }

          if (method === "GET") {
            const [object, row] = yield* Effect.all(
              [
                bucket.get(key),
                db
                  .prepare("SELECT key, bytes, content_type, created_at FROM photos WHERE key = ?")
                  .bind(key)
                  .first<PhotoRow>(),
              ],
              { concurrency: "unbounded" },
            );
            if (object === null) {
              return yield* json({ error: "object not found in R2", key, row }, { status: 404 });
            }
            // Stream the stored object body: it is the platform API and it keeps
            // binary bytes intact (reading `.text()` would re-encode them).
            return HttpServerResponse.fromWeb(
              new Response(Stream.toReadableStream(object.body), {
                status: 200,
                headers: {
                  "content-type": row?.content_type ?? "text/plain; charset=utf-8",
                  "x-photo-bytes": String(object.size),
                  "x-photo-created": row?.created_at ?? "unknown",
                },
              }),
            );
          }

          if (method === "PUT") {
            const body = yield* request.text;
            const byteLength = new TextEncoder().encode(body).byteLength;
            const contentType = request.headers["content-type"] ?? "text/plain";
            const createdAt = new Date().toISOString();

            yield* bucket.put(key, body, { httpMetadata: { contentType } });
            yield* db
              .prepare(
                `INSERT INTO photos (key, bytes, content_type, created_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET
                   bytes = excluded.bytes,
                   content_type = excluded.content_type,
                   created_at = excluded.created_at`,
              )
              .bind(key, byteLength, contentType, createdAt)
              .run();
            yield* kv.delete(INDEX_CACHE_KEY);

            const event: PhotoEvent = {
              id: crypto.randomUUID(),
              type: "photo.put",
              key,
              bytes: byteLength,
              at: createdAt,
            };
            yield* queue.send(event);

            return yield* json(
              { key, bytes: byteLength, contentType, createdAt, queued: event.id },
              { status: 201 },
            );
          }

          if (method === "DELETE") {
            yield* bucket.delete(key);
            const deleted = yield* db
              .prepare("DELETE FROM photos WHERE key = ?")
              .bind(key)
              .run();
            yield* kv.delete(INDEX_CACHE_KEY);
            return yield* json({
              key,
              deleted: Number(deleted.meta.changes ?? 0) > 0,
            });
          }
        }

        return yield* json({ error: "not found", method, path }, { status: 404 });
      }).pipe(
        // Degrade, don't 500: an unexpected dependency failure names itself and
        // returns 503, so a client can tell "try again" from "bad request".
        Effect.catch((error) =>
          json(
            {
              error: "dependency unavailable",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 503 },
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.KV.ReadWriteNamespaceBinding,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.Workers.CronEventSourceLive,
      ),
    ),
  ),
) {}
