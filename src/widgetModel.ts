export const widgetMetricDefinitions = [
  { id: "currentProjectUsage", label: "当前项目 Token" },
  { id: "runningTasks", label: "正在运行的任务" },
  { id: "failedTasks", label: "失败的任务" },
  { id: "pendingApprovals", label: "等待批准" },
  { id: "highestCompletion", label: "完成度最高的项目" },
  { id: "stagnantProject", label: "久未更新的项目" },
  { id: "todayUsage", label: "今日 Token" },
  { id: "recentChanges", label: "最近变化" },
  { id: "subscription", label: "Codex 订阅版本" },
] as const;

export type WidgetMetricId = (typeof widgetMetricDefinitions)[number]["id"];

/**
 * The two compact chips beside a real Mac notch are intentionally limited to
 * one signal each.  Keeping the choice as a small, explicit enum prevents a
 * long card description from being squeezed into a 100pt side track and
 * makes the persisted preference forward-compatible when new metrics are
 * added later.
 */
export const widgetCompactMetricDefinitions = [
  {
    id: "projectStatus",
    label: "项目与状态",
    description: "项目名称和当前运行状态",
  },
  {
    id: "projectUsage",
    label: "项目 Token",
    description: "当前项目已测 Token",
  },
  {
    id: "usageRemaining",
    label: "Usage 余量",
    description: "官方窗口剩余比例",
  },
  {
    id: "projectProgress",
    label: "项目进度",
    description: "当前项目里程碑完成度",
  },
  {
    id: "todayUsage",
    label: "今日 Token",
    description: "官方最近日 Token",
  },
  {
    id: "runningTasks",
    label: "运行中任务",
    description: "本地记录的运行任务数",
  },
  {
    id: "failedTasks",
    label: "失败任务",
    description: "本地记录的失败任务数",
  },
  {
    id: "pendingApprovals",
    label: "待批准",
    description: "等待用户批准的任务数",
  },
  {
    id: "subscription",
    label: "订阅版本",
    description: "官方或手工套餐标签",
  },
  {
    id: "hidden",
    label: "不显示",
    description: "收起时隐藏这一侧",
  },
] as const;

export type WidgetCompactMetricId =
  (typeof widgetCompactMetricDefinitions)[number]["id"];

export type WidgetMediumMetricId = Exclude<WidgetCompactMetricId, "hidden">;

/** Summary cells reuse the same factual signals as compact chips, but an
 * empty cell is not useful in a fixed three-column layout. */
export const widgetMediumMetricDefinitions = widgetCompactMetricDefinitions.filter(
  (
    definition,
  ): definition is Exclude<
    (typeof widgetCompactMetricDefinitions)[number],
    { id: "hidden" }
  > => definition.id !== "hidden",
);

export const defaultFloatingMediumMetrics: [
  WidgetMediumMetricId,
  WidgetMediumMetricId,
  WidgetMediumMetricId,
] = ["projectUsage", "todayUsage", "projectProgress"];

/** The passive surface that remains visible while the pointer is away. */
export type WidgetRestingMode = "compact" | "medium";

/** Where the passive observer surface is anchored on the desktop. */
export type WidgetPlacementMode = "notch" | "floating";

/**
 * A real hardware-notch surface is intentionally passive and therefore uses
 * AppKit pointer proximity. A floating utility window can receive a precise
 * click, so opening it on hover would be an avoidable accidental action.
 */
export function usesPointerProximityExpansion(
  placementMode: WidgetPlacementMode,
): boolean {
  return placementMode === "notch";
}

/**
 * Floating surfaces can always choose their stacking behavior. A camera-safe
 * surface may expose the same choice only for its persistent summary: compact
 * must remain at menu-bar level to preserve the hardware anchor, while the
 * expanded page temporarily returns there so its controls stay reachable.
 */
export function canCustomizeWidgetWindowLevel(
  placementMode: WidgetPlacementMode,
  restingMode: WidgetRestingMode,
): boolean {
  return placementMode === "floating" || restingMode === "medium";
}

const widgetCompactMetricIds = new Set<WidgetCompactMetricId>(
  widgetCompactMetricDefinitions.map(({ id }) => id),
);

const widgetMediumMetricIds = new Set<WidgetMediumMetricId>(
  widgetMediumMetricDefinitions.map(({ id }) => id),
);

/** The first-run view favors project work over account metadata. */
export const coreWidgetMetricIds: WidgetMetricId[] = [
  "currentProjectUsage",
  "runningTasks",
  "failedTasks",
  "highestCompletion",
  "todayUsage",
  "recentChanges",
];

export type WidgetMetricState = "known" | "derived" | "manual" | "unknown" | string;

export interface WidgetPreferences {
  schemaVersion: 1;
  visibleMetrics: WidgetMetricId[];
  /** Notch remains the safe migration default for preferences from older builds. */
  placementMode: WidgetPlacementMode;
  /** User-selected persistent surface; its activation follows placementMode. */
  restingMode: WidgetRestingMode;
  /** One compact signal shown in the left chip beside the notch. */
  compactLeftMetric: WidgetCompactMetricId;
  /** One compact signal shown in the right chip beside the notch. */
  compactRightMetric: WidgetCompactMetricId;
  /** Three user-selected cells in the detached summary surface. */
  floatingMediumMetrics: [
    WidgetMediumMetricId,
    WidgetMediumMetricId,
    WidgetMediumMetricId,
  ];
  pinned: boolean;
  refreshSeconds: number;
  subscriptionLabel?: string;
}

/**
 * Preferences read from older stores may not contain placement, resting mode,
 * or the two side-customisation fields. The normalizer fills them with safe
 * defaults; callers that save preferences always receive the complete
 * WidgetPreferences shape back.
 */
export type WidgetPreferencesInput = Omit<
  WidgetPreferences,
  | "placementMode"
  | "restingMode"
  | "compactLeftMetric"
  | "compactRightMetric"
  | "floatingMediumMetrics"
> &
  Partial<
    Pick<
      WidgetPreferences,
      | "placementMode"
      | "restingMode"
      | "compactLeftMetric"
      | "compactRightMetric"
      | "floatingMediumMetrics"
    >
  >;

export interface WidgetPreferencesSnapshot {
  schemaVersion: 1;
  source: string;
  updatedAt: number;
  confidence: string;
  persistence: "persisted" | "default" | "preview" | string;
  preferences: WidgetPreferences;
}

export interface WidgetSnapshotRequest {
  projectPath?: string;
}

export interface TokenMetric {
  state: WidgetMetricState;
  source: string;
  updatedAt: number;
  confidence: string;
  period: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  evidence: string[];
}

export interface WidgetTaskSummary {
  taskId: string;
  projectPath: string;
  state: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  lastEvent?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface TaskListMetric {
  state: WidgetMetricState;
  source: string;
  updatedAt: number;
  confidence: string;
  scope: string;
  tasks: WidgetTaskSummary[];
  evidence: string[];
}

export interface CountMetric {
  state: WidgetMetricState;
  source: string;
  updatedAt: number;
  confidence: string;
  count?: number;
  evidence: string[];
}

export interface ProjectHighlightMetric {
  state: WidgetMetricState;
  source: string;
  updatedAt: number;
  confidence: string;
  /** Stable scope for comparison cards; current MVP compares all saved projects. */
  scope: string;
  projectPath?: string;
  percent?: number;
  lastUpdatedAt?: number;
  ageHours?: number;
  evidence: string[];
}

export interface RecentChange {
  at: number;
  kind: string;
  projectPath: string;
  detail: string;
}

export interface RecentChangesMetric {
  state: WidgetMetricState;
  source: string;
  updatedAt: number;
  confidence: string;
  changes: RecentChange[];
  evidence: string[];
}

export interface SubscriptionMetric {
  state: WidgetMetricState;
  source: string;
  updatedAt: number;
  confidence: string;
  label?: string;
  evidence: string[];
}

export interface WidgetSnapshot {
  schemaVersion: 1;
  source: string;
  updatedAt: number;
  confidence: string;
  scope: string;
  currentProjectPath?: string;
  currentProjectUsage: TokenMetric;
  todayUsage: TokenMetric;
  runningTasks: TaskListMetric;
  failedTasks: TaskListMetric;
  pendingApprovals: CountMetric;
  currentProjectProgress: ProjectHighlightMetric;
  highestCompletion: ProjectHighlightMetric;
  stagnantProject: ProjectHighlightMetric;
  recentChanges: RecentChangesMetric;
  subscription: SubscriptionMetric;
}

export interface WidgetWindowState {
  label: string;
  exists: boolean;
  visible: boolean;
  alwaysOnTop: boolean;
  selectedProjectPath?: string;
}

export const defaultWidgetPreferences: WidgetPreferences = {
  schemaVersion: 1,
  visibleMetrics: [...coreWidgetMetricIds],
  placementMode: "notch",
  restingMode: "compact",
  compactLeftMetric: "projectStatus",
  compactRightMetric: "usageRemaining",
  floatingMediumMetrics: [...defaultFloatingMediumMetrics],
  pinned: true,
  refreshSeconds: 5,
};

export function normalizeWidgetPreferences(
  preferences: WidgetPreferencesInput,
): WidgetPreferences {
  const allowed = new Set<WidgetMetricId>(
    widgetMetricDefinitions.map(({ id }) => id),
  );
  const visibleMetrics = [...new Set(preferences.visibleMetrics)].filter(
    (id): id is WidgetMetricId => allowed.has(id),
  );
  const subscriptionLabel = preferences.subscriptionLabel?.trim().slice(0, 48);
  const compactLeftMetric = widgetCompactMetricIds.has(
    preferences.compactLeftMetric as WidgetCompactMetricId,
  )
    ? (preferences.compactLeftMetric as WidgetCompactMetricId)
    : defaultWidgetPreferences.compactLeftMetric;
  const compactRightMetric = widgetCompactMetricIds.has(
    preferences.compactRightMetric as WidgetCompactMetricId,
  )
    ? (preferences.compactRightMetric as WidgetCompactMetricId)
    : defaultWidgetPreferences.compactRightMetric;
  const floatingMediumMetrics = defaultFloatingMediumMetrics.map(
    (fallback, index) => {
      const candidate = preferences.floatingMediumMetrics?.[index];
      return widgetMediumMetricIds.has(candidate as WidgetMediumMetricId)
        ? (candidate as WidgetMediumMetricId)
        : fallback;
    },
  ) as WidgetPreferences["floatingMediumMetrics"];
  const restingMode: WidgetRestingMode = preferences.restingMode === "medium"
    ? "medium"
    : defaultWidgetPreferences.restingMode;
  const placementMode: WidgetPlacementMode = preferences.placementMode === "floating"
    ? "floating"
    : defaultWidgetPreferences.placementMode;
  return {
    schemaVersion: 1,
    visibleMetrics,
    placementMode,
    restingMode,
    compactLeftMetric,
    compactRightMetric,
    floatingMediumMetrics,
    pinned: Boolean(preferences.pinned),
    refreshSeconds: Math.max(2, Math.min(60, Math.round(preferences.refreshSeconds || 5))),
    ...(subscriptionLabel ? { subscriptionLabel } : {}),
  };
}

export function browserWidgetPreferences(): WidgetPreferencesSnapshot {
  return {
    schemaVersion: 1,
    source: "browser.preview",
    updatedAt: Date.now(),
    confidence: "none",
    persistence: "preview",
    preferences: { ...defaultWidgetPreferences },
  };
}

export function browserWidgetSnapshot(projectPath?: string): WidgetSnapshot {
  const now = Date.now();
  const unavailable = "浏览器预览没有桌面后台，不会伪造本机 Codex 数据。";
  const token = (period: string): TokenMetric => ({
    state: "unknown",
    source: "browser.preview",
    updatedAt: now,
    confidence: "none",
    period,
    evidence: [unavailable],
  });
  const taskList = (scope: string): TaskListMetric => ({
    state: "unknown",
    source: "browser.preview",
    updatedAt: now,
    confidence: "none",
    scope,
    tasks: [],
    evidence: [unavailable],
  });
  const highlight = (scope = "all_saved_projects"): ProjectHighlightMetric => ({
    state: "unknown",
    source: "browser.preview",
    updatedAt: now,
    confidence: "none",
    scope,
    evidence: [unavailable],
  });
  return {
    schemaVersion: 1,
    source: "browser.preview",
    updatedAt: now,
    confidence: "none",
    scope: "浏览器预览",
    currentProjectPath: projectPath,
    currentProjectUsage: token("当前项目"),
    todayUsage: token("今天"),
    runningTasks: taskList("浏览器预览"),
    failedTasks: taskList("浏览器预览"),
    pendingApprovals: {
      state: "unknown",
      source: "browser.preview",
      updatedAt: now,
      confidence: "none",
      evidence: [unavailable],
    },
    currentProjectProgress: highlight("current_project"),
    highestCompletion: highlight(),
    stagnantProject: highlight(),
    recentChanges: {
      state: "unknown",
      source: "browser.preview",
      updatedAt: now,
      confidence: "none",
      changes: [],
      evidence: [unavailable],
    },
    subscription: {
      state: "unknown",
      source: "browser.preview",
      updatedAt: now,
      confidence: "none",
      evidence: [unavailable],
    },
  };
}

export function projectDisplayName(path: string | undefined): string {
  if (!path) return "未知项目";
  const pieces = path.split(/[\\/]/).filter(Boolean);
  return pieces[pieces.length - 1] ?? path;
}

export function widgetStateLabel(
  state: WidgetMetricState,
  source = "",
): string {
  if (state === "known") {
    return source.includes("app_server") ? "官方数据" : "本地记录";
  }
  if (state === "derived") return "规则推导";
  if (state === "manual") return "手工填写";
  if (state === "partial") return "部分数据";
  if (state === "unavailable") return "暂不可用";
  if (source === "not_connected") return "未接入";
  if (source.includes("app_server")) return "官方未返回";
  if (source.startsWith("local.")) return "暂无记录";
  if (source === "browser.preview") return "不可用";
  return "暂无数据";
}
