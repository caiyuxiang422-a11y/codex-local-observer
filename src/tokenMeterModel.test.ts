import { describe, expect, it } from "vitest";
import { clampMeterPercent, tokenCompositionSegments } from "./tokenMeterModel";

describe("token composition meter", () => {
  it("shows explicitly reported input/output components", () => {
    const composition = tokenCompositionSegments({
      inputTokens: 100,
      outputTokens: 20,
    });

    expect(composition?.reportedComponentTotal).toBe(120);
    expect(composition?.segments).toEqual([
      { key: "input", label: "输入", value: 100, percent: 83 },
      { key: "output", label: "输出", value: 20, percent: 17 },
    ]);
  });

  it("keeps reasoning as an output breakdown instead of double-counting it", () => {
    const composition = tokenCompositionSegments({
      inputTokens: 3,
      outputTokens: 3,
      reasoningOutputTokens: 4,
    });

    expect(composition?.reportedComponentTotal).toBe(6);
    expect(composition?.segments.map(({ key, percent }) => ({ key, percent }))).toEqual([
      { key: "input", percent: 50 },
      { key: "output", percent: 50 },
    ]);
    expect(composition?.reasoning).toEqual({ value: 4, percentOfOutput: 100 });
  });

  it("does not invent a composition from a single or invalid component", () => {
    expect(tokenCompositionSegments({ inputTokens: 120 })).toBeUndefined();
    expect(
      tokenCompositionSegments({ inputTokens: -1, outputTokens: 20 }),
    ).toBeUndefined();
    expect(tokenCompositionSegments({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });

  it("keeps the rounded segments at exactly 100 percent", () => {
    const composition = tokenCompositionSegments({
      inputTokens: 1,
      outputTokens: 1,
      reasoningOutputTokens: 1,
    });

    expect(composition?.segments.reduce((total, segment) => total + segment.percent, 0)).toBe(100);
  });

  it("clamps an account percentage for presentation without inventing unknown data", () => {
    expect(clampMeterPercent(66)).toBe(66);
    expect(clampMeterPercent(-4)).toBe(0);
    expect(clampMeterPercent(104)).toBe(100);
    expect(clampMeterPercent(undefined)).toBeUndefined();
    expect(clampMeterPercent(Number.NaN)).toBeUndefined();
  });
});
