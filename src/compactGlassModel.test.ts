import { describe, expect, it } from "vitest";
import {
  COMPACT_GLASS_MATERIAL_RECIPE,
  COMPACT_GLASS_MAX_DPR,
  compactGlassFrame,
  compactGlassGeometryReady,
  compactGlassOpticsAllowed,
  compactGlassPixelRatio,
  compactGlassShapes,
  compactGlassSurfaceContract,
} from "./compactGlassModel";

describe("compact glass rendering model", () => {
  it("uses one material recipe for floating and camera-safe compact surfaces", () => {
    const floating = compactGlassSurfaceContract(true, false);
    const hardwareNotch = compactGlassSurfaceContract(false, true);

    expect(floating.materialRecipe).toBe(COMPACT_GLASS_MATERIAL_RECIPE);
    expect(hardwareNotch.materialRecipe).toBe(floating.materialRecipe);
    expect(floating).toMatchObject({ layout: "single", surfaceTarget: "host" });
    expect(hardwareNotch).toMatchObject({ layout: "split", surfaceTarget: "sides" });
  });

  it("caps the always-visible backing store at Retina 2x", () => {
    expect(compactGlassPixelRatio(3)).toBe(COMPACT_GLASS_MAX_DPR);
    expect(compactGlassPixelRatio(0)).toBe(1);
    expect(compactGlassPixelRatio(Number.NaN)).toBe(1);
  });

  it("derives a bounded rounded SDF frame from the live element size", () => {
    expect(compactGlassFrame(220, 38, 2)).toEqual({
      cssWidth: 220,
      cssHeight: 38,
      pixelWidth: 440,
      pixelHeight: 76,
      pixelRatio: 2,
      radius: 17.75,
    });
    expect(compactGlassFrame(0, 38, 2)).toBeUndefined();
  });

  it("falls back for reduced transparency, high contrast, or missing WebGL2", () => {
    expect(
      compactGlassOpticsAllowed({
        webgl2Available: true,
        reducedTransparency: false,
        increasedContrast: false,
      }),
    ).toBe(true);
    expect(
      compactGlassOpticsAllowed({
        webgl2Available: true,
        reducedTransparency: true,
        increasedContrast: false,
      }),
    ).toBe(false);
    expect(
      compactGlassOpticsAllowed({
        webgl2Available: false,
        reducedTransparency: false,
        increasedContrast: false,
      }),
    ).toBe(false);
  });

  it("requires both camera-safe-area side shapes before split rendering", () => {
    expect(compactGlassGeometryReady("split", 2)).toBe(true);
    expect(compactGlassGeometryReady("split", 1)).toBe(false);
    expect(compactGlassGeometryReady("split", 0)).toBe(false);
    expect(compactGlassGeometryReady("single", 1)).toBe(true);
  });

  it("maps two DOM side chips into one bottom-left WebGL coordinate space", () => {
    const result = compactGlassShapes(
      { left: 100, top: 20, width: 417.25, height: 32.25 },
      [
        { left: 104, top: 23, width: 104, height: 26 },
        { left: 409.25, top: 23, width: 104, height: 26 },
      ],
      3,
    );
    expect(result?.frame.pixelRatio).toBe(2);
    expect(result?.shapes).toHaveLength(2);
    const [left, right] = result!.shapes;
    expect(left.centerX + left.halfWidth).toBeLessThan(
      right.centerX - right.halfWidth,
    );
    expect(left.centerY).toBeCloseTo(right.centerY, 6);
    expect(left.radius).toBeLessThanOrEqual(left.halfHeight);
  });
});
