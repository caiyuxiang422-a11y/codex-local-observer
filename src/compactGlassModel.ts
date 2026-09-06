export const COMPACT_GLASS_MAX_DPR = 2;

/**
 * One stable identifier for the complete compact glass recipe.
 *
 * Floating and camera-safe compact views intentionally share this value. The
 * only supported variation is geometry: a detached surface is one capsule,
 * while a Mac with a physical camera housing renders two capsules around the
 * system-owned gap.
 */
export const COMPACT_GLASS_MATERIAL_RECIPE = "transparent-sdf-v1" as const;

export interface CompactGlassSurfaceContract {
  layout: "single" | "split";
  surfaceTarget: "host" | "sides";
  materialRecipe: typeof COMPACT_GLASS_MATERIAL_RECIPE;
}

export function compactGlassSurfaceContract(
  floating: boolean,
  hasHardwareNotch: boolean,
): CompactGlassSurfaceContract {
  const split = !floating && hasHardwareNotch;
  return {
    layout: split ? "split" : "single",
    surfaceTarget: split ? "sides" : "host",
    materialRecipe: COMPACT_GLASS_MATERIAL_RECIPE,
  };
}

export interface CompactGlassFrame {
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  pixelRatio: number;
  radius: number;
}

export interface CompactGlassCapability {
  webgl2Available: boolean;
  reducedTransparency: boolean;
  increasedContrast: boolean;
}

export interface CompactGlassRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CompactGlassShape {
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
  radius: number;
}

/**
 * The compact surface is permanently visible, so its backing store is capped
 * at 2x even on higher-density displays. This keeps the analytical SDF crisp
 * on Retina while avoiding a 3x/4x fragment workload for a difference that is
 * not visible at a 24–38pt surface height.
 */
export function compactGlassPixelRatio(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 1;
  return Math.min(COMPACT_GLASS_MAX_DPR, Math.max(1, value));
}

export function compactGlassFrame(
  width: number,
  height: number,
  devicePixelRatio: number | undefined,
): CompactGlassFrame | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }

  const pixelRatio = compactGlassPixelRatio(devicePixelRatio);
  const cssWidth = Math.max(1, width);
  const cssHeight = Math.max(1, height);
  // Leave a small optical gutter for the SDF's outside shadow. The radius is
  // expressed in CSS pixels and converted to device pixels by the renderer.
  const radius = Math.max(4, Math.min(20, (Math.min(cssWidth, cssHeight) - 2.5) / 2));

  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.round(cssWidth * pixelRatio)),
    pixelHeight: Math.max(1, Math.round(cssHeight * pixelRatio)),
    pixelRatio,
    radius,
  };
}

export function compactGlassOpticsAllowed(capability: CompactGlassCapability): boolean {
  return (
    capability.webgl2Available &&
    !capability.reducedTransparency &&
    !capability.increasedContrast
  );
}

/** Keep split rendering out of the macOS camera safe area unless both sides exist. */
export function compactGlassGeometryReady(
  layout: "single" | "split",
  shapeCount: number,
): boolean {
  return layout === "split" ? shapeCount === 2 : shapeCount >= 1;
}

/** Convert CSS-pixel DOM rectangles into WebGL's bottom-left backing pixels. */
export function compactGlassShapes(
  canvasBounds: CompactGlassRect,
  shapeBounds: CompactGlassRect[],
  devicePixelRatio: number | undefined,
): { frame: CompactGlassFrame; shapes: CompactGlassShape[] } | undefined {
  const frame = compactGlassFrame(
    canvasBounds.width,
    canvasBounds.height,
    devicePixelRatio,
  );
  if (!frame) return undefined;
  const scaleX = frame.pixelWidth / canvasBounds.width;
  const scaleY = frame.pixelHeight / canvasBounds.height;
  const shapes = shapeBounds.slice(0, 2).flatMap((bounds) => {
    if (
      !Number.isFinite(bounds.left) ||
      !Number.isFinite(bounds.top) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      return [];
    }
    const shapeFrame = compactGlassFrame(bounds.width, bounds.height, frame.pixelRatio);
    return [{
      centerX: (bounds.left - canvasBounds.left + bounds.width / 2) * scaleX,
      centerY: (
        canvasBounds.height -
        (bounds.top - canvasBounds.top + bounds.height / 2)
      ) * scaleY,
      halfWidth: (bounds.width * scaleX) / 2,
      halfHeight: (bounds.height * scaleY) / 2,
      radius: (shapeFrame?.radius ?? frame.radius) * Math.min(scaleX, scaleY),
    }];
  });
  return { frame, shapes };
}
