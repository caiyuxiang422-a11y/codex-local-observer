import { describe, expect, it } from "vitest";
import type { AccountUsageSnapshot } from "./accountModel";
import type { ProjectUsageSnapshot } from "./projectUsageModel";
import {
  widgetProjectTokenMetric,
  widgetRecentDailyTokenMetric,
  widgetSubscriptionMetric,
  widgetWindowRemainingText,
} from "./widgetOfficialModel";
import { browserWidgetSnapshot } from "./widgetModel";

const local = browserWidgetSnapshot("/tmp/project");

const officialProject: ProjectUsageSnapshot = {
  schemaVersion: 1,
  source: "codex.app_server.project_usage",
  projectPath: "/tmp/project",
  updatedAt: 10,
  confidence: "medium",
  state: "known",
  totalTokens: 120,
  inputTokens: 100,
  outputTokens: 20,
  threadCount: 2,
  measuredThreadCount: 2,
  activeThreadCount: 0,
  systemErrorThreadCount: 0,
  truncated: false,
  evidence: ["official fixture"],
};

const account: AccountUsageSnapshot = {
  schemaVersion: 1,
  source: "codex.app_server.account_usage",
  updatedAt: 20,
  confidence: "medium",
  state: "known",
  planType: "pro",
  rateLimits: [{ limitId: "codex", remainingPercent: 78 }],
  tokenActivity: { latestDailyTokens: 456, latestDailyDate: "2026-08-29" },
  evidence: ["account fixture"],
};

describe("widget official data composition", () => {
  it("uses official project usage without adding local coverage", () => {
    const metric = widgetProjectTokenMetric(local, officialProject);
    expect(metric?.totalTokens).toBe(120);
    expect(metric?.source).toContain("app_server");
  });

  it("keeps an official null unknown instead of turning it into zero", () => {
    const metric = widgetProjectTokenMetric(local, {
      ...officialProject,
      state: "unknown",
      totalTokens: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      measuredThreadCount: 0,
    });
    expect(metric?.totalTokens).toBeUndefined();
    expect(metric?.state).toBe("unknown");
    expect(metric?.evidence[0]).toContain("2 个会话");
  });

  it("maps the official recent-day activity without claiming it is today's live total", () => {
    const metric = widgetRecentDailyTokenMetric(local, account);
    expect(metric?.totalTokens).toBe(456);
    expect(metric?.period).toContain("2026-08-29");
    expect(metric?.evidence[0]).toContain("不一定等于当前自然日");
  });

  it("exposes the verified plan and remaining window percentage", () => {
    expect(widgetSubscriptionMetric(local, account)?.label).toBe("Pro");
    expect(widgetWindowRemainingText(account)).toBe("窗口余量 78%");
  });
});
