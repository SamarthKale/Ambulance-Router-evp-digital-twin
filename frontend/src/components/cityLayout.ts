/**
 * City layout generated from the road network (pure, deterministic, unit-tested).
 *
 * Roads, junctions, markings and signal-head positions come from /api/network
 * (CLAUDE.md section 11). Buildings and street furniture fill the blocks between roads, seeded
 * so every screen and every reload shows the same city. All coordinates are Three.js world
 * metres (x east, z south). Sizes come from the manifest's placeholder sizes, which equal
 * the fitted model sizes, so the layout never waits for a model to load.
 */
import { MANIFEST, type AssetKey } from "../assets/manifest";
import { originFromBounds, sumoToWorld, type Origin } from "../simulation/coords";
import type { LaneMsg, NetworkMsg } from "../simulation/state";

export interface V2 {
  x: number;
  z: number;
}

/** Axis-aligned rectangle, x0 < x1 and z0 < z1. */
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Placement {
  x: number;
  y?: number;
  z: number;
  yaw: number; // rotation.y; a model's +Z then faces (sin yaw, cos yaw)
  scale?: number;
}

/** A flat rectangle on the ground: centre, unit direction u, extent along u and across. */
export interface Strip {
  x: number;
  z: number;
  ux: number;
  uz: number;
  length: number;
  width: number;
}

export interface SignalHead {
  junction: string;
  approach: string;
  links: number[];
  placement: Placement;
}

export type LotKind = "paved" | "park" | "residential" | "hospital";

export interface CityLayout {
  /** Ground around the map (a frame: inside the map, pavements and lots cover it). */
  ground: Rect[];
  /** The network's bounding box. */
  bounds: Rect;
  /** Pavement bands between the roads and the lots. */
  sidewalks: Rect[];
  lots: { rect: Rect; kind: LotKind }[];
  /** Park footpaths (flat). */
  paths: Strip[];
  /** Raised concrete median between the two directions of a road. */
  medians: Strip[];
  /** White paint: stop lines, lane dashes, edge lines. */
  paint: Strip[];
  /** Zebra crossing stripes. */
  zebras: Strip[];
  /** Every model copy, by asset key (drawn instanced). */
  props: Partial<Record<AssetKey, Placement[]>>;
  signalHeads: SignalHead[];
  hospital: Placement | null;
}

export const SIDEWALK_W = 4.0;
const SETBACK = 1.5;
const ROW_DEPTH = 26;
const TREE_SPACING = 30;
const LIGHT_SPACING = 48;
const CORNER_CLEAR = 9;
const DIVIDER_RUN = 11.5; // delivered divider segments at each junction mouth; generated median between
const SEED = 20261005;

// ---- small vector helpers --------------------------------------------------------------
const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, z: a.z + b.z });
const mul = (a: V2, k: number): V2 => ({ x: a.x * k, z: a.z * k });
const len = (a: V2): number => Math.hypot(a.x, a.z);
const unit = (a: V2): V2 => mul(a, 1 / (len(a) || 1));

/** rotation.y that turns a model's +Z towards direction d. */
export function yawFacing(d: V2): number {
  return Math.atan2(d.x, d.z);
}

/** rotation.y that turns a model's +X towards direction d. */
export function yawXFacing(d: V2): number {
  return Math.atan2(-d.z, d.x);
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly { item: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = random() * total;
  for (const i of items) {
    r -= i.weight;
    if (r <= 0) return i.item;
  }
  return items[items.length - 1]!.item;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x0 < b.x1 + margin && b.x0 < a.x1 + margin && a.z0 < b.z1 + margin && b.z0 < a.z1 + margin;
}

export function contains(r: Rect, p: V2): boolean {
  return p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;
}

/** Footprint of a model placed at p facing the axis-aligned direction n. */
function footprint(key: AssetKey, p: V2, n: V2): Rect {
  const [w, , l] = MANIFEST[key].placeholder.size;
  const alongX = Math.abs(n.x) > 0.5; // facing east/west: length runs along x
  const hx = (alongX ? l : w) / 2;
  const hz = (alongX ? w : l) / 2;
  return { x0: p.x - hx, z0: p.z - hz, x1: p.x + hx, z1: p.z + hz };
}

// ---- network geometry ------------------------------------------------------------------
interface Edge {
  id: string;
  lanes: LaneMsg[];
  start: V2; // lane 0 (curb lane) centre at the start and end, world
  end: V2;
  dir: V2;
  length: number;
  width: number; // all lanes of this direction
  curb: V2; // unit normal towards the curb side
  innerOffset: number; // lane-0 centre -> road centre line
}

function edgesOf(network: NetworkMsg, origin: Origin): Map<string, Edge> {
  const byEdge = new Map<string, LaneMsg[]>();
  for (const lane of network.lanes) {
    if (lane.edge.startsWith(":")) continue;
    byEdge.set(lane.edge, [...(byEdge.get(lane.edge) ?? []), lane]);
  }
  const edges = new Map<string, Edge>();
  for (const [id, lanes] of byEdge) {
    lanes.sort((a, b) => a.index - b.index);
    const shape = lanes[0]!.shape;
    if (shape.length < 2) continue;
    const [sx, , sz] = sumoToWorld(shape[0]![0], shape[0]![1], origin);
    const [ex, , ez] = sumoToWorld(shape[shape.length - 1]![0], shape[shape.length - 1]![1], origin);
    const start = { x: sx, z: sz };
    const end = { x: ex, z: ez };
    const dir = unit({ x: ex - sx, z: ez - sz });
    // left of travel in world (x east, z south) is (dz, -dx)
    const left = { x: dir.z, z: -dir.x };
    const curb = network.lefthand ? left : mul(left, -1);
    const width = lanes.reduce((s, l) => s + l.width, 0);
    edges.set(id, {
      id,
      lanes,
      start,
      end,
      dir,
      length: len({ x: ex - sx, z: ez - sz }),
      width,
      curb,
      innerOffset: width - lanes[0]!.width / 2,
    });
  }
  return edges;
}

function reverseId(id: string): string {
  const [a, b] = id.split("_");
  return `${b}_${a}`;
}

function junctionCenters(network: NetworkMsg, origin: Origin): Map<string, V2> {
  const centers = new Map<string, V2>();
  for (const j of network.junctions) {
    if (j.shape.length === 0) continue;
    const xs = j.shape.map((p) => p[0]);
    const ys = j.shape.map((p) => p[1]);
    const [x, , z] = sumoToWorld(
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
      origin,
    );
    centers.set(j.id, { x, z });
  }
  return centers;
}

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((v, i) => i === 0 || Math.abs(v - sorted[i - 1]!) > 1);
}

// ---- blocks ----------------------------------------------------------------------------
type Side = "west" | "east" | "north" | "south";
const NORMALS: Record<Side, V2> = {
  west: { x: -1, z: 0 },
  east: { x: 1, z: 0 },
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
};

interface Cell {
  index: number;
  sidewalk: Rect; // the block without the roads around it
  lot: Rect; // without the sidewalks
  roads: Record<Side, boolean>;
  kind: LotKind;
}

function lotEdge(lot: Rect, side: Side): number {
  return side === "west" ? lot.x0 : side === "east" ? lot.x1 : side === "north" ? lot.z0 : lot.z1;
}

/** Position on a block side: `t` along it (x for north/south, z for west/east), `inset` inwards. */
function onSide(rect: Rect, side: Side, t: number, inset: number): V2 {
  const n = NORMALS[side];
  const edge = lotEdge(rect, side);
  if (side === "north" || side === "south") return { x: t, z: edge - n.z * inset };
  return { x: edge - n.x * inset, z: t };
}

function span(rect: Rect, side: Side): [number, number] {
  return side === "north" || side === "south" ? [rect.x0, rect.x1] : [rect.z0, rect.z1];
}

function sideFacing(n: V2): Side {
  if (Math.abs(n.x) > Math.abs(n.z)) return n.x > 0 ? "east" : "west";
  return n.z > 0 ? "south" : "north";
}

// ---- layout ----------------------------------------------------------------------------
const GENERIC: { item: AssetKey; weight: number }[] = [
  { item: "building_01", weight: 0.22 },
  { item: "building_02", weight: 0.1 },
  { item: "building_03", weight: 0.13 },
  { item: "building_04", weight: 0.2 },
  { item: "building_05", weight: 0.35 },
];
const RESIDENTIAL: { item: AssetKey; weight: number }[] = [
  { item: "residential", weight: 0.6 },
  { item: "building_03", weight: 0.25 },
  { item: "building_05", weight: 0.15 },
];

export function buildCityLayout(network: NetworkMsg, seed = SEED): CityLayout {
  const origin = originFromBounds(network.bounds);
  const random = rng(seed);
  const edges = edgesOf(network, origin);
  const centers = junctionCenters(network, origin);
  const tlsIds = new Set(network.signals.map((s) => s.id));

  const [xmin, ymin, xmax, ymax] = network.bounds;
  const [bx0, , bz1] = sumoToWorld(xmin, ymin, origin);
  const [bx1, , bz0] = sumoToWorld(xmax, ymax, origin);
  const bounds: Rect = { x0: bx0, z0: bz0, x1: bx1, z1: bz1 };
  const margin = 3000; // ground to the horizon (fog hides its edge; the 2D map is wide)
  const ground: Rect = { x0: bx0 - margin, z0: bz0 - margin, x1: bx1 + margin, z1: bz1 + margin };

  const props: Partial<Record<AssetKey, Placement[]>> = {};
  const put = (key: AssetKey, p: Placement) => (props[key] ??= []).push(p);
  const reserved: Rect[] = [];
  const paint: Strip[] = [];
  const zebras: Strip[] = [];
  const medians: Strip[] = [];
  const paths: Strip[] = [];
  const signalHeads: SignalHead[] = [];

  // Road half width: one direction's lanes (both directions are equal in the grid).
  const roadHalf = Math.max(0, ...[...edges.values()].map((e) => e.width));

  // ---- grid cells between the signalised junction lines ----
  const tlsCenters = [...centers].filter(([id]) => tlsIds.has(id)).map(([, c]) => c);
  const xs = uniqueSorted(tlsCenters.map((c) => c.x));
  const zs = uniqueSorted(tlsCenters.map((c) => c.z));
  const xLines = [bounds.x0, ...xs, bounds.x1];
  const zLines = [bounds.z0, ...zs, bounds.z1];
  const cells: Cell[] = [];
  const smallBlocks: Rect[] = [];
  for (let i = 0; i + 1 < xLines.length; i++) {
    for (let j = 0; j + 1 < zLines.length; j++) {
      const roads = { west: i > 0, east: i + 2 < xLines.length, north: j > 0, south: j + 2 < zLines.length };
      const sidewalk = {
        x0: xLines[i]! + (roads.west ? roadHalf : 0),
        x1: xLines[i + 1]! - (roads.east ? roadHalf : 0),
        z0: zLines[j]! + (roads.north ? roadHalf : 0),
        z1: zLines[j + 1]! - (roads.south ? roadHalf : 0),
      };
      const lot = {
        x0: sidewalk.x0 + (roads.west ? SIDEWALK_W : 0),
        x1: sidewalk.x1 - (roads.east ? SIDEWALK_W : 0),
        z0: sidewalk.z0 + (roads.north ? SIDEWALK_W : 0),
        z1: sidewalk.z1 - (roads.south ? SIDEWALK_W : 0),
      };
      if (lot.x1 - lot.x0 < 20 || lot.z1 - lot.z0 < 20) {
        if (sidewalk.x1 > sidewalk.x0 && sidewalk.z1 > sidewalk.z0) smallBlocks.push(sidewalk); // paved over
        continue;
      }
      cells.push({ index: cells.length, sidewalk, lot, roads, kind: "paved" });
    }
  }
  const cellAt = (p: V2) => cells.find((c) => contains(c.sidewalk, p));

  /** The block beside an edge (on its curb side, or the far side), at a position along it. */
  const beside = (edge: Edge, pos: number, curbSide: boolean) => {
    const n = curbSide ? edge.curb : mul(edge.curb, -1);
    const at = add(edge.start, mul(edge.dir, pos));
    const probe = add(at, mul(n, edge.lanes[0]!.width / 2 + (curbSide ? 0 : edge.innerOffset * 2) + SIDEWALK_W + 2));
    const cell = cellAt(probe);
    if (!cell) return null;
    const side = sideFacing(mul(n, -1)); // the block side that faces this road
    const t = side === "north" || side === "south" ? at.x : at.z;
    return { cell, side, t, toRoad: mul(n, -1) };
  };

  // ---- specials (placed first; generic rows avoid them) ----
  let hospital: Placement | null = null;
  const hospitalEdge = edges.get(network.hospital.edge);
  if (hospitalEdge) {
    const spot = beside(hospitalEdge, network.hospital.pos, true);
    if (spot) {
      spot.cell.kind = "hospital";
      const [w, , l] = MANIFEST.hospital.placeholder.size;
      const forecourt = 14;
      const [lo, hi] = span(spot.cell.lot, spot.side);
      const boundEnd = spot.side === "north" || spot.side === "south" ? bounds.x1 : bounds.z1;
      const max = Math.abs(hi - boundEnd) < 1 ? hi + w / 2 - 2 : hi - w / 2 - 2; // may overhang the map edge
      const t = Math.min(Math.max(spot.t, lo + w / 2 + 2), max);
      const c = onSide(spot.cell.lot, spot.side, t, forecourt + l / 2);
      hospital = { x: c.x, z: c.z, yaw: yawFacing(spot.toRoad) };
      reserved.push(footprint("hospital", c, spot.toRoad));
      const court = onSide(spot.cell.lot, spot.side, t, forecourt / 2);
      reserved.push(footprint("hospital", court, spot.toRoad)); // the forecourt in front
      const along = spot.side === "north" || spot.side === "south" ? { x: 1, z: 0 } : { x: 0, z: 1 };
      const lot = (dt: number, inset: number) => onSide(spot.cell.lot, spot.side, t + dt, inset);
      const p = lot(-w / 2 + 4, 6);
      put("police_car", { x: p.x, z: p.z, yaw: yawFacing(along) });
      const bay = lot(4, 5); // the ambulance bay in front of the entrance
      put("street_tile", { x: bay.x, y: 0.01, z: bay.z, yaw: yawFacing(spot.toRoad) });
      for (let inset = 1.2; inset < forecourt; inset += 2) {
        const tile = lot(-6, inset); // a paved walkway to the door
        put("path_tile", { x: tile.x, y: 0.01, z: tile.z, yaw: yawFacing(spot.toRoad) });
      }
      for (const dt of [-8, 8]) {
        const s = lot(dt, 1.5);
        put("bench", { x: s.x, z: s.z, yaw: yawXFacing(spot.toRoad) });
      }
      const sw = spot.cell.sidewalk;
      for (const dt of [-w / 2 + 2, w / 2 - 2]) {
        const s = onSide(sw, spot.side, t + dt, 0.6);
        put("sign_no_parking", { x: s.x, z: s.z, yaw: yawFacing(spot.toRoad) });
      }
    }
  }

  const depotEdge = edges.get(network.depot.edge);
  if (depotEdge) {
    // Shops (the bazaar row) on the curb side of the depot road, petrol station across it.
    const shops = beside(depotEdge, depotEdge.length * 0.55, true);
    if (shops) {
      shops.cell.kind = "paved";
      const [, , l] = MANIFEST.shops.placeholder.size;
      const c = onSide(shops.cell.lot, shops.side, shops.t, 3 + l / 2);
      put("shops", { x: c.x, z: c.z, yaw: yawFacing(shops.toRoad) });
      reserved.push(footprint("shops", c, shops.toRoad));
      // an auto-rickshaw stand and parked scooters in front
      for (let k = 0; k < 3; k++) {
        const a = onSide(shops.cell.lot, shops.side, shops.t - 9 + k * 3.4, 1.6);
        put("auto_rickshaw", { x: a.x, z: a.z, yaw: yawFacing(shops.toRoad) + (k - 1) * 0.08 });
        const s = onSide(shops.cell.lot, shops.side, shops.t + 6 + k * 1.3, 1.1);
        put("scooter", { x: s.x, z: s.z, yaw: yawFacing(shops.toRoad) + 0.3 });
      }
    }
    const fuel = beside(depotEdge, depotEdge.length * 0.6, false);
    if (fuel) {
      const [w, , l] = MANIFEST.petrol_station.placeholder.size;
      const c = onSide(fuel.cell.lot, fuel.side, fuel.t, 9 + l / 2);
      put("petrol_station", { x: c.x, z: c.z, yaw: yawFacing(fuel.toRoad) });
      reserved.push(footprint("petrol_station", c, fuel.toRoad));
      const yard = onSide(fuel.cell.lot, fuel.side, fuel.t, 4.5);
      reserved.push(footprint("petrol_station", yard, fuel.toRoad));
      for (const dt of [-4, 4]) {
        const p = onSide(fuel.cell.lot, fuel.side, fuel.t + dt, 5);
        put("fuel_pump", { x: p.x, z: p.z, yaw: yawFacing(fuel.toRoad) });
      }
      const tr = onSide(fuel.cell.lot, fuel.side, fuel.t + w / 2 + 6, 6);
      const along = fuel.side === "north" || fuel.side === "south" ? { x: 1, z: 0 } : { x: 0, z: 1 };
      put("truck", { x: tr.x, z: tr.z, yaw: yawFacing(mul(along, -1)) });
      reserved.push(footprint("truck", tr, along));
      const stop = onSide(fuel.cell.lot, fuel.side, fuel.t - w / 2 - 1, 0.5);
      put("sign_stop", { x: stop.x, z: stop.z, yaw: yawFacing(mul(fuel.toRoad, -1)) });
    }
    // The emergency depot: a fire truck parked by the road where the ambulance starts.
    const depot = beside(depotEdge, Math.min(18, depotEdge.length / 3), true);
    if (depot) {
      const c = onSide(depot.cell.lot, depot.side, depot.t, 6);
      put("fire_truck", { x: c.x, z: c.z, yaw: yawFacing(depot.toRoad) });
      reserved.push(footprint("fire_truck", c, depot.toRoad));
      const apron = onSide(depot.cell.lot, depot.side, depot.t + 9, 4.5);
      put("street_tile", { x: apron.x, y: 0.01, z: apron.z, yaw: yawFacing(depot.toRoad) });
      reserved.push(footprint("street_tile", apron, depot.toRoad));
    }
    // A bus stop on the pavement of the next road straight on.
    const next = [...edges.values()].find(
      (e) => e.id.startsWith(`${depotEdge.id.split("_")[1]}_`) && e.dir.x * depotEdge.dir.x + e.dir.z * depotEdge.dir.z > 0.9,
    );
    const stop = next ? beside(next, next.length * 0.42, true) : null;
    if (stop) {
      const c = onSide(stop.cell.sidewalk, stop.side, stop.t, SIDEWALK_W / 2);
      put("bus_stop", { x: c.x, z: c.z, yaw: yawFacing(stop.toRoad) });
      reserved.push(footprint("bus_stop", c, stop.toRoad));
      const bin = onSide(stop.cell.sidewalk, stop.side, stop.t + 4.2, 3);
      put("trashcan", { x: bin.x, z: bin.z, yaw: 0 });
    }
  }

  // ---- lot kinds: one park at least, then residential / commercial ----
  const free = cells.filter((c) => c.kind === "paved" && !reserved.some((r) => rectsOverlap(r, c.lot)));
  if (free.length) {
    const park = free[Math.floor(random() * free.length)]!;
    park.kind = "park";
    for (const c of free) {
      if (c === park) continue;
      const r = random();
      c.kind = r < 0.15 ? "park" : r < 0.55 ? "residential" : "paved";
    }
  }

  // ---- building rows along every road side of every block ----
  for (const cell of cells) {
    if (cell.kind === "park") continue;
    const sides = (Object.keys(NORMALS) as Side[]).filter((s) => cell.roads[s]);
    for (const side of sides) {
      let [lo, hi] = span(cell.lot, side);
      if (side === "west" || side === "east") {
        if (cell.roads.north) lo += ROW_DEPTH;
        if (cell.roads.south) hi -= ROW_DEPTH;
      }
      const n = NORMALS[side];
      let t = lo + 2 + random() * 4;
      while (t < hi - 4) {
        const key = pick(random, cell.kind === "residential" ? RESIDENTIAL : GENERIC);
        const [w, , l] = MANIFEST[key].placeholder.size;
        if (t + w > hi - 2) {
          t += 3;
          continue;
        }
        const c = onSide(cell.lot, side, t + w / 2, SETBACK + l / 2);
        const rect = footprint(key, c, n);
        if (reserved.some((r) => rectsOverlap(r, rect, 2))) {
          t += 4;
          continue;
        }
        put(key, { x: c.x, z: c.z, yaw: yawFacing(n) });
        reserved.push(rect);
        t += w + 2 + random() * 5;
      }
    }
  }

  // ---- park interiors: footpaths, grass, trees, benches ----
  for (const cell of cells.filter((c) => c.kind === "park")) {
    const { lot } = cell;
    const cx = (lot.x0 + lot.x1) / 2;
    const cz = (lot.z0 + lot.z1) / 2;
    paths.push({ x: cx, z: cz, ux: 1, uz: 0, length: lot.x1 - lot.x0, width: 2.4 });
    paths.push({ x: cx, z: cz, ux: 0, uz: 1, length: lot.z1 - lot.z0, width: 2.4 });
    const area = (lot.x1 - lot.x0) * (lot.z1 - lot.z0);
    const trees = Math.round(area / 1400);
    for (let k = 0; k < trees; k++) {
      const p = { x: lot.x0 + 4 + random() * (lot.x1 - lot.x0 - 8), z: lot.z0 + 4 + random() * (lot.z1 - lot.z0 - 8) };
      if (Math.abs(p.x - cx) < 4 || Math.abs(p.z - cz) < 4) continue; // keep the paths clear
      put(random() < 0.55 ? "tree" : "tree_pine", { ...p, yaw: random() * Math.PI * 2, scale: 0.8 + random() * 0.45 });
    }
    // grass tufts along the paths, near where people (and the camera) look
    for (let k = 0; k < 10; k++) {
      const along = (random() - 0.5) * (lot.x1 - lot.x0 - 10);
      const side = random() < 0.5 ? -1 : 1;
      const p = k % 2 ? { x: cx + along, z: cz + side * 3.2 } : { x: cx + side * 3.2, z: cz + along };
      put("grass_patch", { ...p, yaw: random() * Math.PI * 2, scale: 0.7 + random() * 0.4 });
    }
    for (const [dx, dz, yaw] of [[6, 3, 0], [-6, -3, Math.PI], [3, -6, Math.PI / 2], [-3, 6, -Math.PI / 2]] as const) {
      put("bench", { x: cx + dx, z: cz + dz, yaw });
    }
  }

  // ---- street furniture along the pavements ----
  for (const cell of cells) {
    for (const side of (Object.keys(NORMALS) as Side[]).filter((s) => cell.roads[s])) {
      const n = NORMALS[side];
      const [lo, hi] = span(cell.sidewalk, side);
      const occupied = (p: V2) => reserved.some((r) => contains({ x0: r.x0 - 1.5, z0: r.z0 - 1.5, x1: r.x1 + 1.5, z1: r.z1 + 1.5 }, p));
      for (let t = lo + CORNER_CLEAR + 4, k = 0; t < hi - CORNER_CLEAR; t += TREE_SPACING, k++) {
        const p = onSide(cell.sidewalk, side, t, SIDEWALK_W - 1.3);
        if (!occupied(p)) {
          put(random() < 0.6 ? "tree" : "tree_pine", { ...p, yaw: random() * Math.PI * 2, scale: 0.75 + random() * 0.4 });
        }
      }
      for (let t = lo + CORNER_CLEAR + 4 + TREE_SPACING / 2; t < hi - CORNER_CLEAR; t += LIGHT_SPACING) {
        const p = onSide(cell.sidewalk, side, t, 0.5); // at the kerb, arm over the road
        if (!occupied(p)) put("streetlight", { ...p, yaw: yawXFacing(mul(n, -1)) });
      }
      const h = onSide(cell.sidewalk, side, lo + CORNER_CLEAR + 1, 0.7);
      if (!occupied(h)) put("hydrant", { ...h, yaw: yawFacing(n) });
      for (let t = lo + 70 + random() * 20; t < hi - 30; t += 90) {
        const p = onSide(cell.sidewalk, side, t, SIDEWALK_W - 0.7);
        if (!occupied(p)) put("trashcan", { ...p, yaw: yawFacing(n) });
      }
    }
  }

  // ---- junction mouths: signal heads, stop lines, zebra crossings, pedestrian signals ----
  for (const signal of network.signals) {
    const byApproach = new Map<string, number[]>();
    for (const link of signal.links) byApproach.set(link.approach, [...(byApproach.get(link.approach) ?? []), link.index]);
    for (const [approach, links] of byApproach) {
      const e = edges.get(approach);
      if (!e) continue;
      const w0 = e.lanes[0]!.width;
      const pole = add(add(e.end, mul(e.curb, w0 / 2 + 1.0)), mul(e.dir, -1.0));
      signalHeads.push({ junction: signal.id, approach, links, placement: { x: pole.x, z: pole.z, yaw: yawFacing(mul(e.dir, -1)) } });

      const curbEdge = add(e.end, mul(e.curb, w0 / 2));
      const centre = add(e.end, mul(e.curb, -e.innerOffset));
      const mid = mul(add(curbEdge, centre), 0.5);
      const across = mul(e.curb, -1);
      paint.push({ ...add(mid, mul(e.dir, -0.3)), ux: across.x, uz: across.z, length: e.width, width: 0.45 });
      const zebraCentre = add(centre, mul(e.dir, 2.1));
      for (let k = -e.width + 0.6; k <= e.width - 0.5; k += 1.0) {
        const p = add(zebraCentre, mul(e.curb, k));
        zebras.push({ x: p.x, z: p.z, ux: e.dir.x, uz: e.dir.z, length: 3.0, width: 0.5 });
      }
      const ped = add(add(centre, mul(e.curb, e.width + 1.4)), mul(e.dir, 2.1));
      put("pedestrian_signal", { ...ped, yaw: yawFacing(across) });
    }
  }

  // ---- lane markings, edge lines, medians and dividers ----
  for (const e of edges.values()) {
    const solidFrom = e.length - 15;
    const along = (pos: number, offset: number) => add(add(e.start, mul(e.dir, pos)), mul(e.curb, offset));
    let offset = e.lanes[0]!.width / 2;
    for (let i = 0; i + 1 < e.lanes.length; i++) {
      const boundary = -offset; // towards the inner lanes
      for (let pos = 2; pos + 3 < solidFrom; pos += 9) {
        paint.push({ ...along(pos + 1.5, boundary), ux: e.dir.x, uz: e.dir.z, length: 3, width: 0.15 });
      }
      paint.push({ ...along((solidFrom + e.length) / 2, boundary), ux: e.dir.x, uz: e.dir.z, length: e.length - solidFrom, width: 0.15 });
      offset += e.lanes[i + 1]!.width;
    }
    const curbLine = e.lanes[0]!.width / 2 - 0.35;
    paint.push({ ...along(e.length / 2, curbLine), ux: e.dir.x, uz: e.dir.z, length: e.length, width: 0.15 });

    const back = edges.get(reverseId(e.id));
    if (!back || e.id > back.id) continue; // one median per road
    const toJunctionStart = tlsIds.has(e.id.split("_")[0]!);
    const toJunctionEnd = tlsIds.has(e.id.split("_")[1]!);
    const s0 = toJunctionStart ? DIVIDER_RUN : 0.5;
    const s1 = e.length - (toJunctionEnd ? DIVIDER_RUN : 0.5);
    if (s1 > s0) {
      const c = along((s0 + s1) / 2, -e.innerOffset);
      medians.push({ ...c, ux: e.dir.x, uz: e.dir.z, length: s1 - s0, width: 0.5 });
    }
    const segment = MANIFEST.divider.placeholder.size[2];
    const runs: [number, number][] = [];
    if (toJunctionStart) runs.push([0.6, DIVIDER_RUN]);
    if (toJunctionEnd) runs.push([e.length - DIVIDER_RUN, e.length - 0.6]);
    for (const [a, b] of runs) {
      for (let pos = a + segment / 2; pos + segment / 2 <= b + 0.01; pos += segment) {
        put("divider", { ...along(pos, -e.innerOffset), yaw: yawFacing(e.dir) });
      }
    }
  }

  // Ground layers that don't overlap: a frame of ground around the map, pavement bands,
  // lots. Every overlapping full-screen layer costs fill rate on an integrated GPU.
  const sidewalks = cells.flatMap(({ sidewalk: s, lot: l }) =>
    [
      { x0: s.x0, z0: s.z0, x1: s.x1, z1: l.z0 }, // north band, full width
      { x0: s.x0, z0: l.z1, x1: s.x1, z1: s.z1 }, // south band, full width
      { x0: s.x0, z0: l.z0, x1: l.x0, z1: l.z1 }, // west band, between them
      { x0: l.x1, z0: l.z0, x1: s.x1, z1: l.z1 }, // east band
    ].filter((r) => r.x1 - r.x0 > 0.01 && r.z1 - r.z0 > 0.01),
  );
  sidewalks.push(...smallBlocks);
  const groundFrame = [
    { x0: ground.x0, z0: ground.z0, x1: ground.x1, z1: bounds.z0 },
    { x0: ground.x0, z0: bounds.z1, x1: ground.x1, z1: ground.z1 },
    { x0: ground.x0, z0: bounds.z0, x1: bounds.x0, z1: bounds.z1 },
    { x0: bounds.x1, z0: bounds.z0, x1: ground.x1, z1: bounds.z1 },
  ];
  const lots = cells.map((c) => ({ rect: c.lot, kind: c.kind }));
  return { ground: groundFrame, bounds, sidewalks, lots, paths, medians, paint, zebras, props, signalHeads, hospital };
}

/** The lamp a single-head signal shows for an approach: green if any link may go. */
export function approachLamp(state: string, links: readonly number[]): "red" | "yellow" | "green" | "off" {
  let best: "red" | "yellow" | "green" | "off" = "off";
  for (const i of links) {
    const c = state[i];
    if (c === "G" || c === "g") return "green";
    if (c === "y" || c === "Y" || c === "u") best = "yellow";
    else if ((c === "r" || c === "R" || c === "s") && best === "off") best = "red";
  }
  return best;
}
