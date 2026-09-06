import { describe, expect, it } from "vitest";
import { mediumCrownCopy, mediumCrownStatusTone } from "./MediumCrown";
import {
  localizedMetricPeriod,
  localizedSystemMetricText,
  localizedTaskState,
} from "./WidgetApp";

describe("widget localization", () => {
  it("keeps Simplified Chinese as the widget default copy", () => {
    expect(mediumCrownCopy("zh-CN")).toEqual({
      statusPrefix: "当前状态：",
      remainingLabel: "Usage 余量",
      remainingAria: "Usage 剩余比例",
    });
    expect(localizedMetricPeriod("zh-CN", "今天（本机时区）")).toBe(
      "今天（本机时区）",
    );
  });

  it("provides English copy for camera-safe companion content", () => {
    expect(mediumCrownCopy("en-US")).toEqual({
      statusPrefix: "Current status: ",
      remainingLabel: "Usage remaining",
      remainingAria: "Usage remaining percentage",
    });
    expect(mediumCrownStatusTone("2 awaiting approval")).toBe("warning");
    expect(mediumCrownStatusTone("1 failed")).toBe("error");
    expect(mediumCrownStatusTone("3 running")).toBe("active");
    expect(localizedTaskState("zh-CN", "failed")).toBe("任务失败");
    expect(localizedTaskState("en-US", "running")).toBe("Running");
    expect(localizedTaskState("en-US", "future-state")).toBe("future-state");
  });

  it("translates normalized metric presentation while preserving numbers", () => {
    expect(
      localizedMetricPeriod("en-US", "当前项目 · 3/5 个会话可测"),
    ).toBe("Current project · 3/5 measurable sessions");
    expect(
      localizedSystemMetricText(
        "en-US",
        "1 分钟负载 2.5 · 8 线程 · Codex 相关进程 17%",
      ),
    ).toBe("1 min load 2.5 · 8 threads · Codex processes 17%");
    expect(localizedSystemMetricText("en-US", "Codex 12%（1.2 核）")).toBe(
      "Codex 12%(1.2 cores)",
    );
  });
});
