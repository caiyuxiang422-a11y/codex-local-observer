export interface MediumGlassContourInput {
  width: number;
  height: number;
  headerHeight: number;
  cameraWidth: number;
  wrapsHardwareNotch: boolean;
}

export interface MediumGlassContour {
  path: string;
  wrapsHardwareNotch: boolean;
  gapLeft?: number;
  gapRight?: number;
}

const OUTER_INSET = 8;
const TOP_INSET = 3;
const BOTTOM_INSET = 8;
const NOTCH_CLEARANCE = 5;
const CIRCLE_KAPPA = 0.5522847498307936;

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function coordinate(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function roundedRectPath(
  left: number,
  top: number,
  right: number,
  bottom: number,
  requestedRadius: number,
): string {
  const radius = clamp(
    requestedRadius,
    0,
    Math.max(0, Math.min((right - left) / 2, (bottom - top) / 2)),
  );
  const x0 = coordinate(left);
  const x1 = coordinate(left + radius);
  const x2 = coordinate(right - radius);
  const x3 = coordinate(right);
  const y0 = coordinate(top);
  const y1 = coordinate(top + radius);
  const y2 = coordinate(bottom - radius);
  const y3 = coordinate(bottom);
  return [
    `M ${x1} ${y0}`,
    `H ${x2}`,
    `A ${coordinate(radius)} ${coordinate(radius)} 0 0 1 ${x3} ${y1}`,
    `V ${y2}`,
    `A ${coordinate(radius)} ${coordinate(radius)} 0 0 1 ${x2} ${y3}`,
    `H ${x1}`,
    `A ${coordinate(radius)} ${coordinate(radius)} 0 0 1 ${x0} ${y2}`,
    `V ${y1}`,
    `A ${coordinate(radius)} ${coordinate(radius)} 0 0 1 ${x1} ${y0}`,
    "Z",
  ].join(" ");
}

/**
 * Produce one continuous glass outline for the medium page.
 *
 * A notched display has one open camera cut-out along the top edge; the path
 * joins both shoulders immediately below the measured safe-area band. A
 * floating window or a display without a hardware notch receives one ordinary
 * rounded rectangle instead of a fake black camera gap.
 */
export function mediumGlassContourPath(
  input: MediumGlassContourInput,
): MediumGlassContour {
  const width = finitePositive(input.width, 560);
  const height = finitePositive(input.height, 224);
  const left = Math.min(OUTER_INSET, width / 4);
  const right = Math.max(left + 1, width - left);
  const top = Math.min(TOP_INSET, height / 4);
  const bottom = Math.max(top + 1, height - Math.min(BOTTOM_INSET, height / 4));
  const fallback = (): MediumGlassContour => ({
    // Floating/no-notch AppKit glass uses the complete WebView bounds. Match
    // that exact silhouette so an uncovered native-glass ring cannot read as
    // a second background colour around the SVG material.
    path: roundedRectPath(0, 0, width, height, 28),
    wrapsHardwareNotch: false,
  });

  const cameraWidth = Number.isFinite(input.cameraWidth)
    ? Math.max(0, input.cameraWidth)
    : 0;
  if (!input.wrapsHardwareNotch || cameraWidth <= 2) return fallback();

  const gapLeft = width / 2 - cameraWidth / 2 - NOTCH_CLEARANCE;
  const gapRight = width / 2 + cameraWidth / 2 + NOTCH_CLEARANCE;
  // Keep enough material for a readable shoulder and its two rounded turns.
  if (gapLeft - left < 28 || right - gapRight < 28) return fallback();

  const header = clamp(input.headerHeight, top + 10, bottom - 18);
  // These radii and cubic control points intentionally mirror AppKit's
  // `medium_contour_path`; the optical fill, native mask and spectrum edge
  // therefore describe one contour instead of three almost-matching ones.
  const leftShoulderWidth = Math.max(0, gapLeft - left);
  const rightShoulderWidth = Math.max(0, right - gapRight);
  const topBandHeight = Math.max(0, header - top);
  const topRadius = clamp(
    16,
    0,
    Math.min(leftShoulderWidth / 2, rightShoulderWidth / 2, topBandHeight),
  );
  const notchRadius = clamp(
    11,
    0,
    Math.min(
      leftShoulderWidth / 2,
      rightShoulderWidth / 2,
      (gapRight - gapLeft) / 2,
      topBandHeight / 2,
    ),
  );
  const bottomRadius = clamp(
    28,
    0,
    Math.min((right - left) / 2, bottom - header),
  );

  const xLeft = coordinate(left);
  const xLeftTopRadius = coordinate(left + topRadius);
  const xRightTopRadius = coordinate(right - topRadius);
  const xLeftBottomRadius = coordinate(left + bottomRadius);
  const xRightBottomRadius = coordinate(right - bottomRadius);
  const xRight = coordinate(right);
  const xGapLeftTop = coordinate(gapLeft - notchRadius);
  const xGapLeft = coordinate(gapLeft);
  const xGapLeftBottom = coordinate(gapLeft + notchRadius);
  const xGapRightBottom = coordinate(gapRight - notchRadius);
  const xGapRight = coordinate(gapRight);
  const xGapRightTop = coordinate(gapRight + notchRadius);
  const yTop = coordinate(top);
  const yTopRadius = coordinate(top + topRadius);
  const yBottomRadius = coordinate(bottom - bottomRadius);
  const yBottom = coordinate(bottom);
  const yNotchTopRadius = coordinate(top + notchRadius);
  const yNotchBottomRadius = coordinate(header - notchRadius);
  const yHeader = coordinate(header);
  const control = (value: number) => coordinate(value);

  return {
    wrapsHardwareNotch: true,
    gapLeft,
    gapRight,
    path: [
      `M ${xLeftTopRadius} ${yTop}`,
      `H ${xGapLeftTop}`,
      `C ${control(gapLeft - notchRadius + CIRCLE_KAPPA * notchRadius)} ${yTop} ${xGapLeft} ${control(top + notchRadius - CIRCLE_KAPPA * notchRadius)} ${xGapLeft} ${yNotchTopRadius}`,
      `V ${yNotchBottomRadius}`,
      `C ${xGapLeft} ${control(header - notchRadius + CIRCLE_KAPPA * notchRadius)} ${control(gapLeft + notchRadius - CIRCLE_KAPPA * notchRadius)} ${yHeader} ${xGapLeftBottom} ${yHeader}`,
      `H ${xGapRightBottom}`,
      `C ${control(gapRight - notchRadius + CIRCLE_KAPPA * notchRadius)} ${yHeader} ${xGapRight} ${control(header - notchRadius + CIRCLE_KAPPA * notchRadius)} ${xGapRight} ${yNotchBottomRadius}`,
      `V ${yNotchTopRadius}`,
      `C ${xGapRight} ${control(top + notchRadius - CIRCLE_KAPPA * notchRadius)} ${control(gapRight + notchRadius - CIRCLE_KAPPA * notchRadius)} ${yTop} ${xGapRightTop} ${yTop}`,
      `H ${xRightTopRadius}`,
      `C ${control(right - topRadius + CIRCLE_KAPPA * topRadius)} ${yTop} ${xRight} ${control(top + topRadius - CIRCLE_KAPPA * topRadius)} ${xRight} ${yTopRadius}`,
      `V ${yBottomRadius}`,
      `C ${xRight} ${control(bottom - bottomRadius + CIRCLE_KAPPA * bottomRadius)} ${control(right - bottomRadius + CIRCLE_KAPPA * bottomRadius)} ${yBottom} ${xRightBottomRadius} ${yBottom}`,
      `H ${xLeftBottomRadius}`,
      `C ${control(left + bottomRadius - CIRCLE_KAPPA * bottomRadius)} ${yBottom} ${xLeft} ${control(bottom - bottomRadius + CIRCLE_KAPPA * bottomRadius)} ${xLeft} ${yBottomRadius}`,
      `V ${yTopRadius}`,
      `C ${xLeft} ${control(top + topRadius - CIRCLE_KAPPA * topRadius)} ${control(left + topRadius - CIRCLE_KAPPA * topRadius)} ${yTop} ${xLeftTopRadius} ${yTop}`,
      "Z",
    ].join(" "),
  };
}
