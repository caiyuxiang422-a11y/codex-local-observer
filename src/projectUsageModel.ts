/**
 * Usage that the official Codex App Server can attribute to one project's
 * threads.  This is intentionally separate from the local `codex exec`
 * history in widgetModel: the two sources have different coverage and must
 * never be silently added together.
 */
export interface ProjectUsageSnapshot {
  schemaVersion: 1;
  source: string;
  projectPath: string;
  updatedAt: number;
  confidence: string;
  state: "known" | "partial" | "unavailable" | "unknown" | string;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  threadCount: number;
  measuredThreadCount: number;
  activeThreadCount: number;
  systemErrorThreadCount: number;
  /** True when the server reported another page that was not read. */
  truncated: boolean;
  evidence: string[];
}

export function projectUsageValue(
  snapshot: ProjectUsageSnapshot | undefined,
): string {
  if (!snapshot || snapshot.totalTokens === undefined) return "不可测";
  return new Intl.NumberFormat("zh-CN").format(snapshot.totalTokens);
}

export function projectUsageCaption(
  snapshot: ProjectUsageSnapshot | undefined,
): string {
  if (!snapshot) return "点击“查看项目”读取官方线程数据";
  if (snapshot.totalTokens === undefined) {
    if (snapshot.state === "unavailable") return "官方项目用量读取失败或暂不可用";
    if (snapshot.threadCount === 0) return "官方没有找到这个目录的 Codex 会话";
    return `已找到 ${snapshot.threadCount} 个会话，但官方未返回历史 Token`;
  }
  const measured = `${snapshot.measuredThreadCount}/${snapshot.threadCount} 个会话可测`;
  return snapshot.truncated ? `${measured} · 结果可能不完整` : measured;
}

export function projectUsageStateLabel(
  snapshot: ProjectUsageSnapshot | undefined,
): string {
  if (!snapshot) return "未读取";
  if (snapshot.state === "known") return "官方可测";
  if (snapshot.state === "partial") return "部分可测";
  if (snapshot.state === "unavailable") return "官方未提供";
  if (snapshot.state === "unknown") return "官方未返回历史 Token";
  return "未知";
}
