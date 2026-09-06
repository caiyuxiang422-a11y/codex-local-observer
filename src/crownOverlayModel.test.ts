import { describe, expect, it } from "vitest";
import {
  normalizeWidgetCrownPaintedPayload,
  normalizeWidgetCrownPayload,
} from "./crownOverlayModel";

describe("normalizeWidgetCrownPayload", () => {
  it("accepts and clamps a versioned render payload", () => {
    expect(normalizeWidgetCrownPayload({
      schemaVersion: 1,
      presentationId: 7.8,
      visible: true,
      projectName: "Observer",
      status: "运行中",
      statusTone: "active",
      remainingValue: "74%",
      remainingPercent: 112,
      surfaceWidth: 560,
      surfaceHeight: 224,
      headerHeight: 32,
      cameraWidth: 185,
      updatedAt: 123,
    })).toMatchObject({
      visible: true,
      remainingPercent: 100,
      statusTone: "active",
      presentationId: 7,
      surfaceWidth: 560,
      surfaceHeight: 224,
    });
  });

  it("accepts only a versioned paint acknowledgement", () => {
    expect(normalizeWidgetCrownPaintedPayload({
      schemaVersion: 1,
      sessionId: "crown-session-a",
      presentationId: 9.9,
      paintedAt: 456,
    })).toEqual({
      schemaVersion: 1,
      sessionId: "crown-session-a",
      presentationId: 9,
      paintedAt: 456,
    });
    expect(normalizeWidgetCrownPaintedPayload({
      schemaVersion: 1,
      sessionId: "crown-session-a",
      presentationId: -1,
      paintedAt: 456,
    })).toBeUndefined();
    expect(normalizeWidgetCrownPaintedPayload({
      schemaVersion: 1,
      sessionId: "",
      presentationId: 9,
      paintedAt: 456,
    })).toBeUndefined();
    expect(normalizeWidgetCrownPaintedPayload({ schemaVersion: 2 })).toBeUndefined();
  });

  it("supplies the complete medium contour height for an older payload", () => {
    expect(normalizeWidgetCrownPayload({
      schemaVersion: 1,
      presentationId: 3,
      visible: true,
      projectName: "Observer",
      status: "空闲",
      statusTone: "idle",
      remainingValue: "未返回",
      surfaceWidth: 560,
      headerHeight: 32,
      cameraWidth: 185,
      updatedAt: 123,
    })?.surfaceHeight).toBe(224);
  });

  it("rejects a visible crown without a real presentation generation", () => {
    expect(normalizeWidgetCrownPayload({
      schemaVersion: 1,
      visible: true,
      projectName: "Observer",
      status: "空闲",
      remainingValue: "未返回",
    })).toBeUndefined();
  });

  it("rejects malformed and future payloads", () => {
    expect(normalizeWidgetCrownPayload(null)).toBeUndefined();
    expect(normalizeWidgetCrownPayload({ schemaVersion: 2 })).toBeUndefined();
    expect(normalizeWidgetCrownPayload({
      schemaVersion: 1,
      visible: "yes",
      projectName: "Observer",
      status: "空闲",
      remainingValue: "未返回",
    })).toBeUndefined();
  });
});
