import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuotaWindows } from "./QuotaWindows";

describe("separate quota windows", () => {
  it("shows available short quota beside an exhausted weekly window", () => {
    const markup = renderToStaticMarkup(<QuotaWindows bucket={{
      limitId: "codex", remainingPercent: 68, windowDurationMins: 300,
      secondary: {remainingPercent: 0, windowDurationMins: 10080},
    }} />);
    expect(markup).toContain("68%");
    expect(markup).toContain("0%");
    expect(markup).toContain('data-exhausted="true"');
    expect(markup).toContain("5 小时");
    expect(markup).toContain("1 周");
  });

  it("keeps missing quota unknown and avoids a redundant single-window panel", () => {
    expect(renderToStaticMarkup(<QuotaWindows bucket={{limitId: "codex", remainingPercent: 68}} />)).toBe("");
    const markup = renderToStaticMarkup(<QuotaWindows bucket={{
      limitId: "codex", remainingPercent: 68, secondary: {windowDurationMins: 10080},
    }} />);
    expect(markup).toContain("—");
    expect(markup).not.toContain('data-exhausted="true"');
  });
});
