import { describe, expect, it } from "vitest";
import { mediumGlassContourPath } from "./mediumContourModel";

describe("medium glass contour", () => {
  it("wraps a measurable camera gap with one continuous path", () => {
    const contour = mediumGlassContourPath({
      width: 560,
      height: 224,
      headerHeight: 32,
      cameraWidth: 185,
      wrapsHardwareNotch: true,
    });

    expect(contour.wrapsHardwareNotch).toBe(true);
    expect(contour.gapLeft).toBeCloseTo(182.5);
    expect(contour.gapRight).toBeCloseTo(377.5);
    expect(contour.path).toContain("H 366.5");
    expect(contour.path).toContain("C ");
    expect(contour.path.endsWith("Z")).toBe(true);
    expect(contour.path).not.toMatch(/NaN|Infinity/);
  });

  it("uses a full rounded surface for a floating window", () => {
    const contour = mediumGlassContourPath({
      width: 560,
      height: 224,
      headerHeight: 32,
      cameraWidth: 185,
      wrapsHardwareNotch: false,
    });

    expect(contour.wrapsHardwareNotch).toBe(false);
    expect(contour.gapLeft).toBeUndefined();
    expect(contour.path).not.toContain("182.5");
    expect(contour.path).toContain("M 28 0");
    expect(contour.path).toContain("A 28 28 0 0 1 560 28");
    expect(contour.path.endsWith("Z")).toBe(true);
  });

  it("degrades malformed or impossible geometry to a safe full surface", () => {
    const contour = mediumGlassContourPath({
      width: Number.NaN,
      height: -1,
      headerHeight: Number.POSITIVE_INFINITY,
      cameraWidth: 540,
      wrapsHardwareNotch: true,
    });

    expect(contour.wrapsHardwareNotch).toBe(false);
    expect(contour.path).not.toMatch(/NaN|Infinity/);
  });
});
