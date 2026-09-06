import {
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  getEnvironment,
  getAdvancedCapabilities,
  getAccountUsage,
  listWorkspaces,
  saveWorkspace,
  deleteWorkspace,
  getProjectProgress,
  getProjectUsage,
  getSystemMetrics,
  getProjectStatus,
  getWidgetSnapshot,
  readableError,
  setWidgetProject,
  showWidget,
  subscribeToTaskEvents,
  minimizeMainWindow,
} from "./desktopApi";
import {
  capabilityStatusLabel,
  capabilityTone,
  type AdvancedCapabilitiesSnapshot,
  type Workspace,
  type WorkspaceSnapshot,
} from "./advancedModel";
import {
  formatTokenCount,
  initialMonitorState,
  isTaskActive,
  monitorReducer,
  type EnvironmentInfo,
  type ProjectProgressSnapshot,
  type ProjectStatusSnapshot,
} from "./taskModel";
import {
  planLabel,
  primaryRateLimit,
  type AccountUsageSnapshot,
} from "./accountModel";
import {
  projectDisplayName,
  type WidgetSnapshot,
  type WidgetTaskSummary,
} from "./widgetModel";
import {
  projectUsageCaption,
  projectUsageStateLabel,
  projectUsageValue,
  type ProjectUsageSnapshot,
} from "./projectUsageModel";
import {
  formatBytes as formatSystemBytes,
  formatMilliseconds,
  formatRate,
  systemMetricDisplay,
  systemMetricDetails,
  systemMetricDisplays,
  type SystemMetricId,
  type SystemMetricsSnapshot,
} from "./systemMetricsModel";
import {
  intlLocale,
  localized,
  setAppLocale,
  useAppLocale,
  type AppLocale,
} from "./locale";
import { BrandLogo } from "./BrandLogo";
import WidgetApp from "./WidgetApp";
import CrownOverlayApp from "./CrownOverlayApp";

type LocalizedMessage = Readonly<{
  chinese: string;
  english: string;
}>;

function localizedMessage(
  locale: AppLocale,
  message: LocalizedMessage | undefined,
): string | undefined {
  return message
    ? localized(locale, message.chinese, message.english)
    : undefined;
}

function formatClock(timestamp: number, locale: AppLocale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

/** A small inline icon keeps the settings affordance consistent across
 * platforms.  Using SVG here avoids the platform-dependent emoji rendering
 * that a Unicode gear can receive in a WebView. */
function SettingsGlyph() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 5h13M3.5 10h13M3.5 15h13" />
      <circle cx="7" cy="5" r="1.45" fill="currentColor" stroke="none" />
      <circle cx="13" cy="10" r="1.45" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.45" fill="currentColor" stroke="none" />
    </svg>
  );
}

function healthConfidenceText(confidence: string, locale: AppLocale): string {
  if (confidence === "high") return localized(locale, "高", "High");
  if (confidence === "medium") return localized(locale, "中", "Medium");
  if (confidence === "low") return localized(locale, "低", "Low");
  return localized(locale, "未定义", "Undefined");
}

function accountResetText(timestamp: number | undefined, locale: AppLocale): string {
  if (!timestamp) return localized(locale, "重置时间未知", "Reset time unknown");
  const formatted = new Intl.DateTimeFormat(intlLocale(locale), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1_000);
  return localized(locale, `重置于 ${formatted}`, `Resets ${formatted}`);
}

function focusMetricValue(value: number | undefined): string {
  return value === undefined ? "—" : formatTokenCount(value);
}

function accountCreditsText(limit: ReturnType<typeof primaryRateLimit>, locale: AppLocale): string {
  return limit?.creditsBalance === undefined
    ? ""
    : localized(locale, `credits 余额 ${limit.creditsBalance}`, `Credits balance ${limit.creditsBalance}`);
}

function accountWindowDurationText(
  minutes: number | undefined,
  locale: AppLocale,
): string {
  if (!minutes || !Number.isFinite(minutes) || minutes < 1) return "";
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return localized(locale, `${weeks} 周窗口`, `${weeks}-week window`);
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return localized(locale, `${days} 天窗口`, `${days}-day window`);
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return localized(locale, `${hours} 小时窗口`, `${hours}-hour window`);
  }
  return localized(locale, `${minutes} 分钟窗口`, `${minutes}-minute window`);
}

function accountWindowUsageText(
  limit: ReturnType<typeof primaryRateLimit>,
  locale: AppLocale,
): string {
  if (!limit) return "";
  return [
    limit.usedPercent === undefined ? "" : localized(locale, `已用 ${limit.usedPercent}%`, `Used ${limit.usedPercent}%`),
    limit.remainingPercent === undefined ? "" : localized(locale, `剩余 ${limit.remainingPercent}%`, `${limit.remainingPercent}% remaining`),
    accountWindowDurationText(limit.windowDurationMins, locale),
  ]
    .filter(Boolean)
    .join(" · ");
}

function accountRemainingValue(
  snapshot: AccountUsageSnapshot | undefined,
  limit: ReturnType<typeof primaryRateLimit>,
  loading: boolean,
  error: string | undefined,
  locale: AppLocale,
): string {
  if (!limit && loading && !snapshot) return localized(locale, "读取中…", "Loading…");
  if (!limit && error && !snapshot) return localized(locale, "读取失败", "Load failed");
  if (!limit && snapshot) return localized(locale, "不可用", "Unavailable");
  if (!limit) return localized(locale, "尚未读取", "Not loaded");
  if (limit.remainingPercent !== undefined) return `${limit.remainingPercent}%`;
  return limit.creditsBalance === undefined
    ? localized(locale, "官方未返回剩余值", "No remaining value returned")
    : `${limit.creditsBalance} credits`;
}

function accountLimitCaption(
  limit: ReturnType<typeof primaryRateLimit>,
  plan: string | undefined,
  loading: boolean,
  error: string | undefined,
  snapshot: AccountUsageSnapshot | undefined,
  locale: AppLocale,
): string {
  if (limit) {
    return [
      plan ?? localized(locale, "计划未返回", "Plan not returned"),
      accountWindowUsageText(limit, locale),
      accountResetText(limit.resetsAt, locale),
      accountCreditsText(limit, locale),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (error && !snapshot) return localized(locale, `读取失败：${error}`, `Load failed: ${error}`);
  if (plan) return localized(locale, `${plan} · 剩余窗口未知`, `${plan} · Remaining window unknown`);
  if (loading) return localized(locale, "读取官方额度中…", "Loading official limits…");
  if (snapshot) return localized(locale, `官方未返回窗口 · ${snapshot.state}`, `No official window returned · ${snapshot.state}`);
  return localized(locale, "官方未返回可换算的剩余额度", "No convertible remaining allowance returned");
}

function goalRemainingText(snapshot: ProjectProgressSnapshot | undefined, locale: AppLocale): string {
  const percent = snapshot?.completion.percent;
  return percent === undefined ? localized(locale, "未设置", "Not set") : `${Math.max(0, 100 - percent)}%`;
}

function accountLifetimeText(snapshot: AccountUsageSnapshot | undefined): string {
  return focusMetricValue(snapshot?.tokenActivity.lifetimeTokens);
}

function accountDailyLabel(snapshot: AccountUsageSnapshot | undefined, locale: AppLocale): string {
  const date = snapshot?.tokenActivity.latestDailyDate;
  return date
    ? localized(locale, `最近日 Token · ${date}`, `Latest daily tokens · ${date}`)
    : localized(locale, "最近日 Token", "Latest daily tokens");
}

function projectTokenValue(
  official: ProjectUsageSnapshot | undefined,
  local: WidgetSnapshot | undefined,
  locale: AppLocale,
): string {
  if (official?.totalTokens !== undefined) {
    return new Intl.NumberFormat(intlLocale(locale)).format(official.totalTokens);
  }
  if (local?.currentProjectUsage.totalTokens !== undefined) {
    return focusMetricValue(local.currentProjectUsage.totalTokens);
  }
  return official
    ? localized(locale, "未返回", "Not returned")
    : localized(locale, "未读取", "Not loaded");
}

function projectTokenCaption(
  official: ProjectUsageSnapshot | undefined,
  local: WidgetSnapshot | undefined,
  locale: AppLocale,
): string {
  if (official?.totalTokens !== undefined) {
    if (locale === "zh-CN") {
      return `${projectUsageCaption(official)} · ${projectUsageStateLabel(official)}`;
    }
    const measured = `${official.measuredThreadCount}/${official.threadCount} measurable threads`;
    const coverage = official.truncated ? `${measured} · results may be incomplete` : measured;
    const state = official.state === "known"
      ? "Officially measured"
      : official.state === "partial"
        ? "Partially measured"
        : official.state === "unavailable"
          ? "Not provided by the official source"
          : official.state === "unknown"
            ? "No historical tokens returned"
            : "Unknown";
    return `${coverage} · ${state}`;
  }
  if (local?.currentProjectUsage.totalTokens !== undefined) {
    return localized(
      locale,
      "本工具已启动任务的本地记录 · 不含其他 Codex 客户端",
      "Local record of tasks launched by this app · Excludes other Codex clients",
    );
  }
  if (locale === "zh-CN") return projectUsageCaption(official);
  if (!official) return "Select View Project to load official thread data";
  if (official.state === "unavailable") return "Official project usage could not be loaded";
  if (official.threadCount === 0) return "No Codex sessions were found for this directory";
  return `${official.threadCount} sessions found, but no historical tokens were returned`;
}

function taskUsageText(task: WidgetTaskSummary, locale: AppLocale): string {
  return task.usage?.totalTokens === undefined
    ? localized(locale, "Token 未知", "Tokens unknown")
    : `${formatTokenCount(task.usage.totalTokens)} Token`;
}

function newWorkspaceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Compare the user-visible project path with a request path without letting
 * harmless surrounding whitespace make a completed read look like a no-op.
 * The backend may additionally canonicalize relative paths; in that case the
 * snapshot's own projectPath remains the source of truth and the request is
 * still accepted for the current view.
 */
function sameProjectPath(left: string | undefined, right: string): boolean {
  return left?.trim() === right.trim();
}

function advancedUpdatedText(snapshot: AdvancedCapabilitiesSnapshot | undefined, locale: AppLocale): string {
  if (!snapshot) return localized(locale, "尚未探测", "Not checked");
  const formatted = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(snapshot.collectedAt);
  return localized(locale, `探测于 ${formatted}`, `Checked ${formatted}`);
}

function workspaceUpdatedText(snapshot: WorkspaceSnapshot | undefined, locale: AppLocale): string {
  if (!snapshot) return localized(locale, "尚未读取", "Not loaded");
  const formatted = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(snapshot.updatedAt);
  return localized(locale, `读取于 ${formatted}`, `Loaded ${formatted}`);
}

function capabilityDisplayLabel(id: string, fallback: string, locale: AppLocale): string {
  if (locale === "zh-CN") return fallback;
  const labels: Record<string, string> = {
    appServer: "App Server",
    sessionRecovery: "Session recovery",
    approvals: "Approvals",
    usageApi: "Usage API",
    multiProject: "Multiple projects",
    plugins: "Plugin system",
  };
  return labels[id] ?? fallback;
}

function capabilityDisplayStatus(status: string, locale: AppLocale): string {
  if (locale === "zh-CN") return capabilityStatusLabel(status);
  const labels: Record<string, string> = {
    available: "Available",
    experimental: "Experimental",
    notConfigured: "Not configured",
    notVerified: "Not verified",
    disabled: "Off by default",
    unavailable: "Unavailable",
  };
  return labels[status] ?? "Unknown status";
}

function capabilityDisplayDetail(
  id: string,
  status: string,
  fallback: string,
  locale: AppLocale,
): string {
  if (locale === "zh-CN") return fallback;
  const details: Record<string, Record<string, string>> = {
    appServer: {
      experimental: "The CLI exposes an experimental App Server entry; bidirectional JSON-RPC is not integrated yet.",
      notVerified: "The current CLI probe could not verify App Server support.",
      unavailable: "No usable Codex CLI was found, so App Server support could not be checked.",
    },
    sessionRecovery: {
      notVerified: "Session recovery is not integrated or could not be verified by the current CLI probe.",
      unavailable: "No usable Codex CLI was found, so session recovery could not be checked.",
    },
    approvals: {
      notVerified: "Approvals require the App Server protocol and per-request confirmation; this app never approves automatically.",
      unavailable: "Approval support is unavailable without a verified App Server connection.",
    },
    usageApi: {
      notConfigured: "Organization-level API credentials and a reporting period must be configured explicitly; no secret is read and no request is sent now.",
      unavailable: "The organization Usage API is unavailable in the current configuration.",
    },
    multiProject: {
      available: "The local workspace registry is available. It stores only directories you add and does not scan disks.",
    },
    plugins: {
      disabled: "Plugin execution is off by default; trust, permission isolation, and uninstall contracts are not defined yet.",
    },
  };
  return details[id]?.[status] ?? fallback;
}

function systemMetricMeterPercent(
  snapshot: SystemMetricsSnapshot,
  id: SystemMetricId,
): number | undefined {
  const value = id === "cpu"
    ? snapshot.cpu.usagePercent
    : id === "memory"
      ? snapshot.memory.usedPercent
      : id === "storage"
        ? snapshot.storage.usedPercent
        : id === "battery"
          ? snapshot.battery.percent
          : undefined;
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.min(100, value));
}

function systemMetricPrimaryValue(
  snapshot: SystemMetricsSnapshot,
  id: SystemMetricId,
  displayValue: string,
): string {
  if (id === "storage" && snapshot.storage.availableBytes !== undefined) {
    return formatSystemBytes(snapshot.storage.availableBytes);
  }
  if (id === "memory" && snapshot.memory.usedBytes !== undefined && snapshot.memory.totalBytes !== undefined) {
    return `${formatSystemBytes(snapshot.memory.usedBytes)} / ${formatSystemBytes(snapshot.memory.totalBytes)}`;
  }
  return displayValue;
}

function systemMetricPrimaryLabel(id: SystemMetricId, locale: AppLocale): string {
  if (id === "storage") return localized(locale, "项目所在卷可用", "Available on project volume");
  if (id === "memory") return localized(locale, "已用 / 总量", "Used / total");
  if (id === "cpu") return localized(locale, "系统总占用", "Total system usage");
  if (id === "network") return localized(locale, "连接状态", "Connection status");
  return localized(locale, "当前电量", "Current charge");
}

function systemMetricCodingHint(
  snapshot: SystemMetricsSnapshot,
  id: SystemMetricId,
  locale: AppLocale,
): string | undefined {
  switch (id) {
    case "cpu":
      if (snapshot.cpu.usagePercent !== undefined && snapshot.cpu.usagePercent >= 85) {
        return localized(locale, "推断：系统 CPU 当前较高，构建或测试可能排队。", "Inference: CPU usage is high; builds or tests may queue.");
      }
      if (snapshot.cpu.load1m !== undefined && snapshot.cpu.logicalCores !== undefined && snapshot.cpu.load1m > snapshot.cpu.logicalCores) {
        return localized(locale, "推断：1 分钟负载高于逻辑核心数，短时任务可能变慢。", "Inference: the 1-minute load exceeds the logical core count; short tasks may slow down.");
      }
      return undefined;
    case "memory":
      if (snapshot.memory.pressure === "critical") return localized(locale, "推断：可用内存偏低，构建可能触发交换或变慢。", "Inference: available memory is low; builds may swap or slow down.");
      if (snapshot.memory.swapUsedBytes !== undefined && snapshot.memory.swapUsedBytes > 0) {
        return localized(locale, "提示：系统正在使用交换空间；这不是 Token 消耗。", "Note: the system is using swap space; this is not token usage.");
      }
      return undefined;
    case "storage":
      if (snapshot.storage.usedPercent !== undefined && snapshot.storage.usedPercent >= 90) {
        return localized(locale, "推断：项目所在卷空间紧张，node_modules 或构建产物可能失败。", "Inference: the project volume is low on space; node_modules or build output may fail.");
      }
      return undefined;
    case "network":
      if (snapshot.network.connected === false) return localized(locale, "提示：本机接口离线；这不等于 Codex API 的可达性测试结果。", "Note: the local interface is offline; this is not a Codex API reachability test.");
      return undefined;
    case "battery":
      if (snapshot.battery.present !== false && snapshot.battery.charging === false && snapshot.battery.percent !== undefined && snapshot.battery.percent <= 20) {
        return localized(locale, "提示：电量较低；是否降频取决于系统电源策略。", "Note: battery is low; any throttling depends on macOS power policy.");
      }
      return undefined;
  }
}

function systemMetricLabel(id: SystemMetricId, locale: AppLocale): string {
  const english: Record<SystemMetricId, string> = {
    cpu: "CPU",
    memory: "Memory",
    storage: "Storage",
    network: "Network",
    battery: "Battery",
  };
  const chinese: Record<SystemMetricId, string> = {
    cpu: "CPU",
    memory: "内存",
    storage: "磁盘",
    network: "网络",
    battery: "电池",
  };
  return localized(locale, chinese[id], english[id]);
}

function systemMetricStatus(state: string, locale: AppLocale): string {
  if (state === "known") return localized(locale, "实时", "Live");
  if (state === "partial") return localized(locale, "部分数据", "Partial");
  if (state === "derived") return localized(locale, "计算值", "Derived");
  if (state === "unavailable") return localized(locale, "暂不可用", "Unavailable");
  return localized(locale, "未知", "Unknown");
}

function formatMetricPercent(value: number | undefined, locale: AppLocale): string {
  if (value === undefined) return "—";
  return `${new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatEnglishMinutes(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return "—";
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

function englishSystemMetricDetail(snapshot: SystemMetricsSnapshot, id: SystemMetricId): string {
  const metric = snapshot[id];
  if (id === "cpu") {
    const cpu = snapshot.cpu;
    const load = cpu.load1m === undefined ? "Load unknown" : `1-min load ${cpu.load1m.toFixed(2)}`;
    const cores = cpu.logicalCores === undefined ? "Core count unknown" : `${cpu.logicalCores} threads`;
    const codex = cpu.codexCpuPercent === undefined ? "Codex process usage unknown" : `Codex processes ${formatMetricPercent(cpu.codexCpuPercent, "en-US")}`;
    return `${load} · ${cores} · ${codex}`;
  }
  if (id === "memory") {
    const memory = snapshot.memory;
    const capacity = memory.usedBytes !== undefined && memory.totalBytes !== undefined
      ? `${formatSystemBytes(memory.usedBytes)} / ${formatSystemBytes(memory.totalBytes)}`
      : "Capacity unknown";
    const pressure = memory.pressure
      ? `Pressure ${memory.pressure === "normal" ? "normal" : memory.pressure === "warning" ? "warning" : memory.pressure === "critical" ? "critical" : memory.pressure}`
      : "Pressure unknown";
    const codex = memory.codexBytes === undefined ? "Codex memory unknown" : `Codex ${formatSystemBytes(memory.codexBytes)}`;
    return `${capacity} · ${pressure} · ${codex}`;
  }
  if (id === "storage") {
    const storage = snapshot.storage;
    const volume = storage.volumeName || storage.mountPoint || storage.path || "Project volume";
    const capacity = storage.availableBytes === undefined ? "Free space unknown" : `${formatSystemBytes(storage.availableBytes)} free`;
    const io = storage.readBytesPerSecond === undefined && storage.writeBytesPerSecond === undefined
      ? "I/O not sampled"
      : `Read ${formatRate(storage.readBytesPerSecond)} · Write ${formatRate(storage.writeBytesPerSecond)}`;
    const kind = storage.kind && storage.kind !== "Unknown" ? ` · ${storage.kind}` : "";
    return `${volume}${kind} · ${capacity} · ${io}`;
  }
  if (id === "network") {
    const network = snapshot.network;
    const connection = network.connected === undefined
      ? "Connection unknown"
      : network.connected
        ? network.interfaceName || "Connected"
        : "Disconnected";
    const latency = network.latencyMs === undefined ? "Latency unknown" : `Latency ${formatMilliseconds(network.latencyMs)}`;
    const traffic = `↓ ${formatRate(network.downBytesPerSecond)} · ↑ ${formatRate(network.upBytesPerSecond)}`;
    return `${connection} · ${latency} · ${traffic}`;
  }
  const battery = snapshot.battery;
  if (battery.present === false) return "No battery was reported by this device";
  const power = battery.charging === true ? "Charging" : battery.charging === false ? "On battery" : "Power state unknown";
  const remaining = battery.timeRemainingMinutes === undefined ? "Time remaining unknown" : `About ${formatEnglishMinutes(battery.timeRemainingMinutes)}`;
  const health = battery.healthPercent === undefined ? "Health unknown" : `Health ${formatMetricPercent(battery.healthPercent, "en-US")}`;
  return `${power} · ${remaining} · ${health} · ${systemMetricStatus(metric.state, "en-US")}`;
}

const ENGLISH_SYSTEM_DETAIL_LABELS: Record<string, string> = {
  "系统总占用": "Total system usage",
  "Codex 相关进程": "Codex-related processes",
  "负载（1 / 5 / 15 分钟）": "Load (1 / 5 / 15 min)",
  "核心（逻辑 / 物理）": "Cores (logical / physical)",
  "平均频率": "Average frequency",
  "进程数": "Process count",
  "热状态": "Thermal state",
  "已用 / 总量": "Used / total",
  "可用": "Available",
  "使用率": "Usage",
  "压力（本地推导）": "Pressure (locally derived)",
  "交换空间已用 / 总量": "Swap used / total",
  "Codex 常驻内存": "Codex resident memory",
  "分页读入 / 写出": "Page-ins / page-outs",
  "项目路径": "Project path",
  "所在卷 / 挂载点": "Volume / mount point",
  "可用 / 使用率": "Available / usage",
  "文件系统 / 类型": "Filesystem / type",
  "读 / 写速率": "Read / write rate",
  "累计读 / 写": "Total read / write",
  "只读卷": "Read-only volume",
  "连接状态": "Connection status",
  "接口 / 类型": "Interface / type",
  "默认路由": "Default route",
  "下载 / 上传速率": "Download / upload rate",
  "累计接收 / 发送": "Total received / sent",
  "数据包接收 / 发送": "Packets received / sent",
  "错误接收 / 发送": "Receive / send errors",
  "延迟 / 丢包": "Latency / packet loss",
  "状态": "Status",
  "采集说明": "Collection note",
  "电量": "Charge",
  "状态 / 电源": "Status / power source",
  "剩余时间": "Time remaining",
  "健康度 / 循环次数": "Health / cycle count",
  "功率 / 电压": "Power / voltage",
  "能量 / 满充能量": "Energy / full-charge energy",
  "温度": "Temperature",
};

function englishSystemDetailValue(value: string): string {
  return value
    .replace("当前设备未报告电池", "No battery was reported by this device")
    .replace("台式机、外接显示器或部分 UPS 可能没有电池传感器", "Desktops, external displays, and some UPS devices may not expose a battery sensor")
    .replace("已启用", "Enabled")
    .replace("未启用", "Disabled")
    .replace("在线", "Online")
    .replace("离线", "Offline")
    .replace("外部电源", "AC power")
    .replace("已充满", "Full")
    .replace("充电中", "Charging")
    .replace("使用电池", "On battery")
    .replace(/(\d+) 小时/g, "$1 hr")
    .replace(/(\d+) 分钟/g, "$1 min")
    .replace(/(\d+(?:\.\d+)?) 核/g, "$1 cores")
    .replace(" 页/s", " pages/s");
}

function SystemMetricCard({
  snapshot,
  id,
  locale,
}: {
  snapshot: SystemMetricsSnapshot;
  id: SystemMetricId;
  locale: AppLocale;
}) {
  const sourceDisplay = systemMetricDisplay(snapshot, id);
  const metric = snapshot[id];
  const display = locale === "zh-CN"
    ? sourceDisplay
    : {
        ...sourceDisplay,
        label: systemMetricLabel(id, locale),
        status: systemMetricStatus(metric.state, locale),
        value: id === "network"
          ? snapshot.network.connected === false
            ? "Offline"
            : snapshot.network.connected === true
              ? "Online"
              : "—"
          : id === "battery" && snapshot.battery.present === false
            ? "No battery"
            : sourceDisplay.value,
        detail: englishSystemMetricDetail(snapshot, id),
      };
  const meterPercent = systemMetricMeterPercent(snapshot, id);
  const primaryValue = systemMetricPrimaryValue(snapshot, id, display.value);
  const hint = systemMetricCodingHint(snapshot, id, locale);
  const details = systemMetricDetails(snapshot, id).map((row) => locale === "zh-CN"
    ? row
    : {
        label: ENGLISH_SYSTEM_DETAIL_LABELS[row.label] ?? row.label,
        value: englishSystemDetailValue(row.value),
      });
  return (
    <article className={`system-metric-card system-metric-card--${display.tone}`}>
      <div className="system-metric-card-heading">
        <span>{display.label}</span>
        <small>{display.status}</small>
      </div>
      <strong className="system-metric-card-value" title={primaryValue}>
        {primaryValue}
      </strong>
      <span className="system-metric-card-label">{systemMetricPrimaryLabel(id, locale)}</span>
      {meterPercent !== undefined && (
        <div
          className="system-metric-meter"
          role="progressbar"
          aria-label={localized(
            locale,
            `${display.label}${id === "battery" ? "电量" : "使用率"}`,
            `${display.label} ${id === "battery" ? "charge" : "usage"}`,
          )}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={meterPercent}
        >
          <span style={{ width: `${meterPercent}%` }} />
        </div>
      )}
      <p className="system-metric-card-detail">{display.detail}</p>
      {hint && <p className="system-metric-card-hint">{hint}</p>}
      <details className="system-metric-card-details">
        <summary>{localized(locale, "数据说明", "Data details")}</summary>
        <p>
          {localized(locale, "来源", "Source")}：{metric.source} · {localized(locale, "置信度", "Confidence")}：
          {healthConfidenceText(metric.confidence, locale)}
        </p>
        <p>{localized(locale, "采样", "Sampled")}：{formatClock(metric.updatedAt, locale)}</p>
        <dl className="system-metric-card-detail-list">
          {details.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {metric.evidence.length > 0 && (
          <ul className="system-metric-card-evidence">
            {metric.evidence.map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
      </details>
    </article>
  );
}

export function ProductOverview({ locale }: { locale: AppLocale }) {
  const t = (chinese: string, english: string) => localized(locale, chinese, english);
  return (
    <section className="product-overview" aria-labelledby="product-overview-title">
      <header className="product-overview-hero">
        <div>
          <p className="panel-kicker">PRODUCT GUIDE</p>
          <h3 id="product-overview-title">{t("Codex 本地观察台", "Codex Local Observer")}</h3>
          <p>
            {t(
              "一个本地优先的项目观察工具：把选中项目的 Codex 用量、任务状态、里程碑进度与本机资源整理成可核实的摘要，并提供摄像头安全区与浮动窗口两种常驻方式。",
              "A local-first project observer that turns Codex usage, task status, milestone progress, and machine resources for the selected project into a verifiable summary. It can remain available beside the camera safe area or in a floating window.",
            )}
          </p>
        </div>
        <span className="product-overview-badge">{t("本地优先", "Local first")}</span>
      </header>

      <div className="product-overview-grid">
        <article className="product-overview-card">
          <span className="product-overview-index" aria-hidden="true">01</span>
          <h4>{t("项目与任务", "Projects and tasks")}</h4>
          <p>{t("查看当前项目、运行中与失败任务、最近变化，以及由你定义的里程碑完成度。", "See the selected project, running and failed tasks, recent changes, and milestone-based progress that you define.")}</p>
          <small>{t("任务范围只包含本工具启动或记录的 Codex 任务，不代表所有 Codex 桌面任务。", "Task scope includes only Codex tasks launched or recorded by this app, not every Codex desktop task.")}</small>
        </article>
        <article className="product-overview-card">
          <span className="product-overview-index" aria-hidden="true">02</span>
          <h4>{t("Usage 与 Token", "Usage and tokens")}</h4>
          <p>{t("在官方接口返回数据时显示项目 Token、最近日用量与账户窗口剩余比例。", "When the official interface returns data, see project tokens, the latest daily usage, and the account window remaining percentage.")}</p>
          <small>{t("窗口余量是百分比，不是可换算的“剩余 Token”；缺少可靠来源时保持“未返回”。", "A remaining window is a percentage, not a convertible token balance. The app shows “Not returned” when no reliable source exists.")}</small>
        </article>
        <article className="product-overview-card">
          <span className="product-overview-index" aria-hidden="true">03</span>
          <h4>{t("常驻摘要", "Persistent summary")}</h4>
          <p>{t("提供紧凑、摘要和详细三种信息密度；可固定在摄像头安全区，也可作为浮动窗口拖到任意位置。", "Choose compact, summary, or detailed information density. Keep it by the camera safe area or drag a floating window anywhere.")}</p>
          <small>{t("显示指标、默认视图与窗口层级均由用户控制，并遵循系统的减少动态效果设置。", "You control visible metrics, the default view, and window level. The UI also respects reduced-motion preferences.")}</small>
        </article>
        <article className="product-overview-card">
          <span className="product-overview-index" aria-hidden="true">04</span>
          <h4>{t("编码环境", "Coding environment")}</h4>
          <p>{t("只读采样 CPU、内存、项目所在磁盘、网络接口与电池状态，帮助解释构建或测试变慢的环境因素。", "Read-only CPU, memory, project-volume, network, and battery samples help explain environmental causes of slow builds or tests.")}</p>
          <small>{t("这些信号用于诊断本机环境，不等同于 Codex 服务状态，也不会计入 Token。", "These signals diagnose the local environment. They are not Codex service status and do not count toward tokens.")}</small>
        </article>
      </div>

      <div className="product-boundary-grid">
        <article className="product-boundary-card product-boundary-card--privacy">
          <div className="product-boundary-heading">
            <span aria-hidden="true">✓</span>
            <h4>{t("安全与隐私", "Security and privacy")}</h4>
          </div>
          <ul>
            <li>{t("只读取你主动选择的项目目录，不主动扫描整块磁盘。", "Reads only project directories you select; it does not proactively scan entire disks.")}</li>
            <li>{t("不读取", "Does not read")} <code>auth.json</code>{t("、浏览器 Cookie 或其他应用的登录凭据。", ", browser cookies, or sign-in credentials from other apps.")}</li>
            <li>{t("任务说明默认只传给本地子进程，不写入本工具的任务历史。", "Task instructions go only to the local child process by default and are not written to this app’s task history.")}</li>
            <li>{t("偏好、里程碑与有限任务元数据保存在本机，不由本工具上传或同步。", "Preferences, milestones, and limited task metadata stay on this Mac and are not uploaded or synced by this app.")}</li>
          </ul>
        </article>
        <article className="product-boundary-card product-boundary-card--limits">
          <div className="product-boundary-heading">
            <span aria-hidden="true">i</span>
            <h4>{t("数据边界", "Data boundaries")}</h4>
          </div>
          <ul>
            <li>{t("项目完成度只依据用户保存的里程碑计算，不由 Token 用量或 AI 猜测。", "Project progress comes only from milestones you save, never token usage or an AI guess.")}</li>
            <li>{t("官方数据暂不可用时展示未知状态，不用本地估算值冒充官方结论。", "Unavailable official data remains unknown; local estimates are never presented as official results.")}</li>
            <li>{t("测试与构建只有在用户明确触发时才执行；项目脚本可能写文件或访问网络。", "Tests and builds run only after an explicit action; project scripts may write files or access the network.")}</li>
            <li>{t("订阅版本、审批与账户额度以可验证来源为准；无法验证时会明确标注。", "Subscription tier, approvals, and account limits use verifiable sources and are marked clearly when they cannot be verified.")}</li>
          </ul>
        </article>
      </div>

      <footer className="product-overview-footer">
        <strong>{t("推荐使用方式", "Recommended workflow")}</strong>
        <p>
          {t(
            "在上方选择项目并点击“查看项目”，再从项目概览的设置中选择浮动方式、信息密度和需要展示的指标。所有无法确认的数据都会保留为空或标注来源，避免把推断误当事实。",
            "Choose a project above and select View Project. Then use Project Overview settings to choose placement, information density, and visible metrics. Unverified data stays empty or source-labeled so an inference is never mistaken for fact.",
          )}
        </p>
      </footer>
    </section>
  );
}

function MainApp() {
  const locale = useAppLocale();
  const t = (chinese: string, english: string) => localized(locale, chinese, english);
  const [environment, setEnvironment] = useState<EnvironmentInfo>();
  const [projectPath, setProjectPath] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [monitor, dispatch] = useReducer(monitorReducer, initialMonitorState);
  const [projectStatus, setProjectStatus] = useState<ProjectStatusSnapshot>();
  const [projectProgress, setProjectProgress] =
    useState<ProjectProgressSnapshot>();
  const [advancedCapabilities, setAdvancedCapabilities] =
    useState<AdvancedCapabilitiesSnapshot>();
  const [workspaceSnapshot, setWorkspaceSnapshot] =
    useState<WorkspaceSnapshot>();
  const [advancedError, setAdvancedError] = useState<string>();
  const [advancedLoading, setAdvancedLoading] = useState(false);
  const [focusSnapshot, setFocusSnapshot] = useState<WidgetSnapshot>();
  const [projectUsage, setProjectUsage] = useState<ProjectUsageSnapshot>();
  const [focusError, setFocusError] = useState<string>();
  const [projectViewLoading, setProjectViewLoading] = useState(false);
  const [projectViewMessage, setProjectViewMessage] = useState<LocalizedMessage>();
  // A remembered workspace path is only a selection. Project files are not
  // touched until the user explicitly presses “查看项目”.
  const [projectViewedPath, setProjectViewedPath] = useState<string>();
  const [accountUsage, setAccountUsage] = useState<AccountUsageSnapshot>();
  const [accountError, setAccountError] = useState<string>();
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountRefreshNonce, setAccountRefreshNonce] = useState(0);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetricsSnapshot>();
  const [systemMetricsError, setSystemMetricsError] = useState<string>();
  const [systemMetricsLoading, setSystemMetricsLoading] = useState(false);
  const [systemMetricsRefreshNonce, setSystemMetricsRefreshNonce] = useState(0);
  const [focusDetailsOpen, setFocusDetailsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const projectPathRef = useRef(projectPath);
  const systemMetricsRequestIdRef = useRef(0);
  const systemMetricsRequestedPathRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    let active = true;
    getEnvironment()
      .then((result) => {
        if (!active) return;
        setEnvironment(result);
        setProjectPath((current) => {
          const selected = projectPathRef.current.trim() || current.trim();
          if (selected) return selected;
          projectPathRef.current = result.projectPath;
          return result.projectPath;
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setEnvironment({
          backendReady: false,
          projectPath: "",
          message: readableError(error),
        });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setAdvancedLoading(true);
    setAdvancedError(undefined);
    Promise.allSettled([getAdvancedCapabilities(), listWorkspaces()])
      .then(([capabilityResult, workspaceResult]) => {
        if (!active) return;
        const errors: string[] = [];
        if (capabilityResult.status === "fulfilled") {
          setAdvancedCapabilities(capabilityResult.value);
        } else {
          errors.push(`${t("能力探测", "Capability check")}: ${readableError(capabilityResult.reason)}`);
        }
        if (workspaceResult.status === "fulfilled") {
          setWorkspaceSnapshot(workspaceResult.value);
          if (workspaceResult.value.activeProjectPath && !projectPathRef.current) {
            projectPathRef.current = workspaceResult.value.activeProjectPath;
            setProjectPath(workspaceResult.value.activeProjectPath);
          }
        } else {
          errors.push(`${t("工作区", "Workspaces")}: ${readableError(workspaceResult.reason)}`);
        }
        setAdvancedError(errors.length > 0 ? errors.join(" · ") : undefined);
      })
      .catch((error: unknown) => {
        if (active) setAdvancedError(readableError(error));
      })
      .finally(() => {
        if (active) setAdvancedLoading(false);
      });
    return () => {
      active = false;
    };
  }, [locale]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    subscribeToTaskEvents((event) => {
      dispatch({ type: "event-received", event });
    })
      .then((dispose) => {
        if (!active) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch((error: unknown) => {
        if (!active) return;
        setActionError(`${t("无法订阅任务事件", "Could not subscribe to task events")}: ${readableError(error)}`);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [locale]);

  useEffect(() => {
    // A path edit invalidates the previous snapshot. Keeping it visible would
    // make a real result look like it belongs to a different repository.
    projectPathRef.current = projectPath;
    setProjectViewedPath(undefined);
    setProjectStatus(undefined);
    setProjectProgress(undefined);
    setFocusSnapshot(undefined);
    setProjectUsage(undefined);
    setFocusError(undefined);
    setSystemMetrics(undefined);
    setSystemMetricsError(undefined);
    setSystemMetricsLoading(false);
    systemMetricsRequestIdRef.current += 1;
    systemMetricsRequestedPathRef.current = undefined;
    setProjectViewMessage(undefined);
  }, [projectPath]);

  useEffect(() => {
    const path = projectPath.trim();
    if (!environment?.backendReady || !path || projectViewedPath !== path) return;
    let active = true;
    getProjectProgress({ projectPath: path })
      .then((snapshot) => {
        if (!active || !sameProjectPath(projectPathRef.current, path)) return;
        setProjectProgress(snapshot);
      })
      .catch((error: unknown) => {
        if (!active || !sameProjectPath(projectPathRef.current, path)) return;
        setFocusError(`${t("项目进度", "Project progress")}: ${readableError(error)}`);
      });
    return () => {
      active = false;
    };
  }, [environment?.backendReady, projectPath, projectViewedPath]);

  // System metrics are a separate local read model. They refresh on a calm
  // cadence and do not depend on Codex task events, so opening a long-running
  // task cannot cause a burst of OS probes. The first request is also started
  // by the explicit “查看项目” action (below), so a slow App Server request
  // cannot hide local CPU/memory/disk/network/battery data behind it.
  function requestSystemMetrics(path: string): Promise<void> {
    const requestId = systemMetricsRequestIdRef.current + 1;
    systemMetricsRequestIdRef.current = requestId;
    systemMetricsRequestedPathRef.current = path;
    setSystemMetricsLoading(true);
    return getSystemMetrics(path)
      .then((snapshot) => {
        if (
          requestId !== systemMetricsRequestIdRef.current ||
          !sameProjectPath(projectPathRef.current, path)
        ) return;
        setSystemMetrics(snapshot);
        setSystemMetricsError(undefined);
      })
      .catch((error: unknown) => {
        if (
          requestId !== systemMetricsRequestIdRef.current ||
          !sameProjectPath(projectPathRef.current, path)
        ) return;
        setSystemMetricsError(readableError(error));
      })
      .finally(() => {
        if (requestId === systemMetricsRequestIdRef.current) {
          setSystemMetricsLoading(false);
        }
      });
  }

  useEffect(() => {
    const path = projectPath.trim();
    if (!environment?.backendReady || !path || projectViewedPath !== path) return;
    let loading = false;
    const loadSystemMetrics = () => {
      if (loading) return;
      loading = true;
      void requestSystemMetrics(path).finally(() => {
        loading = false;
      });
    };
    // The explicit view action starts the first request. On restored state (or
    // a future caller that sets projectViewedPath directly), make sure one is
    // still issued. A manual refresh nonce always bypasses this check.
    if (
      systemMetricsRequestedPathRef.current !== path ||
      systemMetricsRefreshNonce > 0
    ) {
      loadSystemMetrics();
    }
    const interval = window.setInterval(loadSystemMetrics, 5_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [
    environment?.backendReady,
    projectPath,
    projectViewedPath,
    systemMetricsRefreshNonce,
  ]);

  // The focus view is intentionally a single-project read model. It refreshes
  // after task events, but the account snapshot below has a much slower cadence
  // because it can involve a network-backed App Server request.
  useEffect(() => {
    const path = projectPath.trim();
    if (!path || projectViewedPath !== path) return;
    let active = true;
    const timer = window.setTimeout(() => {
      Promise.allSettled([getWidgetSnapshot({ projectPath: path }), getProjectUsage(path)])
        .then(([snapshotResult, usageResult]) => {
          if (!active || !sameProjectPath(projectPathRef.current, path)) return;
          if (snapshotResult.status === "fulfilled") {
            setFocusSnapshot(snapshotResult.value);
            setFocusError(undefined);
          } else {
            setFocusError(readableError(snapshotResult.reason));
          }
          if (usageResult.status === "fulfilled") {
            setProjectUsage(usageResult.value);
          }
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [monitor.status, monitor.totalEventCount, projectPath, projectViewedPath]);

  useEffect(() => {
    if (!environment?.backendReady) return;
    let active = true;
    const loadAccount = () => {
      setAccountLoading(true);
      setAccountError(undefined);
      getAccountUsage()
        .then((snapshot) => {
          if (active) {
            setAccountUsage(snapshot);
            setAccountError(undefined);
          }
        })
        .catch((error: unknown) => {
          if (active) setAccountError(readableError(error));
        })
        .finally(() => {
          if (active) setAccountLoading(false);
        });
    };
    loadAccount();
    const interval = window.setInterval(loadAccount, 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [accountRefreshNonce, environment?.backendReady]);

  const cliAvailable = Boolean(environment?.backendReady && environment.codexPath);
  const active = isTaskActive(monitor.status);
  // The Rust adapter may canonicalize a relative path. The path-change effect
  // above invalidates stale data, so the snapshot itself is the source of truth
  // for the currently selected project.
  const currentProjectStatus = projectStatus;

  const focusLimit = primaryRateLimit(accountUsage);
  const verifiedPlan = accountUsage?.planType
    ? planLabel(accountUsage.planType)
    : undefined;
  const focusProjectChoices = workspaceSnapshot?.workspaces ?? [];
  const projectHasBeenViewed = sameProjectPath(projectViewedPath, projectPath.trim());

  /**
   * Load the selected project's read model in one explicit action. Git,
   * progress, task history and usage are safe read paths. Test/build are not
   * included here because package scripts may write files or access the
   * network. The one-click observer never launches them implicitly.
   */
  async function viewSelectedProject() {
    const path = projectPath.trim();
    if (!path) {
      setFocusError(t("请先填写或选择项目目录。", "Enter or choose a project directory first."));
      return;
    }
    if (!environment?.backendReady) {
      setFocusError(environment?.message ?? t("桌面后端未连接，请使用 Tauri 桌面版。", "The desktop backend is not connected. Use the Tauri desktop app."));
      return;
    }
    if (active || projectViewLoading) return;

    // Pin the request identity before any async work. This also removes
    // trailing/leading whitespace from the comparison used when results land.
    projectPathRef.current = path;
    setProjectViewLoading(true);
    setFocusError(undefined);
    setProjectViewMessage(undefined);
    setProjectViewMessage({
      chinese: "正在读取项目…",
      english: "Loading project…",
    });
    // Start the cheap local snapshot immediately. It is intentionally
    // independent from project usage/App Server calls, so the five machine
    // cards can become useful even when official history is slow or missing.
    void requestSystemMetrics(path);
    // Viewing a project is the user's explicit refresh action.  Re-read the
    // account snapshot as well so the headline cards are from one moment.
    setAccountRefreshNonce((value) => value + 1);

    const pathParts = path.split(/[\\/]/).filter(Boolean);
    const fallbackName = pathParts[pathParts.length - 1] ?? t("当前项目", "Current project");
    const workspaceId =
      focusProjectChoices.find((workspace) => workspace.path === path)?.id ??
      newWorkspaceId();

    const [
      workspaceResult,
      widgetProjectResult,
      snapshotResult,
      projectUsageResult,
      progressResult,
      statusResult,
    ] =
      await Promise.allSettled([
        // Persist the selection as the active workspace so the floating note
        // observes the same project instead of falling back to another path.
        saveWorkspace({
          workspace: { id: workspaceId, name: fallbackName, path },
          makeActive: true,
        }),
        // Update an existing sticky note without forcing it to open or steal
        // focus. A newly-created note reads the same native state later.
        setWidgetProject(path),
        getWidgetSnapshot({ projectPath: path }),
        getProjectUsage(path),
        getProjectProgress({ projectPath: path }),
        // Git is read-only. Test/build remain manual to avoid silently
        // executing arbitrary package.json scripts.
        getProjectStatus({ projectPath: path, kind: "git" }),
      ]);

    if (sameProjectPath(projectPathRef.current, path)) {
      const errors: string[] = [];
      if (workspaceResult.status === "fulfilled") {
        setWorkspaceSnapshot(workspaceResult.value);
      } else {
        errors.push(`${t("项目选择未保存", "Project selection was not saved")}: ${readableError(workspaceResult.reason)}`);
      }
      if (widgetProjectResult.status === "rejected") {
        errors.push(`${t("项目概览同步", "Project Overview sync")}: ${readableError(widgetProjectResult.reason)}`);
      }
      if (snapshotResult.status === "fulfilled") {
        setFocusSnapshot(snapshotResult.value);
      } else {
        const message = readableError(snapshotResult.reason);
        setFocusError(message);
        errors.push(`${t("任务与 Token", "Tasks and tokens")}: ${message}`);
      }
      if (projectUsageResult.status === "fulfilled") {
        setProjectUsage(projectUsageResult.value);
      } else {
        const message = readableError(projectUsageResult.reason);
        errors.push(`${t("官方项目 Token", "Official project tokens")}: ${message}`);
      }
      if (progressResult.status === "fulfilled") {
        setProjectProgress(progressResult.value);
      } else {
        const message = readableError(progressResult.reason);
        errors.push(`${t("项目进度", "Project progress")}: ${message}`);
      }
      if (statusResult.status === "fulfilled") {
        setProjectStatus((previous) => {
          if (!previous || previous.projectPath !== statusResult.value.projectPath) {
            return statusResult.value;
          }
          return {
            ...statusResult.value,
            source: "local.project_status.merged",
            confidence: "medium",
            checks: previous.checks,
          };
        });
      } else {
        const message = readableError(statusResult.reason);
        errors.push(`Git: ${message}`);
      }
      if (errors.length > 0) {
        setFocusError(errors.join(" · "));
        setProjectViewMessage({
          chinese: `读取完成，但有 ${errors.length} 项数据不可用`,
          english: `Project loaded, but ${errors.length} data source${errors.length === 1 ? " is" : "s are"} unavailable`,
        });
      }
      if (
          errors.length === 0 &&
          widgetProjectResult.status === "fulfilled" &&
          statusResult.status === "fulfilled" &&
        snapshotResult.status === "fulfilled" &&
        projectUsageResult.status === "fulfilled" &&
        progressResult.status === "fulfilled"
      ) {
        const hasTaskHistory =
          snapshotResult.value.currentProjectUsage.state !== "unknown" ||
          snapshotResult.value.runningTasks.tasks.length > 0 ||
          snapshotResult.value.failedTasks.tasks.length > 0;
        const buildSummary = (summaryLocale: AppLocale) => {
          const translate = (chinese: string, english: string) =>
            localized(summaryLocale, chinese, english);
          const git = statusResult.value.git;
          const gitText =
            git.status === "available"
              ? translate(
                  `Git ${git.branch ?? "已连接"} · 未提交 ${git.uncommittedFiles}`,
                  `Git ${git.branch ?? "connected"} · ${git.uncommittedFiles} uncommitted`,
                )
              : git.status === "notRepository"
                ? translate("不是 Git 仓库", "Not a Git repository")
                : translate("Git 状态未知", "Git status unknown");
          const runningCount = snapshotResult.value.runningTasks.tasks.length;
          const taskText = runningCount > 0
            ? translate(
                `运行中 ${runningCount} 个任务`,
                `${runningCount} running task${runningCount === 1 ? "" : "s"}`,
              )
            : translate("当前无运行任务", "No running tasks");
          const taskDataText = hasTaskHistory
            ? translate("已加载本工具任务记录", "Local task records loaded")
            : translate("暂无本工具任务/Token记录", "No local task or token records yet");
          const officialUsageText = projectUsageResult.value.totalTokens === undefined
            ? translate("官方项目 Token 暂不可回溯", "Historical official project tokens are unavailable")
            : translate(
                `官方项目 Token ${projectUsageValue(projectUsageResult.value)}`,
                `Official project tokens ${new Intl.NumberFormat(intlLocale(summaryLocale)).format(projectUsageResult.value.totalTokens)}`,
              );
          const milestoneCount = progressResult.value.milestones.length;
          const progressText = milestoneCount > 0
            ? translate(
                `已加载 ${milestoneCount} 个里程碑`,
                `${milestoneCount} milestone${milestoneCount === 1 ? "" : "s"} loaded`,
              )
            : translate("尚未设置里程碑", "No milestones set");
          return `${translate("已读取", "Loaded")}: ${gitText} · ${taskText} · ${officialUsageText} · ${taskDataText} · ${progressText}`;
        };
        setProjectViewMessage({
          chinese: buildSummary("zh-CN"),
          english: buildSummary("en-US"),
        });
      }
    }

    setProjectViewLoading(false);
    if (sameProjectPath(projectPathRef.current, path)) {
      setProjectViewedPath(path);
    }
  }

  async function refreshAdvanced() {
    if (advancedLoading) return;
    setAdvancedLoading(true);
    setAdvancedError(undefined);
    try {
      const [capabilityResult, workspaceResult] = await Promise.allSettled([
        getAdvancedCapabilities(),
        listWorkspaces(),
      ]);
      const errors: string[] = [];
      if (capabilityResult.status === "fulfilled") {
        setAdvancedCapabilities(capabilityResult.value);
      } else {
        errors.push(`${t("能力探测", "Capability check")}: ${readableError(capabilityResult.reason)}`);
      }
      if (workspaceResult.status === "fulfilled") {
        setWorkspaceSnapshot(workspaceResult.value);
      } else {
        errors.push(`${t("工作区", "Workspaces")}: ${readableError(workspaceResult.reason)}`);
      }
      setAdvancedError(errors.length > 0 ? errors.join(" · ") : undefined);
    } catch (error: unknown) {
      setAdvancedError(readableError(error));
    } finally {
      setAdvancedLoading(false);
    }
  }

  async function addCurrentWorkspace() {
    const path = projectPath.trim();
    if (!path || active || advancedLoading) return;
    const pathParts = path.split(/[\\/]/).filter(Boolean);
    const fallbackName = pathParts[pathParts.length - 1] ?? t("当前项目", "Current project");
    setAdvancedLoading(true);
    setAdvancedError(undefined);
    try {
      const snapshot = await saveWorkspace({
        workspace: { id: newWorkspaceId(), name: fallbackName, path },
        makeActive: true,
      });
      setWorkspaceSnapshot(snapshot);
      if (snapshot.activeProjectPath) {
        projectPathRef.current = snapshot.activeProjectPath;
        setProjectPath(snapshot.activeProjectPath);
      }
    } catch (error: unknown) {
      setAdvancedError(readableError(error));
    } finally {
      setAdvancedLoading(false);
    }
  }

  async function activateWorkspace(workspace: Workspace) {
    if (active || advancedLoading) return;
    setAdvancedLoading(true);
    setAdvancedError(undefined);
    try {
      const snapshot = await saveWorkspace({
        workspace: {
          id: workspace.id,
          name: workspace.name,
          path: workspace.path,
        },
        makeActive: true,
      });
      setWorkspaceSnapshot(snapshot);
      projectPathRef.current = workspace.path;
      setProjectPath(workspace.path);
    } catch (error: unknown) {
      setAdvancedError(readableError(error));
    } finally {
      setAdvancedLoading(false);
    }
  }

  async function removeWorkspace(workspace: Workspace) {
    if (active || advancedLoading) return;
    if (!window.confirm(t(
      `确定从工作区列表移除“${workspace.name}”吗？不会删除项目文件。`,
      `Remove “${workspace.name}” from the workspace list? Project files will not be deleted.`,
    ))) {
      return;
    }
    setAdvancedLoading(true);
    setAdvancedError(undefined);
    try {
      const snapshot = await deleteWorkspace({ id: workspace.id });
      setWorkspaceSnapshot(snapshot);
      if (snapshot.activeProjectPath) {
        projectPathRef.current = snapshot.activeProjectPath;
        setProjectPath(snapshot.activeProjectPath);
      } else if (workspace.path === projectPathRef.current) {
        projectPathRef.current = "";
        setProjectPath("");
      }
    } catch (error: unknown) {
      setAdvancedError(readableError(error));
    } finally {
      setAdvancedLoading(false);
    }
  }

  async function openDesktopWidget(minimizeMain: boolean) {
    setActionError(undefined);
    try {
      // Pass the path currently visible in the main picker.  This avoids
      // falling back to an older workspace when the user typed a path without
      // saving it to the workspace list first.
      await showWidget(projectPath.trim() || undefined);
      if (minimizeMain) await minimizeMainWindow();
    } catch (error: unknown) {
      setActionError(readableError(error));
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <BrandLogo size={36} />
          <div>
            <p className="eyebrow">CODEX LOCAL OBSERVER</p>
            <h1>{t("本地观察台", "Local Observer")}</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className={`button button--quiet button--compact settings-trigger${settingsOpen ? " settings-trigger--active" : ""}`}
            type="button"
            onClick={() => setSettingsOpen((value) => !value)}
            aria-expanded={settingsOpen}
            aria-controls="settings-diagnostics-panel"
            title={t("打开设置与高级诊断", "Open settings and advanced diagnostics")}
          >
            <span className="settings-trigger-icon">
              <SettingsGlyph />
            </span>
            {t("设置", "Settings")}
          </button>
          <button
            className="button button--quiet button--compact"
            type="button"
            onClick={() => void openDesktopWidget(false)}
            disabled={!environment?.backendReady}
          >
            {t("打开项目概览", "Open Project Overview")}
          </button>
          <button
            className="button button--quiet button--compact"
            type="button"
            onClick={() => void openDesktopWidget(true)}
            disabled={!environment?.backendReady}
          >
            {t("打开并最小化", "Open and minimize")}
          </button>
          <div
            className={`connection ${cliAvailable ? "connection--ready" : "connection--down"}`}
            aria-label={cliAvailable ? t("Codex CLI 已连接", "Codex CLI connected") : t("Codex CLI 未连接", "Codex CLI disconnected")}
          >
            <span className="connection-dot" aria-hidden="true" />
            <span>{cliAvailable ? environment?.codexVersion ?? t("Codex 可用", "Codex available") : t("未连接", "Disconnected")}</span>
          </div>
        </div>
      </header>

      {settingsOpen && (
        <div className="settings-popover-wrap">
          <button
            className="settings-popover-backdrop"
            type="button"
            aria-label={t("关闭设置", "Close settings")}
            onClick={() => setSettingsOpen(false)}
          />
          <aside
            className="settings-popover"
            id="settings-diagnostics-panel"
            aria-label={t("设置与高级诊断", "Settings and advanced diagnostics")}
            role="dialog"
            aria-modal="true"
          >
            <div className="settings-popover-heading">
              <div>
                <p className="panel-kicker">SETTINGS</p>
                <h2>{t("设置与诊断", "Settings and diagnostics")}</h2>
              </div>
              <button
                className="settings-close"
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label={t("关闭设置", "Close settings")}
              >
                ×
              </button>
            </div>
            <p className="settings-popover-description">
              {t("高级能力、工作区和本机诊断集中在这里；默认只读，不会自动运行测试或构建。", "Advanced capabilities, workspaces, and local diagnostics live here. The app is read-only by default and never runs tests or builds automatically.")}
            </p>
            <section className="settings-section settings-section--language" aria-labelledby="settings-language-title">
              <div className="settings-section-heading">
                <div>
                  <h3 id="settings-language-title">{t("语言", "Language")}</h3>
                  <span className="project-updated">
                    {t("会同步到主窗口和常驻摘要", "Applies to the main window and persistent summaries")}
                  </span>
                </div>
              </div>
              <div className="settings-language-control" role="group" aria-label={t("界面语言", "Interface language")}>
                <button
                  type="button"
                  className={locale === "zh-CN" ? "is-selected" : ""}
                  aria-pressed={locale === "zh-CN"}
                  onClick={() => setAppLocale("zh-CN")}
                >
                  简体中文
                </button>
                <button
                  type="button"
                  className={locale === "en-US" ? "is-selected" : ""}
                  aria-pressed={locale === "en-US"}
                  onClick={() => setAppLocale("en-US")}
                >
                  English
                </button>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="settings-capabilities-title">
              <div className="settings-section-heading">
                <div>
                  <h3 id="settings-capabilities-title">{t("高级能力", "Advanced capabilities")}</h3>
                  <span className="project-updated">{advancedUpdatedText(advancedCapabilities, locale)}</span>
                </div>
                <button
                  className="button button--quiet button--compact"
                  type="button"
                  onClick={() => void refreshAdvanced()}
                  disabled={advancedLoading || active}
                  aria-busy={advancedLoading}
                >
                  {advancedLoading ? t("探测中…", "Checking…") : t("刷新", "Refresh")}
                </button>
              </div>
              {advancedError && (
                <div className="project-error" role="alert">
                  <strong>{t("读取失败", "Load failed")}</strong>
                  <span>{advancedError}</span>
                </div>
              )}
              <div className="settings-capability-list">
                {(advancedCapabilities?.capabilities ?? []).map((capability) => (
                  <div className="settings-capability-row" key={capability.id}>
                    <span>
                      <strong>{capabilityDisplayLabel(capability.id, capability.label, locale)}</strong>
                      <small>{capabilityDisplayDetail(capability.id, capability.status, capability.detail, locale)}</small>
                    </span>
                    <span className={`health-chip health-chip--${capabilityTone(capability.status)}`}>
                      {capabilityDisplayStatus(capability.status, locale)}
                    </span>
                  </div>
                ))}
                {!advancedCapabilities && !advancedLoading && (
                  <p className="settings-empty">{t("尚未读取能力状态。点击“刷新”获取本机结果。", "Capability status has not been loaded. Select Refresh to check this Mac.")}</p>
                )}
              </div>
            </section>
            <section className="settings-section" aria-labelledby="settings-workspace-title">
              <div className="settings-section-heading">
                <div>
                  <h3 id="settings-workspace-title">{t("项目工作区", "Project workspaces")}</h3>
                  <span className="project-updated">{workspaceUpdatedText(workspaceSnapshot, locale)}</span>
                </div>
                <button
                  className="button button--primary button--compact"
                  type="button"
                  onClick={() => void addCurrentWorkspace()}
                  disabled={!environment?.backendReady || !projectPath.trim() || active || advancedLoading}
                >
                  {t("添加当前项目", "Add current project")}
                </button>
              </div>
              {workspaceSnapshot?.workspaces.length ? (
                <ul className="settings-workspace-list">
                  {workspaceSnapshot.workspaces.map((workspace) => {
                    const selected = workspace.path === projectPath;
                    return (
                      <li key={workspace.id} className={selected ? "is-selected" : ""}>
                        <button
                          className="workspace-select"
                          type="button"
                          onClick={() => {
                            void activateWorkspace(workspace);
                            setSettingsOpen(false);
                          }}
                          disabled={selected || active || advancedLoading}
                          aria-current={selected ? "true" : undefined}
                        >
                          <strong>{workspace.name}</strong>
                          <span>{workspace.path}</span>
                        </button>
                        <button
                          className="milestone-delete"
                          type="button"
                          onClick={() => void removeWorkspace(workspace)}
                          disabled={active || advancedLoading}
                          aria-label={t(`从工作区移除：${workspace.name}`, `Remove from workspaces: ${workspace.name}`)}
                        >
                          {t("移除", "Remove")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="settings-empty">{t("尚未登记项目。添加后可从这里快速切换。", "No projects are registered yet. Add one to switch here quickly.")}</p>
              )}
            </section>
          </aside>
        </div>
      )}

      <main className="workspace">
        <section className="intro" aria-labelledby="page-title">
          <div>
            <p className="step-label">{t("当前项目 · 实时概览", "CURRENT PROJECT · LIVE OVERVIEW")}</p>
            <h2 id="page-title">{t("项目概览", "Project Overview")}</h2>
            <p>{t("先选一个项目，再只看这个项目的进度、Token 和任务状态。", "Choose one project to see only its progress, tokens, and task status.")}</p>
          </div>
          <div className="scope-note">
            <span aria-hidden="true">i</span>
            <p>
              {t("项目数据来自本机，账户数据来自官方只读接口；无法确认时显示", "Project data comes from this Mac; account data comes from an official read-only interface. Unverified values remain ")}
              <strong>{t("未返回", "Not returned")}</strong>
              {t("，不会猜测。", "; the app does not guess.")}
            </p>
          </div>
        </section>

        <section className="focus-dashboard" aria-labelledby="focus-dashboard-title">
          <div className="focus-dashboard-heading">
            <div>
              <p className="panel-kicker">{t("当前项目", "CURRENT PROJECT")}</p>
              <h3 id="focus-dashboard-title">
                {projectPath ? projectDisplayName(projectPath) : t("请选择项目", "Choose a project")}
              </h3>
            </div>
            <button
              className="button button--quiet button--compact"
              type="button"
              onClick={() => setFocusDetailsOpen((value) => !value)}
              aria-expanded={focusDetailsOpen}
            >
              {focusDetailsOpen ? t("收起说明", "Hide guide") : t("产品说明", "Product guide")}
            </button>
            <button
              className="button button--quiet button--compact"
              type="button"
              onClick={() => setAccountRefreshNonce((value) => value + 1)}
              disabled={!environment?.backendReady || accountLoading}
              aria-busy={accountLoading}
              title={t("重新读取官方账户 usage 和额度窗口", "Reload official account usage and limit windows")}
            >
              {accountLoading ? t("读取账户…", "Loading account…") : t("刷新账户", "Refresh account")}
            </button>
          </div>

          <div className="focus-project-picker">
            <label htmlFor="focus-project-path">
              <span>{t("项目目录", "Project directory")}</span>
              <small>{t("选择或粘贴路径", "Choose or paste a path")}</small>
            </label>
            <div className="focus-project-input-wrap">
              <input
                id="focus-project-path"
                list="focus-project-options"
                value={projectPath}
                placeholder={t("例如 /Users/你/Projects/my-project", "For example /Users/you/Projects/my-project")}
                aria-describedby="focus-project-help"
                onChange={(event) => {
                  projectPathRef.current = event.target.value;
                  setProjectPath(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void viewSelectedProject();
                  }
                }}
              />
              <datalist id="focus-project-options">
                {focusProjectChoices.map((workspace) => (
                  <option value={workspace.path} key={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </datalist>
            </div>
            <button
              className="button button--primary button--compact focus-view-button"
              type="button"
              onClick={() => void viewSelectedProject()}
              disabled={
                !projectPath.trim() ||
                active ||
                projectViewLoading
              }
              aria-busy={projectViewLoading}
              title={
                environment?.backendReady
                  ? t("读取当前项目的本地信息", "Read local information for this project")
                  : t("浏览器预览无法读取本机项目，请使用 Tauri 桌面版", "Browser preview cannot read local projects. Use the Tauri desktop app.")
              }
            >
              {projectViewLoading ? t("读取中…", "Loading…") : t("查看项目", "View Project")}
            </button>
            <span
              className={`focus-view-feedback${focusError ? " focus-view-feedback--error" : ""}`}
              role={focusError ? "alert" : "status"}
              aria-live="polite"
            >
              {projectViewLoading
                ? t("正在读取 Git、任务和 Token 摘要…", "Loading Git, task, and token summaries…")
                : focusError
                  ? t("读取失败，请查看下方诊断。", "Load failed. See the diagnostic below.")
                  : localizedMessage(locale, projectViewMessage) ?? t("尚未读取项目。", "Project has not been loaded yet.")}
            </span>
            {/* Keep the path available to assistive technology without repeating it in the visual layout. */}
            <span id="focus-project-help" className="sr-only">
              {projectPath || t("还没有选择项目", "No project selected")}
            </span>
          </div>

          {environment && !environment.backendReady && (
            <p className="focus-view-hint" role="status">
              {environment.message ?? t("当前没有连接桌面后端；点击查看会给出运行提示。", "The desktop backend is not connected. View Project will show setup guidance.")}
            </p>
          )}

          {actionError && (
            <div className="focus-error" role="alert">
              <strong>{t("应用操作失败", "App action failed")}</strong>
              <span>{actionError}</span>
            </div>
          )}

          {focusError && (
            <div className="focus-error" role="alert">
              <strong>{t("项目数据读取失败", "Project data could not be loaded")}</strong>
              <span>{focusError}</span>
            </div>
          )}
          {accountError && (
            <div className="focus-error focus-error--soft" role="status">
              <strong>{t("账户额度暂不可用", "Account limits are temporarily unavailable")}</strong>
              <span>{accountError}</span>
            </div>
          )}

          <div className="focus-summary-grid">
            <article className="focus-summary-card focus-summary-card--accent">
              <span>{t("距最终目标", "Remaining to goal")}</span>
              <strong>{goalRemainingText(projectProgress, locale)}</strong>
              <small>
                {projectProgress?.completion.percent === undefined
                  ? t("尚未设置；系统不会用 Token 推测完成度", "Not set; the app never infers progress from tokens")
                  : t(`已完成 ${projectProgress.completion.percent}% · 按已保存里程碑计算`, `${projectProgress.completion.percent}% complete · Based on saved milestones`)}
              </small>
              {projectProgress?.completion.percent !== undefined && (
                <div
                  className="focus-summary-meter"
                  role="progressbar"
                  aria-label={t("项目已完成比例", "Project completion percentage")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={projectProgress.completion.percent}
                >
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, projectProgress.completion.percent))}%`,
                    }}
                  />
                </div>
              )}
            </article>
            <article className="focus-summary-card">
              <span>{t("本项目 Token", "Project tokens")}</span>
              <strong>{projectTokenValue(projectUsage, focusSnapshot, locale)}</strong>
              <small>{projectTokenCaption(projectUsage, focusSnapshot, locale)}</small>
            </article>
            <article className="focus-summary-card">
              <span>{t("账户累计 Token（非额度）", "Account lifetime tokens (not a limit)")}</span>
              <strong>{accountLifetimeText(accountUsage)}</strong>
              <small>{t("官方账户 usage 活动总量；不是额度上限，也不等于当前项目", "Total activity returned by official account usage; neither a quota nor this project’s usage")}</small>
            </article>
            <article className="focus-summary-card focus-summary-card--account">
              <span>{t("Codex 主窗口余量", "Codex primary window remaining")}</span>
              <strong>
                {accountRemainingValue(accountUsage, focusLimit, accountLoading, accountError, locale)}
              </strong>
              <small>
                {accountLimitCaption(
                  focusLimit,
                  verifiedPlan,
                  accountLoading,
                  accountError,
                  accountUsage,
                  locale,
                )}
              </small>
              {focusLimit?.remainingPercent !== undefined && (
                <div
                  className="focus-summary-meter"
                  role="progressbar"
                  aria-label={t("Codex 主窗口剩余比例", "Codex primary window remaining percentage")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={focusLimit.remainingPercent}
                >
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, focusLimit.remainingPercent))}%`,
                    }}
                  />
                </div>
              )}
            </article>
          </div>

          <div className="focus-account-strip" aria-live="polite">
            <span>{accountDailyLabel(accountUsage, locale)}</span>
            <strong>{focusMetricValue(accountUsage?.tokenActivity.latestDailyTokens)}</strong>
            <small>
              {accountUsage?.tokenActivity.latestDailyDate
                ? t("官方账户最近一个已返回的日用量", "Most recent daily usage returned by the official account source")
                : t("等待官方日用量", "Waiting for official daily usage")}
            </small>
          </div>

          <section className="system-snapshot-strip" aria-labelledby="system-snapshot-title">
            <div className="system-snapshot-heading">
              <div>
                <span className="panel-kicker">CODING ENVIRONMENT</span>
                <h4 id="system-snapshot-title">{t("本机状态", "This Mac")}</h4>
              </div>
              <div className="system-snapshot-actions">
                <small>
                  {systemMetrics
                    ? t(`采样于 ${formatClock(systemMetrics.updatedAt, locale)}`, `Sampled ${formatClock(systemMetrics.updatedAt, locale)}`)
                    : systemMetricsLoading
                      ? t("采集中…", "Sampling…")
                      : t("查看项目后采集", "Sampled after viewing a project")}
                </small>
                <button
                  className="button button--quiet button--compact"
                  type="button"
                  onClick={() => setSystemMetricsRefreshNonce((value) => value + 1)}
                  disabled={!projectHasBeenViewed || systemMetricsLoading}
                  aria-busy={systemMetricsLoading}
                  title={t("重新读取 CPU、内存、项目所在磁盘、电池和网络状态", "Reload CPU, memory, project-volume, battery, and network status")}
                >
                  {systemMetricsLoading ? t("读取中…", "Loading…") : t("刷新本机", "Refresh Mac")}
                </button>
              </div>
            </div>
            {systemMetricsError && (
              <p className="system-snapshot-error" role="status">
                {t("本机状态读取失败", "Machine status could not be loaded")}: {systemMetricsError}
              </p>
            )}
            {systemMetrics ? (
              <div className="system-snapshot-grid">
                {systemMetricDisplays(systemMetrics).map((display) => (
                  <SystemMetricCard
                    key={display.id}
                    snapshot={systemMetrics}
                    id={display.id}
                    locale={locale}
                  />
                ))}
              </div>
            ) : (
              <div className="system-snapshot-empty" role="status">
                <strong>{systemMetricsLoading ? t("正在读取本机状态…", "Loading machine status…") : t("尚未采集本机状态", "Machine status has not been sampled")}</strong>
                <span>
                  {projectHasBeenViewed
                    ? t("CPU、内存、项目所在卷、网络和电池会在这里显示；首帧 I/O 速率会标为未采样。", "CPU, memory, project volume, network, and battery appear here. First-frame I/O rates are marked as not sampled.")
                    : t("先点击“查看项目”，系统才会读取与编码相关的本机资源。", "Select View Project before the app reads coding-related resources from this Mac.")}
                </span>
              </div>
            )}
            {systemMetrics && (
              <p className="system-snapshot-boundary">
                {t("本机资源只说明编码环境，不会替代 Codex Token/Usage；网络已连接也不等于 API 可达。", "Machine resources describe the coding environment; they do not replace Codex token or usage data. A connected network does not prove API reachability.")}
              </p>
            )}
          </section>

          <div className="focus-project-readout" aria-live="polite">
            <div>
              <span>{t("项目状态", "Project status")}</span>
              <strong>
                {projectViewLoading
                  ? t("读取中…", "Loading…")
                  : currentProjectStatus?.git.status === "available"
                    ? currentProjectStatus.git.branch ?? t("已连接 Git", "Git connected")
                    : currentProjectStatus?.git.status === "notRepository"
                      ? t("不是 Git 仓库", "Not a Git repository")
                      : currentProjectStatus
                        ? t("状态未知", "Status unknown")
                        : t("尚未查看", "Not viewed")}
              </strong>
            </div>
            <div>
              <span>{t("未提交改动", "Uncommitted changes")}</span>
              <strong>
                {currentProjectStatus?.git.status === "available"
                  ? t(`${currentProjectStatus.git.uncommittedFiles} 个文件`, `${currentProjectStatus.git.uncommittedFiles} file${currentProjectStatus.git.uncommittedFiles === 1 ? "" : "s"}`)
                  : "—"}
              </strong>
            </div>
            <div>
              <span>{t("读取结果", "Load result")}</span>
              <strong>{localizedMessage(locale, projectViewMessage) ?? t("点击“查看项目”读取", "Select View Project to load")}</strong>
            </div>
          </div>

          <div className="focus-detail-grid">
            <article className="focus-detail-card">
              <div className="focus-detail-heading">
                <h4>{t("运行中", "Running")}</h4>
                <strong>{focusSnapshot?.runningTasks.tasks.length ?? "—"}</strong>
              </div>
              {focusSnapshot?.runningTasks.tasks.length ? (
                <ul>
                  {focusSnapshot.runningTasks.tasks.slice(0, 3).map((task) => (
                    <li key={task.taskId}>
                      <span>{task.lastEvent ?? t("任务运行中", "Task running")}</span>
                      <small>
                        {formatClock(task.startedAt, locale)} · {taskUsageText(task, locale)}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  {focusSnapshot
                    ? t("当前没有运行中的本地任务。", "No local tasks are currently running.")
                    : projectViewLoading
                      ? t("正在读取…", "Loading…")
                      : projectHasBeenViewed
                        ? t("正在同步…", "Syncing…")
                        : t("点击“查看项目”后读取。", "Select View Project to load tasks.")}
                </p>
              )}
            </article>
            <article className="focus-detail-card">
              <div className="focus-detail-heading">
                <h4>{t("最近失败", "Recent failures")}</h4>
                <strong>{focusSnapshot?.failedTasks.tasks.length ?? "—"}</strong>
              </div>
              {focusSnapshot?.failedTasks.tasks.length ? (
                <ul>
                  {focusSnapshot.failedTasks.tasks.slice(0, 3).map((task) => (
                    <li key={task.taskId}>
                      <span>{task.lastEvent ?? t("任务失败", "Task failed")}</span>
                      <small>
                        {task.exitCode === undefined ? t("退出码未知", "Exit code unknown") : t(`退出码 ${task.exitCode}`, `Exit code ${task.exitCode}`)} · {taskUsageText(task, locale)}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  {focusSnapshot
                    ? t("没有失败记录。", "No failed tasks recorded.")
                    : projectViewLoading
                      ? t("正在读取…", "Loading…")
                      : projectHasBeenViewed
                        ? t("正在同步…", "Syncing…")
                        : t("点击“查看项目”后读取。", "Select View Project to load tasks.")}
                </p>
              )}
            </article>
          </div>

          <div className="focus-recent-row">
            <span>{t("最近变化", "Recent changes")}</span>
            <strong>
              {focusSnapshot?.recentChanges.changes[0]?.detail ?? t("尚无本地变化记录", "No local change records yet")}
            </strong>
            <small>
              {focusSnapshot?.recentChanges.changes[0]
                ? formatClock(focusSnapshot.recentChanges.changes[0].at, locale)
                : "—"}
            </small>
          </div>
          <p className="focus-boundary">
            {t("项目 Token 没有可靠来源时显示“未返回”；账户窗口显示官方比例，不能换算成绝对 Token。", "Project tokens show “Not returned” without a reliable source. The account window is an official percentage and cannot be converted into an absolute token balance.")}
          </p>
          <div className="focus-meta" aria-live="polite">
            <span>
              {t("项目快照", "Project snapshot")}: {focusSnapshot ? t(`本地 · ${formatClock(focusSnapshot.updatedAt, locale)}`, `Local · ${formatClock(focusSnapshot.updatedAt, locale)}`) : t("尚未同步", "Not synced")}
            </span>
            <span>
              {t("账户快照", "Account snapshot")}:
              {accountUsage
                ? `${accountUsage.state === "known" ? t("已返回", "Returned") : t("部分/未知", "Partial/unknown")} · ${formatClock(accountUsage.updatedAt, locale)}`
                : accountLoading
                  ? t("读取中…", "Loading…")
                  : t("尚未读取", "Not loaded")}
            </span>
          </div>
        </section>

        <details
          className="legacy-details product-details"
          open={focusDetailsOpen}
          onToggle={(event) => setFocusDetailsOpen(event.currentTarget.open)}
        >
          <summary>{t("产品说明与隐私", "Product guide and privacy")}</summary>

          <ProductOverview locale={locale} />

        </details>
      </main>

      <footer>
        <span>{t("本地优先 · 不读取 auth.json · 默认不持久化 Prompt", "Local first · Does not read auth.json · Prompts are not persisted by default")}</span>
        {environment?.codexPath && <code title={environment.codexPath}>{t("CLI 已探测", "CLI detected")}</code>}
      </footer>
    </div>
  );
}

export default function App() {
  const crownRoute =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("crown") === "1";
  const widgetRoute =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("widget") === "1";
  if (crownRoute) return <CrownOverlayApp />;
  return widgetRoute ? <WidgetApp /> : <MainApp />;
}
