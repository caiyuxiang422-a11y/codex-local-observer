export type TaskState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "unavailable";

export type EventSeverity = "info" | "success" | "warning" | "error";

export interface UsageSnapshot {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface TaskEvent {
  schemaVersion: 1;
  eventId: string;
  taskId: string;
  sequence: number;
  source: "codex_exec" | "monitor";
  receivedAt: number;
  kind: string;
  rawType?: string;
  taskState?: TaskState;
  severity: EventSeverity;
  label: string;
  detail?: string;
  usage?: UsageSnapshot;
  exitCode?: number;
  warningCount?: number;
}

export interface EnvironmentInfo {
  backendReady: boolean;
  projectPath: string;
  codexPath?: string;
  codexVersion?: string;
  message?: string;
}

/**
 * The project-health surface is deliberately separate from Codex task events.
 * Git and check results are local observations, not progress estimates.
 */
export type ProjectStatusKind = "all" | "git" | "test" | "build";

export interface ProjectStatusRequest {
  projectPath: string;
  kind: ProjectStatusKind;
}

export type GitStatusKind =
  | "available"
  | "notRepository"
  | "notRequested"
  | "error";

export interface GitStatus {
  status: GitStatusKind;
  source: string;
  updatedAt: number;
  confidence: string;
  branch?: string;
  headSha?: string;
  detached?: boolean;
  dirty: boolean;
  uncommittedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  countsTruncated: boolean;
  detail?: string;
}

export type ProjectCheckStatus =
  | "passed"
  | "failed"
  | "timedOut"
  | "notConfigured"
  | "notRequested"
  | "notFound"
  | "error";

export interface ProjectCheckResult {
  status: ProjectCheckStatus;
  source: string;
  updatedAt: number;
  confidence: string;
  configured: boolean;
  exitCode?: number;
  durationMs: number;
  outputTail?: string;
  detail?: string;
}

export interface ProjectStatusSnapshot {
  schemaVersion: 1;
  source: string;
  projectPath: string;
  collectedAt: number;
  confidence: string;
  git: GitStatus;
  checks: {
    test: ProjectCheckResult;
    build: ProjectCheckResult;
  };
}

/**
 * Third-step progress is deliberately a separate contract from the live
 * Git/test/build snapshot. These values are user-authored or explicitly
 * derived from those values; they are never inferred from tokens or lines of
 * code.
 */
export type MilestoneStatus =
  | "planned"
  | "inProgress"
  | "done"
  | "blocked";

export interface MilestoneInput {
  id: string;
  title: string;
  weight: number;
  progressPercent: number;
  status: MilestoneStatus;
}

export interface ProjectProgressRequest {
  projectPath: string;
}

export interface SaveProjectProgressRequest extends ProjectProgressRequest {
  milestones: MilestoneInput[];
}

export interface ProgressEvidence {
  kind: string;
  detail: string;
}

export interface CompletionMetric {
  state: "unknown" | "derived" | string;
  percent?: number;
  source: string;
  updatedAt: number;
  confidence: string;
  evidence: ProgressEvidence[];
}

export interface HealthSignal {
  kind: string;
  value: number;
  source: string;
  updatedAt: number;
  confidence: string;
  evidence: ProgressEvidence[];
}

export interface HealthMetric {
  status: "unknown" | "healthy" | "attention" | "blocked" | string;
  source: string;
  updatedAt: number;
  confidence: string;
  signals: HealthSignal[];
  evidence: ProgressEvidence[];
}

export interface ProjectProgressSnapshot {
  schemaVersion: 1;
  source: string;
  projectPath: string;
  updatedAt: number;
  confidence: string;
  milestones: MilestoneInput[];
  completion: CompletionMetric;
  health: HealthMetric;
}

export interface StartTaskRequest {
  projectPath: string;
  prompt: string;
}

export interface StartTaskResponse {
  taskId: string;
  projectPath: string;
  codexPath: string;
}

export interface MonitorState {
  taskId?: string;
  status: TaskState;
  events: TaskEvent[];
  totalEventCount: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  warningCount: number;
  usage?: UsageSnapshot;
  error?: string;
}

export type MonitorAction =
  | { type: "start-requested"; at: number }
  | { type: "start-accepted"; taskId: string }
  | { type: "start-failed"; error: string; at: number }
  | { type: "stop-requested" }
  | { type: "stop-failed"; error: string }
  | { type: "event-received"; event: TaskEvent }
  | { type: "reset" };

const MAX_VISIBLE_EVENTS = 300;

export const initialMonitorState: MonitorState = {
  status: "idle",
  events: [],
  totalEventCount: 0,
  warningCount: 0,
};

const terminalStates = new Set<TaskState>([
  "completed",
  "failed",
  "cancelled",
]);

export function isTaskActive(status: TaskState): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

export function isTaskTerminal(status: TaskState): boolean {
  return terminalStates.has(status);
}

export function monitorReducer(
  state: MonitorState,
  action: MonitorAction,
): MonitorState {
  switch (action.type) {
    case "reset":
      return initialMonitorState;
    case "start-requested":
      return {
        status: "starting",
        events: [],
        totalEventCount: 0,
        startedAt: action.at,
        warningCount: 0,
      };
    case "start-accepted":
      return {
        ...state,
        taskId: state.taskId ?? action.taskId,
      };
    case "start-failed":
      return {
        ...state,
        status: "failed",
        endedAt: action.at,
        error: action.error,
      };
    case "stop-requested":
      return isTaskActive(state.status)
        ? { ...state, status: "stopping" }
        : state;
    case "stop-failed":
      return isTaskTerminal(state.status)
        ? state
        : { ...state, status: "running", error: action.error };
    case "event-received": {
      const { event } = action;
      if (state.taskId && event.taskId !== state.taskId) {
        return state;
      }

      let nextStatus = event.taskState ?? state.status;
      if (state.status === "stopping" && nextStatus === "running") {
        nextStatus = "stopping";
      }
      if (isTaskTerminal(state.status) && !isTaskTerminal(nextStatus)) {
        nextStatus = state.status;
      }

      const isTerminal = isTaskTerminal(nextStatus);
      const events = [...state.events, event].slice(-MAX_VISIBLE_EVENTS);
      const eventError =
        event.severity === "error" ? event.detail ?? event.label : undefined;

      return {
        ...state,
        taskId: state.taskId ?? event.taskId,
        status: nextStatus,
        events,
        totalEventCount: state.totalEventCount + 1,
        startedAt: state.startedAt ?? event.receivedAt,
        endedAt: isTerminal ? event.receivedAt : state.endedAt,
        exitCode: event.exitCode ?? state.exitCode,
        warningCount:
          event.warningCount ??
          state.warningCount + (event.severity === "warning" ? 1 : 0),
        usage: event.usage ?? state.usage,
        error: eventError ?? state.error,
      };
    }
  }
}

export const statusText: Record<TaskState, string> = {
  idle: "等待开始",
  starting: "正在启动",
  running: "正在运行",
  stopping: "正在停止",
  completed: "任务完成",
  failed: "任务失败",
  cancelled: "已取消",
  unavailable: "Codex 不可用",
};

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;
}

export function formatTokenCount(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN").format(value);
}
