import { describe, expect, it } from "vitest";

import { safetyStatus } from "./safety";
import { SUMMARY } from "./testData";

const ok = { matchesRecorded: true, checked: 17, differences: [] };

describe("safetyStatus", () => {
  it("is SAFE only with zero violations, collisions and emergency brakings", () => {
    expect(safetyStatus(SUMMARY, ok)).toMatchObject({ level: "safe", headline: "SAFE" });
  });

  it("never claims safe when data is missing", () => {
    expect(safetyStatus(null, null).level).toBe("unknown");
    expect(safetyStatus({ ...SUMMARY, violations: null }, ok).level).toBe("unknown");
    expect(safetyStatus({ ...SUMMARY, collisions: null }, ok).level).toBe("unknown");
    expect(safetyStatus(null, null).headline).toBe("Not recorded");
  });

  it("is a VIOLATION when the independent monitor counted one", () => {
    const status = safetyStatus({ ...SUMMARY, violations: 2 }, ok);
    expect(status.level).toBe("violation");
    expect(status.reasons[0]).toMatch(/2 signal-safety violations/);
  });

  it("warns about collisions of any vehicles and says whether the ambulance was involved", () => {
    const unclassified = safetyStatus({ ...SUMMARY, collisions: 3 }, ok);
    expect(unclassified.level).toBe("warning");
    expect(unclassified.reasons.join(" ")).toMatch(/not classified/);
    const background = safetyStatus({ ...SUMMARY, collisions: 3, ambulanceCollisions: 0 }, ok);
    expect(background.level).toBe("warning");
    expect(background.reasons.join(" ")).toMatch(/none involved the ambulance/);
    const ambulance = safetyStatus({ ...SUMMARY, collisions: 2, ambulanceCollisions: 2 }, ok);
    expect(ambulance.level).toBe("violation");
  });

  it("warns about emergency brakings, teleports and a playback that differs from the result", () => {
    expect(safetyStatus({ ...SUMMARY, emergencyBrakings: 1 }, ok).level).toBe("warning");
    expect(safetyStatus({ ...SUMMARY, teleports: 1 }, ok).level).toBe("warning");
    const differs = safetyStatus(SUMMARY, { matchesRecorded: false, checked: 17, differences: ["x"] });
    expect(differs.level).toBe("warning");
    expect(differs.reasons.join(" ")).toMatch(/differs/);
  });

  it("keeps a violation a violation when there are also warnings", () => {
    const status = safetyStatus({ ...SUMMARY, violations: 1, emergencyBrakings: 2 }, ok);
    expect(status.level).toBe("violation");
    expect(status.reasons).toHaveLength(2);
  });
});
