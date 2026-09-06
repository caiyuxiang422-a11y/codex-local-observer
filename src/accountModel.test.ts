import { describe, expect, it } from "vitest";
import {
  browserAccountUsage,
  planLabel,
  primaryRateLimit,
  type AccountUsageSnapshot,
} from "./accountModel";

describe("account usage model", () => {
  it("chooses the Codex window before another returned bucket", () => {
    const snapshot: AccountUsageSnapshot = {
      schemaVersion: 1,
      source: "fixture",
      updatedAt: 1,
      confidence: "medium",
      state: "known",
      rateLimits: [
        { limitId: "other", remainingPercent: 12 },
        { limitId: "codex", remainingPercent: 88 },
      ],
      tokenActivity: {},
      evidence: [],
    };
    expect(primaryRateLimit(snapshot)?.remainingPercent).toBe(88);
  });

  it("keeps the browser preview honest", () => {
    const snapshot = browserAccountUsage();
    expect(snapshot.state).toBe("unknown");
    expect(primaryRateLimit(snapshot)).toBeUndefined();
  });

  it("does not turn an absent plan into a factual subscription", () => {
    expect(planLabel(undefined)).toBe("未验证");
    expect(planLabel("pro")).toBe("Pro");
  });
});
