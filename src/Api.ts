/**
 * The Worker's runtime code.
 *
 * Alchemy bundles this file as the Worker's `main` (see alchemy.run.ts) and
 * injects `PHOTOS` as an R2 binding, because the stack passes the bucket into
 * the Worker's `env`.
 *
 * The binding is described structurally rather than with
 * `@cloudflare/workers-types`, so this project type-checks with a plain Node
 * toolchain. Add that package and use `R2Bucket` if you want the full surface.
 */

/** The slice of `R2Objects` this Worker reads. */
export interface R2ListResult {
  readonly objects: ReadonlyArray<{
    readonly key: string;
    readonly size: number;
  }>;
  readonly truncated: boolean;
}

/** The slice of the R2 binding this Worker calls. */
export interface R2BucketLike {
  list(options?: { limit?: number; prefix?: string }): Promise<R2ListResult>;
  put(key: string, value: string): Promise<unknown>;
}

export interface Env {
  readonly PHOTOS: R2BucketLike;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // GET /health
    if (path === "/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // GET /photos -> keys currently in the bucket
    if (path === "/photos" && request.method === "GET") {
      const listed = await env.PHOTOS.list({ limit: 100 });
      return json({
        count: listed.objects.length,
        keys: listed.objects.map((object) => object.key),
        truncated: listed.truncated,
      });
    }

    // PUT /photos -> no key to write under
    if (path === "/photos" && request.method === "PUT") {
      return json({ error: "missing key in path: PUT /photos/<key>" }, 400);
    }

    // PUT /photos/<key> -> store the request body under <key>
    if (path.startsWith("/photos/") && request.method === "PUT") {
      const key = decodeURIComponent(path.slice("/photos/".length));
      if (key.length === 0) {
        return json({ error: "missing key in path: PUT /photos/<key>" }, 400);
      }
      const body = await request.text();
      await env.PHOTOS.put(key, body);
      return json({ key, bytes: body.length }, 201);
    }

    return json({ error: "not found", method: request.method, path }, 404);
  },
};
