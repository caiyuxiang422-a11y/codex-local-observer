import { describe, expect, it } from "vitest";
import {
  browserAccountUsage,
  planLabel,
  primaryRateLimit,
  limitingRateLimit,
  rateLimitWindows,
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

  it("surfaces a depleted long window without replacing the primary window", () => {
    const snapshot = browserAccountUsage();
    snapshot.rateLimits = [{limitId: "codex", remainingPercent: 68, windowDurationMins: 300, resetsAt: 42,
      secondary: {usedPercent: 100, remainingPercent: 0, windowDurationMins: 10080, resetsAt: 84}}];
    expect(limitingRateLimit(snapshot)).toMatchObject({remainingPercent: 0, windowDurationMins: 10080, resetsAt: 84});
    expect(primaryRateLimit(snapshot)?.remainingPercent).toBe(68);
    expect(rateLimitWindows(primaryRateLimit(snapshot)).map(window => window.remainingPercent)).toEqual([68, 0]);
  });

  it("preserves unknown windows and falls back to a measured secondary", () => {
    const snapshot = browserAccountUsage();
    snapshot.rateLimits = [{limitId: "codex", remainingPercent: 68, secondary: {windowDurationMins: 10080}}];
    expect(limitingRateLimit(snapshot)?.remainingPercent).toBe(68);
    snapshot.rateLimits = [{limitId: "codex", secondary: {remainingPercent: 12, resetsAt: 84}}];
    expect(limitingRateLimit(snapshot)).toMatchObject({remainingPercent: 12, resetsAt: 84});
    expect(limitingRateLimit(undefined)).toBeUndefined();
  });
});
