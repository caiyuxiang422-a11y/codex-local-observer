import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompactGlassChrome } from "./CompactGlassChrome";

function count(markup: string, value: string): number {
  return markup.split(value).length - 1;
}

describe("CompactGlassChrome", () => {
  it("uses the same frost and spectrum primitives for both placements", () => {
    const floating = renderToStaticMarkup(<CompactGlassChrome layout="single" />);
    const cameraSafe = renderToStaticMarkup(<CompactGlassChrome layout="split" />);

    expect(floating).toContain('data-compact-glass-chrome="shared-v1"');
    expect(cameraSafe).toContain('data-compact-glass-chrome="shared-v1"');
    expect(count(floating, "widget-compact-spectrum-frost")).toBe(1);
    expect(count(floating, "widget-compact-spectrum-frame")).toBe(1);
    expect(count(floating, "widget-compact-spectrum-flow")).toBe(1);
    expect(count(cameraSafe, "widget-compact-spectrum-frost")).toBe(2);
    expect(count(cameraSafe, "widget-compact-spectrum-frame")).toBe(2);
    expect(count(cameraSafe, "widget-compact-spectrum-flow")).toBe(2);
    expect(cameraSafe).not.toContain("<svg");
  });

  it("changes only the number and position names of exposed glass shapes", () => {
    const floating = renderToStaticMarkup(<CompactGlassChrome layout="single" />);
    const cameraSafe = renderToStaticMarkup(<CompactGlassChrome layout="split" />);

    expect(count(floating, 'data-compact-glass-shape="')).toBe(2);
    expect(count(cameraSafe, 'data-compact-glass-shape="')).toBe(4);
    expect(floating).toContain('data-compact-glass-shape="single"');
    expect(cameraSafe).toContain('data-compact-glass-shape="left"');
    expect(cameraSafe).toContain('data-compact-glass-shape="right"');
  });
});
