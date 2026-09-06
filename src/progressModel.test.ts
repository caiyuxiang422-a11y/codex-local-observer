import { describe, expect, it } from "vitest";
import { deriveDisplayHealth, weightedCompletionPercent } from "./progressModel";
import type { ProjectProgressSnapshot, ProjectStatusSnapshot } from "./taskModel";

function progress(
  status: "unknown" | "healthy" | "attention" | "blocked",
  confidence = "medium",
): ProjectProgressSnapshot {
  return {
    schemaVersion: 1,
    source: "local.project_progress",
    projectPath: "/tmp/project",
    updatedAt: 100,
    confidence,
    milestones: [],
    completion: {
      state: status === "unknown" ? "unknown" : "derived",
      percent: status === "unknown" ? undefined : 100,
      source: "local.project_progress",
      updatedAt: 100,
      confidence,
      evidence: [{ kind: "rule", detail: "仅用于测试" }],
    },
    health: {
      status,
      source: "local.project_progress",
      updatedAt: 100,
      confidence,
      signals: [],
      evidence: [{ kind: "rule", detail: "里程碑证据" }],
    },
  };
}

function projectStatus(
  test: "passed" | "failed" | "notRequested",
  build: "passed" | "failed" | "notRequested",
): ProjectStatusSnapshot {
  const check = (status: "passed" | "failed" | "notRequested") => ({
    status,
    source: "local.project_status",
    updatedAt: 100,
    confidence: "high",
    configured: status !== "notRequested",
    durationMs: 1,
    detail: status === "failed" ? `${status} fixture` : undefined,
  });
  return {
    schemaVersion: 1,
    source: "local.project_status",
    projectPath: "/tmp/project",
    collectedAt: 100,
    confidence: "high",
    git: {
      status: "available",
      source: "local.project_status",
      updatedAt: 100,
      confidence: "high",
      dirty: false,
      uncommittedFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      countsTruncated: false,
    },
    checks: { test: check(test), build: check(build) },
  };
}

describe("deriveDisplayHealth", () => {
  it("uses the documented weighted completion formula for drafts", () => {
    expect(
      weightedCompletionPercent([
        { id: "a", title: "基础", weight: 1, progressPercent: 100, status: "done" },
        { id: "b", title: "验证", weight: 3, progressPercent: 0, status: "planned" },
      ]),
    ).toBe(25);
    expect(weightedCompletionPercent([])).toBeUndefined();
  });

  it("does not fabricate a health verdict without progress data", () => {
    const result = deriveDisplayHealth(undefined, undefined);
    expect(result.status).toBe("unknown");
    expect(result.confidence).toBe("none");
    expect(result.updatedAt).toBeGreaterThan(0);
  });

  it("downgrades manually healthy milestones when a check fails", () => {
    const result = deriveDisplayHealth(
      progress("healthy"),
      projectStatus("failed", "passed"),
    );
    expect(result.status).toBe("blocked");
    expect(result.source).toContain("project_status");
    expect(result.updatedAt).toBe(100);
    expect(result.evidence.join(" ")).toContain("失败");
  });

  it("does not treat an uncommitted tree as a failure", () => {
    const snapshot = projectStatus("passed", "passed");
    snapshot.git.dirty = true;
    snapshot.git.uncommittedFiles = 3;
    const result = deriveDisplayHealth(progress("healthy"), snapshot);
    expect(result.status).toBe("healthy");
  });

  it("keeps incomplete checks visible as attention", () => {
    const result = deriveDisplayHealth(
      progress("healthy"),
      projectStatus("notRequested", "passed"),
    );
    expect(result.status).toBe("attention");
  });
});
