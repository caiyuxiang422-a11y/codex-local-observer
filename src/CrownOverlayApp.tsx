import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  isDesktopRuntime,
  publishWidgetCrownPainted,
  publishWidgetCrownReady,
  subscribeToWidgetCrownPayload,
} from "./desktopApi";
import { MediumCrown } from "./MediumCrown";
import { MediumContourChrome } from "./MediumContourChrome";
import { mediumGlassContourPath } from "./mediumContourModel";
import {
  normalizeWidgetCrownPayload,
  type WidgetCrownPayload,
} from "./crownOverlayModel";
import "./WidgetApp.css";

const READY_HEARTBEAT_MS = 2_000;

function createCrownSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `crown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The companion crown is display-only. It never reads project, account or
 * machine APIs: the primary widget remains the sole owner of those adapters.
 */
export default function CrownOverlayApp() {
  const [payload, setPayload] = useState<WidgetCrownPayload>();
  const session = useRef({
    id: createCrownSessionId(),
    mountedAt: Date.now(),
  });

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    let readyTimer: number | undefined;

    const announceReady = () => {
      void publishWidgetCrownReady({
        schemaVersion: 1,
        sessionId: session.current.id,
        mountedAt: session.current.mountedAt,
      }).catch(() => undefined);
    };

    subscribeToWidgetCrownPayload((next) => {
      const normalized = normalizeWidgetCrownPayload(next);
      if (!active || !normalized) return;
      setPayload(normalized);
    })
      .then((dispose) => {
        if (!active) {
          dispose();
          return;
        }
        unlisten = dispose;
        announceReady();
        // A companion can finish loading before the primary WebView has
        // installed its listener. A sparse, render-only heartbeat closes that
        // race and lets a remounted primary WebView rediscover this strip;
        // no data adapter is touched here.
        readyTimer = window.setInterval(announceReady, READY_HEARTBEAT_MS);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
      if (readyTimer !== undefined) window.clearInterval(readyTimer);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime() || !payload?.visible) return;
    let firstFrame: number | undefined;
    let postFrameTask: number | undefined;
    const acknowledgeAfterPaintBoundary = () => {
      if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
      if (postFrameTask !== undefined) window.clearTimeout(postFrameTask);
      // A hidden/passive WKWebView may deliver one animation frame and then
      // throttle subsequent frames. Queue a macrotask from that frame instead
      // of depending on a second rAF; WebKit gets a paint opportunity between
      // the two phases and the native side still verifies final visibility.
      firstFrame = window.requestAnimationFrame(() => {
        postFrameTask = window.setTimeout(() => {
          void publishWidgetCrownPainted({
            schemaVersion: 1,
            sessionId: session.current.id,
            presentationId: payload.presentationId,
            paintedAt: Date.now(),
          }).catch(() => undefined);
        }, 0);
      });
    };
    acknowledgeAfterPaintBoundary();
    return () => {
      if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
      if (postFrameTask !== undefined) window.clearTimeout(postFrameTask);
    };
  }, [payload?.presentationId, payload?.visible]);

  const contour = useMemo(() => {
    if (!payload) return undefined;
    return mediumGlassContourPath({
      width: payload.surfaceWidth,
      height: payload.surfaceHeight,
      headerHeight: payload.headerHeight,
      cameraWidth: payload.cameraWidth,
      wrapsHardwareNotch: true,
    });
  }, [
    payload?.cameraWidth,
    payload?.headerHeight,
    payload?.surfaceHeight,
    payload?.surfaceWidth,
  ]);

  const style = payload
    ? ({
        "--widget-crown-surface-width": `${payload.surfaceWidth}px`,
        "--widget-medium-height": `${payload.surfaceHeight}px`,
        "--widget-surface-height": `${payload.headerHeight}px`,
        "--widget-camera-width": `${payload.cameraWidth}px`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      className="widget-crown-overlay"
      data-visible={payload?.visible ? "true" : "false"}
      style={style}
      aria-hidden="true"
    >
      {payload?.visible && contour && (
        <div
          className="widget-crown-overlay-contour widget-medium-contour"
          data-wraps-notch={contour.wrapsHardwareNotch}
          data-spectrum-edge="true"
        >
          <MediumContourChrome
            width={payload.surfaceWidth}
            height={payload.surfaceHeight}
            path={contour.path}
          />
          <MediumCrown
            projectName={payload.projectName}
            status={payload.status}
            statusTone={payload.statusTone}
            remainingValue={payload.remainingValue}
            remainingPercent={payload.remainingPercent}
            ariaHidden
          />
        </div>
      )}
    </div>
  );
}
