import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EnvironmentInfo,
  ProjectProgressRequest,
  ProjectProgressSnapshot,
  ProjectStatusRequest,
  ProjectStatusSnapshot,
  SaveProjectProgressRequest,
  StartTaskRequest,
  StartTaskResponse,
  TaskEvent,
} from "./taskModel";
import {
  browserAdvancedCapabilities,
  browserWorkspaceSnapshot,
  type AdvancedCapabilitiesSnapshot,
  type DeleteWorkspaceRequest,
  type SaveWorkspaceRequest,
  type WorkspaceSnapshot,
} from "./advancedModel";
import {
  browserWidgetPreferences,
  browserWidgetSnapshot,
  normalizeWidgetPreferences,
  type WidgetPreferences,
  type WidgetPreferencesSnapshot,
  type WidgetSnapshot,
  type WidgetSnapshotRequest,
  type WidgetWindowState,
} from "./widgetModel";
import {
  browserAccountUsage,
  type AccountUsageSnapshot,
} from "./accountModel";
import type { ProjectUsageSnapshot } from "./projectUsageModel";
import {
  browserSystemMetricsSnapshot,
  normalizeSystemMetricsSnapshot,
  type SystemMetricsSnapshot,
} from "./systemMetricsModel";
import {
  browserMacNotchGeometry,
  normalizeMacNotchGeometry,
  type MacPointerProximity,
  type MacNotchGeometry,
  type MacNotchRect,
} from "./macosNotchModel";
import {
  WIDGET_CROWN_PAYLOAD_EVENT,
  WIDGET_CROWN_PAINTED_EVENT,
  WIDGET_CROWN_READY_EVENT,
  WIDGET_CROWN_WINDOW_LABEL,
  WIDGET_WINDOW_LABEL,
  WIDGET_WINDOW_HIDDEN_EVENT,
  WIDGET_WINDOW_SHOWN_EVENT,
  type WidgetCrownPayload,
  type WidgetCrownPaintedPayload,
  type WidgetCrownReadyPayload,
} from "./crownOverlayModel";

const TASK_EVENT_NAME = "codex-task-event";
const WIDGET_PROJECT_EVENT_NAME = "widget-project-changed";

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getEnvironment(): Promise<EnvironmentInfo> {
  if (!isDesktopRuntime()) {
    return {
      backendReady: false,
      projectPath: "",
      message: "当前是浏览器预览；请用 npm run tauri:dev 启动桌面版。",
    };
  }
  return invoke<EnvironmentInfo>("get_environment");
}

/** Read-only account/rate-limit snapshot through the official App Server API. */
export async function getAccountUsage(): Promise<AccountUsageSnapshot> {
  if (!isDesktopRuntime()) return browserAccountUsage();
  return invoke<AccountUsageSnapshot>("get_account_usage");
}

/**
 * Read the usage that the official App Server can attribute to this exact
 * project's threads.  A missing value is returned as an explicit
 * unavailable/partial snapshot; the browser fallback never invents a zero.
 */
export async function getProjectUsage(
  projectPath: string,
): Promise<ProjectUsageSnapshot> {
  if (!isDesktopRuntime()) {
    const updatedAt = Date.now();
    return {
      schemaVersion: 1,
      source: "browser.preview",
      projectPath,
      updatedAt,
      confidence: "none",
      state: "unavailable",
      threadCount: 0,
      measuredThreadCount: 0,
      activeThreadCount: 0,
      systemErrorThreadCount: 0,
      truncated: false,
      evidence: ["浏览器预览没有本地 App Server；请使用 Tauri 桌面版。"],
    };
  }
  return invoke<ProjectUsageSnapshot>("get_project_usage", {
    request: { projectPath },
  });
}

/**
 * Read one local host snapshot for the selected project. The backend keeps
 * the native provider alive so CPU, network, and disk rates are real deltas;
 * browser preview stays explicitly unknown.
 */
export async function getSystemMetrics(
  projectPath: string,
): Promise<SystemMetricsSnapshot> {
  if (!isDesktopRuntime()) return browserSystemMetricsSnapshot();
  const snapshot = await invoke<SystemMetricsSnapshot>("get_system_metrics", {
    request: { projectPath },
  });
  return normalizeSystemMetricsSnapshot(snapshot);
}

export async function subscribeToTaskEvents(
  onEvent: (event: TaskEvent) => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<TaskEvent>(TASK_EVENT_NAME, ({ payload }) => onEvent(payload));
}

/** Keep an already-open sticky note on the project selected in the main UI. */
export async function subscribeToWidgetProject(
  onProjectPath: (projectPath: string) => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<string>(WIDGET_PROJECT_EVENT_NAME, ({ payload }) => {
    if (typeof payload === "string") onProjectPath(payload);
  });
}

/**
 * Send already-derived display copy to the always-front companion strip.
 * The companion is intentionally not allowed to query any data adapter.
 */
export async function publishWidgetCrownPayload(
  payload: WidgetCrownPayload,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await emitTo(WIDGET_CROWN_WINDOW_LABEL, WIDGET_CROWN_PAYLOAD_EVENT, payload);
}

export async function subscribeToWidgetCrownPayload(
  onPayload: (payload: unknown) => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<unknown>(WIDGET_CROWN_PAYLOAD_EVENT, ({ payload }) => {
    onPayload(payload);
  });
}

/** Handshake makes event delivery robust regardless of WebView load order. */
export async function publishWidgetCrownReady(
  payload: WidgetCrownReadyPayload,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await emitTo(WIDGET_WINDOW_LABEL, WIDGET_CROWN_READY_EVENT, payload);
}

export async function subscribeToWidgetCrownReady(
  onReady: (payload: WidgetCrownReadyPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<WidgetCrownReadyPayload>(
    WIDGET_CROWN_READY_EVENT,
    ({ payload }) => onReady(payload),
  );
}

/** Sent only after the companion has committed the requested visible crown. */
export async function publishWidgetCrownPainted(
  payload: WidgetCrownPaintedPayload,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await emitTo(WIDGET_WINDOW_LABEL, WIDGET_CROWN_PAINTED_EVENT, payload);
}

export async function subscribeToWidgetCrownPainted(
  onPainted: (payload: unknown) => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen<unknown>(WIDGET_CROWN_PAINTED_EVENT, ({ payload }) => {
    onPainted(payload);
  });
}

/** Existing native widget windows emit this immediately after being shown. */
export async function subscribeToWidgetWindowShown(
  onShown: () => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen(WIDGET_WINDOW_SHOWN_EVENT, () => onShown());
}

/** Clear split-surface ownership while the native hosts are being hidden. */
export async function subscribeToWidgetWindowHidden(
  onHidden: () => void,
): Promise<UnlistenFn> {
  if (!isDesktopRuntime()) return () => undefined;
  return listen(WIDGET_WINDOW_HIDDEN_EVENT, () => onHidden());
}

export async function startTask(
  request: StartTaskRequest,
): Promise<StartTaskResponse> {
  return invoke<StartTaskResponse>("start_task", { request });
}

export async function stopTask(taskId: string): Promise<void> {
  return invoke<void>("stop_task", { taskId });
}

/** Read-only probe of the installed CLI and local fourth-step adapters. */
export async function getAdvancedCapabilities(): Promise<AdvancedCapabilitiesSnapshot> {
  if (!isDesktopRuntime()) return browserAdvancedCapabilities();
  return invoke<AdvancedCapabilitiesSnapshot>("get_advanced_capabilities");
}

export async function listWorkspaces(): Promise<WorkspaceSnapshot> {
  if (!isDesktopRuntime()) return browserWorkspaceSnapshot();
  return invoke<WorkspaceSnapshot>("list_workspaces");
}

export async function saveWorkspace(
  request: SaveWorkspaceRequest,
): Promise<WorkspaceSnapshot> {
  if (!isDesktopRuntime()) {
    throw new Error("浏览器预览不会保存工作区；请用 npm run tauri:dev 启动桌面版。");
  }
  return invoke<WorkspaceSnapshot>("save_workspace", { request });
}

export async function deleteWorkspace(
  request: DeleteWorkspaceRequest,
): Promise<WorkspaceSnapshot> {
  if (!isDesktopRuntime()) {
    throw new Error("浏览器预览不会删除工作区；请用 npm run tauri:dev 启动桌面版。");
  }
  return invoke<WorkspaceSnapshot>("delete_workspace", { request });
}

export async function getWidgetSnapshot(
  request: WidgetSnapshotRequest = {},
): Promise<WidgetSnapshot> {
  if (!isDesktopRuntime()) return browserWidgetSnapshot(request.projectPath);
  return invoke<WidgetSnapshot>("get_widget_snapshot", { request });
}

export async function getWidgetPreferences(): Promise<WidgetPreferencesSnapshot> {
  if (!isDesktopRuntime()) return browserWidgetPreferences();
  return invoke<WidgetPreferencesSnapshot>("get_widget_preferences");
}

export async function saveWidgetPreferences(
  preferences: WidgetPreferences,
): Promise<WidgetPreferencesSnapshot> {
  const normalized = normalizeWidgetPreferences(preferences);
  if (!isDesktopRuntime()) {
    return {
      schemaVersion: 1,
      source: "browser.preview",
      updatedAt: Date.now(),
      confidence: "none",
      persistence: "preview",
      preferences: normalized,
    };
  }
  return invoke<WidgetPreferencesSnapshot>("save_widget_preferences", {
    request: { preferences: normalized },
  });
}

export async function showWidget(projectPath?: string): Promise<WidgetWindowState> {
  ensureDesktopWidgetRuntime();
  return invoke<WidgetWindowState>("show_widget", { projectPath });
}

export async function setWidgetProject(projectPath: string): Promise<WidgetWindowState> {
  ensureDesktopWidgetRuntime();
  return invoke<WidgetWindowState>("set_widget_project", { projectPath });
}

export async function hideWidget(): Promise<WidgetWindowState> {
  ensureDesktopWidgetRuntime();
  return invoke<WidgetWindowState>("hide_widget");
}

export async function toggleWidget(): Promise<WidgetWindowState> {
  ensureDesktopWidgetRuntime();
  return invoke<WidgetWindowState>("toggle_widget");
}

export async function getWidgetState(): Promise<WidgetWindowState> {
  ensureDesktopWidgetRuntime();
  return invoke<WidgetWindowState>("get_widget_state");
}

export async function setWidgetAlwaysOnTop(
  enabled: boolean,
): Promise<WidgetWindowState> {
  ensureDesktopWidgetRuntime();
  return invoke<WidgetWindowState>("set_widget_always_on_top", { enabled });
}

export async function minimizeMainWindow(): Promise<void> {
  ensureDesktopWidgetRuntime();
  return invoke<void>("minimize_main_window");
}

export async function showMainWindow(): Promise<void> {
  ensureDesktopWidgetRuntime();
  return invoke<void>("show_main_window");
}

/**
 * Read the screen-safe-area metrics used to align the widget with a real
 * MacBook camera/notch.  This is deliberately separate from Codex data: a
 * screen-layout failure must not turn a token value into an invented value.
 */
export async function getMacosNotchGeometry(): Promise<MacNotchGeometry> {
  if (!isDesktopRuntime()) return { ...browserMacNotchGeometry, updatedAt: Date.now() };
  const geometry = await invoke<MacNotchGeometry>("get_macos_notch_geometry");
  return normalizeMacNotchGeometry(geometry);
}

/**
 * Sample pointer proximity using AppKit's global logical-point coordinates.
 * Tauri's generic cursorPosition API uses a primary-display/physical-pixel
 * conversion on macOS, so mixed-scale or offset displays can disagree with
 * the widget's AppKit frame; the notch shelf uses this native result instead.
 */
export async function getMacosPointerProximity(
  margin = 34,
): Promise<MacPointerProximity> {
  if (!isDesktopRuntime()) {
    return {
      schemaVersion: 1,
      source: "browser.preview",
      supported: false,
      pointerX: 0,
      pointerY: 0,
      margin: 0,
      windowVisible: false,
      nearWindow: false,
      screenName: undefined,
      windowFrame: undefined,
      limitation: "浏览器预览没有 AppKit 指针坐标。",
    };
  }
  return invoke<MacPointerProximity>("get_macos_pointer_proximity", { margin });
}

/**
 * Apply an AppKit logical-point frame and re-anchor it to the current
 * display's top edge.  The native side also reapplies non-activating/Spaces
 * window behavior.  Width/height are optional so callers can request only a
 * re-anchor and geometry refresh.
 */
export async function syncMacosWidgetWindow(options: {
  width?: number;
  height?: number;
  animate?: boolean;
  /** Closed mode is click-through; expanded mode enables controls. */
  interactive?: boolean;
  /** Native material/presentation mode; kept separate from hit-testing. */
  surfaceMode?: "compact" | "medium" | "expanded" | "transition";
  /** Keep the surface at the hardware notch, or preserve a draggable centre. */
  placementMode?: "notch" | "floating";
  /** Persistent stacking choice; native policy decides which surfaces honour it. */
  alwaysOnTop?: boolean;
  /** AppKit-point resting frame captured before a floating surface expands. */
  floatingAnchor?: MacNotchRect;
  /** The current companion WebView session painted this presentation. */
  crownContentReady?: boolean;
} = {}): Promise<MacNotchGeometry> {
  if (!isDesktopRuntime()) return { ...browserMacNotchGeometry, updatedAt: Date.now() };
  const geometry = await invoke<MacNotchGeometry>("sync_macos_widget_window", {
    width: options.width,
    height: options.height,
    animate: options.animate ?? false,
    interactive: options.interactive,
    surfaceMode: options.surfaceMode,
    placementMode: options.placementMode,
    alwaysOnTop: options.alwaysOnTop,
    floatingAnchor: options.floatingAnchor,
    crownContentReady: options.crownContentReady,
  });
  return normalizeMacNotchGeometry(geometry);
}

function ensureDesktopWidgetRuntime(): void {
  if (!isDesktopRuntime()) {
    throw new Error("项目概览窗口只在 Tauri 桌面版中可用；浏览器预览不会创建窗口。");
  }
}

/**
 * Ask the local Rust adapter for one project snapshot. The browser fallback is
 * intentionally an error-shaped snapshot: a preview must never fabricate Git,
 * test, or build results.
 */
export async function getProjectStatus(
  request: ProjectStatusRequest,
): Promise<ProjectStatusSnapshot> {
  if (!isDesktopRuntime()) {
    return {
      schemaVersion: 1,
      source: "browser.preview",
      projectPath: request.projectPath,
      collectedAt: Date.now(),
      confidence: "none",
      git: {
        status: "error",
        source: "browser.preview",
        updatedAt: Date.now(),
        confidence: "none",
        dirty: false,
        uncommittedFiles: 0,
        stagedFiles: 0,
        unstagedFiles: 0,
        untrackedFiles: 0,
        countsTruncated: false,
        detail: "当前是浏览器预览；请用 npm run tauri:dev 检查本地项目。",
      },
      checks: {
        test: unavailableCheck("浏览器预览不会运行测试命令。"),
        build: unavailableCheck("浏览器预览不会运行构建命令。"),
      },
    };
  }
  return invoke<ProjectStatusSnapshot>("get_project_status", { request });
}

function browserProgressSnapshot(
  projectPath: string,
): ProjectProgressSnapshot {
  const updatedAt = Date.now();
  const detail = "当前是浏览器预览；请用 npm run tauri:dev 读取本机项目进度。";
  return {
    schemaVersion: 1,
    source: "browser.preview",
    projectPath,
    updatedAt,
    confidence: "none",
    milestones: [],
    completion: {
      state: "unknown",
      source: "browser.preview",
      updatedAt,
      confidence: "none",
      evidence: [{ kind: "unavailable", detail }],
    },
    health: {
      status: "unknown",
      source: "browser.preview",
      updatedAt,
      confidence: "none",
      signals: [],
      evidence: [{ kind: "unavailable", detail }],
    },
  };
}

export async function getProjectProgress(
  request: ProjectProgressRequest,
): Promise<ProjectProgressSnapshot> {
  if (!isDesktopRuntime()) return browserProgressSnapshot(request.projectPath);
  return invoke<ProjectProgressSnapshot>("get_project_progress", { request });
}

export async function saveProjectProgress(
  request: SaveProjectProgressRequest,
): Promise<ProjectProgressSnapshot> {
  if (!isDesktopRuntime()) {
    throw new Error("浏览器预览不会保存里程碑；请用 npm run tauri:dev 启动桌面版。");
  }
  return invoke<ProjectProgressSnapshot>("save_project_progress", { request });
}

function unavailableCheck(detail: string) {
  return {
    status: "error" as const,
    source: "browser.preview",
    updatedAt: Date.now(),
    confidence: "none",
    configured: false,
    durationMs: 0,
    detail,
  };
}

export function readableError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "发生了未识别的错误。";
  if (/permission denied|operation not permitted|eacces|eperm/i.test(raw)) {
    return `${raw}。请在 macOS“系统设置 → 隐私与安全性 → 文件与文件夹”中，允许“Codex 本地观察台”访问所选项目所在的文件夹。`;
  }
  return raw;
}
