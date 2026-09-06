import type {
  MilestoneInput,
  ProjectCheckStatus,
  ProjectProgressSnapshot,
  ProjectStatusSnapshot,
} from "./taskModel";

export function weightedCompletionPercent(
  milestones: MilestoneInput[],
): number | undefined {
  if (milestones.length === 0) return undefined;
  const totalWeight = milestones.reduce(
    (sum, milestone) => sum + milestone.weight,
    0,
  );
  if (totalWeight <= 0) return undefined;
  const weightedPoints = milestones.reduce(
    (sum, milestone) => sum + milestone.weight * milestone.progressPercent,
    0,
  );
  return Math.min(100, Math.round(weightedPoints / totalWeight));
}

export const milestoneStatusText = {
  planned: "计划中",
  inProgress: "进行中",
  done: "已完成",
  blocked: "已阻塞",
} as const;

export type DisplayHealthStatus =
  | "unknown"
  | "healthy"
  | "attention"
  | "blocked";

export interface DisplayHealth {
  status: DisplayHealthStatus;
  source: string;
  updatedAt: number;
  confidence: string;
  evidence: string[];
}

export function milestoneStatusTone(
  status: keyof typeof milestoneStatusText,
): string {
  if (status === "done") return "success";
  if (status === "blocked") return "error";
  if (status === "inProgress") return "accent";
  return "neutral";
}

export function projectHealthTone(status: DisplayHealthStatus): string {
  if (status === "healthy") return "success";
  if (status === "blocked") return "error";
  if (status === "attention") return "warning";
  return "neutral";
}

export function projectHealthLabel(status: DisplayHealthStatus): string {
  if (status === "healthy") return "健康信号良好";
  if (status === "blocked") return "存在阻塞";
  if (status === "attention") return "需要关注";
  return "尚未评估";
}

function failingCheck(status: ProjectCheckStatus): boolean {
  return status === "failed" || status === "timedOut" || status === "error";
}

function incompleteCheck(status: ProjectCheckStatus): boolean {
  return status === "notRequested" || status === "notConfigured" || status === "notFound";
}

/**
 * Combine two explicitly labelled sources without pretending they are one
 * objective score. A failing check can downgrade a manually healthy
 * milestone list; a dirty Git tree alone never means the project is broken.
 */
export function deriveDisplayHealth(
  progress: ProjectProgressSnapshot | undefined,
  projectStatus: ProjectStatusSnapshot | undefined,
): DisplayHealth {
  if (!progress) {
    return {
      status: "unknown",
      source: "derived.project_health",
      updatedAt: projectStatus?.collectedAt ?? Date.now(),
      confidence: "none",
      evidence: ["尚未读取用户里程碑。"],
    };
  }

  let status = progress.health.status as DisplayHealthStatus;
  if (![
    "unknown",
    "healthy",
    "attention",
    "blocked",
  ].includes(status)) {
    status = "unknown";
  }
  const evidence = progress.health.evidence.map((item) => item.detail);
  let usedProjectStatus = false;

  if (projectStatus) {
    usedProjectStatus = true;
    const checks = [projectStatus.checks.test, projectStatus.checks.build];
    const failed = checks
      .filter((check) => failingCheck(check.status))
      .map((check) => check.detail || check.status);
    if (failed.length > 0) {
      status = "blocked";
      evidence.push(`第二步检查出现失败或超时：${failed.join("；")}`);
    } else if (
      status === "healthy" &&
      checks.some((check) => incompleteCheck(check.status))
    ) {
      status = "attention";
      evidence.push("里程碑已全部完成，但测试/构建仍有未检查或未配置项。");
    }
    if (projectStatus.git.status === "notRepository" || projectStatus.git.status === "error") {
      if (status === "healthy") status = "attention";
      evidence.push("Git 状态不可用；这不会被单独解释为代码失败。");
    }
  } else if (status !== "unknown") {
    evidence.push("尚未合并第二步 Git、测试和构建快照；当前只依据用户里程碑。");
  }

  return {
    status,
    source: usedProjectStatus
      ? "derived.project_health+project_status"
      : "derived.project_health",
    updatedAt: Math.max(
      progress.health.updatedAt,
      projectStatus?.collectedAt ?? 0,
    ),
    confidence: usedProjectStatus ? "medium" : progress.confidence,
    evidence,
  };
}
