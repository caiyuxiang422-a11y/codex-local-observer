export interface RateLimitWindow {
  usedPercent?: number;
  remainingPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface RateLimitBucket extends RateLimitWindow {
  limitId: string;
  limitName?: string;
  creditsBalance?: string;
  hasCredits?: boolean;
  planType?: string;
  secondary?: RateLimitWindow;
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

/** Preserve both independent windows; a depleted long window must remain visible. */
export function rateLimitWindows(bucket: RateLimitBucket | undefined): RateLimitWindow[] {
  if (!bucket) return [];
  return bucket.secondary ? [bucket, bucket.secondary] : [bucket];
}

/** The headline shows the tightest reported window, with its own period/reset. */
export function limitingRateLimit(
  snapshot: AccountUsageSnapshot | undefined,
): RateLimitBucket | undefined {
  const bucket = primaryRateLimit(snapshot);
  if (!bucket) return undefined;
  const secondary = bucket.secondary;
  if (
    secondary?.remainingPercent !== undefined &&
    (bucket.remainingPercent === undefined || secondary.remainingPercent < bucket.remainingPercent)
  ) {
    return {
      ...bucket,
      usedPercent: secondary.usedPercent,
      remainingPercent: secondary.remainingPercent,
      windowDurationMins: secondary.windowDurationMins,
      resetsAt: secondary.resetsAt,
    };
  }
  return bucket;
}
