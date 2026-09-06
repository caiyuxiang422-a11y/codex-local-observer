import { describe, expect, it } from "vitest";
import {
  browserSystemMetricsSnapshot,
  formatBytes,
  formatMinutes,
  formatRate,
  formatSystemPercent,
  normalizeSystemMetricsSnapshot,
  systemMetricDisplay,
  systemMetricDetails,
  systemMetricDisplays,
  systemMetricStateLabel,
} from "./systemMetricsModel";

describe("system metrics model", () => {
  it("normalizes a complete coding-oriented snapshot", () => {
    const snapshot = normalizeSystemMetricsSnapshot(
      {
        schemaVersion: 2,
        source: "local.macos.system_profiler",
        updatedAt: 123,
        confidence: "high",
        cpu: {
          usagePercent: 42.25,
          load1m: 2.4,
          logicalCores: 10.9,
          codexCpuPercent: 18,
          thermalState: "nominal",
        },
        memory: {
          totalBytes: 16 * 1024 ** 3,
          usedBytes: 8 * 1024 ** 3,
          availableBytes: 8 * 1024 ** 3,
          usedPercent: 50,
          pressure: "normal",
          swapTotalBytes: 4 * 1024 ** 3,
          swapUsedBytes: 512 * 1024 ** 2,
          codexBytes: 700 * 1024 ** 2,
        },
        storage: {
          path: "/Users/example/project",
          volumeName: "Macintosh HD",
          totalBytes: 1_000,
          availableBytes: 400,
          usedPercent: 60,
          readBytesPerSecond: 1024,
          writeBytesPerSecond: 2048,
          isReadOnly: false,
        },
        network: {
          connected: true,
          interfaceName: "en0",
          networkType: "wifi",
          downBytesPerSecond: 10_000,
          upBytesPerSecond: 2_000,
          latencyMs: 18.4,
          packetLossPercent: 0,
          vpnActive: false,
        },
        battery: {
          present: true,
          percent: 87,
          charging: true,
          timeRemainingMinutes: 120,
          healthPercent: 96,
          cycleCount: 42.7,
        },
        evidence: ["sample"],
      },
      999,
    );

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.state).toBe("known");
    expect(snapshot.cpu.logicalCores).toBe(10);
    expect(snapshot.cpu.usagePercent).toBe(42.25);
    expect(snapshot.memory.codexBytes).toBe(700 * 1024 ** 2);
    expect(snapshot.storage.path).toBe("/Users/example/project");
    expect(snapshot.network.latencyMs).toBe(18.4);
    expect(snapshot.battery.cycleCount).toBe(42);
    expect(snapshot.evidence).toEqual(["sample"]);
  });

  it("keeps invalid and missing values unknown instead of inventing zero", () => {
    const snapshot = normalizeSystemMetricsSnapshot(
      {
        cpu: { usagePercent: Number.NaN, load1m: -1 },
        memory: { totalBytes: -1, usedBytes: "not-a-number" },
        storage: { availableBytes: null, usedPercent: 130 },
        network: { connected: undefined, downBytesPerSecond: -4 },
        battery: { present: null, percent: -20 },
      },
      500,
    );

    expect(snapshot.updatedAt).toBe(500);
    expect(snapshot.cpu.usagePercent).toBeUndefined();
    expect(snapshot.cpu.load1m).toBeUndefined();
    expect(snapshot.memory.totalBytes).toBeUndefined();
    expect(snapshot.memory.usedBytes).toBeUndefined();
    expect(snapshot.storage.availableBytes).toBeUndefined();
    expect(snapshot.storage.usedPercent).toBe(100);
    expect(snapshot.network.downBytesPerSecond).toBeUndefined();
    expect(snapshot.battery.percent).toBeUndefined();
    expect(snapshot.cpu.state).toBe("unknown");
    expect(snapshot.memory.state).toBe("unknown");
    expect(snapshot.battery.state).toBe("unknown");
  });

  it("preserves explicit false values such as no battery and offline network", () => {
    const snapshot = normalizeSystemMetricsSnapshot({
      network: { state: "known", connected: false },
      battery: { state: "known", present: false },
    });

    expect(snapshot.network.connected).toBe(false);
    expect(snapshot.network.state).toBe("known");
    expect(snapshot.battery.present).toBe(false);
    expect(snapshot.battery.state).toBe("known");

    expect(systemMetricDisplay(snapshot, "network")).toMatchObject({
      value: "离线",
      detail: expect.stringContaining("未连接"),
    });
    expect(systemMetricDisplay(snapshot, "battery")).toMatchObject({
      value: "无电池",
    });
  });

  it("accepts the compact adapter contract for network/battery status and free bytes", () => {
    const snapshot = normalizeSystemMetricsSnapshot({
      cpu: { usage: 12 },
      memory: { totalBytes: 100, freeBytes: 40 },
      storage: { path: "/project", totalBytes: 100, freeBytes: 80 },
      network: { state: "connected", interfaceName: "en0" },
      battery: { state: "charging", percent: 55 },
    });

    expect(snapshot.cpu.usagePercent).toBe(12);
    expect(snapshot.memory.availableBytes).toBe(40);
    expect(snapshot.storage.availableBytes).toBe(80);
    expect(snapshot.network).toMatchObject({
      status: "connected",
      connected: true,
      state: "known",
    });
    expect(snapshot.battery).toMatchObject({
      status: "charging",
      charging: true,
      present: true,
      state: "known",
    });
  });

  it("does not override a source-declared unknown or unavailable state", () => {
    const snapshot = normalizeSystemMetricsSnapshot({
      cpu: { state: "unavailable", usagePercent: 20 },
      memory: { state: "unknown", totalBytes: 100, usedBytes: 20 },
    });

    expect(snapshot.cpu.state).toBe("unavailable");
    expect(snapshot.memory.state).toBe("unknown");
    expect(systemMetricStateLabel("unavailable")).toBe("暂不可用");
    expect(systemMetricStateLabel("unknown")).toBe("未知");
  });

  it("formats capacity, rates, percentages, and durations without locale surprises", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1024 ** 2 * 12.5)).toBe("12.5 MiB");
    expect(formatRate(1024)).toBe("1 KiB/s");
    expect(formatSystemPercent(42.25)).toBe("42.3%");
    expect(formatMinutes(45)).toBe("45 分钟");
    expect(formatMinutes(90)).toBe("1 小时 30 分钟");
  });

  it("produces coding-relevant card details for every resource", () => {
    const snapshot = normalizeSystemMetricsSnapshot({
      cpu: { usagePercent: 70, load1m: 3.12, logicalCores: 8, codexCpuPercent: 25 },
      memory: {
        totalBytes: 8 * 1024 ** 3,
        usedBytes: 4 * 1024 ** 3,
        usedPercent: 50,
        pressure: "warning",
        codexBytes: 512 * 1024 ** 2,
      },
      storage: {
        volumeName: "Dev",
        usedPercent: 80,
        availableBytes: 20 * 1024 ** 3,
        readBytesPerSecond: 1_024,
        writeBytesPerSecond: 2_048,
      },
      network: {
        connected: true,
        interfaceName: "en0",
        latencyMs: 12,
        downBytesPerSecond: 2_048,
        upBytesPerSecond: 1_024,
      },
      battery: {
        present: true,
        percent: 66,
        charging: false,
        healthPercent: 91,
        timeRemainingMinutes: 75,
      },
    });

    const cards = systemMetricDisplays(snapshot);
    expect(cards).toHaveLength(5);
    expect(cards.map((card) => card.id)).toEqual([
      "cpu", "memory", "storage", "network", "battery",
    ]);
    expect(cards[0].detail).toContain("Codex 相关进程 25%");
    expect(cards[1].detail).toContain("压力 注意");
    expect(cards[2].detail).toContain("可用 20 GiB");
    expect(cards[3].detail).toContain("延迟 12 ms");
    expect(cards[4].detail).toContain("健康度 91%");

    const cpuRows = systemMetricDetails(snapshot, "cpu");
    expect(cpuRows.find((row) => row.label === "Codex 相关进程")?.value).toBe("25%");
    expect(systemMetricDetails(snapshot, "network")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "下载 / 上传速率", value: "2 KiB/s / 1 KiB/s" }),
      ]),
    );
  });

  it("returns an explicit unknown browser snapshot", () => {
    const snapshot = browserSystemMetricsSnapshot(1234);
    expect(snapshot.source).toBe("browser.preview");
    expect(snapshot.updatedAt).toBe(1234);
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.cpu.usagePercent).toBeUndefined();
    expect(snapshot.memory.totalBytes).toBeUndefined();
    expect(snapshot.storage.availableBytes).toBeUndefined();
    expect(snapshot.network.connected).toBeUndefined();
    expect(snapshot.battery.present).toBeUndefined();
    expect(snapshot.evidence[0]).toContain("不会伪造");
  });
});
