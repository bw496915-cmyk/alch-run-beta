/**
 * The Worker's runtime code.
 *
 * Three bindings, three different Cloudflare services:
 *   PHOTOS -> R2 bucket   (object bodies)
 *   DB     -> D1 database (row metadata, applied via migrations/)
 *   CACHE  -> KV namespace (60s cached index)
 *
 * Bindings are described structurally rather than with
 * `@cloudflare/workers-types`, so this type-checks with a plain Node
 * toolchain. Add that package and use `R2Bucket`/`D1Database`/`KVNamespace`
 * if you want the full surface.
 */

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

export interface Env {
  readonly PHOTOS: R2BucketLike;
  readonly DB: D1Like;
  readonly CACHE: KVLike;
}

interface PhotoRow {
  readonly key: string;
  readonly bytes: number;
  readonly content_type: string;
  readonly created_at: string;
}

const INDEX_CACHE_KEY = "photos:index";
const CACHE_TTL_SECONDS = 60;

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // GET /photos -> D1 rows, served from KV when warm
    if (path === "/photos" && request.method === "GET") {
      const cached = await env.CACHE.get(INDEX_CACHE_KEY);
      if (cached !== null) {
        return json({ source: "kv", photos: JSON.parse(cached) }, 200, {
          "x-cache": "hit",
        });
      }
      const photos = await listPhotos(env);
      await env.CACHE.put(INDEX_CACHE_KEY, JSON.stringify(photos), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
      return json({ source: "d1", photos }, 200, { "x-cache": "miss" });
    }

    // POST /photos -> no key to write under
    if (path === "/photos" && request.method === "POST") {
      return json({ error: "missing key in path: PUT /photos/<key>" }, 400);
    }

    // Everything below addresses one photo: /photos/<key>
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

        // Three services in one operation: object body, row metadata, cache bust.
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

        return json({ key, bytes: body.length, contentType, createdAt }, 201);
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
};
