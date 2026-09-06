export const WIDGET_CROWN_PAYLOAD_EVENT = "widget-crown-payload";
export const WIDGET_CROWN_READY_EVENT = "widget-crown-ready";
export const WIDGET_CROWN_PAINTED_EVENT = "widget-crown-painted";
export const WIDGET_WINDOW_SHOWN_EVENT = "widget-window-shown";
export const WIDGET_WINDOW_HIDDEN_EVENT = "widget-window-hidden";
export const WIDGET_WINDOW_LABEL = "widget";
export const WIDGET_CROWN_WINDOW_LABEL = "widget-crown";

export type MediumCrownStatusTone = "idle" | "active" | "warning" | "error";

/**
 * Render-only state sent from the data-owning widget WebView to the companion
 * crown WebView.  Keeping this deliberately small prevents the always-front
 * strip from starting a second project/Usage/system-metrics polling loop.
 */
export interface WidgetCrownPayload {
  schemaVersion: 1;
  /** Presentation generation used to reject a late paint acknowledgement. */
  presentationId: number;
  visible: boolean;
  projectName: string;
  status: string;
  statusTone: MediumCrownStatusTone;
  remainingValue: string;
  remainingPercent?: number;
  surfaceWidth: number;
  surfaceHeight: number;
  headerHeight: number;
  cameraWidth: number;
  updatedAt: number;
}

export interface WidgetCrownReadyPayload {
  schemaVersion: 1;
  /** Stable for one companion WebView mount, including readiness heartbeats. */
  sessionId: string;
  mountedAt: number;
}

export interface WidgetCrownPaintedPayload {
  schemaVersion: 1;
  sessionId: string;
  presentationId: number;
  paintedAt: number;
}

function finiteDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function crownTone(value: unknown): MediumCrownStatusTone {
  return value === "active" || value === "warning" || value === "error"
    ? value
    : "idle";
}

function finiteGeneration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** Ignore malformed or future event payloads instead of painting stale data. */
export function normalizeWidgetCrownPayload(
  value: unknown,
): WidgetCrownPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WidgetCrownPayload>;
  if (candidate.schemaVersion !== 1) return undefined;
  if (candidate.visible && finiteGeneration(candidate.presentationId) === 0) {
    return undefined;
  }
  if (typeof candidate.visible !== "boolean") return undefined;
  if (typeof candidate.projectName !== "string") return undefined;
  if (typeof candidate.status !== "string") return undefined;
  if (typeof candidate.remainingValue !== "string") return undefined;

  const rawPercent = candidate.remainingPercent;
  const remainingPercent =
    typeof rawPercent === "number" && Number.isFinite(rawPercent)
      ? Math.max(0, Math.min(100, rawPercent))
      : undefined;

  return {
    schemaVersion: 1,
    presentationId: finiteGeneration(candidate.presentationId),
    visible: candidate.visible,
    projectName: candidate.projectName,
    status: candidate.status,
    statusTone: crownTone(candidate.statusTone),
    remainingValue: candidate.remainingValue,
    ...(remainingPercent === undefined ? {} : { remainingPercent }),
    surfaceWidth: finiteDimension(candidate.surfaceWidth, 560),
    surfaceHeight: finiteDimension(candidate.surfaceHeight, 224),
    headerHeight: finiteDimension(candidate.headerHeight, 32),
    cameraWidth: finiteDimension(candidate.cameraWidth, 185),
    updatedAt:
      typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : Date.now(),
  };
}

export function normalizeWidgetCrownPaintedPayload(
  value: unknown,
): WidgetCrownPaintedPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WidgetCrownPaintedPayload>;
  if (candidate.schemaVersion !== 1) return undefined;
  if (
    !validSessionId(candidate.sessionId) ||
    typeof candidate.presentationId !== "number" ||
    !Number.isFinite(candidate.presentationId) ||
    candidate.presentationId <= 0 ||
    typeof candidate.paintedAt !== "number" ||
    !Number.isFinite(candidate.paintedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    sessionId: candidate.sessionId,
    presentationId: Math.floor(candidate.presentationId),
    paintedAt: candidate.paintedAt,
  };
}
