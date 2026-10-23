import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { Photos } from "./src/Photos.ts";

/**
 * Composition root.
 *
 * Every `alchemy` command (`plan`, `deploy`, `dev`, `destroy`) loads this file
 * and runs the default export.
 *
 * Pinned to alchemy 2.0.0-beta.83, which still ships every provider inside the
 * main package (`alchemy/Cloudflare`, `alchemy/AWS`, ...). See
 * MIGRATION-beta84.md for the import rewrite that 2.0.0-beta.84 requires.
 */
export default Alchemy.Stack(
  "AlchRunBeta",
  {
    providers: Cloudflare.providers(),
    // Local state file under .alchemy/ — nothing to bootstrap, nothing shared.
    // Swap for `Cloudflare.state()` when you want state stored in a bucket.
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const photos = yield* Photos;

    const worker = yield* Cloudflare.Worker("Api", {
      main: "./src/Api.ts",
      env: { PHOTOS: photos },
      // Workers Cache off: this API returns live bucket contents.
      cache: { enabled: false },
    });

    return {
      url: worker.url.as<string>(),
      bucketName: photos.bucketName,
    };
  }),
);
