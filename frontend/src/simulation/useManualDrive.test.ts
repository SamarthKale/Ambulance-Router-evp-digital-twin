import { describe, expect, it } from "vitest";

import { keyAction } from "./useManualDrive";

describe("keyAction", () => {
  it("maps physical keys (layout independent) to driving intent", () => {
    expect(keyAction("KeyW")).toEqual({ kind: "throttle" });
    expect(keyAction("KeyS")).toEqual({ kind: "brake" });
    expect(keyAction("KeyA")).toEqual({ kind: "turn", direction: "left" });
    expect(keyAction("KeyD")).toEqual({ kind: "turn", direction: "right" });
    expect(keyAction("KeyQ")).toEqual({ kind: "lane", direction: "left" });
    expect(keyAction("KeyE")).toEqual({ kind: "lane", direction: "right" });
  });

  it("ignores everything else", () => {
    expect(keyAction("KeyF")).toBeNull();
    expect(keyAction("w")).toBeNull(); // e.key values are not codes
    expect(keyAction("ArrowUp")).toBeNull();
  });
});
