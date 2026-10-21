import {
  planLabel,
  limitingRateLimit,
  type AccountUsageSnapshot,
} from "./accountModel";
import {
  projectUsageCaption,
  type ProjectUsageSnapshot,
} from "./projectUsageModel";
import type {
  SubscriptionMetric,
  TokenMetric,
  WidgetSnapshot,
} from "./widgetModel";

/**
 * The sticky note combines already-normalized adapters; it never parses raw
 * App Server responses in the renderer. Official and local usage are not
 * added together because their coverage can overlap.
 */
export function widgetProjectTokenMetric(
  local: WidgetSnapshot | undefined,
  official: ProjectUsageSnapshot | undefined,
): TokenMetric | undefined {
  const localMetric = local?.currentProjectUsage;
  if (!official) return localMetric;

  if (official.totalTokens !== undefined) {
    return {
      state: official.state === "partial" ? "partial" : "known",
      source: official.source,
      updatedAt: official.updatedAt,
      confidence: official.confidence,
      period: `当前项目 · ${official.measuredThreadCount}/${official.threadCount} 个会话可测`,
      inputTokens: official.inputTokens,
      cachedInputTokens: official.cachedInputTokens,
      outputTokens: official.outputTokens,
      totalTokens: official.totalTokens,
      evidence: [projectUsageCaption(official), ...official.evidence],
    };
  }

  // A verified local task total is more useful than an official null, but the
  // evidence must keep the narrower local coverage visible to the user.
  if (localMetric?.totalTokens !== undefined) {
    return {
      ...localMetric,
      evidence: [
        ...localMetric.evidence,
        `${projectUsageCaption(official)}；因此当前显示本工具任务记录，未与官方数据相加。`,
      ],
    };
  }

  return {
    state: official.state === "unavailable" ? "unavailable" : "unknown",
    source: official.source,
    updatedAt: official.updatedAt,
    confidence: official.confidence,
    period: `当前项目 · 已匹配 ${official.threadCount} 个会话`,
    evidence: [projectUsageCaption(official), ...official.evidence],
  };
}

export function widgetRecentDailyTokenMetric(
  local: WidgetSnapshot | undefined,
  account: AccountUsageSnapshot | undefined,
): TokenMetric | undefined {
  const latest = account?.tokenActivity.latestDailyTokens;
  if (account && latest !== undefined) {
    const date = account.tokenActivity.latestDailyDate;
    return {
      state: account.state === "known" ? "known" : "partial",
      source: account.source,
      updatedAt: account.updatedAt,
      confidence: account.confidence,
      period: date ? `官方账户最近日 · ${date}` : "官方账户最近一个日统计桶",
      totalTokens: latest,
      evidence: [
        "这是官方账户最近一个已返回的日用量，不一定等于当前自然日实时累计，也不是额度上限。",
        ...account.evidence,
      ],
    };
  }
  return local?.todayUsage;
}

export function widgetSubscriptionMetric(
  local: WidgetSnapshot | undefined,
  account: AccountUsageSnapshot | undefined,
): SubscriptionMetric | undefined {
  if (account?.planType) {
    return {
      state: "known",
      source: account.source,
      updatedAt: account.updatedAt,
      confidence: account.confidence,
      label: planLabel(account.planType),
      evidence: ["套餐类型由官方 App Server 的账户快照返回。", ...account.evidence],
    };
  }
  return local?.subscription;
}

export function widgetWindowRemainingText(
  account: AccountUsageSnapshot | undefined,
): string | undefined {
  const limit = limitingRateLimit(account);
  if (limit?.remainingPercent === undefined) return undefined;
  return `窗口余量 ${limit.remainingPercent}%`;
}
