/**
 * The road map the replay draws, built only from the network the backend serves
 * (GET /api/replay/network/<scenario>: SUMO's own geometry). No second road model.
 * Coordinates are SUMO metres: x east, y north.
 */
import type { NetworkMsg, Point } from "../simulation/state";

export interface LaneShape {
  edge: string;
  index: number;
  width: number;
  shape: Point[];
}

export interface JunctionShape {
  id: string;
  signalised: boolean;
  shape: Point[];
  cx: number;
  cy: number;
}

/** One road's end at a signalised junction: where its stop line is and which links it uses. */
export interface Approach {
  junction: string;
  edge: string;
  links: number[];
  x: number; // stop line centre
  y: number;
  dx: number; // unit vector along the road, towards the junction
  dy: number;
  width: number; // across all lanes
}

export interface MapGeometry {
  bounds: [number, number, number, number];
  lanes: LaneShape[];
  junctions: JunctionShape[];
  approaches: Approach[];
  approachesByJunction: Map<string, Approach[]>;
  edgeLine: Map<string, Point[]>; // road centreline
  edgeWidth: Map<string, number>;
  edgeIds: string[];
  junctionIds: string[];
  signalIds: string[];
  depot: { x: number; y: number; edge: string };
  hospital: { x: number; y: number; edge: string };
}

function centreline(lanes: LaneShape[]): Point[] {
  const first = lanes[0].shape;
  if (lanes.some((l) => l.shape.length !== first.length)) return first;
  return first.map((_, i) => [
    lanes.reduce((sum, l) => sum + l.shape[i][0], 0) / lanes.length,
    lanes.reduce((sum, l) => sum + l.shape[i][1], 0) / lanes.length,
  ]);
}

export function buildGeometry(network: NetworkMsg): MapGeometry {
  const lanes: LaneShape[] = network.lanes.map((l) => ({ edge: l.edge, index: l.index, width: l.width, shape: l.shape }));
  const byEdge = new Map<string, LaneShape[]>();
  for (const lane of lanes) {
    const list = byEdge.get(lane.edge);
    if (list) list.push(lane);
    else byEdge.set(lane.edge, [lane]);
  }
  const edgeLine = new Map<string, Point[]>();
  const edgeWidth = new Map<string, number>();
  for (const [edge, group] of byEdge) {
    edgeLine.set(edge, centreline(group));
    edgeWidth.set(edge, group.reduce((sum, l) => sum + l.width, 0));
  }
  const junctions: JunctionShape[] = network.junctions.map((j) => ({
    id: j.id,
    signalised: j.type === "traffic_light",
    shape: j.shape,
    cx: j.shape.reduce((s, p) => s + p[0], 0) / Math.max(1, j.shape.length),
    cy: j.shape.reduce((s, p) => s + p[1], 0) / Math.max(1, j.shape.length),
  }));
  const approaches: Approach[] = [];
  for (const signal of network.signals) {
    const links = new Map<string, number[]>();
    for (const link of signal.links) {
      const list = links.get(link.approach);
      if (list) list.push(link.index);
      else links.set(link.approach, [link.index]);
    }
    for (const [edge, indices] of links) {
      const line = edgeLine.get(edge);
      if (!line || line.length < 2) continue;
      const [x1, y1] = line[line.length - 2];
      const [x2, y2] = line[line.length - 1];
      const length = Math.hypot(x2 - x1, y2 - y1) || 1;
      approaches.push({
        junction: signal.id,
        edge,
        links: indices,
        x: x2,
        y: y2,
        dx: (x2 - x1) / length,
        dy: (y2 - y1) / length,
        width: edgeWidth.get(edge) ?? 6.4,
      });
    }
  }
  const approachesByJunction = new Map<string, Approach[]>();
  for (const a of approaches) {
    const list = approachesByJunction.get(a.junction);
    if (list) list.push(a);
    else approachesByJunction.set(a.junction, [a]);
  }
  return {
    bounds: network.bounds,
    lanes,
    junctions,
    approaches,
    approachesByJunction,
    edgeLine,
    edgeWidth,
    edgeIds: [...byEdge.keys()].sort(),
    junctionIds: junctions.map((j) => j.id).sort(),
    signalIds: network.signals.map((s) => s.id).sort(),
    depot: { x: network.depot.x, y: network.depot.y, edge: network.depot.edge },
    hospital: { x: network.hospital.x, y: network.hospital.y, edge: network.hospital.edge },
  };
}

// ---- hit testing (world coordinates, metres) ------------------------------------------------
function distanceToSegment(px: number, py: number, a: Point, b: Point): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / len2));
  return Math.hypot(px - (a[0] + u * vx), py - (a[1] + u * vy));
}

export function nearestEdge(geometry: MapGeometry, x: number, y: number, maxDistance: number): string | null {
  let best: string | null = null;
  let bestDistance = maxDistance;
  for (const [edge, line] of geometry.edgeLine) {
    for (let i = 0; i + 1 < line.length; i++) {
      const d = distanceToSegment(x, y, line[i], line[i + 1]);
      if (d < bestDistance) {
        bestDistance = d;
        best = edge;
      }
    }
  }
  return best;
}

/** The signalised junction whose centre is nearest, within maxDistance. */
export function nearestJunction(geometry: MapGeometry, x: number, y: number, maxDistance: number): string | null {
  let best: string | null = null;
  let bestDistance = maxDistance;
  for (const j of geometry.junctions) {
    if (!j.signalised) continue;
    const d = Math.hypot(x - j.cx, y - j.cy);
    if (d < bestDistance) {
      bestDistance = d;
      best = j.id;
    }
  }
  return best;
}

/** Points along an edge's centreline, for drawing a route. */
export function routePolyline(geometry: MapGeometry, edges: readonly string[]): Point[] {
  const out: Point[] = [];
  for (const edge of edges) {
    const line = geometry.edgeLine.get(edge);
    if (line) out.push(...line);
  }
  return out;
}

/** The point `back` metres before the end of a road's centreline (the mission destination is
 * 15 m before the end of its road, as in the experiments). */
export function pointBeforeEnd(line: readonly Point[], back: number): Point | null {
  let remaining = back;
  for (let i = line.length - 1; i > 0; i--) {
    const [x1, y1] = line[i - 1];
    const [x2, y2] = line[i];
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (remaining <= length) {
      const u = length === 0 ? 0 : 1 - remaining / length;
      return [x1 + (x2 - x1) * u, y1 + (y2 - y1) * u];
    }
    remaining -= length;
  }
  return line.length > 0 ? line[0] : null;
}

export function lineLength(line: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return total;
}
