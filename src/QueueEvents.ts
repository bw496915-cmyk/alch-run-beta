import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Async audit pipeline: the Worker enqueues on write, its own `queue()` handler
 * drains the batch into D1. `Queues.Consumer` attaches that handler to the queue.
 */
export const Events = Cloudflare.Queues.Queue("Events");
