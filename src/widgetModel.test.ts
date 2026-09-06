import { describe, expect, it } from "vitest";
import {
  browserWidgetSnapshot,
  canCustomizeWidgetWindowLevel,
  defaultWidgetPreferences,
  normalizeWidgetPreferences,
  usesPointerProximityExpansion,
  widgetStateLabel,
} from "./widgetModel";

describe("widget model", () => {
  it("keeps unknown values unknown in browser preview", () => {
    const snapshot = browserWidgetSnapshot("/tmp/project");
    expect(snapshot.todayUsage.state).toBe("unknown");
    expect(snapshot.todayUsage.totalTokens).toBeUndefined();
    expect(snapshot.pendingApprovals.count).toBeUndefined();
    expect(snapshot.runningTasks.tasks).toEqual([]);
    expect(snapshot.currentProjectProgress.state).toBe("unknown");
    expect(snapshot.currentProjectProgress.scope).toBe("current_project");
    expect(snapshot.currentProjectProgress.percent).toBeUndefined();
    expect(snapshot.currentProjectProgress.evidence[0]).toContain("浏览器预览");
  });

  it("supports showing only the metrics selected by the user", () => {
    const normalized = normalizeWidgetPreferences({
      ...defaultWidgetPreferences,
      visibleMetrics: ["currentProjectUsage", "runningTasks", "failedTasks"],
    });
    expect(normalized.visibleMetrics).toEqual([
      "currentProjectUsage",
      "runningTasks",
      "failedTasks",
    ]);
  });

  it("trims manual plan labels and bounds refresh frequency", () => {
    const normalized = normalizeWidgetPreferences({
      ...defaultWidgetPreferences,
      refreshSeconds: 1,
      subscriptionLabel: "  Plus  ",
    });
    expect(normalized.refreshSeconds).toBe(2);
    expect(normalized.subscriptionLabel).toBe("Plus");
  });

  it("defaults placement, resting size and surface choices for preferences written by older builds", () => {
    const legacy = { ...defaultWidgetPreferences } as Partial<
      typeof defaultWidgetPreferences
    >;
    delete legacy.placementMode;
    delete legacy.restingMode;
    delete legacy.compactLeftMetric;
    delete legacy.compactRightMetric;
    delete legacy.floatingMediumMetrics;
    const normalized = normalizeWidgetPreferences(
      legacy as Omit<
        typeof defaultWidgetPreferences,
        | "placementMode"
        | "restingMode"
        | "compactLeftMetric"
        | "compactRightMetric"
        | "floatingMediumMetrics"
      >,
    );
    expect(normalized.placementMode).toBe("notch");
    expect(normalized.restingMode).toBe("compact");
    expect(normalized.compactLeftMetric).toBe("projectStatus");
    expect(normalized.compactRightMetric).toBe("usageRemaining");
    expect(normalized.floatingMediumMetrics).toEqual([
      "projectUsage",
      "todayUsage",
      "projectProgress",
    ]);
  });

  it("keeps medium as an explicit persistent resting size", () => {
    const normalized = normalizeWidgetPreferences({
      ...defaultWidgetPreferences,
      restingMode: "medium",
    });
    expect(normalized.restingMode).toBe("medium");
  });

  it("keeps floating as an explicit placement mode", () => {
    const normalized = normalizeWidgetPreferences({
      ...defaultWidgetPreferences,
      placementMode: "floating",
    });
    expect(normalized.placementMode).toBe("floating");
  });

  it("uses an explicit expand control on a floating surface instead of pointer proximity", () => {
    expect(usesPointerProximityExpansion("floating")).toBe(false);
    expect(usesPointerProximityExpansion("notch")).toBe(true);
  });

  it("exposes stacking control for floating surfaces and the camera-safe summary only", () => {
    expect(canCustomizeWidgetWindowLevel("floating", "compact")).toBe(true);
    expect(canCustomizeWidgetWindowLevel("floating", "medium")).toBe(true);
    expect(canCustomizeWidgetWindowLevel("notch", "medium")).toBe(true);
    expect(canCustomizeWidgetWindowLevel("notch", "compact")).toBe(false);
  });

  it("falls back from unknown compact side choices instead of persisting them", () => {
    const normalized = normalizeWidgetPreferences({
      ...defaultWidgetPreferences,
      placementMode: "unknown-placement" as never,
      restingMode: "invalid-size" as never,
      compactLeftMetric: "not-a-metric" as never,
      compactRightMetric: "also-not-a-metric" as never,
      floatingMediumMetrics: [
        "runningTasks",
        "hidden" as never,
        "not-a-metric" as never,
      ],
    });
    expect(normalized.placementMode).toBe("notch");
    expect(normalized.restingMode).toBe("compact");
    expect(normalized.compactLeftMetric).toBe("projectStatus");
    expect(normalized.compactRightMetric).toBe("usageRemaining");
    expect(normalized.floatingMediumMetrics).toEqual([
      "runningTasks",
      "todayUsage",
      "projectProgress",
    ]);
  });

  it("keeps three valid detached summary choices in their selected slots", () => {
    const normalized = normalizeWidgetPreferences({
      ...defaultWidgetPreferences,
      floatingMediumMetrics: ["usageRemaining", "failedTasks", "subscription"],
    });
    expect(normalized.floatingMediumMetrics).toEqual([
      "usageRemaining",
      "failedTasks",
      "subscription",
    ]);
    expect(normalized.floatingMediumMetrics).not.toBe(
      defaultWidgetPreferences.floatingMediumMetrics,
    );
  });

  it("distinguishes an unavailable value from an adapter that is not connected", () => {
    expect(widgetStateLabel("unknown", "codex.app_server.project_usage")).toBe(
      "官方未返回",
    );
    expect(widgetStateLabel("unknown", "local.project_progress")).toBe("暂无记录");
    expect(widgetStateLabel("unknown", "not_connected")).toBe("未接入");
  });
});
