import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import {
  getCurrentWindow,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import {
  getAccountUsage,
  getWidgetPreferences,
  getWidgetSnapshot,
  getEnvironment,
  getProjectUsage,
  getSystemMetrics,
  getMacosNotchGeometry,
  getMacosPointerProximity,
  getWidgetState,
  hideWidget,
  isDesktopRuntime,
  listWorkspaces,
  readableError,
  saveWidgetPreferences,
  setWidgetAlwaysOnTop,
  syncMacosWidgetWindow,
  showMainWindow,
  publishWidgetCrownPayload,
  subscribeToTaskEvents,
  subscribeToWidgetCrownPainted,
  subscribeToWidgetCrownReady,
  subscribeToWidgetProject,
  subscribeToWidgetWindowHidden,
  subscribeToWidgetWindowShown,
} from "./desktopApi";
import { limitingRateLimit, primaryRateLimit, type AccountUsageSnapshot } from "./accountModel";
import type { ProjectUsageSnapshot } from "./projectUsageModel";
import { formatTokenCount } from "./taskModel";
import {
  canCustomizeWidgetWindowLevel,
  defaultFloatingMediumMetrics,
  defaultWidgetPreferences,
  normalizeWidgetPreferences,
  projectDisplayName,
  usesPointerProximityExpansion,
  widgetCompactMetricDefinitions,
  widgetMediumMetricDefinitions,
  widgetMetricDefinitions,
  widgetStateLabel,
  type CountMetric,
  type ProjectHighlightMetric,
  type TaskListMetric,
  type TokenMetric,
  type SubscriptionMetric,
  type WidgetCompactMetricId,
  type WidgetMetricId,
  type WidgetMediumMetricId,
  type WidgetPreferences,
  type WidgetRestingMode,
  type WidgetSnapshot,
} from "./widgetModel";
import {
  widgetProjectTokenMetric,
  widgetRecentDailyTokenMetric,
  widgetSubscriptionMetric,
  widgetWindowRemainingText,
} from "./widgetOfficialModel";
import {
  clampMeterPercent,
  tokenCompositionSegments,
} from "./tokenMeterModel";
import {
  formatBytes as formatSystemBytes,
  systemMetricDetails,
  systemMetricDisplays,
  type SystemMetricDetail,
  type SystemMetricDisplay,
  type SystemMetricId,
  type SystemMetricsSnapshot,
} from "./systemMetricsModel";
import {
  browserMacNotchGeometry,
  isPointerNearCompactAnchor,
  type MacNotchGeometry,
  type MacNotchRect,
} from "./macosNotchModel";
import { mediumGlassContourPath } from "./mediumContourModel";
import { MediumCrown, mediumCrownStatusTone } from "./MediumCrown";
import { QuotaWindows } from "./QuotaWindows";
import { MediumContourChrome } from "./MediumContourChrome";
import {
  normalizeWidgetCrownPaintedPayload,
  type WidgetCrownPaintedPayload,
  type WidgetCrownPayload,
} from "./crownOverlayModel";
import { CompactSdfGlass } from "./CompactSdfGlass";
import { CompactGlassChrome } from "./CompactGlassChrome";
import { BrandLogo } from "./BrandLogo";
import {
  compactGlassSurfaceContract,
  type CompactGlassSurfaceContract,
} from "./compactGlassModel";
import {
  intlLocale,
  localized,
  useAppLocale,
  type AppLocale,
} from "./locale";
import LiquidGlass from "liquid-glass-react";
import "./WidgetApp.css";

// Local task state is cheap and can follow the user-selected interval. The
// official adapter starts a bounded App Server process, so a pinned widget
// refreshes it less often and still offers an explicit refresh button.
const OFFICIAL_REFRESH_MS = 5 * 60 * 1_000;
// The native frame is compact while closed, then temporarily grows so the
// glass surface can morph down from the same top-centred origin. On a notched Mac
// the closed size is supplied by NSScreen's safe-area/auxiliary-area metrics;
// these values are only the honest fallback for an external/non-notched
// display or a runtime that cannot expose AppKit.
const NOTCH_FALLBACK_CLOSED_SIZE = { width: 220, height: 38 } as const;
// The optional medium resting surface is intentionally only a little wider
// than the measured notch plus its side chips. It is a summary, not a second
// dashboard: three project signals and one machine line fit without turning
// the top edge into a dense toolbar.
const NOTCH_MEDIUM_SIZE = { width: 560, height: 224 } as const;
const NOTCH_OPEN_SIZE = { width: 620, height: 460 } as const;
// Keep this aligned with macOS EXPANDED_GLASS_RADIUS. It is also exposed as a
// CSS custom property so the material clip and spectrum edge cannot diverge.
const EXPANDED_SURFACE_RADIUS = 30;
// Resting camera-safe views open only when the pointer intersects the real
// camera band. The expanded view keeps a small exit gutter so one noisy edge
// sample cannot immediately collapse interactive controls.
const NOTCH_ENTRY_MARGIN_PT = 0;
const NOTCH_EXPANDED_EXIT_MARGIN_PT = 8;
const NOTCH_EXPANDED_EXIT_MISS_COUNT = 2;
const NOTCH_PROXIMITY_POLL_MS = 50;
const NOTCH_HIDDEN_POLL_MS = 800;
// Keep the WebView's compact side contour numerically identical to the
// AppKit bridge. These are logical points; Retina scaling happens after both
// layers have agreed on one geometry.
const HARDWARE_COMPACT_VERTICAL_INSET_PT = 3;

type NotchPresentation = "compact" | "medium" | "expanded";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function prefersReducedTransparency(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    (window.matchMedia("(prefers-reduced-transparency: reduce)").matches ||
      window.matchMedia("(prefers-contrast: more)").matches)
  );
}

function supportsLiquidGlassBackdrop(): boolean {
  if (typeof window === "undefined") return false;
  const css = window.CSS;
  if (!css || typeof css.supports !== "function") return true;
  return (
    css.supports("backdrop-filter", "blur(1px)") ||
    css.supports("-webkit-backdrop-filter", "blur(1px)")
  );
}

function formatClock(timestamp: number, locale: AppLocale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatAge(hours: number | undefined, locale: AppLocale): string {
  if (hours === undefined) return localized(locale, "未知", "Unknown");
  if (hours < 24) {
    return localized(locale, `${hours} 小时`, `${hours} hr`);
  }
  const days = Math.floor(hours / 24);
  const remaining = hours % 24;
  return localized(
    locale,
    remaining ? `${days} 天 ${remaining} 小时` : `${days} 天`,
    remaining ? `${days}d ${remaining}h` : `${days}d`,
  );
}

function localizedWidgetStateLabel(
  locale: AppLocale,
  state: string,
  source = "",
): string {
  if (locale === "zh-CN") return widgetStateLabel(state, source);
  if (state === "known") {
    return source.includes("app_server") ? "Official" : "Local";
  }
  if (state === "derived") return "Derived";
  if (state === "manual") return "Manual";
  if (state === "partial") return "Partial";
  if (state === "unavailable") return "Unavailable";
  if (source === "not_connected") return "Not connected";
  if (source.includes("app_server")) return "Not returned";
  if (source.startsWith("local.")) return "No records";
  if (source === "browser.preview") return "Unavailable";
  return "No data";
}

export function localizedMetricPeriod(locale: AppLocale, period: string): string {
  if (locale === "zh-CN") return period;
  const measured = period.match(/^当前项目 · (\d+)\/(\d+) 个会话可测$/);
  if (measured) return `Current project · ${measured[1]}/${measured[2]} measurable sessions`;
  const matched = period.match(/^当前项目 · 已匹配 (\d+) 个会话$/);
  if (matched) return `Current project · ${matched[1]} matched sessions`;
  if (period.startsWith("官方账户最近日 · ")) {
    return `Most recent official day · ${period.slice(10)}`;
  }
  const known: Record<string, string> = {
    "官方账户最近一个日统计桶": "Most recent official daily bucket",
    "当前项目的本地任务历史": "Current project's local task history",
    "今天（本机时区）": "Today (local time)",
    "当前项目": "Current project",
    "今天": "Today",
  };
  return known[period] ?? period;
}

export function localizedTaskState(locale: AppLocale, state: string): string {
  const labels: Record<string, readonly [string, string]> = {
    idle: ["等待开始", "Idle"],
    starting: ["正在启动", "Starting"],
    running: ["正在运行", "Running"],
    stopping: ["正在停止", "Stopping"],
    completed: ["任务完成", "Completed"],
    failed: ["任务失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    unavailable: ["Codex 不可用", "Codex unavailable"],
  };
  const label = labels[state];
  return label ? localized(locale, label[0], label[1]) : state;
}

function localizedSnapshotScope(locale: AppLocale, scope: string): string {
  if (locale === "zh-CN") return scope;
  const known: Record<string, string> = {
    "当前项目的本工具任务；今日 Token 仍是本机全部项目汇总。": "Tasks from this tool for the current project; today's tokens still cover all local projects.",
    "仅本工具启动的 codex exec 任务；项目指标来自用户保存的里程碑。": "Only codex exec tasks launched by this tool; project metrics come from saved milestones.",
    "浏览器预览": "Browser preview",
  };
  return known[scope] ?? scope;
}

const systemMetricEnglishLabels: Record<SystemMetricId, string> = {
  cpu: "CPU",
  memory: "Memory",
  storage: "Storage",
  network: "Network",
  battery: "Battery",
};

/** Translate only the presentation text generated by systemMetricsModel.
 * Collector evidence and error strings remain verbatim so diagnostics never
 * lose their original meaning. */
export function localizedSystemMetricText(
  locale: AppLocale,
  value: string,
): string {
  if (locale === "zh-CN" || !value) return value;
  const replacements: readonly (readonly [string, string])[] = [
    ["当前设备未报告电池", "No battery reported by this Mac"],
    ["台式机、外接显示器或部分 UPS 可能没有电池传感器", "Desktops, external displays, and some UPS devices may not expose a battery sensor"],
    ["Codex 进程占用未知", "Codex process usage unknown"],
    ["Codex 相关进程", "Codex processes"],
    ["Codex 常驻内存", "Codex resident memory"],
    ["Codex 内存未知", "Codex memory unknown"],
    ["剩余时间未知", "Time remaining unknown"],
    ["电源状态未知", "Power status unknown"],
    ["可用空间未知", "Available space unknown"],
    ["容量未知", "Capacity unknown"],
    ["压力未知", "Pressure unknown"],
    ["负载未知", "Load unknown"],
    ["核心数未知", "Core count unknown"],
    ["连接未知", "Connection unknown"],
    ["延迟未知", "Latency unknown"],
    ["错误未知", "Errors unknown"],
    ["健康度未知", "Health unknown"],
    ["功率未知", "Power unknown"],
    ["I/O 未采样", "I/O not sampled"],
    ["项目磁盘", "Project storage"],
    ["使用电池", "On battery"],
    ["外部电源", "External power"],
    ["已充满", "Fully charged"],
    ["充电中", "Charging"],
    ["无电池", "No battery"],
    ["未连接", "Disconnected"],
    ["已连接", "Connected"],
    ["离线", "Offline"],
    ["在线", "Online"],
    ["部分数据", "Partial data"],
    ["计算值", "Derived"],
    ["暂不可用", "Unavailable"],
    ["实时", "Live"],
    ["未知", "Unknown"],
    ["1 分钟负载", "1 min load"],
    ["线程", "threads"],
    [" 核", " cores"],
    ["（", "("],
    ["）", ")"],
    ["压力 正常", "Pressure normal"],
    ["压力 注意", "Pressure warning"],
    ["压力 紧张", "Pressure critical"],
    ["压力 ", "Pressure "],
    ["可用 ", "Available "],
    ["读 ", "Read "],
    ["写 ", "Write "],
    ["延迟 ", "Latency "],
    ["错误 ", "Errors "],
    ["健康度 ", "Health "],
    ["功率 ", "Power "],
    ["电池", "Battery"],
    ["约 ", "About "],
    [" 小时 ", " hr "],
    [" 小时", " hr"],
    [" 分钟", " min"],
    [" 页/s", " pages/s"],
    ["已启用", "Enabled"],
    ["未启用", "Disabled"],
  ];
  return replacements.reduce(
    (translated, [source, replacement]) => translated.split(source).join(replacement),
    value,
  );
}

function localizedSystemMetricDisplay(
  locale: AppLocale,
  display: SystemMetricDisplay,
): SystemMetricDisplay {
  if (locale === "zh-CN") return display;
  return {
    ...display,
    label: systemMetricEnglishLabels[display.id],
    value: localizedSystemMetricText(locale, display.value),
    detail: localizedSystemMetricText(locale, display.detail),
    status: localizedSystemMetricText(locale, display.status),
  };
}

const systemDetailEnglishLabels: Record<string, string> = {
  "系统总占用": "Total system usage",
  "Codex 相关进程": "Codex processes",
  "负载（1 / 5 / 15 分钟）": "Load (1 / 5 / 15 min)",
  "核心（逻辑 / 物理）": "Cores (logical / physical)",
  "平均频率": "Average frequency",
  "进程数": "Process count",
  "热状态": "Thermal state",
  "已用 / 总量": "Used / total",
  "可用": "Available",
  "使用率": "Usage",
  "压力（本地推导）": "Pressure (local estimate)",
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
  "连接状态": "Connection",
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
  "状态 / 电源": "Status / power",
  "剩余时间": "Time remaining",
  "健康度 / 循环次数": "Health / cycle count",
  "功率 / 电压": "Power / voltage",
  "能量 / 满充能量": "Energy / full-charge energy",
  "温度": "Temperature",
};

function localizedSystemMetricDetail(
  locale: AppLocale,
  detail: SystemMetricDetail,
): SystemMetricDetail {
  if (locale === "zh-CN") return detail;
  const translatedValue = localizedSystemMetricText(locale, detail.value);
  return {
    label: systemDetailEnglishLabels[detail.label] ?? detail.label,
    value: detail.value === "是" ? "Yes" : detail.value === "否" ? "No" : translatedValue,
  };
}

/**
 * Keep an expanded shelf inside the display's visible frame.
 *
 * AppKit reports logical points.  A minimum larger than the available extent
 * looks friendly on a normal MacBook, but it is mathematically impossible to
 * keep the window on-screen on a very small/portrait/virtual display.  In
 * that case the content surface is allowed to become narrower/shorter and
 * its own scroll/ellipsis rules provide the graceful degradation.
 */
function fitExpandedDimension(desired: number, visibleExtent: number | undefined): number {
  if (visibleExtent === undefined || !Number.isFinite(visibleExtent) || visibleExtent <= 0) {
    return desired;
  }
  const available = Math.max(1, visibleExtent - 24);
  return Math.min(desired, available);
}

type WidgetIconName =
  | "refresh"
  | "settings"
  | "window"
  | "expand"
  | "collapse"
  | "hide";

/** Small line icons keep the undecorated note legible without relying on
 * platform-specific emoji glyphs. The buttons still expose text labels to
 * assistive technology through their existing aria-label attributes. */
function WidgetIcon({ name }: { name: WidgetIconName }) {
  const common = {
    viewBox: "0 0 20 20",
    width: 16,
    height: 16,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };
  if (name === "refresh") {
    return (
      <svg {...common}>
        <path d="M16.3 7.3A6.5 6.5 0 1 0 16 12" />
        <path d="M16.3 3.8v3.7h-3.7" />
      </svg>
    );
  }
  if (name === "settings") {
    return (
      <svg {...common}>
        <path d="M3 5h14M3 10h14M3 15h14" />
        <circle cx="7" cy="5" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="13" cy="10" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="9" cy="15" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (name === "window") {
    return (
      <svg {...common}>
        <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2" />
        <path d="M3.5 7h13" />
      </svg>
    );
  }
  if (name === "expand") {
    return (
      <svg {...common}>
        <path d="M8 3H3v5M12 3h5v5M3 12v5h5M17 12v5h-5" />
      </svg>
    );
  }
  if (name === "collapse") {
    return (
      <svg {...common}>
        <path d="m5 7.25 5 5 5-5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 10h12" />
    </svg>
  );
}

/**
 * A deliberately small adapter around rdev/liquid-glass-react.
 *
 * The package is a browser/SVG implementation of the Liquid Glass idea. On
 * macOS the app is rendered by WKWebView, where the repository documents that
 * displacement is only partially supported. The native AppKit
 * NSVisualEffectView remains the source of the desktop sample; this layer is
 * only the optical dressing (frost, edge light and a conservative refraction
 * attempt). Keeping it as an empty, pointer-transparent surface means the
 * dashboard text stays crisp and the package can be removed/disabled without
 * changing interaction or data semantics.
 */
function LiquidGlassBackdrop({ enabled }: { enabled: boolean }) {
  if (
    !enabled ||
    prefersReducedMotion() ||
    prefersReducedTransparency() ||
    !supportsLiquidGlassBackdrop()
  ) {
    return null;
  }

  return (
    <div
      className="widget-liquid-glass-host"
      data-liquid-glass-adapter="rdev-liquid-glass-react-1.1.1"
      aria-hidden="true"
    >
      <LiquidGlass
        className="widget-liquid-glass"
        displacementScale={24}
        blurAmount={0.08}
        saturation={128}
        aberrationIntensity={0.65}
        elasticity={0.08}
        cornerRadius={30}
        padding="0"
        overLight={false}
        mode="standard"
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        <span className="widget-liquid-glass-fill" />
      </LiquidGlass>
    </div>
  );
}

function MetricSource({
  state,
  source,
  evidence,
}: {
  state: string;
  source: string;
  evidence: string[];
}) {
  const locale = useAppLocale();
  return (
    <details className="widget-evidence">
      <summary>
        {localizedWidgetStateLabel(locale, state, source)} · {source}
      </summary>
      <p>{evidence[0] ?? localized(locale, "当前没有更多依据。", "No additional evidence is available.")}</p>
    </details>
  );
}

/**
 * A composition meter is intentionally different from an account-quota
 * progress bar. It is rendered only when the source explicitly returned at
 * least two component counters, and its denominator is those known counters.
 */
function TokenCompositionMeter({ metric }: { metric: TokenMetric }) {
  const locale = useAppLocale();
  const composition = tokenCompositionSegments(metric);
  if (!composition) return null;

  const segmentLabel = (key: "input" | "output") =>
    key === "input"
      ? localized(locale, "输入", "Input")
      : localized(locale, "输出", "Output");

  const reasoningText = composition.reasoning
    ? localized(
        locale,
        `推理 ${formatTokenCount(composition.reasoning.value)}（输出内）`,
        `Reasoning ${formatTokenCount(composition.reasoning.value)} (within output)`,
      )
    : undefined;

  return (
    <div
      className="widget-token-composition"
      role="img"
      aria-label={localized(
        locale,
        `已返回 Token 构成：${composition.segments
          .map((segment) => `${segmentLabel(segment.key)} ${segment.percent}%`)
          .join("、")}${reasoningText ? `；${reasoningText}` : ""}`,
        `Reported token composition: ${composition.segments
          .map((segment) => `${segmentLabel(segment.key)} ${segment.percent}%`)
          .join(", ")}${reasoningText ? `; ${reasoningText}` : ""}`,
      )}
      title={localized(
        locale,
        "仅表示已返回的输入、输出、推理构成，不代表额度或项目完成度",
        "Shows reported input, output, and reasoning composition only; it is not quota or project progress.",
      )}
    >
      <div className="widget-token-composition-bar" aria-hidden="true">
        {composition.segments.map((segment) => (
          <span
            className={`widget-token-composition-segment widget-token-composition-segment--${segment.key}`}
            key={segment.key}
            style={{ width: `${segment.percent}%` }}
          />
        ))}
      </div>
      <div className="widget-token-composition-legend">
        {composition.segments.map((segment) => (
          <span key={segment.key}>
            <i
              className={`widget-token-composition-swatch widget-token-composition-swatch--${segment.key}`}
              aria-hidden="true"
            />
            {segmentLabel(segment.key)} {segment.percent}%
          </span>
        ))}
        {reasoningText && (
          <span className="widget-token-composition-reasoning">
            {reasoningText}
          </span>
        )}
      </div>
      <small>
        {localized(
          locale,
          `已返回输入 + 输出 · ${reasoningText ? "推理为输出内的细分 · " : ""}非额度进度`,
          `Reported input + output · ${reasoningText ? "reasoning is included within output · " : ""}not quota progress`,
        )}
      </small>
    </div>
  );
}

function UsageProgressMeter({
  percent,
  label,
}: {
  percent: number | undefined;
  label: string;
}) {
  const boundedPercent = clampMeterPercent(percent);
  if (boundedPercent === undefined) return null;

  return (
    <div className="widget-usage-progress" title={`${label} ${boundedPercent}%`}>
      <div
        className="widget-usage-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={boundedPercent}
      >
        <span style={{ width: `${boundedPercent}%` }} />
      </div>
      <small>{label} {boundedPercent}%</small>
    </div>
  );
}

/**
 * A milestone percentage has a real user-defined denominator, unlike a
 * project Token total. Keeping this as a separate component makes that
 * distinction visible in both the large shelf and the comparison cards.
 */
function CompletionProgressMeter({
  percent,
  label,
}: {
  percent: number | undefined;
  label?: string;
}) {
  const locale = useAppLocale();
  const displayLabel = label ?? localized(locale, "里程碑完成度", "Milestone completion");
  const boundedPercent = clampMeterPercent(percent);
  if (boundedPercent === undefined) return null;

  return (
    <div className="widget-completion-progress" title={`${displayLabel} ${boundedPercent}%`}>
      <div
        className="widget-completion-progress-track"
        role="progressbar"
        aria-label={displayLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={boundedPercent}
      >
        <span style={{ width: `${boundedPercent}%` }} />
      </div>
      <small>{displayLabel} {boundedPercent}%</small>
    </div>
  );
}

function NotchVital({
  label,
  value,
  caption,
  state,
  composition,
  meterPercent,
  meterLabel,
  completionPercent,
  completionLabel,
}: {
  label: string;
  value: string;
  caption: string;
  state: string;
  composition?: TokenMetric;
  meterPercent?: number;
  meterLabel?: string;
  completionPercent?: number;
  completionLabel?: string;
}) {
  return (
    <article className={`notch-vital notch-vital--${state}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{caption}</small>
      {composition && <TokenCompositionMeter metric={composition} />}
      {meterLabel && <UsageProgressMeter percent={meterPercent} label={meterLabel} />}
      {completionLabel && (
        <CompletionProgressMeter
          percent={completionPercent}
          label={completionLabel}
        />
      )}
    </article>
  );
}

function TokenCard({
  id,
  title,
  metric,
}: {
  id: WidgetMetricId;
  title: string;
  metric: TokenMetric;
}) {
  const locale = useAppLocale();
  return (
    <article className={`widget-card widget-card--${metric.state}`} data-metric={id}>
      <div className="widget-card-heading">
        <h2>{title}</h2>
        <span>{localizedWidgetStateLabel(locale, metric.state, metric.source)}</span>
      </div>
      <strong className="widget-card-value">
        {metric.totalTokens === undefined ? "—" : formatTokenCount(metric.totalTokens)}
      </strong>
      <p className="widget-card-caption">
        {metric.totalTokens === undefined
          ? metric.evidence[0] ?? localized(locale, "尚未收到可汇总的 usage", "No usage data is available to total yet")
          : localizedMetricPeriod(locale, metric.period)}
      </p>
      <TokenCompositionMeter metric={metric} />
      <MetricSource state={metric.state} source={metric.source} evidence={metric.evidence} />
    </article>
  );
}

function TaskListCard({
  id,
  title,
  metric,
}: {
  id: WidgetMetricId;
  title: string;
  metric: TaskListMetric;
}) {
  const locale = useAppLocale();
  const count =
    metric.state === "known" || metric.state === "partial"
      ? metric.tasks.length
      : undefined;
  return (
    <article className={`widget-card widget-card--${metric.state}`} data-metric={id}>
      <div className="widget-card-heading">
        <h2>{title}</h2>
        <span>{localizedWidgetStateLabel(locale, metric.state, metric.source)}</span>
      </div>
      <strong className="widget-card-value">{count ?? "—"}</strong>
      {metric.tasks.length > 0 ? (
        <ul className="widget-task-list">
          {metric.tasks.slice(0, 4).map((task) => (
            <li key={task.taskId}>
              <strong>{projectDisplayName(task.projectPath)}</strong>
              <span>{task.lastEvent ?? localizedTaskState(locale, task.state)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="widget-card-caption">
          {metric.state === "known"
            ? localized(locale, "本工具当前没有对应任务。", "No matching tasks are currently recorded.")
            : localized(locale, "当前数据源未接通。", "This data source is not connected.")}
        </p>
      )}
      <MetricSource state={metric.state} source={metric.source} evidence={metric.evidence} />
    </article>
  );
}

function ProjectCard({
  id,
  title,
  metric,
  stagnant = false,
}: {
  id: WidgetMetricId;
  title: string;
  metric: ProjectHighlightMetric;
  stagnant?: boolean;
}) {
  const locale = useAppLocale();
  const scopeLabel =
    metric.scope === "all_saved_projects"
      ? localized(locale, "全部已保存项目", "All saved projects")
      : localized(locale, "范围未知", "Unknown scope");
  return (
    <article className={`widget-card widget-card--${metric.state}`} data-metric={id}>
      <div className="widget-card-heading">
        <h2>{title}</h2>
        <span>{localizedWidgetStateLabel(locale, metric.state, metric.source)}</span>
      </div>
      <strong className="widget-project-name">
        {metric.projectPath ? projectDisplayName(metric.projectPath) : "—"}
      </strong>
      <p className="widget-card-caption">
        {metric.projectPath
          ? `${scopeLabel} · ${
              stagnant
                ? localized(
                    locale,
                    `里程碑记录已有 ${formatAge(metric.ageHours, locale)} 未更新`,
                    `Milestones unchanged for ${formatAge(metric.ageHours, locale)}`,
                  )
                : localized(
                    locale,
                    `用户里程碑完成度 ${metric.percent ?? "—"}%`,
                    `User milestone completion ${metric.percent ?? "—"}%`,
                  )
            }`
          : `${scopeLabel} · ${metric.evidence[0] ?? localized(locale, "没有足够数据。", "Not enough data.")}`}
      </p>
      <CompletionProgressMeter percent={metric.percent} />
      <MetricSource state={metric.state} source={metric.source} evidence={metric.evidence} />
    </article>
  );
}

interface CompactMetricContext {
  projectName: string;
  status: string;
  projectUsage?: TokenMetric;
  usageRemaining?: string;
  usageRemainingPercent?: number;
  projectProgress?: ProjectHighlightMetric;
  todayUsage?: TokenMetric;
  runningTasks?: TaskListMetric;
  failedTasks?: TaskListMetric;
  pendingApprovals?: CountMetric;
  subscription?: SubscriptionMetric;
}

interface CompactMetricCopy {
  label: string;
  value: string;
  title?: string;
  projectStatus?: boolean;
  meterPercent?: number;
  meterLabel?: string;
}

const widgetMetricEnglishLabels: Record<WidgetMetricId, string> = {
  currentProjectUsage: "Current project tokens",
  runningTasks: "Running tasks",
  failedTasks: "Failed tasks",
  pendingApprovals: "Awaiting approval",
  highestCompletion: "Highest completion",
  stagnantProject: "Stale project",
  todayUsage: "Today's tokens",
  recentChanges: "Recent changes",
  subscription: "Codex plan",
};

const compactMetricEnglishCopy: Record<
  WidgetCompactMetricId,
  { label: string; description: string }
> = {
  projectStatus: { label: "Project and status", description: "Project name and current task status" },
  projectUsage: { label: "Project tokens", description: "Measured tokens for the current project" },
  usageRemaining: { label: "Usage remaining", description: "Official rate-limit window remaining" },
  projectProgress: { label: "Project progress", description: "Current milestone completion" },
  todayUsage: { label: "Today's tokens", description: "Most recent official daily tokens" },
  runningTasks: { label: "Running tasks", description: "Locally recorded running task count" },
  failedTasks: { label: "Failed tasks", description: "Locally recorded failed task count" },
  pendingApprovals: { label: "Awaiting approval", description: "Tasks waiting for your approval" },
  subscription: { label: "Plan", description: "Official or manually entered plan label" },
  hidden: { label: "Hidden", description: "Hide this side while collapsed" },
};

function localizedWidgetMetricLabel(
  locale: AppLocale,
  id: WidgetMetricId,
): string {
  if (locale === "en-US") return widgetMetricEnglishLabels[id];
  return widgetMetricDefinitions.find((definition) => definition.id === id)?.label ?? id;
}

function localizedCompactMetricLabel(
  locale: AppLocale,
  id: WidgetCompactMetricId,
): string {
  if (locale === "en-US") return compactMetricEnglishCopy[id].label;
  return widgetCompactMetricDefinitions.find((definition) => definition.id === id)?.label ?? id;
}

function localizedCompactMetricDescription(
  locale: AppLocale,
  id: WidgetCompactMetricId,
): string {
  if (locale === "en-US") return compactMetricEnglishCopy[id].description;
  return widgetCompactMetricDefinitions.find((definition) => definition.id === id)?.description ?? id;
}

function compactTokenValue(metric: TokenMetric | undefined): string {
  return metric?.totalTokens === undefined ? "—" : formatTokenCount(metric.totalTokens);
}

function compactTaskCount(metric: TaskListMetric | undefined): string {
  if (!metric || (metric.state !== "known" && metric.state !== "partial")) return "—";
  return String(metric.tasks.length);
}

function compactMetricCopy(
  metricId: WidgetCompactMetricId,
  context: CompactMetricContext,
  locale: AppLocale,
): CompactMetricCopy {
  switch (metricId) {
    case "projectStatus":
      return {
        label: context.projectName,
        value: context.status,
        title: context.projectName,
        projectStatus: true,
      };
    case "projectUsage":
      return {
        label: localized(locale, "项目 Token", "Project tokens"),
        value: compactTokenValue(context.projectUsage),
        title: context.projectUsage?.evidence[0],
      };
    case "usageRemaining":
      return {
        label: localized(locale, "Usage 余量", "Quota left"),
        value: context.usageRemaining ?? "—",
        meterPercent: context.usageRemainingPercent,
        meterLabel: localized(locale, "官方余量", "Official remaining"),
        title: context.usageRemaining
          ? localized(
              locale,
              `官方窗口余量 ${context.usageRemaining}`,
              `Official window remaining ${context.usageRemaining}`,
            )
          : localized(locale, "官方窗口余量尚未返回", "Official window remaining is not available"),
      };
    case "projectProgress":
      return {
        label: localized(locale, "项目进度", "Project progress"),
        value:
          context.projectProgress?.percent === undefined
            ? "—"
            : `${context.projectProgress.percent}%`,
        meterPercent: context.projectProgress?.percent,
        meterLabel: localized(locale, "里程碑完成度", "Milestone completion"),
        title: context.projectProgress?.evidence[0],
      };
    case "todayUsage":
      return {
        label: localized(locale, "今日 Token", "Today's tokens"),
        value: compactTokenValue(context.todayUsage),
        title: context.todayUsage?.evidence[0],
      };
    case "runningTasks":
      return {
        label: localized(locale, "运行中", "Running"),
        value: compactTaskCount(context.runningTasks),
        title: context.runningTasks?.evidence[0],
      };
    case "failedTasks":
      return {
        label: localized(locale, "失败", "Failed"),
        value: compactTaskCount(context.failedTasks),
        title: context.failedTasks?.evidence[0],
      };
    case "pendingApprovals":
      return {
        label: localized(locale, "待批准", "Approvals"),
        value: context.pendingApprovals?.count === undefined
          ? "—"
          : String(context.pendingApprovals.count),
        title: context.pendingApprovals?.evidence[0],
      };
    case "subscription":
      return {
        label: localized(locale, "订阅", "Plan"),
        value: context.subscription?.label ?? "—",
        title: context.subscription?.evidence[0],
      };
    case "hidden":
      return { label: "", value: "" };
  }
}

function CompactMetricSide({
  side,
  metricId,
  context,
  showGlassChrome,
  glassMaterialRecipe,
}: {
  side: "left" | "right";
  metricId: WidgetCompactMetricId;
  context: CompactMetricContext;
  showGlassChrome?: boolean;
  glassMaterialRecipe?: CompactGlassSurfaceContract["materialRecipe"];
}) {
  const locale = useAppLocale();
  const copy = compactMetricCopy(metricId, context, locale);
  const sideClass = side === "left" ? "widget-capsule-left" : "widget-capsule-details";
  if (metricId === "hidden") {
    return (
      <span
        className={`${sideClass} widget-capsule-side widget-capsule-side--hidden`}
        data-compact-metric={metricId}
        data-compact-glass-surface={glassMaterialRecipe}
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className={`${sideClass} widget-capsule-side widget-capsule-side--${metricId}`}
      data-compact-metric={metricId}
      data-compact-spectrum={showGlassChrome ? "true" : undefined}
      data-compact-glass-surface={glassMaterialRecipe}
      aria-label={localized(
        locale,
        `${copy.label}：${copy.value}`,
        `${copy.label}: ${copy.value}`,
      )}
      title={copy.title}
    >
      {copy.projectStatus && side === "left" && (
        <span className="widget-live-dot" aria-hidden="true" />
      )}
      <span className="widget-capsule-title">
        <strong title={copy.title}>{copy.label}</strong>
        <small>{copy.value}</small>
      </span>
      {copy.meterPercent !== undefined && (
        <span
          className="widget-capsule-meter"
          aria-hidden="true"
          title={copy.meterLabel}
        >
          <span style={{ width: `${clampMeterPercent(copy.meterPercent) ?? 0}%` }} />
        </span>
      )}
    </span>
  );
}

function spectrumWheelSize(width: number, height: number): number {
  const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(1, height) : 1;
  return Math.ceil(Math.hypot(safeWidth, safeHeight) + 8);
}

function SpectrumGradientStops() {
  return (
    <>
      <stop offset="0" stopColor="#ff375f" />
      <stop offset="0.14" stopColor="#ff9f0a" />
      <stop offset="0.28" stopColor="#ffd60a" />
      <stop offset="0.42" stopColor="#30d158" />
      <stop offset="0.56" stopColor="#64d2ff" />
      <stop offset="0.7" stopColor="#0a84ff" />
      <stop offset="0.84" stopColor="#bf5af2" />
      <stop offset="1" stopColor="#ff375f" />
    </>
  );
}

function SpectrumEdge({
  width,
  height,
  radius,
  path,
}: {
  width: number;
  height: number;
  radius?: number;
  path?: string;
}) {
  const gradientId = `widget-spectrum-gradient-${useId().replace(/:/g, "")}`;
  const style = {
    "--widget-spectrum-wheel-size": `${spectrumWheelSize(width, height)}px`,
    "--widget-spectrum-radius": `${radius ?? 0}px`,
  } as CSSProperties;

  if (path) {
    return (
      <svg
        className="widget-spectrum-edge widget-spectrum-edge--path"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={style}
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={gradientId}
            x1="0"
            y1="0"
            x2={width}
            y2={height}
            gradientUnits="userSpaceOnUse"
          >
            <SpectrumGradientStops />
          </linearGradient>
        </defs>
        <path
          className="widget-spectrum-edge-path widget-spectrum-edge-path--base"
          d={path}
          pathLength="1"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          className="widget-spectrum-edge-path widget-spectrum-edge-path--flow"
          d={path}
          pathLength="1"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  return (
    <span
      className="widget-spectrum-edge widget-spectrum-edge--rounded"
      style={style}
      aria-hidden="true"
    >
      <span className="widget-spectrum-edge-frame">
        <span className="widget-spectrum-wheel" />
      </span>
    </span>
  );
}

function widgetSystemPrimary(
  snapshot: SystemMetricsSnapshot,
  id: SystemMetricId,
  fallback: string,
): string {
  if (id === "storage" && snapshot.storage.availableBytes !== undefined) {
    return formatSystemBytes(snapshot.storage.availableBytes);
  }
  if (id === "memory" && snapshot.memory.usedBytes !== undefined && snapshot.memory.totalBytes !== undefined) {
    return `${formatSystemBytes(snapshot.memory.usedBytes)} / ${formatSystemBytes(snapshot.memory.totalBytes)}`;
  }
  return fallback;
}

function widgetSystemMeter(
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

function mediumTaskCount(metric: TaskListMetric | undefined): string {
  if (!metric || (metric.state !== "known" && metric.state !== "partial")) {
    return "—";
  }
  return String(metric.tasks.length);
}

function mediumCount(metric: CountMetric | undefined): string {
  if (!metric || (metric.state !== "known" && metric.state !== "partial")) {
    return "—";
  }
  return metric.count === undefined ? "—" : String(metric.count);
}

function mediumSystemItems(
  snapshot: SystemMetricsSnapshot | undefined,
  locale: AppLocale,
) {
  const displays = new Map(
    (snapshot ? systemMetricDisplays(snapshot) : []).map((display) => [
      display.id,
      localizedSystemMetricDisplay(locale, display),
    ]),
  );
  return [
    { id: "cpu", label: "CPU", value: displays.get("cpu")?.value ?? "—" },
    { id: "memory", label: localized(locale, "内存", "Memory"), value: displays.get("memory")?.value ?? "—" },
    { id: "storage", label: localized(locale, "磁盘", "Storage"), value: displays.get("storage")?.value ?? "—" },
    { id: "network", label: localized(locale, "网络", "Network"), value: displays.get("network")?.value ?? "—" },
  ];
}

function MediumMetricCell({
  label,
  value,
  caption,
  meter,
  tone = "neutral",
}: {
  label: string;
  value: string;
  caption: string;
  meter?: number;
  tone?: "neutral" | "accent" | "warning";
}) {
  const locale = useAppLocale();
  const boundedMeter = meter === undefined
    ? undefined
    : Math.max(0, Math.min(100, meter));
  return (
    <div className="widget-medium-metric" data-tone={tone}>
      <span className="widget-medium-metric-label">{label}</span>
      <strong className="widget-medium-metric-value" title={value}>{value}</strong>
      {boundedMeter !== undefined && (
        <span
          className="widget-medium-page-meter"
          role="progressbar"
          aria-label={localized(locale, `${label}进度`, `${label} progress`)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={boundedMeter}
        >
          <i style={{ width: `${boundedMeter}%` }} />
        </span>
      )}
      {boundedMeter === undefined && (
        <span className="widget-medium-page-meter-spacer" aria-hidden="true" />
      )}
      <small className="widget-medium-metric-caption" title={caption}>{caption}</small>
    </div>
  );
}

function mediumMetricCardCopy(
  metricId: WidgetMediumMetricId,
  context: CompactMetricContext,
  locale: AppLocale,
): {
  label: string;
  value: string;
  caption: string;
  meter?: number;
  tone: "neutral" | "accent" | "warning";
} {
  if (metricId === "projectProgress") {
    const percent = context.projectProgress?.percent;
    return {
      label: localized(locale, "距里程碑目标", "To milestone goal"),
      value: percent === undefined
        ? localized(locale, "未定义", "Not defined")
        : `${Math.max(0, 100 - percent)}%`,
      caption: percent === undefined
        ? localized(locale, "先定义项目里程碑", "Define project milestones first")
        : localized(locale, `已完成 ${percent}%`, `${percent}% completed`),
      meter: percent,
      tone: percent !== undefined && percent < 30 ? "warning" : "neutral",
    };
  }

  const copy = compactMetricCopy(metricId, context, locale);
  const definition = widgetMediumMetricDefinitions.find(({ id }) => id === metricId);
  let label = copy.label;
  let value = copy.value === "—"
    ? localized(locale, "未返回", "Not returned")
    : copy.value;
  // Medium cells use a short, localized presentation caption. Raw collector
  // evidence remains available in the detailed view and is deliberately not
  // promoted here, otherwise an English summary can surface Chinese backend
  // diagnostic prose.
  let caption = definition
    ? localizedCompactMetricDescription(locale, definition.id)
    : localized(locale, "暂无可验证来源", "No verifiable source");
  let tone: "neutral" | "accent" | "warning" = "neutral";

  if (metricId === "projectStatus") {
    label = localized(locale, "项目状态", "Project status");
    value = context.status;
    caption = context.projectName;
  } else if (metricId === "projectUsage") {
    caption = context.projectUsage?.period
      ? localizedMetricPeriod(locale, context.projectUsage.period)
      : caption;
    tone = context.projectUsage?.state === "known" ? "accent" : "neutral";
  } else if (metricId === "todayUsage") {
    caption = context.todayUsage?.period
      ? localizedMetricPeriod(locale, context.todayUsage.period)
      : caption;
    tone = context.todayUsage?.state === "known" ? "accent" : "neutral";
  } else if (metricId === "usageRemaining") {
    tone = context.usageRemainingPercent === undefined ? "neutral" : "accent";
  } else if (metricId === "runningTasks") {
    tone = context.runningTasks?.tasks.length ? "accent" : "neutral";
  } else if (metricId === "failedTasks") {
    tone = context.failedTasks?.tasks.length ? "warning" : "neutral";
  } else if (metricId === "pendingApprovals") {
    tone = context.pendingApprovals?.count ? "warning" : "neutral";
  }

  return {
    label,
    value,
    caption,
    meter: copy.meterPercent,
    tone,
  };
}

interface MediumNotchPageProps {
  projectName: string;
  status: string;
  updatedAt?: number;
  metricIds: readonly [WidgetMediumMetricId, WidgetMediumMetricId, WidgetMediumMetricId];
  metricContext: CompactMetricContext;
  remainingValue: string;
  remainingPercent?: number;
  runningTasks?: TaskListMetric;
  failedTasks?: TaskListMetric;
  pendingApprovals?: CountMetric;
  systemMetrics?: SystemMetricsSnapshot;
  systemMetricsLoading: boolean;
  surfaceWidth: number;
  surfaceHeight: number;
  headerHeight: number;
  cameraWidth: number;
  wrapsHardwareNotch: boolean;
  showExpandButton: boolean;
  suppressCrown?: boolean;
  onOpen: () => void;
}

/**
 * Medium is a standalone resting page. It deliberately does not reuse the
 * compact side-chip header. Its compound material has two information
 * shoulders beside the measured hardware gap and one connected body below;
 * it never paints a replacement black notch.
 */
function MediumNotchPage({
  projectName,
  status,
  updatedAt,
  metricIds,
  metricContext,
  remainingValue,
  remainingPercent,
  runningTasks,
  failedTasks,
  pendingApprovals,
  systemMetrics,
  systemMetricsLoading,
  surfaceWidth,
  surfaceHeight,
  headerHeight,
  cameraWidth,
  wrapsHardwareNotch,
  showExpandButton,
  suppressCrown = false,
  onOpen,
}: MediumNotchPageProps) {
  const locale = useAppLocale();
  const contour = useMemo(
    () => mediumGlassContourPath({
      width: surfaceWidth,
      height: surfaceHeight,
      headerHeight,
      cameraWidth,
      wrapsHardwareNotch,
    }),
    [cameraWidth, headerHeight, surfaceHeight, surfaceWidth, wrapsHardwareNotch],
  );
  const metricCopies = metricIds.map((metricId) =>
    mediumMetricCardCopy(metricId, metricContext, locale),
  );
  const systemItems = mediumSystemItems(systemMetrics, locale);
  const statusTone = mediumCrownStatusTone(status);

  return (
    <div
      className="widget-medium-page widget-medium-contour"
      data-status-tone={statusTone}
      data-wraps-notch={contour.wrapsHardwareNotch}
      data-spectrum-edge="true"
      data-crown-suppressed={suppressCrown ? "true" : undefined}
      style={{ "--widget-surface-height": `${headerHeight}px` } as CSSProperties}
    >
      <MediumContourChrome
        width={surfaceWidth}
        height={surfaceHeight}
        path={contour.path}
      />
      {showExpandButton && (
        <button
          className="widget-surface-expand-button widget-medium-expand-button"
          type="button"
          aria-label={localized(locale, "打开项目详细视图", "Open project details")}
          aria-controls="widget-full-shelf"
          aria-expanded="false"
          title={localized(locale, "打开详细视图", "Open details")}
          onClick={onOpen}
        >
          <WidgetIcon name="expand" />
        </button>
      )}

      {!suppressCrown && (
        <MediumCrown
          projectName={projectName}
          status={status}
          statusTone={statusTone}
          remainingValue={remainingValue}
          remainingPercent={remainingPercent}
        />
      )}

      <section className="widget-medium-body">
        <header className="widget-medium-body-heading">
          <span>{localized(locale, "项目快速概览", "PROJECT QUICK LOOK")}</span>
          <time>
            {systemMetricsLoading
              ? localized(locale, "本机同步中…", "Syncing Mac…")
              : updatedAt
                ? localized(locale, `${formatClock(updatedAt, locale)} 更新`, `Updated ${formatClock(updatedAt, locale)}`)
                : localized(locale, "尚未同步", "Not synced")}
          </time>
        </header>

        <div className="widget-medium-metrics">
          {metricCopies.map((metric, index) => (
            <MediumMetricCell
              key={`${index}-${metricIds[index]}`}
              label={metric.label}
              value={metric.value}
              caption={metric.caption}
              meter={metric.meter}
              tone={metric.tone}
            />
          ))}
        </div>

        <footer className="widget-medium-page-footer" aria-label={localized(locale, "任务与本机状态摘要", "Task and Mac status summary")}>
          <div className="widget-medium-page-status" aria-label={localized(locale, "任务状态摘要", "Task status summary")}>
            <span className="widget-medium-page-status-item widget-medium-page-status-item--running">
              <i aria-hidden="true" />{localized(locale, "运行中", "Running")} {mediumTaskCount(runningTasks)}
            </span>
            <span className="widget-medium-page-status-item widget-medium-page-status-item--failed">
              <i aria-hidden="true" />{localized(locale, "失败", "Failed")} {mediumTaskCount(failedTasks)}
            </span>
            <span className="widget-medium-page-status-item widget-medium-page-status-item--pending">
              <i aria-hidden="true" />{localized(locale, "待批准", "Approvals")} {mediumCount(pendingApprovals)}
            </span>
          </div>
          <div className="widget-medium-machine-grid" aria-label={localized(locale, "本机状态摘要", "Mac status summary")}>
            {systemItems.map((item) => (
              <span key={item.id}>
                <small>{item.label}</small>
                <strong title={`${item.label} ${item.value}`}>{item.value}</strong>
              </span>
            ))}
          </div>
        </footer>
      </section>
    </div>
  );
}

export default function WidgetApp() {
  const locale = useAppLocale();
  const [snapshot, setSnapshot] = useState<WidgetSnapshot>();
  const [projectUsage, setProjectUsage] = useState<ProjectUsageSnapshot>();
  const [accountUsage, setAccountUsage] = useState<AccountUsageSnapshot>();
  const [nativeGeometry, setNativeGeometry] = useState<MacNotchGeometry>();
  const [preferences, setPreferences] = useState<WidgetPreferences>(
    defaultWidgetPreferences,
  );
  const [projectPath, setProjectPath] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presentation, setPresentation] = useState<NotchPresentation>("compact");
  const [loading, setLoading] = useState(true);
  const [officialLoading, setOfficialLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [officialError, setOfficialError] = useState<string>();
  const [systemMetrics, setSystemMetrics] = useState<SystemMetricsSnapshot>();
  const [systemMetricsError, setSystemMetricsError] = useState<string>();
  const [systemMetricsLoading, setSystemMetricsLoading] = useState(false);
  const [nativeError, setNativeError] = useState<string>();
  const [crownSessionId, setCrownSessionId] = useState<string>();
  const [crownPainted, setCrownPainted] =
    useState<WidgetCrownPaintedPayload>();
  const projectPathRef = useRef<string | undefined>(undefined);
  const nativeGeometryRef = useRef<MacNotchGeometry | undefined>(undefined);
  const systemMetricsRef = useRef<SystemMetricsSnapshot | undefined>(undefined);
  const localRequestSequence = useRef(0);
  const officialRequestSequence = useRef(0);
  const transitionSequence = useRef(0);
  const nativeOperationSequence = useRef(0);
  const presentationRef = useRef<NotchPresentation>("compact");
  const restingModeRef = useRef<WidgetRestingMode>(
    defaultWidgetPreferences.restingMode,
  );
  const placementModeRef = useRef(defaultWidgetPreferences.placementMode);
  const pinnedRef = useRef(defaultWidgetPreferences.pinned);
  const floatingRestingFrameRef = useRef<MacNotchRect | undefined>(undefined);
  const settingsOpenRef = useRef(false);
  const draggingRef = useRef(false);
  const expandedExitMissesRef = useRef(0);
  const crownPayloadRef = useRef<WidgetCrownPayload | undefined>(undefined);
  const crownSessionIdRef = useRef<string | undefined>(undefined);
  const crownPaintedRef = useRef<WidgetCrownPaintedPayload | undefined>(undefined);
  const crownHandoffReadyRef = useRef(false);

  const expanded = presentation === "expanded" || settingsOpen;
  const medium = presentation === "medium" && !settingsOpen;
  const floating = preferences.placementMode === "floating";
  const layerChoiceAvailable = canCustomizeWidgetWindowLevel(
    preferences.placementMode,
    preferences.restingMode,
  );
  const opensOnPointerProximity = usesPointerProximityExpansion(
    preferences.placementMode,
  );
  const surfaceOpen = presentation !== "compact" || settingsOpen;
  const liquidGlassEligible =
    surfaceOpen && !(medium && !floating && nativeGeometry?.hasHardwareNotch);
  // The native app already owns a real NSVisualEffectView. Avoid mounting the
  // SVG displacement tree there: it adds an off-screen filter pass and makes
  // frequently used size switches compete with WebKit painting. Browser
  // preview keeps the adapter so the material can still be reviewed there.
  const liquidGlassReady = liquidGlassEligible && !isDesktopRuntime();

  useEffect(() => {
    nativeGeometryRef.current = nativeGeometry;
  }, [nativeGeometry]);

  useEffect(() => {
    systemMetricsRef.current = systemMetrics;
  }, [systemMetrics]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let active = true;
    const unlisteners: Array<() => void> = [];
    subscribeToWidgetCrownReady((ready) => {
      if (
        !active ||
        ready.schemaVersion !== 1 ||
        typeof ready.sessionId !== "string" ||
        ready.sessionId.length === 0 ||
        ready.sessionId.length > 128
      ) {
        return;
      }
      if (crownSessionIdRef.current !== ready.sessionId) {
        crownSessionIdRef.current = ready.sessionId;
        setCrownSessionId(ready.sessionId);
        crownPaintedRef.current = undefined;
        setCrownPainted(undefined);
        crownHandoffReadyRef.current = false;
      }
      const current = crownPayloadRef.current;
      if (!current) return;
      // Readiness only proves that the companion WebView is listening. It
      // deliberately does not transfer visual ownership; that happens after
      // the companion acknowledges an actual painted presentation below.
      void publishWidgetCrownPayload(current).catch(() => undefined);
    })
      .then((dispose) => {
        if (!active) dispose();
        else unlisteners.push(dispose);
      })
      .catch(() => undefined);

    subscribeToWidgetCrownPainted((next) => {
      const painted = normalizeWidgetCrownPaintedPayload(next);
      if (!active || !painted) return;
      // A targeted painted acknowledgement is also authoritative proof of the
      // currently mounted companion session. This closes the startup race in
      // which the one ready heartbeat emitted before the primary listener was
      // installed, while presentationId still rejects stale visual state.
      if (painted.sessionId !== crownSessionIdRef.current) {
        crownSessionIdRef.current = painted.sessionId;
        setCrownSessionId(painted.sessionId);
      }
      crownPaintedRef.current = painted;
      setCrownPainted(painted);
    })
      .then((dispose) => {
        if (!active) dispose();
        else unlisteners.push(dispose);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisteners.forEach((dispose) => dispose());
    };
  }, []);

  const collapsedNativeSize = useCallback(() => {
    const geometry = nativeGeometryRef.current;
    return {
      width: geometry?.closedWidth ?? NOTCH_FALLBACK_CLOSED_SIZE.width,
      height: geometry?.closedHeight ?? NOTCH_FALLBACK_CLOSED_SIZE.height,
    };
  }, []);

  const expandedNativeSize = useCallback(() => {
    const visibleFrame = nativeGeometryRef.current?.visibleFrame;
    // AppKit reports logical points. Clamp the shelf to the display's visible
    // frame so a small/portrait/virtual monitor cannot leave the expanded
    // panel partly off-screen.  Do not impose a minimum larger than the
    // available extent: that would reintroduce the very overflow this clamp
    // is meant to prevent. The normal MacBook path remains 620 × 460 pt.
    return {
      width: fitExpandedDimension(NOTCH_OPEN_SIZE.width, visibleFrame?.width),
      height: fitExpandedDimension(NOTCH_OPEN_SIZE.height, visibleFrame?.height),
    };
  }, []);

  const mediumNativeSize = useCallback(() => {
    const visibleFrame = nativeGeometryRef.current?.visibleFrame;
    return {
      width: fitExpandedDimension(NOTCH_MEDIUM_SIZE.width, visibleFrame?.width),
      height: fitExpandedDimension(NOTCH_MEDIUM_SIZE.height, visibleFrame?.height),
    };
  }, []);

  const nativeSizeForPresentation = useCallback(
    (nextPresentation: NotchPresentation) => {
      if (nextPresentation === "expanded") return expandedNativeSize();
      if (nextPresentation === "medium") return mediumNativeSize();
      return collapsedNativeSize();
    },
    [collapsedNativeSize, expandedNativeSize, mediumNativeSize],
  );

  const invalidateCrownPresentation = useCallback(() => {
    const requestId = ++transitionSequence.current;
    crownPaintedRef.current = undefined;
    setCrownPainted(undefined);
    crownHandoffReadyRef.current = false;
    const currentGeometry = nativeGeometryRef.current;
    if (currentGeometry && currentGeometry.crownCompanionVisible !== false) {
      const invalidatedGeometry = {
        ...currentGeometry,
        crownCompanionVisible: false,
      };
      nativeGeometryRef.current = invalidatedGeometry;
      setNativeGeometry(invalidatedGeometry);
    }
    return requestId;
  }, []);

  /** Apply one final top-centred native frame. Presentation changes never
   * enter a temporary material mode and AppKit is always asked not to animate. */
  const resizeNativeWindow = useCallback(async (
    nextPresentation: NotchPresentation,
    requestId: number,
    crownContentReady = false,
  ) => {
    if (!isDesktopRuntime()) return;
    const nativeOperationId = ++nativeOperationSequence.current;
    const isCurrentNativeOperation = () =>
      requestId === transitionSequence.current &&
      nativeOperationId === nativeOperationSequence.current;
    const target = nativeSizeForPresentation(nextPresentation);
    const placementMode = placementModeRef.current;
    const floatingAnchor =
      placementMode === "floating" && nextPresentation !== "expanded"
        ? floatingRestingFrameRef.current
        : undefined;
    // The medium summary remains click-through on a real hardware-notch Mac;
    // only the full shelf is allowed to receive focus or steal menu-bar hits.
    // A no-notch fallback is made interactive by the AppKit bridge itself.
    const interactive = placementMode === "floating" || nextPresentation === "expanded";
    try {
      const nativeWindow = getCurrentWindow();
      // TaoWindow's macOS subclass uses this flag for
      // canBecomeKeyWindow/canBecomeMainWindow.  Closed mode must remain a
      // passive overlay; expanded mode temporarily enables keyboard/mouse
      // controls.  This is deliberately best-effort because macOS cannot
      // forcibly unfocus a window that is already key.
      // Focusability and AppKit geometry are independent native operations.
      // Start them together so the visible frame is not held behind a second
      // IPC round trip. The AppKit bridge still owns hit testing/material.
      void nativeWindow.setFocusable(interactive).catch(() => undefined);

      // On macOS AppKit owns both the frame and the top-centre anchor.  Use
      // its single setFrame path first so a resize cannot briefly happen at
      // the old top-left origin (the former Tauri setSize → AppKit sync pair
      // caused a visible diagonal jump on Retina displays).  Non-macOS
      // runtimes return supported=false and continue through the portable
      // physical-pixel fallback below.
      const syncOptions = {
        width: target.width,
        height: target.height,
        animate: false,
        interactive,
        surfaceMode: nextPresentation,
        placementMode,
        alwaysOnTop: pinnedRef.current,
        floatingAnchor,
        crownContentReady,
      } as const;
      let native = await syncMacosWidgetWindow(syncOptions).catch(() => undefined);
      if (!isCurrentNativeOperation()) return;
      const handoffRequested =
        crownContentReady &&
        nextPresentation === "medium" &&
        placementMode === "notch" &&
        !pinnedRef.current;
      if (
        native?.supported &&
        handoffRequested &&
        native.crownCompanionVisible !== true
      ) {
        // The first call may only stage and reveal a previously hidden native
        // crown. One immediate retry observes that visible surface and commits
        // the body-only handoff; an actual failure remains a single-window
        // fallback and stops here.
        native = await syncMacosWidgetWindow(syncOptions).catch(() => native);
        if (!isCurrentNativeOperation()) return;
      }
      if (native?.supported) {
        nativeGeometryRef.current = native;
        setNativeGeometry(native);
        if (floatingAnchor) floatingRestingFrameRef.current = undefined;
        return;
      }

      const [previousPosition, previousSize] = await Promise.all([
        nativeWindow.outerPosition().catch(() => undefined),
        nativeWindow.outerSize().catch(() => undefined),
      ]);
      await nativeWindow.setSize(new LogicalSize(target.width, target.height));
      if (!isCurrentNativeOperation()) return;

      // On a portable runtime Tauri exposes physical pixels. Keep the centre
      // correction isolated to that path; AppKit logical geometry above must
      // never be converted a second time through a primary-display scale.
      const fallbackNative = await syncMacosWidgetWindow({
        width: target.width,
        height: target.height,
        animate: false,
        interactive,
        surfaceMode: nextPresentation,
        placementMode,
        alwaysOnTop: pinnedRef.current,
        floatingAnchor,
        crownContentReady,
      }).catch(() => undefined);
      if (!isCurrentNativeOperation()) return;
      if (fallbackNative?.supported) {
        nativeGeometryRef.current = fallbackNative;
        setNativeGeometry(fallbackNative);
        if (floatingAnchor) floatingRestingFrameRef.current = undefined;
        return;
      }

      // Non-macOS fallback: Tauri's monitor coordinates are physical pixels.
      // Keep the old center correction only on this path.
      const nextSize = await nativeWindow.outerSize().catch(() => undefined);
      if (previousPosition && previousSize && nextSize) {
        const widthDelta = Math.round((previousSize.width - nextSize.width) / 2);
        const heightDelta = placementMode === "floating"
          ? Math.round((previousSize.height - nextSize.height) / 2)
          : 0;
        await nativeWindow
          .setPosition(new PhysicalPosition(
            previousPosition.x + widthDelta,
            previousPosition.y + heightDelta,
          ))
          .catch(() => undefined);
      }
      if (floatingAnchor) floatingRestingFrameRef.current = undefined;
    } catch {
      // Browser preview and a runtime that refuses a window mutation still
      // retain the CSS state, data, and keyboard interaction.
    }
  }, [nativeSizeForPresentation]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let active = true;
    const unlisteners: Array<() => void> = [];
    subscribeToWidgetWindowShown(() => {
      if (!active) return;
      const currentPresentation = settingsOpenRef.current
        ? "expanded"
        : presentationRef.current;
      // A newly visible native host is a new presentation even if its selected
      // page did not change. Reusing the previous generation would let a stale
      // paint acknowledgement suppress the main header before the companion
      // has returned from its hidden state.
      const requestId = invalidateCrownPresentation();
      void resizeNativeWindow(currentPresentation, requestId, false);
    })
      .then((dispose) => {
        if (!active) dispose();
        else unlisteners.push(dispose);
      })
      .catch(() => undefined);

    subscribeToWidgetWindowHidden(() => {
      if (active) invalidateCrownPresentation();
    })
      .then((dispose) => {
        if (!active) dispose();
        else unlisteners.push(dispose);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisteners.forEach((dispose) => dispose());
    };
  }, [invalidateCrownPresentation, resizeNativeWindow]);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
    presentationRef.current = presentation;
  }, [presentation, settingsOpen]);

  useEffect(() => {
    restingModeRef.current = preferences.restingMode;
  }, [preferences.restingMode]);

  useEffect(() => {
    pinnedRef.current = preferences.pinned;
  }, [preferences.pinned]);

  useEffect(() => {
    const previousPlacement = placementModeRef.current;
    placementModeRef.current = preferences.placementMode;
    if (previousPlacement === preferences.placementMode || !isDesktopRuntime()) return;
    floatingRestingFrameRef.current = undefined;
    const currentPresentation = settingsOpenRef.current
      ? "expanded"
      : presentationRef.current;
    const requestId = invalidateCrownPresentation();
    void resizeNativeWindow(currentPresentation, requestId, false);
  }, [
    invalidateCrownPresentation,
    preferences.placementMode,
    resizeNativeWindow,
  ]);

  useEffect(() => {
    return () => {
      transitionSequence.current += 1;
      nativeOperationSequence.current += 1;
    };
  }, []);

  /**
   * Ask AppKit for the screen that actually owns this widget.  The result is
   * also refreshed periodically so moving the menu bar/display does not leave
   * a stale, hand-written notch width in the renderer.
   */
  useEffect(() => {
    let active = true;
    if (!isDesktopRuntime()) {
      const previewGeometry = { ...browserMacNotchGeometry, updatedAt: Date.now() };
      nativeGeometryRef.current = previewGeometry;
      setNativeGeometry(previewGeometry);
      return () => {
        active = false;
      };
    }

    const refreshNativeGeometry = async () => {
      const refreshRequestId = transitionSequence.current;
      const nativeOperationId = ++nativeOperationSequence.current;
      const isCurrentNativeOperation = () =>
        active &&
        refreshRequestId === transitionSequence.current &&
        nativeOperationId === nativeOperationSequence.current;
      const crownContentReady = crownHandoffReadyRef.current;
      try {
        const geometry = await getMacosNotchGeometry();
        if (!isCurrentNativeOperation()) return;
        nativeGeometryRef.current = geometry;

        // The first native frame is created from a conservative config size.
        // Replace it with the screen-derived collapsed size, or just re-anchor
        // the current expanded frame after a display change.
        const currentPresentation = settingsOpenRef.current
          ? "expanded"
          : presentationRef.current;
        const target = nativeSizeForPresentation(currentPresentation);
        const syncOptions = {
          width: target.width,
          height: target.height,
          animate: false,
          interactive:
            placementModeRef.current === "floating" || currentPresentation === "expanded",
          surfaceMode: currentPresentation,
          placementMode: placementModeRef.current,
          alwaysOnTop: pinnedRef.current,
          crownContentReady,
        } as const;
        let syncedGeometry = await syncMacosWidgetWindow(syncOptions);
        if (!isCurrentNativeOperation()) return;
        if (
          crownContentReady &&
          currentPresentation === "medium" &&
          placementModeRef.current === "notch" &&
          !pinnedRef.current &&
          syncedGeometry.crownCompanionVisible !== true
        ) {
          syncedGeometry = await syncMacosWidgetWindow(syncOptions);
          if (!isCurrentNativeOperation()) return;
        }
        // Keep the presentation acknowledgement returned by the sync. The
        // preceding geometry-only probe intentionally has no companion state;
        // rendering it every five seconds would briefly revoke crown
        // ownership and make the top material pulse.
        nativeGeometryRef.current = syncedGeometry;
        setNativeGeometry(syncedGeometry);
        setNativeError(undefined);
      } catch (cause: unknown) {
        if (active) setNativeError(readableError(cause));
      }
    };

    void refreshNativeGeometry();
    const interval = window.setInterval(refreshNativeGeometry, 5_000);
    const refreshAfterWindowShow = () => {
      if (document.visibilityState === "visible") {
        void refreshNativeGeometry();
      }
    };
    document.addEventListener("visibilitychange", refreshAfterWindowShow);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshAfterWindowShow);
    };
  }, [nativeSizeForPresentation]);

  /** Commit the requested page immediately and issue exactly one final
   * AppKit resize. The request sequence prevents an older async response from
   * replacing newer geometry in React. */
  const commitPresentation = useCallback((nextPresentation: NotchPresentation) => {
    if (presentationRef.current === nextPresentation) return Promise.resolve();
    const requestId = invalidateCrownPresentation();
    presentationRef.current = nextPresentation;
    setPresentation(nextPresentation);
    return resizeNativeWindow(nextPresentation, requestId, false);
  }, [invalidateCrownPresentation, resizeNativeWindow]);

  const openPresentation = useCallback((
    nextPresentation: Exclude<NotchPresentation, "compact">,
  ) => {
    if (settingsOpenRef.current && nextPresentation !== "expanded") {
      return Promise.resolve();
    }
    return commitPresentation(nextPresentation);
  }, [commitPresentation]);

  const openCapsule = useCallback(async () => {
    if (
      placementModeRef.current === "floating" &&
      presentationRef.current !== "expanded"
    ) {
      let restingFrame = nativeGeometryRef.current?.windowFrame;
      if (isDesktopRuntime()) {
        const currentGeometry = await getMacosNotchGeometry().catch(() => undefined);
        if (currentGeometry) {
          nativeGeometryRef.current = currentGeometry;
          setNativeGeometry(currentGeometry);
          restingFrame = currentGeometry.windowFrame;
        }
      }
      if (restingFrame) {
        floatingRestingFrameRef.current = { ...restingFrame };
      }
    }
    await openPresentation("expanded");
  }, [openPresentation]);

  // Preferences arrive after the WebView's conservative compact bootstrap.
  // Apply a saved medium resting choice once, or any future resting-mode
  // update made while the shelf is not expanded. Settings themselves live in
  // the expanded shelf, so normal user changes settle on the next close.
  useEffect(() => {
    const nextResting = preferences.restingMode;
    restingModeRef.current = nextResting;
    if (
      settingsOpenRef.current ||
      presentationRef.current === "expanded" ||
      presentationRef.current === nextResting
    ) {
      return;
    }
    void commitPresentation(nextResting);
  }, [
    commitPresentation,
    preferences.restingMode,
  ]);

  const collapseToResting = useCallback(() => {
    if (settingsOpenRef.current || draggingRef.current) return;
    const targetPresentation = restingModeRef.current;
    void commitPresentation(targetPresentation);
  }, [commitPresentation]);

  /** A click-open floating surface stays open until the user explicitly
   * dismisses it. This also gives keyboard and VoiceOver users a deterministic
   * way back to the selected resting page. */
  const collapseExpandedSurface = useCallback(() => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    return commitPresentation(restingModeRef.current);
  }, [commitPresentation]);

  const startFloatingDrag = useCallback(async (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const target = event.target;
    const selection = window.getSelection();
    const protectedTarget = target instanceof Element && Boolean(target.closest([
      "button",
      "a",
      "input",
      "select",
      "textarea",
      "label",
      "summary",
      "details",
      "[contenteditable='true']",
      "[role='button']",
      "[role='link']",
      "[role='slider']",
      "[data-window-drag-exclude]",
      ".widget-settings",
      ".widget-dashboard",
      ".widget-content",
      ".widget-error",
    ].join(",")));
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      event.defaultPrevented ||
      protectedTarget ||
      (selection && !selection.isCollapsed) ||
      placementModeRef.current !== "floating" ||
      !isDesktopRuntime()
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    draggingRef.current = true;
    try {
      await getCurrentWindow().startDragging();
      setNativeError(undefined);
    } catch (cause: unknown) {
      setNativeError(localized(
        locale,
        `浮动窗口拖动失败：${readableError(cause)}`,
        `Could not drag the floating window: ${readableError(cause)}`,
      ));
    } finally {
      draggingRef.current = false;
    }
  }, [locale]);

  useEffect(() => {
    if (!isDesktopRuntime() || !opensOnPointerProximity) return;
    let active = true;
    let timer: number | undefined;

    const checkPointerProximity = async () => {
      if (!active) return;
      let nextPollMs = NOTCH_PROXIMITY_POLL_MS;
      try {
        // AppKit returns both the pointer and the native window frame in the
        // same global logical-point coordinate space. Do not use tao's generic
        // cursorPosition here: its macOS path converts through the primary
        // display's physical height, so mixed-scale/offset displays can put
        // the proximity test in a different coordinate space.
        const currentPresentation = presentationRef.current;
        const restingPresentation = currentPresentation !== "expanded";
        const sample = await getMacosPointerProximity(
          restingPresentation
            ? NOTCH_ENTRY_MARGIN_PT
            : NOTCH_EXPANDED_EXIT_MARGIN_PT,
        );
        if (!active) return;
        // Ignore a sample that was taken for a frame which changed while the
        // AppKit IPC request was in flight.
        if (presentationRef.current !== currentPresentation) {
          if (active) {
            timer = window.setTimeout(
              checkPointerProximity,
              NOTCH_PROXIMITY_POLL_MS,
            );
          }
          return;
        }

        // Non-macOS runtimes return supported=false. Their fallback capsule
        // remains an ordinary interactive DOM target, so no second coordinate
        // conversion is needed here. Keep the timer alive in every branch:
        // the widget can be hidden and shown again, and a transient native
        // probe failure must not permanently disable hover expansion.
        if (!sample.supported) {
          nextPollMs = NOTCH_HIDDEN_POLL_MS;
        } else if (!sample.windowVisible) {
          // A hidden widget cannot be hovered. Back off the native IPC poll
          // while it is hidden, then return to the responsive cadence as soon
          // as AppKit reports it visible again.
          nextPollMs = NOTCH_HIDDEN_POLL_MS;
        } else {
          const geometry = nativeGeometryRef.current;
          // Resting hardware views expose one compact information band: the
          // two side metrics plus the system-owned camera gap between them.
          // Its horizontal intent follows the complete visible resting band:
          // the measured compact host in compact mode and the authored crown
          // width in medium mode. Its vertical intent must never extend below
          // the real camera-safe strip. The helper anchors either band to the
          // live window's top centre.
          const cameraBandWidth = geometry?.hasHardwareNotch
            ? currentPresentation === "medium"
              ? mediumNativeSize().width
              : geometry.closedWidth
            : geometry?.closedWidth ?? NOTCH_FALLBACK_CLOSED_SIZE.width;
          const cameraBandHeight = geometry?.hasHardwareNotch
            ? Math.min(
                geometry.closedHeight,
                geometry.notchHeight || geometry.safeAreaTop,
              )
            : Math.min(
                geometry?.closedHeight ?? NOTCH_FALLBACK_CLOSED_SIZE.height,
                NOTCH_FALLBACK_CLOSED_SIZE.height,
              );
          const pointerInsideIntentRegion = restingPresentation
            ? isPointerNearCompactAnchor(
                sample,
                cameraBandWidth,
                cameraBandHeight,
                NOTCH_ENTRY_MARGIN_PT,
              )
            : sample.nearWindow;

          if (pointerInsideIntentRegion) {
            expandedExitMissesRef.current = 0;
            // The target ref changes in the same tick, so the native poll
            // cannot enqueue the same resize repeatedly while IPC is settling.
            if (restingPresentation) void openCapsule();
          } else if (!restingPresentation) {
            expandedExitMissesRef.current += 1;
            if (
              expandedExitMissesRef.current >= NOTCH_EXPANDED_EXIT_MISS_COUNT
            ) {
              expandedExitMissesRef.current = 0;
              collapseToResting();
            }
          } else {
            expandedExitMissesRef.current = 0;
          }
        }
      } catch {
        // A transient AppKit sample failure should not tear down the widget;
        // the next bounded poll retries. Treat an error like a hidden state so
        // a repeated IPC failure cannot keep a battery-powered Mac on a
        // 120ms retry loop; fallback displays still have DOM pointer events.
        nextPollMs = NOTCH_HIDDEN_POLL_MS;
      }

      if (active) {
        timer = window.setTimeout(checkPointerProximity, nextPollMs);
      }
    };

    void checkPointerProximity();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [collapseToResting, mediumNativeSize, openCapsule, opensOnPointerProximity]);

  const refreshLocal = useCallback(async (path = projectPathRef.current) => {
    const requestId = ++localRequestSequence.current;
    setLoading(true);
    let requestedPath = path?.trim() || undefined;
    try {
      // The main window can switch projects while this webview stays alive.
      // Read the native hand-off on every refresh so an already-open widget
      // follows that selection without requiring a window recreation.
      if (isDesktopRuntime()) {
        const nativeState = await getWidgetState().catch(() => undefined);
        const nativePath = nativeState?.selectedProjectPath?.trim();
        if (nativePath) {
          requestedPath = nativePath;
        }
      }
      if (requestedPath && requestedPath !== projectPathRef.current) {
        projectPathRef.current = requestedPath;
        setProjectPath(requestedPath);
      }
      const next = await getWidgetSnapshot({ projectPath: requestedPath });
      if (requestId !== localRequestSequence.current) return requestedPath;
      const resolvedPath = next.currentProjectPath?.trim() || requestedPath;
      if (resolvedPath && resolvedPath !== projectPathRef.current) {
        projectPathRef.current = resolvedPath;
        setProjectPath(resolvedPath);
      }
      setSnapshot(next);
      setError(undefined);
      return resolvedPath;
    } catch (cause: unknown) {
      if (requestId === localRequestSequence.current) {
        setError(readableError(cause));
      }
      return requestedPath;
    } finally {
      if (requestId === localRequestSequence.current) setLoading(false);
    }
  }, []);

  const refreshOfficial = useCallback(async (path = projectPathRef.current) => {
    const requestId = ++officialRequestSequence.current;
    const requestedPath = path?.trim() || undefined;
    setOfficialLoading(true);
    setOfficialError(undefined);
    try {
      const projectRequest = requestedPath
        ? getProjectUsage(requestedPath)
        : Promise.resolve<ProjectUsageSnapshot | undefined>(undefined);
      const [accountResult, projectResult] = await Promise.allSettled([
        getAccountUsage(),
        projectRequest,
      ]);
      if (requestId !== officialRequestSequence.current) return;

      const errors: string[] = [];
      if (accountResult.status === "fulfilled") {
        setAccountUsage(accountResult.value);
      } else {
        errors.push(localized(
          locale,
          `账户：${readableError(accountResult.reason)}`,
          `Account: ${readableError(accountResult.reason)}`,
        ));
      }
      if (projectResult.status === "fulfilled") {
        setProjectUsage(projectResult.value);
      } else {
        errors.push(localized(
          locale,
          `项目 Token：${readableError(projectResult.reason)}`,
          `Project tokens: ${readableError(projectResult.reason)}`,
        ));
      }
      setOfficialError(errors.length > 0 ? errors.join(localized(locale, "；", "; ")) : undefined);
    } finally {
      if (requestId === officialRequestSequence.current) setOfficialLoading(false);
    }
  }, [locale]);

  const refreshAll = useCallback(async () => {
    const selectedPath = await refreshLocal();
    await refreshOfficial(selectedPath ?? projectPathRef.current);
  }, [refreshLocal, refreshOfficial]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.allSettled([
      getWidgetPreferences(),
      listWorkspaces(),
      getEnvironment(),
      isDesktopRuntime() ? getWidgetState() : Promise.resolve(undefined),
    ])
      .then(async ([
        preferenceResult,
        workspaceResult,
        environmentResult,
        widgetStateResult,
      ]) => {
        if (!active) return;
        if (preferenceResult.status === "fulfilled") {
          const nextPreferences = normalizeWidgetPreferences(
            preferenceResult.value.preferences,
          );
          setPreferences(nextPreferences);
          pinnedRef.current = nextPreferences.pinned;
          if (isDesktopRuntime()) {
            await setWidgetAlwaysOnTop(nextPreferences.pinned).catch(() => undefined);
          }
        }
        const activeProject =
          workspaceResult.status === "fulfilled"
            ? workspaceResult.value.activeProjectPath
            : undefined;
        const fallbackProject =
          environmentResult.status === "fulfilled"
            ? environmentResult.value.projectPath
            : undefined;
        const passedProject =
          widgetStateResult.status === "fulfilled"
            ? widgetStateResult.value?.selectedProjectPath
            : undefined;
        const selectedProject = passedProject || activeProject || fallbackProject || undefined;
        projectPathRef.current = selectedProject;
        setProjectPath(selectedProject);
        await refreshLocal(selectedProject);
      })
      .catch((cause: unknown) => {
        if (active) setError(readableError(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshLocal]); // Initial load is intentionally one-shot; polling below uses the saved interval.

  useEffect(() => {
    const interval = window.setInterval(
      () => void refreshLocal(),
      preferences.refreshSeconds * 1_000,
    );
    return () => window.clearInterval(interval);
  }, [preferences.refreshSeconds, refreshLocal]);

  useEffect(() => {
    const selectedPath = projectPath?.trim();
    if (!selectedPath) return;
    projectPathRef.current = selectedPath;
    void refreshOfficial(selectedPath);
    const interval = window.setInterval(
      () => void refreshOfficial(selectedPath),
      OFFICIAL_REFRESH_MS,
    );
    return () => window.clearInterval(interval);
  }, [projectPath, refreshOfficial]);

  // A project switch changes the Git/task scope, disk volume, and Codex
  // process context. Drop project-scoped snapshots immediately so the middle
  // surface never shows the previous project's name or counts while the first
  // sample for the new selection is being collected.
  useEffect(() => {
    // Fast local reads can finish before this effect runs. Keep a result that
    // already belongs to the new selection instead of erasing it until the
    // next poll, while still discarding every previous project's snapshot.
    setSnapshot(current => current?.currentProjectPath === projectPath ? current : undefined);
    setProjectUsage(current => current?.projectPath === projectPath ? current : undefined);
    systemMetricsRef.current = undefined;
    setSystemMetrics(undefined);
    setSystemMetricsError(undefined);
  }, [projectPath]);

  // The medium summary and expanded shelf get a light local-resource sample.
  // It backs off while the widget is collapsed so the floating note does not
  // become a persistent high-frequency system probe. The native collector
  // keeps the previous frame for real network/disk deltas and marks
  // first-frame rates unknown.
  useEffect(() => {
    const selectedPath = projectPath?.trim();
    if (!selectedPath || !surfaceOpen) return;
    let active = true;
    let inFlight = false;
    const loadSystemMetrics = () => {
      if (inFlight) return;
      inFlight = true;
      const isFirstSample = systemMetricsRef.current === undefined;
      if (isFirstSample) setSystemMetricsLoading(true);
      getSystemMetrics(selectedPath)
        .then((next) => {
          if (!active || selectedPath !== projectPathRef.current) return;
          systemMetricsRef.current = next;
          setSystemMetrics(next);
          setSystemMetricsError(undefined);
        })
        .catch((cause: unknown) => {
          if (active) setSystemMetricsError(readableError(cause));
        })
        .finally(() => {
          inFlight = false;
          if (active && isFirstSample) setSystemMetricsLoading(false);
        });
    };
    void loadSystemMetrics();
    const interval = window.setInterval(loadSystemMetrics, 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [projectPath, surfaceOpen]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    subscribeToTaskEvents(() => void refreshLocal())
      .then((dispose) => {
        if (!active) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refreshLocal]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    subscribeToWidgetProject((path) => {
      const selectedPath = path.trim();
      if (!selectedPath) return;
      projectPathRef.current = selectedPath;
      setProjectPath(selectedPath);
      void refreshLocal(selectedPath);
    })
      .then((dispose) => {
        if (!active) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refreshLocal]);

  const visible = useMemo(
    () => new Set(preferences.visibleMetrics),
    [preferences.visibleMetrics],
  );

  function toggleMetric(id: WidgetMetricId) {
    setPreferences((current) => {
      const exists = current.visibleMetrics.includes(id);
      return {
        ...current,
        visibleMetrics: exists
          ? current.visibleMetrics.filter((metric) => metric !== id)
          : [...current.visibleMetrics, id],
      };
    });
  }

  function setCompactSideMetric(
    side: "left" | "right",
    metric: WidgetCompactMetricId,
  ) {
    setPreferences((current) =>
      side === "left"
        ? { ...current, compactLeftMetric: metric }
        : { ...current, compactRightMetric: metric },
    );
  }

  function setFloatingMediumMetric(
    index: 0 | 1 | 2,
    metric: WidgetMediumMetricId,
  ) {
    setPreferences((current) => {
      const floatingMediumMetrics = [
        ...current.floatingMediumMetrics,
      ] as WidgetPreferences["floatingMediumMetrics"];
      floatingMediumMetrics[index] = metric;
      return { ...current, floatingMediumMetrics };
    });
  }

  function setRestingMode(mode: WidgetRestingMode) {
    restingModeRef.current = mode;
    setPreferences((current) => ({ ...current, restingMode: mode }));
  }

  async function saveSettings() {
    setSaving(true);
    setError(undefined);
    try {
      const result = await saveWidgetPreferences(preferences);
      const normalized = normalizeWidgetPreferences(result.preferences);
      restingModeRef.current = normalized.restingMode;
      placementModeRef.current = normalized.placementMode;
      pinnedRef.current = normalized.pinned;
      setPreferences(normalized);
      if (isDesktopRuntime()) {
        const requestId = ++transitionSequence.current;
        // Stacking and placement both touch the same NSWindow. Apply them in a
        // deterministic order so a late always-on-top lifecycle sync cannot
        // overwrite the final floating/notch frame.
        await setWidgetAlwaysOnTop(normalized.pinned);
        await resizeNativeWindow("expanded", requestId);
      }
      setSettingsOpen(false);
      await refreshAll();
    } catch (cause: unknown) {
      setError(readableError(cause));
    } finally {
      setSaving(false);
    }
  }

  const countMetric = preferences.visibleMetrics.length;
  const projectTokenMetric = useMemo(
    () => widgetProjectTokenMetric(snapshot, projectUsage),
    [projectUsage, snapshot],
  );
  const recentDailyTokenMetric = useMemo(
    () => widgetRecentDailyTokenMetric(snapshot, accountUsage),
    [accountUsage, snapshot],
  );
  const subscriptionMetric = useMemo(
    () => widgetSubscriptionMetric(snapshot, accountUsage),
    [accountUsage, snapshot],
  );
  const windowRemainingText = useMemo(
    () => widgetWindowRemainingText(accountUsage),
    [accountUsage],
  );
  const accountLifetimeText =
    accountUsage?.tokenActivity.lifetimeTokens === undefined
      ? undefined
      : localized(
          locale,
          `账户累计（非额度）${formatTokenCount(accountUsage.tokenActivity.lifetimeTokens)}`,
          `Account lifetime activity (not quota) ${formatTokenCount(accountUsage.tokenActivity.lifetimeTokens)}`,
        );
  const accountRemainingPercent = limitingRateLimit(accountUsage)?.remainingPercent;

  const capsuleStatus = error
    ? localized(locale, "读取失败", "Read failed")
    : loading
      ? localized(locale, "读取中", "Reading")
      : officialLoading
        ? localized(locale, "同步中", "Syncing")
        : snapshot?.pendingApprovals.count
          ? localized(
              locale,
              `${snapshot.pendingApprovals.count} 项待批准`,
              `${snapshot.pendingApprovals.count} awaiting approval`,
            )
          : snapshot?.runningTasks.tasks.length
            ? localized(
                locale,
                `${snapshot.runningTasks.tasks.length} 个运行中`,
                `${snapshot.runningTasks.tasks.length} running`,
              )
            : !snapshot || snapshot.runningTasks.state === "unknown" || snapshot.runningTasks.state === "unavailable"
              ? localized(locale, "状态未知", "Status unknown")
              : localized(locale, "空闲", "Idle");
  const selectedProjectPath = snapshot?.currentProjectPath ?? projectPath;
  const currentProjectName = selectedProjectPath
    ? projectDisplayName(selectedProjectPath)
    : localized(locale, "未知项目", "Unknown project");
  const currentProgress = snapshot?.currentProjectProgress;
  const currentProgressPercent = currentProgress?.percent;
  const compactContext: CompactMetricContext = {
    projectName: currentProjectName,
    status: capsuleStatus,
    projectUsage: projectTokenMetric,
    usageRemaining: windowRemainingText
      ?.replace(/^(窗口余量|Window remaining)\s*/, "") ?? undefined,
    usageRemainingPercent: accountRemainingPercent,
    projectProgress: currentProgress,
    todayUsage: recentDailyTokenMetric,
    runningTasks: snapshot?.runningTasks,
    failedTasks: snapshot?.failedTasks,
    pendingApprovals: snapshot?.pendingApprovals,
    subscription: subscriptionMetric,
  };
  const remainingValue = windowRemainingText
    ?.replace(/^(窗口余量|Window remaining)\s*/, "") ?? localized(locale, "未返回", "Not returned");
  const goalRemainingValue =
    currentProgressPercent === undefined
      ? localized(locale, "未定义", "Not defined")
      : `${Math.max(0, 100 - currentProgressPercent)}%`;
  const goalCaption =
    currentProgressPercent === undefined
      ? currentProgress?.evidence[0] ?? localized(
          locale,
          "先在主窗口为当前项目保存里程碑",
          "Save milestones for this project in the main window first",
        )
      : localized(
          locale,
          `已完成 ${currentProgressPercent}% · 基于你保存的里程碑`,
          `${currentProgressPercent}% completed · based on your saved milestones`,
        );
  // On a real notched display the native host follows the measured top safe
  // area and is widened to leave room for two compact status chips. The
  // central camera gap remains transparent; external displays use the
  // explicit fallback host height. Global AppKit pointer polling still
  // handles hover intent because the compact hardware host is click-through.
  // Use the actual native host height rather than the raw safe-area measure.
  // The bridge deliberately applies a small readability floor on unusual
  // displays; using `notchHeight` here would let a 20pt safe area clip a 26pt
  // side chip even though the native frame is correctly 24pt high.
  const closedSurfaceHeight =
    nativeGeometry?.closedHeight ?? NOTCH_FALLBACK_CLOSED_SIZE.height;
  const hardwareCompactSideHeight = Math.max(
    1,
    closedSurfaceHeight - HARDWARE_COMPACT_VERTICAL_INSET_PT * 2,
  );
  const hardwareCompactSideRadius = hardwareCompactSideHeight / 2;
  const mediumSurfaceSize = mediumNativeSize();
  const expandedSurfaceSize = expandedNativeSize();
  const notchStyle = useMemo(
    () =>
      ({
        "--widget-closed-width": `${
          nativeGeometry?.closedWidth ?? NOTCH_FALLBACK_CLOSED_SIZE.width
        }px`,
        "--widget-closed-height": `${
          nativeGeometry?.closedHeight ?? NOTCH_FALLBACK_CLOSED_SIZE.height
        }px`,
        "--widget-surface-height": `${closedSurfaceHeight}px`,
        "--widget-camera-width": `${nativeGeometry?.notchWidth ?? 0}px`,
        "--widget-safe-top": `${nativeGeometry?.safeAreaTop ?? 0}px`,
        "--widget-compact-side-height": `${hardwareCompactSideHeight}px`,
        "--widget-compact-side-radius": `${hardwareCompactSideRadius}px`,
        "--widget-medium-width": `${mediumSurfaceSize.width}px`,
        "--widget-medium-height": `${mediumSurfaceSize.height}px`,
        "--widget-open-width": `${expandedSurfaceSize.width}px`,
        "--widget-open-height": `${expandedSurfaceSize.height}px`,
        "--widget-expanded-radius": `${EXPANDED_SURFACE_RADIUS}px`,
      }) as CSSProperties,
    [
      closedSurfaceHeight,
      hardwareCompactSideHeight,
      hardwareCompactSideRadius,
      mediumSurfaceSize.height,
      mediumSurfaceSize.width,
      expandedSurfaceSize.height,
      expandedSurfaceSize.width,
      nativeGeometry,
    ],
  );
  // Do not paint the portable fallback while the first AppKit sample is still
  // in flight. On a real notched Mac the initial 220×38 bootstrap frame would
  // otherwise flash as a second, obviously fake notch for a few frames.
  const nativeGeometryPending =
    !floating && isDesktopRuntime() && !nativeGeometry && !nativeError;
  const notchClass = nativeGeometryPending
    ? "widget-notch widget-notch--pending"
    : floating
      ? "widget-notch widget-notch--fallback widget-notch--floating"
      : nativeGeometry?.hasHardwareNotch
      ? "widget-notch widget-notch--hardware"
      : "widget-notch widget-notch--fallback";
  // A few external displays expose only a 24–26pt top safe area. Two stacked
  // text lines plus a border cannot fit there without cutting descenders, so
  // the compact presentation switches to a deliberate single-line density
  // instead of relying on overflow clipping. The expanded shelf always keeps
  // the full status text.
  const compactTight = closedSurfaceHeight < 30;
  const nativeSurfaceLabel = floating
    ? localized(locale, "可拖动浮动窗口", "Draggable floating window")
    : nativeGeometry?.hasHardwareNotch
    ? localized(locale, "macOS 摄像头安全区适配 · 双侧指标", "macOS camera-safe fit · dual metrics")
    : nativeGeometry?.supported
      ? localized(locale, "顶部胶囊回退", "Top capsule fallback")
      : localized(locale, "等待原生屏幕信息", "Waiting for native display data");

  function toggleSettingsView() {
    if (settingsOpen) {
      settingsOpenRef.current = false;
      setSettingsOpen(false);
      return;
    }
    void openCapsule();
    settingsOpenRef.current = true;
    presentationRef.current = "expanded";
    setPresentation("expanded");
    setSettingsOpen(true);
  }

  async function hideNotchWindow() {
    await collapseExpandedSurface();
    await hideWidget();
  }

  const shellPresentation = settingsOpen ? "expanded" : presentation;
  const shellPresentationClass = shellPresentation === "expanded"
    ? "widget-shell--expanded"
    : shellPresentation === "medium"
      ? "widget-shell--medium"
      : "widget-shell--collapsed";
  const hardwareCompactSpectrumActive =
    shellPresentation === "compact" &&
    !nativeGeometryPending &&
    !floating &&
    Boolean(nativeGeometry?.hasHardwareNotch);
  const compactGlassExperimentActive =
    shellPresentation === "compact" &&
    !nativeGeometryPending;
  const compactGlassContract = compactGlassSurfaceContract(
    floating,
    Boolean(nativeGeometry?.hasHardwareNotch),
  );
  const compactGlassNativeBackdrop = isDesktopRuntime();
  const splitCrownVisible =
    shellPresentation === "medium" &&
    !floating &&
    Boolean(nativeGeometry?.hasHardwareNotch) &&
    !preferences.pinned;
  const crownHeaderHeight = nativeGeometry?.hasHardwareNotch
    ? Math.max(1, Math.min(nativeGeometry.notchHeight, closedSurfaceHeight))
    : closedSurfaceHeight;
  const mediumHeaderHeight =
    !floating && nativeGeometry?.hasHardwareNotch
      ? crownHeaderHeight
      : closedSurfaceHeight;
  const crownPresentationId = transitionSequence.current;
  const crownPayload = useMemo<WidgetCrownPayload>(
    () => ({
      schemaVersion: 1,
      presentationId: crownPresentationId,
      visible: splitCrownVisible,
      projectName: currentProjectName,
      status: capsuleStatus,
      statusTone: mediumCrownStatusTone(capsuleStatus),
      remainingValue,
      ...(accountRemainingPercent === undefined
        ? {}
        : { remainingPercent: accountRemainingPercent }),
      surfaceWidth: mediumSurfaceSize.width,
      surfaceHeight: mediumSurfaceSize.height,
      headerHeight: crownHeaderHeight,
      cameraWidth: nativeGeometry?.notchWidth ?? 0,
      updatedAt: Math.max(
        snapshot?.updatedAt ?? 0,
        projectTokenMetric?.updatedAt ?? 0,
        accountUsage?.updatedAt ?? 0,
      ),
    }),
    [
      accountRemainingPercent,
      accountUsage?.updatedAt,
      capsuleStatus,
      crownHeaderHeight,
      crownPresentationId,
      currentProjectName,
      mediumSurfaceSize.height,
      mediumSurfaceSize.width,
      nativeGeometry?.notchWidth,
      projectTokenMetric?.updatedAt,
      remainingValue,
      snapshot?.updatedAt,
      splitCrownVisible,
    ],
  );
  crownPayloadRef.current = crownPayload;

  const crownPaintMatchesPresentation =
    splitCrownVisible &&
    crownSessionId !== undefined &&
    crownPainted !== undefined &&
    crownPainted.sessionId === crownSessionId &&
    crownPainted.presentationId === crownPayload.presentationId;
  crownHandoffReadyRef.current = crownPaintMatchesPresentation;
  const crownOwnsHeader =
    crownPaintMatchesPresentation &&
    nativeGeometry?.crownCompanionVisible === true &&
    crownPaintedRef.current?.presentationId === crownPayload.presentationId;

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void publishWidgetCrownPayload(crownPayload).catch(() => undefined);
  }, [crownPayload]);

  useEffect(() => {
    if (
      !isDesktopRuntime() ||
      !crownPaintMatchesPresentation ||
      nativeGeometry?.crownCompanionVisible === true ||
      presentationRef.current !== "medium" ||
      transitionSequence.current !== crownPayload.presentationId
    ) {
      return;
    }
    // This second native phase lowers/crops the main body only after the
    // current companion session crossed an actual paint boundary. The helper
    // retries once when AppKit had to reveal a hidden crown first.
    void resizeNativeWindow("medium", crownPayload.presentationId, true);
  }, [
    crownPaintMatchesPresentation,
    crownPayload.presentationId,
    nativeGeometry?.crownCompanionVisible,
    resizeNativeWindow,
  ]);

  const compactMetrics = (
    <>
      <CompactMetricSide
        side="left"
        metricId={preferences.compactLeftMetric}
        context={compactContext}
        showGlassChrome={hardwareCompactSpectrumActive}
        glassMaterialRecipe={
          hardwareCompactSpectrumActive && compactGlassContract.surfaceTarget === "sides"
            ? compactGlassContract.materialRecipe
            : undefined
        }
      />
      {!floating && <span className="widget-camera-space" aria-hidden="true" />}
      <CompactMetricSide
        side="right"
        metricId={preferences.compactRightMetric}
        context={compactContext}
        showGlassChrome={hardwareCompactSpectrumActive}
        glassMaterialRecipe={
          hardwareCompactSpectrumActive && compactGlassContract.surfaceTarget === "sides"
            ? compactGlassContract.materialRecipe
            : undefined
        }
      />
    </>
  );

  return (
    <div
      className={`widget-shell ${shellPresentationClass}${
        compactTight ? " widget-shell--compact-tight" : ""
      }`}
      data-placement={preferences.placementMode}
      data-expansion-trigger={opensOnPointerProximity ? "proximity" : "button"}
      style={notchStyle}
    >
      <section
        className={notchClass}
        data-spectrum-edge={expanded ? "true" : undefined}
        data-compact-glass-surface={
          compactGlassExperimentActive && compactGlassContract.surfaceTarget === "host"
            ? compactGlassContract.materialRecipe
            : undefined
        }
        aria-label={
          expanded
            ? localized(locale, "Codex 项目详细视图", "Codex project details")
            : medium
              ? localized(locale, "Codex 项目摘要视图", "Codex project summary")
              : localized(locale, "Codex 项目紧凑视图", "Codex compact project view")
        }
        onPointerDown={(event) => void startFloatingDrag(event)}
        onPointerEnter={() => {
          if (
            opensOnPointerProximity &&
            !nativeGeometry?.supported &&
            !medium
          ) {
            void openCapsule();
          }
        }}
        onPointerLeave={() => {
          if (opensOnPointerProximity && !nativeGeometry?.supported) {
            collapseToResting();
          }
        }}
        onFocusCapture={() => {
          if (opensOnPointerProximity) void openCapsule();
        }}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (nextTarget && event.currentTarget.contains(nextTarget)) return;
          if (opensOnPointerProximity) collapseToResting();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          void collapseExpandedSurface();
        }}
      >
        {liquidGlassReady && <LiquidGlassBackdrop enabled />}
        {expanded && (
          <SpectrumEdge
            width={expandedSurfaceSize.width}
            height={expandedSurfaceSize.height}
            radius={EXPANDED_SURFACE_RADIUS}
          />
        )}
        {!medium && (
          <header className="widget-notch-bar">
            {floating ? (
              <div
                className="widget-capsule widget-capsule--floating"
                role="group"
                aria-label={localized(locale, "项目紧凑视图", "Compact project view")}
              >
                {compactGlassExperimentActive && (
                  <CompactSdfGlass
                    layout={compactGlassContract.layout}
                    nativeBackdrop={compactGlassNativeBackdrop}
                  />
                )}
                {!expanded && compactGlassExperimentActive && (
                  <CompactGlassChrome layout={compactGlassContract.layout} />
                )}
                {!expanded && (
                  <button
                    className="widget-surface-expand-button widget-compact-expand-button"
                    type="button"
                    aria-controls="widget-full-shelf"
                    aria-expanded={false}
                    aria-label={localized(locale, "打开项目详细视图", "Open project details")}
                    title={localized(locale, "打开详细视图", "Open details")}
                    onClick={() => void openCapsule()}
                  >
                    <WidgetIcon name="expand" />
                  </button>
                )}
                {compactMetrics}
              </div>
            ) : (
              <button
                className="widget-capsule"
                type="button"
                aria-expanded={expanded}
                aria-controls="widget-full-shelf"
                aria-label={localized(locale, "打开项目详细视图", "Open project details")}
                title={localized(
                  locale,
                  "靠近摄像头安全区或点击以打开详细视图",
                  "Move to the camera-safe area or click to open details",
                )}
                onClick={() => void openCapsule()}
              >
                {compactGlassExperimentActive && (
                  <CompactSdfGlass
                    layout={compactGlassContract.layout}
                    nativeBackdrop={compactGlassNativeBackdrop}
                  />
                )}
                {!expanded && compactGlassExperimentActive && (
                  <CompactGlassChrome layout={compactGlassContract.layout} />
                )}
                {compactMetrics}
              </button>
            )}
          </header>
        )}

        {medium && (
          <MediumNotchPage
            projectName={currentProjectName}
            status={capsuleStatus}
            updatedAt={snapshot?.updatedAt ?? projectUsage?.updatedAt}
            metricIds={
              floating
                ? preferences.floatingMediumMetrics
                : defaultFloatingMediumMetrics
            }
            metricContext={compactContext}
            remainingValue={remainingValue}
            remainingPercent={accountRemainingPercent}
            runningTasks={snapshot?.runningTasks}
            failedTasks={snapshot?.failedTasks}
            pendingApprovals={snapshot?.pendingApprovals}
            systemMetrics={systemMetrics}
            systemMetricsLoading={systemMetricsLoading}
            surfaceWidth={mediumSurfaceSize.width}
            surfaceHeight={mediumSurfaceSize.height}
            headerHeight={mediumHeaderHeight}
            cameraWidth={nativeGeometry?.notchWidth ?? 0}
            wrapsHardwareNotch={!floating && Boolean(nativeGeometry?.hasHardwareNotch)}
            showExpandButton={floating || !Boolean(nativeGeometry?.hasHardwareNotch)}
            suppressCrown={crownOwnsHeader}
            onOpen={() => void openCapsule()}
          />
        )}

        <div
          id="widget-full-shelf"
          className="widget-shelf"
          aria-hidden={!expanded}
          inert={!expanded}
        >
          <div className="widget-toolbar">
            <div className="widget-toolbar-title">
              <BrandLogo size={28} />
              <div className="widget-toolbar-title-copy">
                <p>{localized(locale, "项目观察台", "PROJECT OBSERVER")}</p>
                <h1>{currentProjectName}</h1>
              </div>
            </div>
            <nav aria-label={localized(locale, "项目概览操作", "Project overview actions")}>
              {floating && (
                <button
                  type="button"
                  onClick={() => void collapseExpandedSurface()}
                  aria-label={localized(locale, "收起浮动窗口", "Collapse floating window")}
                  title={localized(locale, "返回默认视图", "Return to default view")}
                >
                  <WidgetIcon name="collapse" />
                </button>
              )}
              <button
                type="button"
                onClick={() => void refreshAll()}
                disabled={loading || officialLoading}
                aria-label={localized(locale, "刷新本地与官方数据", "Refresh local and official data")}
                title={localized(locale, "刷新", "Refresh")}
              >
                <WidgetIcon name="refresh" />
              </button>
              <button
                type="button"
                onClick={() => void toggleSettingsView()}
                aria-label={localized(locale, "自定义显示内容", "Customize visible information")}
                aria-expanded={settingsOpen}
                title={localized(locale, "自定义", "Customize")}
              >
                <WidgetIcon name="settings" />
              </button>
              <button
                type="button"
                onClick={() => void showMainWindow().catch((cause) => setError(readableError(cause)))}
                aria-label={localized(locale, "打开主窗口", "Open main window")}
                title={localized(locale, "打开主窗口", "Open main window")}
                disabled={!isDesktopRuntime()}
              >
                <WidgetIcon name="window" />
              </button>
              <button
                type="button"
                onClick={() => void hideNotchWindow().catch((cause) => setError(readableError(cause)))}
                aria-label={localized(locale, "隐藏项目概览", "Hide project overview")}
                title={localized(locale, "隐藏项目概览", "Hide project overview")}
                disabled={!isDesktopRuntime()}
              >
                <WidgetIcon name="hide" />
              </button>
            </nav>
          </div>

          <div className="widget-scope">
            <span>{`${capsuleStatus} · ${nativeSurfaceLabel}`}</span>
            <time>
              {officialLoading
                ? localized(locale, "同步官方数据…", "Syncing official data…")
                : snapshot
                  ? localized(locale, `${formatClock(snapshot.updatedAt, locale)} 更新`, `Updated ${formatClock(snapshot.updatedAt, locale)}`)
                  : localized(locale, "尚未同步", "Not synced")}
            </time>
          </div>

          {(error || officialError) && (
            <div className="widget-error" role="alert">
              <strong>{error
                ? localized(locale, "项目快照读取失败", "Could not read project snapshot")
                : localized(locale, "部分官方数据暂不可用", "Some official data is unavailable")}</strong>
              <span>{[error, officialError].filter(Boolean).join(localized(locale, "；", "; "))}</span>
            </div>
          )}

          {nativeError && (
            <div className="widget-native-warning" role="status">
              <strong>{localized(locale, "原生屏幕适配未完成", "Native display adaptation is incomplete")}</strong>
              <span>{nativeError}{localized(locale, "；当前使用顶部位置回退。", "; using the top-position fallback.")}</span>
            </div>
          )}

          {settingsOpen ? (
            <div className="widget-settings-page">
            <section className="widget-settings" aria-labelledby="widget-settings-title">
              <div className="widget-settings-heading">
                <div>
                  <p>{localized(locale, "自定义", "CUSTOMIZE")}</p>
                  <h2 id="widget-settings-title">{localized(locale, "显示哪些消息", "Visible information")}</h2>
                </div>
                <span>{countMetric} / 9</span>
              </div>
              <section
                className="widget-placement-settings"
                aria-labelledby="widget-placement-settings-title"
              >
                <div className="widget-resting-settings-heading">
                  <div>
                    <p>{localized(locale, "窗口模式", "WINDOW MODE")}</p>
                    <h3 id="widget-placement-settings-title">
                      {localized(locale, "窗口位置", "Window placement")}
                    </h3>
                  </div>
                  <span>{localized(locale, "二选一", "Choose one")}</span>
                </div>
                <div
                  className="widget-placement-options"
                  role="radiogroup"
                  aria-labelledby="widget-placement-settings-title"
                >
                  <label
                    className="widget-placement-option"
                    data-selected={preferences.placementMode === "notch"}
                  >
                    <input
                      type="radio"
                      name="widget-placement-mode"
                      value="notch"
                      checked={preferences.placementMode === "notch"}
                      onChange={() => setPreferences((current) => ({
                        ...current,
                        placementMode: "notch",
                      }))}
                    />
                    <span className="widget-placement-preview widget-placement-preview--notch" aria-hidden="true">
                      <i />
                    </span>
                    <span className="widget-resting-option-copy">
                      <strong>{localized(locale, "摄像头安全区", "Camera-safe area")}</strong>
                      <small>{localized(locale, "贴合当前显示器的顶部安全区", "Fit the current display's top safe area")}</small>
                    </span>
                  </label>
                  <label
                    className="widget-placement-option"
                    data-selected={preferences.placementMode === "floating"}
                  >
                    <input
                      type="radio"
                      name="widget-placement-mode"
                      value="floating"
                      checked={preferences.placementMode === "floating"}
                      onChange={() => setPreferences((current) => ({
                        ...current,
                        placementMode: "floating",
                      }))}
                    />
                    <span className="widget-placement-preview widget-placement-preview--floating" aria-hidden="true">
                      <i />
                    </span>
                    <span className="widget-resting-option-copy">
                      <strong>{localized(locale, "浮动窗口", "Floating window")}</strong>
                      <small>{localized(locale, "可拖到当前屏幕任意位置", "Drag anywhere on the current display")}</small>
                    </span>
                  </label>
                </div>
                <p className="widget-setting-hint">
                  {floating
                    ? localized(
                        locale,
                        "浮动窗口可单独设置前后层级；两种位置共享相同的项目数据和三种视图。",
                        "The floating window has its own window level. Both placements share project data and all three views.",
                      )
                    : localized(
                        locale,
                        "紧凑与详细视图使用 macOS 顶部层级；摘要视图可选择整页置顶，或只让下方正文被其他窗口覆盖。",
                        "Compact and detail views use the macOS top level. The summary can stay fully on top or let only its body sit behind other windows.",
                      )}
                </p>
              </section>
              <section
                className="widget-resting-settings"
                aria-labelledby="widget-resting-settings-title"
              >
                <div className="widget-resting-settings-heading">
                  <div>
                    <p>{localized(locale, "默认尺寸", "RESTING SIZE")}</p>
                    <h3 id="widget-resting-settings-title">
                      {localized(locale, "默认视图", "Default view")}
                    </h3>
                  </div>
                  <span>{localized(locale, "二选一", "Choose one")}</span>
                </div>
                <div
                  className="widget-resting-options"
                  role="radiogroup"
                  aria-labelledby="widget-resting-settings-title"
                >
                  <label
                    className="widget-resting-option"
                    data-selected={preferences.restingMode === "compact"}
                  >
                    <input
                      type="radio"
                      name="widget-resting-mode"
                      value="compact"
                      checked={preferences.restingMode === "compact"}
                      onChange={() => setRestingMode("compact")}
                    />
                    <span className="widget-resting-preview widget-resting-preview--compact" aria-hidden="true">
                      <i />
                      <b />
                    </span>
                    <span className="widget-resting-option-copy">
                      <strong>{localized(locale, "紧凑视图", "Compact view")}</strong>
                      <small>
                        {floating
                          ? localized(locale, "显示两项核心指标", "Show two core metrics")
                          : localized(locale, "在摄像头安全区两侧显示核心指标", "Show core metrics beside the camera-safe area")}
                      </small>
                    </span>
                  </label>
                  <label
                    className="widget-resting-option"
                    data-selected={preferences.restingMode === "medium"}
                  >
                    <input
                      type="radio"
                      name="widget-resting-mode"
                      value="medium"
                      checked={preferences.restingMode === "medium"}
                      onChange={() => setRestingMode("medium")}
                    />
                    <span className="widget-resting-preview widget-resting-preview--medium" aria-hidden="true">
                      <i />
                      <b />
                    </span>
                    <span className="widget-resting-option-copy">
                      <strong>{localized(locale, "摘要视图", "Summary view")}</strong>
                      <small>
                        {floating
                          ? localized(locale, "显示项目、Usage 与性能摘要", "Show project, usage, and performance summaries")
                          : localized(locale, "围绕摄像头安全区显示项目、Usage 与性能摘要", "Show project, usage, and performance around the camera-safe area")}
                      </small>
                    </span>
                  </label>
                </div>
                <p className="widget-setting-hint">
                  {floating
                    ? localized(
                        locale,
                        "两种模式都是独立的默认视图；只有“展开详细视图”按钮会打开详细视图，使用收起按钮或 Escape 返回。",
                        "Each option is an independent default view. Use Expand to open details, then Collapse or Escape to return.",
                      )
                    : localized(
                        locale,
                        "两种模式都是独立的默认视图；鼠标靠近摄像头安全区会打开详细视图，移开后自动返回。",
                        "Each option is an independent default view. Moving into the camera-safe area opens details; moving away returns automatically.",
                      )}
                </p>
              </section>
              <section className="widget-compact-settings" aria-labelledby="widget-compact-settings-title">
                <div className="widget-compact-settings-heading">
                  <div>
                    <p>{localized(locale, "紧凑指标", "COMPACT CHIPS")}</p>
                    <h3 id="widget-compact-settings-title">
                      {localized(locale, "紧凑视图指标", "Compact-view metrics")}
                    </h3>
                  </div>
                  <span>{localized(locale, "左右各一项", "One per side")}</span>
                </div>
                <div className="widget-compact-settings-grid">
                  <label className="widget-setting-field">
                    <span>{localized(locale, "左侧信息", "Left metric")}</span>
                    <select
                      value={preferences.compactLeftMetric}
                      onChange={(event) =>
                        setCompactSideMetric(
                          "left",
                          event.target.value as WidgetCompactMetricId,
                        )
                      }
                    >
                      {widgetCompactMetricDefinitions.map(({ id }) => (
                        <option key={id} value={id}>
                          {localizedCompactMetricLabel(locale, id)} · {localizedCompactMetricDescription(locale, id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="widget-setting-field">
                    <span>{localized(locale, "右侧信息", "Right metric")}</span>
                    <select
                      value={preferences.compactRightMetric}
                      onChange={(event) =>
                        setCompactSideMetric(
                          "right",
                          event.target.value as WidgetCompactMetricId,
                        )
                      }
                    >
                      {widgetCompactMetricDefinitions.map(({ id }) => (
                        <option key={id} value={id}>
                          {localizedCompactMetricLabel(locale, id)} · {localizedCompactMetricDescription(locale, id)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="widget-setting-hint">
                  {localized(
                    locale,
                    "每侧只保留一个短指标，避免摄像头安全区压缩文字；这些选项只影响紧凑视图，摘要视图使用独立布局。",
                    "Each side keeps one short metric so the camera-safe area never compresses text. These choices affect only the compact view; the summary has its own layout.",
                  )}
                </p>
              </section>
              {floating && (
                <section
                  className="widget-compact-settings widget-medium-settings"
                  aria-labelledby="widget-medium-settings-title"
                >
                  <div className="widget-compact-settings-heading">
                    <div>
                      <p>{localized(locale, "摘要信息", "SUMMARY CELLS")}</p>
                      <h3 id="widget-medium-settings-title">
                        {localized(locale, "浮动摘要视图指标", "Floating-summary metrics")}
                      </h3>
                    </div>
                    <span>{localized(locale, "三栏独立设置", "Set each column")}</span>
                  </div>
                  <div className="widget-compact-settings-grid widget-medium-settings-grid">
                    {(["左栏", "中栏", "右栏"] as const).map((label, index) => (
                      <label className="widget-setting-field" key={label}>
                        <span>{localized(locale, label, (["Left column", "Center column", "Right column"] as const)[index])}</span>
                        <select
                          value={preferences.floatingMediumMetrics[index]}
                          onChange={(event) =>
                            setFloatingMediumMetric(
                              index as 0 | 1 | 2,
                              event.target.value as WidgetMediumMetricId,
                            )
                          }
                        >
                          {widgetMediumMetricDefinitions.map(
                            ({ id }) => (
                              <option key={id} value={id}>
                                {localizedCompactMetricLabel(locale, id)} · {localizedCompactMetricDescription(locale, id)}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    ))}
                  </div>
                  <p className="widget-setting-hint">
                    {localized(
                      locale,
                      "三个选择只影响浮动摘要视图的中部信息栏；顶部项目状态与 Usage 余量保持固定，避免失去关键上下文。",
                      "These choices affect only the floating summary's center row. Project status and usage remaining stay fixed to preserve context.",
                    )}
                  </p>
                </section>
              )}
              <div className="widget-check-grid">
                {widgetMetricDefinitions.map(({ id }, index) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={preferences.visibleMetrics.includes(id)}
                      onChange={() => toggleMetric(id)}
                    />
                    <span>{index + 1}</span>
                    {localizedWidgetMetricLabel(locale, id)}
                  </label>
                ))}
              </div>
              <details className="widget-native-details">
                <summary>{localized(locale, "原生窗口与安全区诊断", "Native window and safe-area diagnostics")}</summary>
                {nativeGeometry ? (
                  <dl>
                    <div>
                      <dt>{localized(locale, "数据源", "Source")}</dt>
                      <dd>{nativeGeometry.source} · {nativeGeometry.hostKind}</dd>
                    </div>
                    <div>
                      <dt>{localized(locale, "显示器", "Display")}</dt>
                      <dd>{nativeGeometry.screenName ?? localized(locale, "未返回", "Not returned")}</dd>
                    </div>
                    <div>
                      <dt>{localized(locale, "AppKit 摄像头安全区", "AppKit camera-safe area")}</dt>
                      <dd>
                        {nativeGeometry.hasHardwareNotch
                          ? `${nativeGeometry.notchWidth.toFixed(1)} × ${nativeGeometry.notchHeight.toFixed(1)} pt`
                          : localized(locale, "未检测到摄像头外壳", "No camera housing detected")}
                      </dd>
                    </div>
                    <div>
                      <dt>{localized(locale, "顶部安全区", "Top safe area")}</dt>
                      <dd>{`${nativeGeometry.safeAreaTop.toFixed(1)} pt`}</dd>
                    </div>
                    <div>
                      <dt>{localized(locale, "宿主命中区", "Host hit area")}</dt>
                      <dd>
                        {`${nativeGeometry.closedWidth.toFixed(1)} × ${nativeGeometry.closedHeight.toFixed(1)} pt`}
                      </dd>
                    </div>
                    <div>
                      <dt>{localized(locale, "菜单栏高度", "Menu bar height")}</dt>
                      <dd>{`${nativeGeometry.menuBarHeight.toFixed(1)} pt`}</dd>
                    </div>
                    <div>
                      <dt>{localized(locale, "窗口状态", "Window state")}</dt>
                      <dd>
                        {nativeGeometry.windowIsKey
                          ? localized(locale, "当前是键窗口", "Key window")
                          : localized(locale, "未取得键窗口", "Not the key window")}
                        {nativeGeometry.windowIsOpaque === false
                          ? localized(locale, " · AppKit 非不透明", " · AppKit non-opaque")
                          : ""}
                        {nativeGeometry.windowIgnoresMouseEvents === true
                          ? localized(locale, " · 收起态点击穿透", " · Click-through while collapsed")
                          : localized(locale, " · 当前接收鼠标", " · Receiving pointer input")}
                      </dd>
                    </div>
                    <div>
                      <dt>{localized(locale, "WebView 像素", "WebView pixels")}</dt>
                      <dd>
                        {nativeGeometry.webviewAlphaValue === undefined
                          ? localized(locale, "未返回", "Not returned")
                          : localized(
                              locale,
                              `${Math.round(nativeGeometry.webviewAlphaValue * 100)}% alpha（两侧信息可见）`,
                              `${Math.round(nativeGeometry.webviewAlphaValue * 100)}% alpha (side metrics visible)`,
                            )}
                      </dd>
                    </div>
                    <div>
                      <dt>{localized(locale, "交互策略", "Interaction policy")}</dt>
                      <dd>
                        {nativeGeometry.windowIgnoresMouseEvents === true
                          ? localized(locale, "中央缺口透明；靠近顶部后由原生桥接展开", "The center gap is transparent; the native bridge expands near the top edge")
                          : localized(locale, "展开态允许按钮和键盘操作", "Buttons and keyboard input are enabled while expanded")}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p>{localized(locale, "正在等待 AppKit 返回屏幕信息…", "Waiting for AppKit display information…")}</p>
                )}
                {nativeGeometry?.limitation && <p>{nativeGeometry.limitation}</p>}
                <p>
                  {localized(
                    locale,
                    "这里读取的是系统公开的屏幕安全区；应用不能修改摄像头硬件，也不会把整条菜单栏涂黑。",
                    "This reads the system's public display safe area. The app cannot alter camera hardware and does not paint the entire menu bar black.",
                  )}
                </p>
                <p>
                  {localized(
                    locale,
                    "浅色外观使用白色液态玻璃；深色外观跟随 macOS，以保持系统对比度与可访问性设置。",
                    "Light appearance uses white Liquid Glass; dark appearance follows macOS contrast and accessibility settings.",
                  )}
                </p>
              </details>
              <section
                className="widget-layer-settings"
                aria-labelledby="widget-layer-settings-title"
              >
                <div className="widget-resting-settings-heading">
                  <div>
                    <p>{localized(locale, "窗口层级", "WINDOW LEVEL")}</p>
                    <h3 id="widget-layer-settings-title">
                      {localized(locale, "窗口显示层级", "Window level")}
                    </h3>
                  </div>
                  <span>{localized(locale, "二选一", "Choose one")}</span>
                </div>
                <div
                  className="widget-layer-options"
                  role="radiogroup"
                  aria-labelledby="widget-layer-settings-title"
                >
                  <label
                    className="widget-layer-option"
                    data-selected={preferences.pinned}
                    data-disabled={!layerChoiceAvailable}
                    aria-disabled={!layerChoiceAvailable}
                  >
                    <input
                      type="radio"
                      name="widget-window-level"
                      value="front"
                      checked={preferences.pinned}
                      disabled={!layerChoiceAvailable}
                      onChange={() =>
                        setPreferences((current) => ({
                          ...current,
                          pinned: true,
                        }))
                      }
                    />
                    <span
                      className="widget-layer-preview widget-layer-preview--front"
                      aria-hidden="true"
                    >
                      <i />
                      <b />
                    </span>
                    <span className="widget-resting-option-copy">
                      <strong>{localized(locale, "保持在最前方", "Stay on top")}</strong>
                      <small>{localized(locale, "始终显示在其他应用窗口上方", "Keep this view above other app windows")}</small>
                    </span>
                  </label>
                  <label
                    className="widget-layer-option"
                    data-selected={!preferences.pinned}
                    data-disabled={!layerChoiceAvailable}
                    aria-disabled={!layerChoiceAvailable}
                  >
                    <input
                      type="radio"
                      name="widget-window-level"
                      value="standard"
                      checked={!preferences.pinned}
                      disabled={!layerChoiceAvailable}
                      onChange={() =>
                        setPreferences((current) => ({
                          ...current,
                          pinned: false,
                        }))
                      }
                    />
                    <span
                      className="widget-layer-preview widget-layer-preview--standard"
                      aria-hidden="true"
                    >
                      <i />
                      <b />
                    </span>
                    <span className="widget-resting-option-copy">
                      <strong>
                        {floating
                          ? localized(locale, "标准窗口层级", "Standard window level")
                          : localized(locale, "仅正文允许覆盖", "Allow body to be covered")}
                      </strong>
                      <small>
                        {floating
                          ? localized(locale, "作为普通工具窗口显示", "Behave like a standard utility window")
                          : localized(locale, "顶部状态保留，摘要正文可被普通应用覆盖", "Keep the top status visible while regular apps may cover the summary body")}
                      </small>
                    </span>
                  </label>
                </div>
                <p className="widget-setting-hint">
                  {floating
                    ? localized(locale, "该选项只改变浮动窗口的前后层级，不会改变它的位置。", "This changes only the floating window's level, not its position.")
                    : preferences.restingMode === "medium"
                      ? localized(locale, "该选项只降低摘要正文的层级；摄像头安全区左右状态由独立的点击穿透层保留。系统安全界面、锁屏和部分全屏层仍可能位于它上方。", "Only the summary body moves down a level; a separate click-through layer keeps the camera-safe status visible. System security UI, Lock Screen, and some full-screen layers may still appear above it.")
                      : localized(locale, "摄像头安全区紧凑视图必须保持系统顶部层级；选择摘要视图后可调整其层级。", "The camera-safe compact view must stay at the system top level. Switch to the summary view to adjust its level.")}
                </p>
              </section>
              <div className="widget-setting-fields">
                <label className="widget-setting-field">
                  <span>{localized(locale, "本地任务刷新（秒）", "Local task refresh (seconds)")}</span>
                  <input
                    type="number"
                    min={2}
                    max={60}
                    value={preferences.refreshSeconds}
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        refreshSeconds: Number(event.target.value) || 5,
                      }))
                    }
                  />
                </label>
                <label className="widget-setting-field">
                  <span>{localized(locale, "订阅版本（手动回退）", "Plan (manual fallback)")}</span>
                  <input
                    value={preferences.subscriptionLabel ?? ""}
                    maxLength={48}
                    placeholder={localized(locale, "例如 Plus / Pro", "For example, Plus / Pro")}
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        subscriptionLabel: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <p className="widget-setting-warning">
                {localized(
                  locale,
                  "Usage 和套餐优先使用官方返回值；手填套餐只是未返回时的标签。",
                  "Usage and plan use official values first. The manual plan is only a fallback label when none is returned.",
                )}
              </p>
            </section>
              <footer className="widget-settings-footer">
                <button
                  className="widget-save-button"
                  type="button"
                  onClick={() => void saveSettings()}
                  disabled={saving}
                >
                  {saving
                    ? localized(locale, "保存中…", "Saving…")
                    : localized(locale, "完成", "Done")}
                </button>
              </footer>
            </div>
          ) : (
            <div className="widget-dashboard">
              <section
                className="notch-vitals"
                aria-label={localized(locale, "项目核心数据", "Core project data")}
              >
                {projectTokenMetric && visible.has("currentProjectUsage") && (
                  <NotchVital
                    label={localized(locale, "项目 TOKEN", "PROJECT TOKENS")}
                    value={
                      projectTokenMetric.totalTokens === undefined
                        ? localized(locale, "未返回", "Not returned")
                        : formatTokenCount(projectTokenMetric.totalTokens)
                    }
                    caption={
                      projectTokenMetric.totalTokens === undefined
                        ? projectTokenMetric.evidence[0] ?? localized(locale, "当前数据源没有可汇总 usage", "The current source has no usage to total")
                        : localizedWidgetStateLabel(locale, projectTokenMetric.state, projectTokenMetric.source)
                    }
                    state={projectTokenMetric.state}
                    composition={projectTokenMetric}
                  />
                )}
                <NotchVital
                  label={localized(locale, "USAGE 余量", "USAGE REMAINING")}
                  value={remainingValue}
                  caption={localized(locale, "最紧额度窗口 · 不是绝对剩余 Token", "Limiting quota window · not an absolute token balance")}
                  state={windowRemainingText ? "known" : "unknown"}
                  meterPercent={accountRemainingPercent}
                  meterLabel={localized(locale, "官方窗口余量", "Official window remaining")}
                />
                <NotchVital
                  label={localized(locale, "距里程碑目标", "TO MILESTONE GOAL")}
                  value={goalRemainingValue}
                  caption={goalCaption}
                  state={currentProgress?.state ?? "unknown"}
                  completionPercent={currentProgressPercent}
                  completionLabel={localized(locale, "已完成里程碑", "Milestone completed")}
                />
                <div className="widget-quota-windows">
                  <QuotaWindows bucket={primaryRateLimit(accountUsage)} />
                </div>
              </section>

              <section className="widget-system-snapshot" aria-labelledby="widget-system-title">
                <div className="widget-system-heading">
                  <div>
                    <p>{localized(locale, "本机", "LOCAL MACHINE")}</p>
                    <h2 id="widget-system-title">{localized(locale, "编码环境", "Coding environment")}</h2>
                  </div>
                  <span>
                    {systemMetricsLoading
                      ? localized(locale, "采集中…", "Collecting…")
                      : systemMetrics
                        ? localized(locale, `${formatClock(systemMetrics.updatedAt, locale)} 更新`, `Updated ${formatClock(systemMetrics.updatedAt, locale)}`)
                        : localized(locale, "尚未采集", "Not collected")}
                  </span>
                </div>
                {systemMetricsError && (
                  <p className="widget-system-error" role="status">
                    {localized(locale, "本机状态读取失败：", "Could not read Mac status: ")}{systemMetricsError}
                  </p>
                )}
                {systemMetrics ? (
                  <div className="widget-system-grid">
                    {systemMetricDisplays(systemMetrics).map((rawDisplay) => {
                      const display = localizedSystemMetricDisplay(locale, rawDisplay);
                      const meter = widgetSystemMeter(systemMetrics, rawDisplay.id);
                      const detailTitle = systemMetricDetails(systemMetrics, display.id)
                        .map((row) => localizedSystemMetricDetail(locale, row))
                        .map((row) => `${row.label}: ${row.value}`)
                        .join("\n");
                      return (
                        <article
                          key={display.id}
                          className={`widget-system-card widget-system-card--${display.tone}`}
                          title={detailTitle}
                          aria-label={localized(
                            locale,
                            `${display.label}：${display.value}。${display.detail}`,
                            `${display.label}: ${display.value}. ${display.detail}`,
                          )}
                        >
                          <div className="widget-system-card-title">
                            <strong>{display.label}</strong>
                            <small>{display.status}</small>
                          </div>
                          <b title={display.value}>{widgetSystemPrimary(systemMetrics, display.id, display.value)}</b>
                          {meter !== undefined && (
                            <span className="widget-system-meter" aria-hidden="true">
                              <i style={{ width: `${meter}%` }} />
                            </span>
                          )}
                          <p>{display.detail}</p>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="widget-system-empty">
                    {systemMetricsLoading
                      ? localized(locale, "正在读取 CPU、内存、磁盘、电池和网络…", "Reading CPU, memory, storage, battery, and network…")
                      : localized(locale, "展开后读取本机编码环境。", "Open details to read the local coding environment.")}
                  </p>
                )}
                <p className="widget-system-boundary">
                  {localized(locale, "本机资源与 Codex Token 分开统计；网络状态不是 API 可达性测试。", "Mac resources and Codex tokens are measured separately. Network status is not an API reachability test.")}
                </p>
              </section>

              <main className="widget-content" aria-busy={loading || officialLoading || systemMetricsLoading}>
        {loading && !snapshot && (
          <p className="widget-loading">{localized(locale, "正在读取本机状态…", "Reading local status…")}</p>
        )}
        {!loading && !snapshot && (
          <div className="widget-empty" role="status">
            <strong>{localized(locale, "没有拿到项目快照", "No project snapshot")}</strong>
            <p>{error ?? localized(locale, "请确认项目目录仍可访问，然后重新读取。", "Confirm the project directory is still accessible, then try again.")}</p>
            <button
              className="widget-retry-button"
              type="button"
              onClick={() => void refreshAll()}
            >
              {localized(locale, "重新读取", "Try again")}
            </button>
          </div>
        )}
        {snapshot && visible.has("runningTasks") && (
          <TaskListCard
            id="runningTasks"
            title={localized(locale, "正在运行", "Running")}
            metric={snapshot.runningTasks}
          />
        )}
        {snapshot && visible.has("failedTasks") && (
          <TaskListCard
            id="failedTasks"
            title={localized(locale, "最近失败", "Recent failures")}
            metric={snapshot.failedTasks}
          />
        )}
        {snapshot && visible.has("pendingApprovals") && (
          <article
            className={`widget-card widget-card--${snapshot.pendingApprovals.state}`}
            data-metric="pendingApprovals"
          >
            <div className="widget-card-heading">
              <h2>{localized(locale, "等待批准", "Awaiting approval")}</h2>
              <span>
                {localizedWidgetStateLabel(
                  locale,
                  snapshot.pendingApprovals.state,
                  snapshot.pendingApprovals.source,
                )}
              </span>
            </div>
            <strong className="widget-card-value">
              {snapshot.pendingApprovals.count ?? "—"}
            </strong>
            <p className="widget-card-caption">
              {snapshot.pendingApprovals.count === undefined
                ? localized(locale, "审批事件源尚未接入，未知不等于 0。", "The approval event source is not connected. Unknown does not mean zero.")
                : localized(locale, "来自已接入审批事件的待处理数量。", "Pending count from connected approval events.")}
            </p>
            <MetricSource
              state={snapshot.pendingApprovals.state}
              source={snapshot.pendingApprovals.source}
              evidence={snapshot.pendingApprovals.evidence}
            />
          </article>
        )}
        {snapshot && visible.has("highestCompletion") && (
          <ProjectCard
            id="highestCompletion"
            title={localized(locale, "完成度最高", "Highest completion")}
            metric={snapshot.highestCompletion}
          />
        )}
        {snapshot && visible.has("stagnantProject") && (
          <ProjectCard
            id="stagnantProject"
            title={localized(locale, "里程碑久未更新", "Milestones unchanged")}
            metric={snapshot.stagnantProject}
            stagnant
          />
        )}
        {recentDailyTokenMetric && visible.has("todayUsage") && (
          <TokenCard
            id="todayUsage"
            title={accountUsage?.tokenActivity.latestDailyTokens === undefined
              ? localized(locale, "今日 Token", "Today's tokens")
              : localized(locale, "最近日 Token", "Most recent daily tokens")}
            metric={recentDailyTokenMetric}
          />
        )}
        {snapshot && visible.has("recentChanges") && (
          <article
            className={`widget-card widget-card--${snapshot.recentChanges.state}`}
            data-metric="recentChanges"
          >
            <div className="widget-card-heading">
              <h2>{localized(locale, "最近变化", "Recent changes")}</h2>
              <span>
                {localizedWidgetStateLabel(
                  locale,
                  snapshot.recentChanges.state,
                  snapshot.recentChanges.source,
                )}
              </span>
            </div>
            {snapshot.recentChanges.changes.length > 0 ? (
              <ol className="widget-change-list">
                {snapshot.recentChanges.changes.slice(0, 5).map((change) => (
                  <li key={`${change.at}-${change.kind}-${change.projectPath}`}>
                    <time>{formatClock(change.at, locale)}</time>
                    <span>{change.detail}</span>
                    <small>{projectDisplayName(change.projectPath)}</small>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="widget-card-caption">
                {localized(locale, "还没有本工具记录的任务变化。", "No task changes have been recorded yet.")}
              </p>
            )}
            <MetricSource
              state={snapshot.recentChanges.state}
              source={snapshot.recentChanges.source}
              evidence={snapshot.recentChanges.evidence}
            />
          </article>
        )}
        {subscriptionMetric && visible.has("subscription") && (
          <article
            className={`widget-card widget-card--${subscriptionMetric.state}`}
            data-metric="subscription"
          >
            <div className="widget-card-heading">
              <h2>{localized(locale, "Codex 订阅版本", "Codex plan")}</h2>
              <span>
                {localizedWidgetStateLabel(locale, subscriptionMetric.state, subscriptionMetric.source)}
              </span>
            </div>
            <strong className="widget-project-name">
              {subscriptionMetric.label ?? localized(locale, "未验证", "Not verified")}
            </strong>
            <p className="widget-card-caption">
              {subscriptionMetric.source.includes("app_server")
                ? localized(locale, "由官方账户快照返回。", "Returned by the official account snapshot.")
                : subscriptionMetric.state === "manual"
                ? localized(locale, "这是你的手工标签，不是账号接口验证结果。", "This is your manual label, not a value verified by the account API.")
                : localized(locale, "请在自定义设置中手动填写，或到官方 Usage Dashboard 核对。", "Enter a fallback in Customize, or verify it in the official Usage Dashboard.")}
            </p>
            <MetricSource
              state={subscriptionMetric.state}
              source={subscriptionMetric.source}
              evidence={subscriptionMetric.evidence}
            />
          </article>
        )}
        {snapshot && visible.size === 0 && (
          <div className="widget-empty">
            <strong>{localized(locale, "自定义消息已全部隐藏", "All optional information is hidden")}</strong>
            <p>{localized(locale, "Usage 余量和当前项目里程碑仍作为项目概览的核心信息保留。", "Usage remaining and the current project's milestone remain visible as core overview data.")}</p>
          </div>
        )}
              </main>
            </div>
          )}

          <footer className="widget-footer">
            <span>
              {accountLifetimeText ??
                (projectUsage || accountUsage
                  ? localized(locale, "官方与本地记录分开显示，不重复相加。", "Official and local records are shown separately and are not added together.")
                  : snapshot?.scope
                    ? localizedSnapshotScope(locale, snapshot.scope)
                    : localized(locale, "正在建立数据边界…", "Establishing data boundaries…"))}
            </span>
            <span>
              {preferences.restingMode === "medium"
                ? localized(locale, "摘要视图默认", "Summary is default")
                : localized(locale, "紧凑视图默认", "Compact is default")}
              {floating
                ? preferences.pinned
                  ? localized(locale, " · 保持在最前方", " · Stay on top")
                  : localized(locale, " · 标准窗口层级", " · Standard window level")
                : preferences.restingMode === "medium"
                  ? preferences.pinned
                    ? localized(locale, " · 摄像头安全区置顶", " · Camera-safe view on top")
                    : localized(locale, " · 仅摘要正文可被覆盖", " · Summary body may be covered")
                  : localized(locale, " · 摄像头安全区层级", " · Camera-safe window level")}
            </span>
          </footer>
        </div>
      </section>
    </div>
  );
}
