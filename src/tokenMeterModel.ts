import type { TokenMetric } from "./widgetModel";

export type TokenCompositionKey = "input" | "output";

export interface TokenCompositionSegment {
  key: TokenCompositionKey;
  label: string;
  value: number;
  percent: number;
}

export interface TokenComposition {
  /** Sum of input + output; reasoning is a breakdown of output, not an extra bucket. */
  reportedComponentTotal: number;
  segments: TokenCompositionSegment[];
  /** Optional output sub-breakdown. It is intentionally not added to the denominator. */
  reasoning?: {
    value: number;
    percentOfOutput: number;
  };
}

const componentDefinitions: ReadonlyArray<{
  key: TokenCompositionKey;
  label: string;
  field: "inputTokens" | "outputTokens";
}> = [
  { key: "input", label: "输入", field: "inputTokens" },
  { key: "output", label: "输出", field: "outputTokens" },
];

function isReportedToken(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Keep an official percentage safe for a visual meter without changing the source value. */
export function clampMeterPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

/**
 * Build a visual composition meter only when input and output were explicitly
 * returned by the data source. The API describes reasoning tokens as a
 * breakdown of output, so they are kept as an annotation rather than added a
 * second time. This is deliberately not a quota/progress calculation: the
 * denominator is input + output, not an account limit or guessed target.
 */
export function tokenCompositionSegments(
  metric: Pick<
    TokenMetric,
    "inputTokens" | "outputTokens" | "reasoningOutputTokens"
  >,
): TokenComposition | undefined {
  const components = componentDefinitions.flatMap((definition) => {
    const value = metric[definition.field];
    return isReportedToken(value) ? [{ ...definition, value }] : [];
  });

  if (components.length < 2) return undefined;

  const reportedComponentTotal = components.reduce(
    (total, component) => total + component.value,
    0,
  );
  if (reportedComponentTotal <= 0) return undefined;

  const segments = components.map((component, index) => {
    const percent =
      index === components.length - 1
        ? 100 - components
            .slice(0, index)
            .reduce(
              (total, previous) =>
                total + Math.round((previous.value / reportedComponentTotal) * 100),
              0,
            )
        : Math.round((component.value / reportedComponentTotal) * 100);
    return {
      key: component.key,
      label: component.label,
      value: component.value,
      percent,
    };
  });

  const reasoning = metric.reasoningOutputTokens;
  const reasoningBreakdown =
    isReportedToken(reasoning) && components[1].value > 0
      ? {
          value: reasoning,
          percentOfOutput: Math.max(
            0,
            Math.min(100, Math.round((reasoning / components[1].value) * 100)),
          ),
        }
      : undefined;

  return {
    reportedComponentTotal,
    segments,
    ...(reasoningBreakdown ? { reasoning: reasoningBreakdown } : {}),
  };
}
