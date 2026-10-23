/**
 * Stand-in for the `cloudflare:workers` runtime module under Node/Vitest.
 *
 * Only the surface our code touches: the base class supplies `ctx` and `env`.
 * Type-checking still uses the real declaration from `@cloudflare/workers-types`
 * (vitest's alias is a runtime resolution only).
 */
export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
