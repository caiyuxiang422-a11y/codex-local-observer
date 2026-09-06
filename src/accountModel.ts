export interface RateLimitBucket {
  limitId: string;
  limitName?: string;
  usedPercent?: number;
  remainingPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  creditsBalance?: string;
  hasCredits?: boolean;
  planType?: string;
}

export interface TokenActivity {
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  latestDailyTokens?: number;
  latestDailyDate?: string;
}

export interface AccountUsageSnapshot {
  schemaVersion: 1;
  source: string;
  updatedAt: number;
  confidence: string;
  state: "known" | "partial" | "unknown" | string;
  accountType?: string;
  planType?: string;
  rateLimits: RateLimitBucket[];
  tokenActivity: TokenActivity;
  evidence: string[];
}

export function browserAccountUsage(): AccountUsageSnapshot {
  const updatedAt = Date.now();
  return {
    schemaVersion: 1,
    source: "browser.preview",
    updatedAt,
    confidence: "none",
    state: "unknown",
    rateLimits: [],
    tokenActivity: {},
    evidence: ["浏览器预览没有本地 App Server，不会伪造账户额度。"],
  };
}

export function primaryRateLimit(
  snapshot: AccountUsageSnapshot | undefined,
): RateLimitBucket | undefined {
  if (!snapshot) return undefined;
  return (
    snapshot.rateLimits.find((bucket) => bucket.limitId === "codex") ??
    snapshot.rateLimits[0]
  );
}

export function planLabel(planType: string | undefined): string {
  if (!planType) return "未验证";
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}
