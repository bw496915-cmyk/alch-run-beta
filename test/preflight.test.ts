import { describe, expect, it } from "vitest";

import { classifyProbe, type Probe } from "../scripts/preflight-logic.ts";

/**
 * The preflight is what a session runs before any work lands, so its classifier
 * is tested rather than trusted — the same standard `test/cron-health.test.ts`
 * holds the cron assertion to. Each case is a real way a scratch directory can
 * lie: refused, broken, silently unhonoured, or left behind.
 */

const probe = (overrides: Partial<Probe> = {}): Probe => ({
  dir: "/tmp",
  writeError: null,
  readBack: "nonce-123",
  expected: "nonce-123",
  removed: true,
  ...overrides,
});

describe("scratch probe classification", () => {
  it("reports ok only when the write round-trips and the file is confirmed gone", () => {
    expect(classifyProbe(probe())).toEqual({ status: "ok" });
  });

  it("reports READ-ONLY for a refused write, as an environment failure with a named cause", () => {
    const verdict = classifyProbe(
      probe({ writeError: "EPERM: operation not permitted, open '/tmp/.dsh-preflight-1'", readBack: null }),
    );

    expect(verdict.status).toBe("read-only");
    if (verdict.status === "read-only") {
      expect(verdict.detail).toContain("EPERM");
      // The message must name the class, so it is never retried as a network error.
      expect(verdict.detail).toContain("/tmp");
    }
  });

  it("reports unusable for a write that failed for a reason other than refusal", () => {
    const verdict = classifyProbe(probe({ writeError: "ENOSPC: no space left on device", readBack: null }));

    expect(verdict.status).toBe("unusable");
    expect(verdict.status).not.toBe("read-only");
  });

  it("reports silent-write when the write reports success but the read-back disagrees", () => {
    const verdict = classifyProbe(probe({ readBack: "stale-contents" }));

    expect(verdict.status).toBe("silent-write");
    if (verdict.status === "silent-write") {
      expect(verdict.detail).toContain("read-back did not match");
    }
  });

  it("reports leaked when the probe file could not be confirmed removed", () => {
    const verdict = classifyProbe(probe({ removed: false }));

    expect(verdict.status).toBe("leaked");
    if (verdict.status === "leaked") {
      expect(verdict.detail).toContain("survived cleanup");
    }
  });
});
