import { describe, expect, it } from "vitest";
import {
  browserMacNotchGeometry,
  isPointerNearCompactAnchor,
  normalizeMacNotchGeometry,
} from "./macosNotchModel";

describe("macOS notch geometry model", () => {
  it("keeps the browser preview explicitly unsupported", () => {
    expect(browserMacNotchGeometry.supported).toBe(false);
    expect(browserMacNotchGeometry.hasHardwareNotch).toBe(false);
    expect(browserMacNotchGeometry.notchWidth).toBe(0);
    expect(browserMacNotchGeometry.menuBarHeight).toBe(0);
  });

  it("clamps invalid native sizes without inventing a hardware notch", () => {
    const normalized = normalizeMacNotchGeometry({
      ...browserMacNotchGeometry,
      supported: true,
      closedWidth: Number.NaN,
      closedHeight: -10,
      menuBarHeight: Number.POSITIVE_INFINITY,
      backingScaleFactor: 0,
    });

    expect(normalized.closedWidth).toBe(220);
    expect(normalized.closedHeight).toBe(24);
    expect(normalized.menuBarHeight).toBe(0);
    expect(normalized.backingScaleFactor).toBe(1);
    expect(normalized.hasHardwareNotch).toBe(false);
  });

  it("preserves only an explicit native companion acknowledgement", () => {
    expect(normalizeMacNotchGeometry({
      ...browserMacNotchGeometry,
      crownCompanionVisible: true,
    }).crownCompanionVisible).toBe(true);
    expect(normalizeMacNotchGeometry({
      ...browserMacNotchGeometry,
      crownCompanionVisible: false,
    }).crownCompanionVisible).toBe(false);
    expect(normalizeMacNotchGeometry(browserMacNotchGeometry).crownCompanionVisible)
      .toBeUndefined();
  });

  it("opens a compact hardware surface across the full top information band", () => {
    const compactFrame = { x: 547, y: 950, width: 417, height: 32 };
    expect(
      isPointerNearCompactAnchor(
        { pointerX: 548, pointerY: 970, windowFrame: compactFrame },
        417,
        32,
        0,
      ),
    ).toBe(true);
    expect(
      isPointerNearCompactAnchor(
        { pointerX: 963, pointerY: 970, windowFrame: compactFrame },
        417,
        32,
        0,
      ),
    ).toBe(true);
    expect(
      isPointerNearCompactAnchor(
        { pointerX: 546.9, pointerY: 970, windowFrame: compactFrame },
        417,
        32,
        0,
      ),
    ).toBe(false);
    expect(
      isPointerNearCompactAnchor(
        { pointerX: 755, pointerY: 949.9, windowFrame: compactFrame },
        417,
        32,
        0,
      ),
    ).toBe(false);
  });

  it("opens from medium shoulders but not below the real camera-safe height", () => {
    const mediumFrame = { x: 476, y: 758, width: 560, height: 224 };
    const nearTopInformationBand = (pointerX: number, pointerY: number) =>
      isPointerNearCompactAnchor(
        { pointerX, pointerY, windowFrame: mediumFrame },
        560,
        32,
        0,
      );

    expect(nearTopInformationBand(477, 970)).toBe(true);
    expect(nearTopInformationBand(1_035, 970)).toBe(true);
    expect(nearTopInformationBand(475.9, 970)).toBe(false);
    expect(nearTopInformationBand(1_036.1, 970)).toBe(false);
    expect(nearTopInformationBand(600, 949.9)).toBe(false);
    expect(nearTopInformationBand(755, 900)).toBe(false);
  });

  it("keeps normalized compact geometry inside a narrow display", () => {
    const normalized = normalizeMacNotchGeometry({
      ...browserMacNotchGeometry,
      supported: true,
      closedWidth: 220,
      closedHeight: 38,
      screenFrame: { x: 0, y: 0, width: 96, height: 180 },
    });

    expect(normalized.closedWidth).toBe(96);
    expect(normalized.closedHeight).toBe(38);
  });

  it("does not trust a hardware-notch flag without a measurable gap", () => {
    const normalized = normalizeMacNotchGeometry({
      ...browserMacNotchGeometry,
      supported: true,
      hasHardwareNotch: true,
      notchWidth: 0,
      safeAreaTop: 32,
      screenFrame: { x: 0, y: 0, width: 1512, height: 982 },
    });

    expect(normalized.hasHardwareNotch).toBe(false);
    expect(normalized.notchWidth).toBe(0);
  });
});
