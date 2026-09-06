import { describe, expect, it } from "vitest";
import {
  projectUsageCaption,
  projectUsageStateLabel,
  projectUsageValue,
  type ProjectUsageSnapshot,
} from "./projectUsageModel";

const unavailable: ProjectUsageSnapshot = {
  schemaVersion: 1,
  source: "fixture",
  projectPath: "/tmp/project",
  updatedAt: 1,
  confidence: "low",
  state: "unavailable",
  threadCount: 3,
  measuredThreadCount: 0,
  activeThreadCount: 1,
  systemErrorThreadCount: 0,
  truncated: false,
  evidence: ["threadUsage 为 null"],
};

describe("project usage model", () => {
  it("does not turn an unavailable official usage into zero", () => {
    expect(projectUsageValue(unavailable)).toBe("不可测");
    expect(projectUsageCaption(unavailable)).toContain("读取失败");
    expect(projectUsageStateLabel(unavailable)).toBe("官方未提供");
  });

  it("distinguishes an empty project from a failed project query", () => {
    expect(
      projectUsageCaption({ ...unavailable, state: "partial", threadCount: 0 }),
    ).toContain("没有找到");
    const queriedButUnmeasured = { ...unavailable, state: "unknown" } satisfies ProjectUsageSnapshot;
    expect(projectUsageCaption(queriedButUnmeasured)).toContain("3 个会话");
    expect(projectUsageStateLabel(queriedButUnmeasured)).toContain("未返回");
  });

  it("formats a measured total and its coverage", () => {
    const measured = {
      ...unavailable,
      state: "partial",
      totalTokens: 1234567,
      measuredThreadCount: 2,
    } satisfies ProjectUsageSnapshot;
    expect(projectUsageValue(measured)).toBe("1,234,567");
    expect(projectUsageCaption(measured)).toContain("2/3");
    expect(projectUsageStateLabel(measured)).toBe("部分可测");
  });
});
