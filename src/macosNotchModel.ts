/**
 * Geometry reported by the macOS AppKit bridge.
 *
 * Values are AppKit logical points (not Retina pixels).  The model is kept
 * separate from the widget data model so a screen-layout failure cannot be
 * mistaken for a missing Codex metric.
 */
export interface MacNotchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Native AppKit pointer sample used by the top-edge proximity fallback. */
export interface MacPointerProximity {
  schemaVersion: 1;
  source: string;
  supported: boolean;
  pointerX: number;
  pointerY: number;
  margin: number;
  windowVisible: boolean;
  nearWindow: boolean;
  screenName?: string;
  windowFrame?: MacNotchRect;
  limitation?: string;
}

/**
 * During a close morph the native frame is intentionally still the expanded
 * size so CSS can animate without being clipped. Hit-testing that whole frame
 * would make a pointer resting over the old content cancel the close. This
 * helper narrows the intent region to the compact top-centred anchor, using
 * AppKit's global bottom-left logical-point coordinates.
 */
export function isPointerNearCompactAnchor(
  sample: Pick<MacPointerProximity, "pointerX" | "pointerY" | "windowFrame">,
  compactWidth: number,
  compactHeight: number,
  margin: number,
): boolean {
  const frame = sample.windowFrame;
  if (
    !frame ||
    !Number.isFinite(frame.x) ||
    !Number.isFinite(frame.y) ||
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    !Number.isFinite(compactWidth) ||
    !Number.isFinite(compactHeight) ||
    compactWidth <= 0 ||
    compactHeight <= 0 ||
    !Number.isFinite(sample.pointerX) ||
    !Number.isFinite(sample.pointerY)
  ) {
    return false;
  }
  const safeWidth = Math.min(compactWidth, frame.width);
  const safeHeight = Math.min(compactHeight, frame.height);
  const safeMargin = Number.isFinite(margin) ? Math.max(0, Math.min(512, margin)) : 0;
  const centerX = frame.x + frame.width / 2;
  const topY = frame.y + frame.height;
  const left = centerX - safeWidth / 2;
  const bottom = topY - safeHeight;
  return (
    sample.pointerX >= left - safeMargin &&
    sample.pointerX <= left + safeWidth + safeMargin &&
    sample.pointerY >= bottom - safeMargin &&
    sample.pointerY <= topY + safeMargin
  );
}

export interface MacNotchGeometry {
  schemaVersion: 1;
  source: string;
  updatedAt: number;
  supported: boolean;
  hostKind: string;
  screenName?: string;
  hasHardwareNotch: boolean;
  notchWidth: number;
  /** AppKit's top safe-area height used for the closed surface; not a writable hardware dimension. */
  notchHeight: number;
  /** Menu-bar reservation, retained for diagnostics; not used as notch height. */
  menuBarHeight: number;
  /** Recommended logical size for the compact host, including side chips. */
  closedWidth: number;
  closedHeight: number;
  safeAreaTop: number;
  safeAreaLeft: number;
  safeAreaBottom: number;
  safeAreaRight: number;
  auxiliaryTopLeftWidth: number;
  auxiliaryTopRightWidth: number;
  backingScaleFactor: number;
  screenFrame: MacNotchRect;
  visibleFrame: MacNotchRect;
  windowFrame?: MacNotchRect;
  /** Optional native read-back diagnostics; absent on fallback runtimes. */
  windowLevel?: number;
  windowStyleMask?: number;
  windowCollectionBehavior?: number;
  windowIsOpaque?: boolean;
  windowHasShadow?: boolean;
  windowIsMovable?: boolean;
  windowIsKey?: boolean;
  /** Native NSView alpha; compact hardware mode keeps side-chip pixels visible. */
  webviewAlphaValue?: number;
  windowIgnoresMouseEvents?: boolean;
  windowAcceptsMouseMovedEvents?: boolean;
  /** True only after native visibility, current-session paint and body handoff all succeed. */
  crownCompanionVisible?: boolean;
  limitation?: string;
}

export const browserMacNotchGeometry: MacNotchGeometry = {
  schemaVersion: 1,
  source: "browser.preview",
  updatedAt: 0,
  supported: false,
  hostKind: "browser",
  hasHardwareNotch: false,
  notchWidth: 0,
  notchHeight: 0,
  menuBarHeight: 0,
  closedWidth: 220,
  closedHeight: 38,
  safeAreaTop: 0,
  safeAreaLeft: 0,
  safeAreaBottom: 0,
  safeAreaRight: 0,
  auxiliaryTopLeftWidth: 0,
  auxiliaryTopRightWidth: 0,
  backingScaleFactor: 1,
  screenFrame: { x: 0, y: 0, width: 0, height: 0 },
  visibleFrame: { x: 0, y: 0, width: 0, height: 0 },
  limitation: "浏览器预览没有 AppKit 屏幕安全区。",
};

export function normalizeMacNotchGeometry(
  geometry: MacNotchGeometry,
): MacNotchGeometry {
  const finite = (value: number, fallback = 0) =>
    Number.isFinite(value) ? Math.max(0, value) : fallback;
  const screenWidth = finite(geometry.screenFrame.width);
  const screenHeight = finite(geometry.screenFrame.height);
  const notchWidth = finite(geometry.notchWidth);
  const safeAreaTop = finite(geometry.safeAreaTop);
  // Keep the normal usability floors, but never let malformed/native values
  // make the compact host wider or taller than the display that owns it. A
  // tiny virtual display therefore degrades to a smaller, ellipsized chip
  // instead of being positioned partly off-screen.
  const minClosedWidth = screenWidth > 0 ? Math.min(120, screenWidth) : 120;
  const minClosedHeight = screenHeight > 0 ? Math.min(24, screenHeight) : 24;
  const closedWidth = Math.min(
    screenWidth > 0 ? screenWidth : Number.POSITIVE_INFINITY,
    Math.max(minClosedWidth, finite(geometry.closedWidth, 220)),
  );
  const closedHeight = Math.min(
    screenHeight > 0 ? screenHeight : Number.POSITIVE_INFINITY,
    Math.max(minClosedHeight, finite(geometry.closedHeight, 38)),
  );
  const webviewAlphaValue =
    geometry.webviewAlphaValue === undefined
      ? undefined
      : Math.min(1, finite(geometry.webviewAlphaValue));
  return {
    ...geometry,
    schemaVersion: 1,
    updatedAt: Number.isFinite(geometry.updatedAt) ? geometry.updatedAt : Date.now(),
    supported: Boolean(geometry.supported),
    // Treat the flag as a claim from the IPC boundary, not as proof by
    // itself.  A stale/partial response with `hasHardwareNotch=true` but no
    // measurable gap must use the ordinary fallback layout instead of
    // creating a three-column grid with a zero-width camera track.
    hasHardwareNotch:
      Boolean(geometry.hasHardwareNotch) &&
      notchWidth > 1 &&
      screenWidth > notchWidth + 1 &&
      safeAreaTop > 0,
    notchWidth,
    notchHeight: finite(geometry.notchHeight),
    menuBarHeight: finite(geometry.menuBarHeight),
    closedWidth,
    closedHeight,
    safeAreaTop,
    safeAreaLeft: finite(geometry.safeAreaLeft),
    safeAreaBottom: finite(geometry.safeAreaBottom),
    safeAreaRight: finite(geometry.safeAreaRight),
    auxiliaryTopLeftWidth: finite(geometry.auxiliaryTopLeftWidth),
    auxiliaryTopRightWidth: finite(geometry.auxiliaryTopRightWidth),
    backingScaleFactor: finite(geometry.backingScaleFactor, 1) || 1,
    webviewAlphaValue,
    crownCompanionVisible:
      geometry.crownCompanionVisible === undefined
        ? undefined
        : Boolean(geometry.crownCompanionVisible),
  };
}
