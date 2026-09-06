import { describe, expect, it } from "vitest";
import {
  browserAdvancedCapabilities,
  browserWorkspaceSnapshot,
  capabilityStatusLabel,
  capabilityTone,
} from "./advancedModel";

describe("advanced capability model", () => {
  it("keeps browser preview honest", () => {
    const snapshot = browserAdvancedCapabilities();
    expect(snapshot.source).toBe("browser.preview");
    expect(snapshot.capabilities).toHaveLength(6);
    expect(snapshot.capabilities.every((item) => item.status === "unavailable")).toBe(true);
  });

  it("maps statuses to readable labels and tones", () => {
    expect(capabilityStatusLabel("experimental")).toBe("实验性");
    expect(capabilityStatusLabel("future-value")).toBe("未知状态");
    expect(capabilityTone("available")).toBe("success");
    expect(capabilityTone("notVerified")).toBe("neutral");
  });

  it("does not fabricate browser workspaces", () => {
    const snapshot = browserWorkspaceSnapshot();
    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.confidence).toBe("none");
  });
});

