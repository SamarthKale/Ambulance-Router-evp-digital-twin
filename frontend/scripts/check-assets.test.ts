import path from "node:path";

import { describe, expect, it } from "vitest";

import { MANIFEST } from "../src/assets/manifest";
import { checkFiles, checkWorkbook, fittedSize, readWorkbook, type WorkbookRow } from "./check-assets";
import { resolveModelFile } from "./deliveredModels";

describe("manifest vs the workbook (source of truth for ownership and priority)", () => {
  const rows = readWorkbook();

  it("reads all 33 asset rows", () => {
    expect(rows).toHaveLength(33);
    expect(rows[0]).toEqual({ asset: "Ambulance", priority: "P1", owner: "Member 1" });
  });

  it("covers every row with the workbook's owner and priority", () => {
    expect(checkWorkbook(rows)).toEqual([]);
  });

  it("catches a reassigned asset", () => {
    const tampered: WorkbookRow[] = rows.map((r) => (r.asset === "Hospital" ? { ...r, owner: "Member 2" } : r));
    expect(checkWorkbook(tampered)).toEqual([
      { level: "error", key: "hospital", message: "owner Member 4, workbook says Member 2" },
    ]);
  });
});

describe("delivered files", () => {
  it("exist, are real models (not LFS pointers) and have attribution rows", () => {
    expect(checkFiles()).toEqual([]);
  });

  it("fits sizes the way the renderer does (rotation first, then scale)", () => {
    // fire truck: modelled along X (1 x 0.48 x 0.38), turned a quarter, fitted to 8 m long
    const size = fittedSize(MANIFEST.fire_truck, [-0.529, -0.271, -0.189], [0.471, 0.209, 0.191]);
    expect(size[2]).toBeCloseTo(8);
    expect(size[0]).toBeCloseTo(3.04, 2);
  });
});

describe("model server", () => {
  const root = path.resolve("/repo/3d_models");

  it("maps URL paths with spaces to files below 3d_models", () => {
    expect(resolveModelFile(root, "/member-4/Bus%20by%20Poly%20by%20Google%20-%204CPpvEmrMoF.glb")).toBe(
      path.join(root, "member-4", "Bus by Poly by Google - 4CPpvEmrMoF.glb"),
    );
  });

  it("never serves anything outside the folder or of another type", () => {
    expect(resolveModelFile(root, "/../backend/main.py")).toBeNull();
    expect(resolveModelFile(root, "/..%2F..%2Fsecret.glb")).toBe(path.join(root, "secret.glb")); // clamped inside
    expect(resolveModelFile(root, "/EmergencyFlow_3D_Asset_Checklist_Assigned.xlsx")).toBeNull();
    expect(resolveModelFile(root, "/%E0%A4%A")).toBeNull(); // malformed escape
  });
});
