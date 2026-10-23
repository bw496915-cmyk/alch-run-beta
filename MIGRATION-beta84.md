# Migrating this repo to `alchemy@2.0.0-beta.84`

**Status: not runnable yet.** Checked 2026-10-23 against the npm registry:

| Package | `dist-tags.latest` | Verdict |
| --- | --- | --- |
| `alchemy` | `2.0.0-beta.83` | beta.84 not published (last publish 2026-10-12) |
| `@alchemy.run/aws` | `0.0.0` | placeholder |
| `@alchemy.run/cloudflare` | `0.0.0` | placeholder |
| `@alchemy.run/domain` | `0.0.0` | placeholder |

The blog post is dated 2026-10-22 and the RSS feed still ends at beta.83, so the release
looks staged ahead of the npm push. Confirm before starting:

```bash
npm view alchemy dist-tags
npm view @alchemy.run/cloudflare dist-tags
```

You want a real version on **both**. If only `alchemy` moved, the import rewrite cannot
resolve, and if only the scoped packages are there, the core is still beta.83.

---

## The entire diff for this tree: 3 files

### 1. `package.json`

```diff
   "dependencies": {
-    "alchemy": "2.0.0-beta.83",
+    "alchemy": "2.0.0-beta.84",
+    "@alchemy.run/cloudflare": "2.0.0-beta.84",
     "@effect/platform-node": "4.0.6",
     "effect": "4.0.6"
   },
```

The scoped provider package is expected to be versioned in lockstep with `alchemy`;
verify the exact number from the registry rather than assuming it matches.

### 2. `alchemy.run.ts`

```diff
 import * as Alchemy from "alchemy";
-import * as Cloudflare from "alchemy/Cloudflare";
+import * as Cloudflare from "@alchemy.run/cloudflare";
 import * as Effect from "effect/Effect";
```

`import * as Alchemy from "alchemy"` stays: core (`Stack`, `localState`, `Output`, …)
remains in the `alchemy` package.

### 3. `src/Photos.ts`

```diff
-import * as Cloudflare from "alchemy/Cloudflare";
+import * as Cloudflare from "@alchemy.run/cloudflare";
```

### 4. `src/Api.ts` — no change

The Worker imports nothing from Alchemy. It talks to `env.PHOTOS`, which is a binding,
not a provider import.

### That is all

```bash
# should print exactly the two import lines above
rg -n 'from "alchemy/' alchemy.run.ts src/
```

---

## The release's breaking changes, and whether each one applies here

| beta.84 breaking change | Applies here? | Why |
| --- | --- | --- |
| Providers moved into `@alchemy.run/*` packages | **Yes** | The 3 files above; every provider import is concentrated in two of them |
| State store commands moved under `alchemy state` (`alchemy provider cloudflare bootstrap` → `alchemy state bootstrap --backend cloudflare`) | No, not yet | This repo uses `Alchemy.localState()`, and no bootstrap/prisma command is wired into any script. It becomes relevant only if you switch to `Cloudflare.state()` |
| `AWS.Lambda.isBindingHost` removed; AWS hosts now get IAM grants | No | No AWS resources in this stack |
| Distilled error classes are no longer Effect Schemas | No | No distilled SDK error handling in this code |
| Prisma/Neon env values use the runtime wire format (`{"_tag":"Redacted",…}`) | No | No Prisma or Neon providers |
| AWS framework sites default to Web Functions | No | No AWS |

Optional at beta.84, not needed for this stack: `Cloudflare.Hyperdrive.lookup`,
`localUploads` on R2 buckets, Worker website builds receiving `env`.

## How to verify the migration

```bash
pnpm install
pnpm typecheck          # expect exit 0, no new errors
git diff --stat         # expect exactly 3 changed files (+ pnpm-lock.yaml)
pnpm dev                # local loop should behave identically: 1337, same routes
```

Then, with a real account configured:

```bash
pnpm plan               # expect "Plan: 0 to create" against an existing stage,
                        # or 2 to create on a fresh one
```

## If it breaks

- **`Cannot find package '@alchemy.run/cloudflare'`** — the scoped package is not
  published yet; stay on beta.83.
- **`providers()` / `state()` not exported** — beta.84 may split those helpers
  differently. Inspect the real export map rather than guessing:

  ```bash
  node -e 'const p=require("./node_modules/@alchemy.run/cloudflare/package.json");console.log(Object.keys(p.exports))'
  ```

- **Local state survives the upgrade** — `.alchemy/` and stage names (`live_<user>`,
  `dev_<user>`) are unchanged, so `pnpm dev` should not need a clean slate.
- No rollback complexity: `git checkout -- . && pnpm install` returns to beta.83,
  because nothing in this repo depends on beta.84-only features.
