/** Search over junctions, roads and the recorded events of the selected run. */
import type { ReplayEventMsg } from "../simulation/state";

export interface SearchResult {
  type: "junction" | "edge" | "event";
  id: string;
  label: string;
  t?: number;
}

const LIMIT = 12;
const RANK = { junction: 0, event: 1, edge: 2 } as const;

export function searchAll(
  query: string,
  junctions: readonly string[],
  edges: readonly string[],
  events: readonly ReplayEventMsg[],
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: SearchResult[] = [];
  for (const id of junctions) {
    if (id.toLowerCase().includes(q)) out.push({ type: "junction", id, label: `Junction ${id}` });
  }
  for (const e of events) {
    const haystack = `${e.kind} ${e.junction ?? ""} ${e.edge ?? ""} ${e.text}`.toLowerCase();
    if (haystack.includes(q)) {
      const where = e.junction ? ` ${e.junction}` : "";
      out.push({ type: "event", id: `${e.t}-${e.kind}-${e.junction ?? ""}`, label: `${e.t.toFixed(1)} s ${e.kind}${where}`, t: e.t });
    }
  }
  for (const id of edges) {
    if (id.toLowerCase().includes(q)) out.push({ type: "edge", id, label: `Road ${id}` });
  }
  const starts = (r: SearchResult) => Number(!r.id.toLowerCase().startsWith(q));
  return out.sort((a, b) => starts(a) - starts(b) || RANK[a.type] - RANK[b.type]).slice(0, LIMIT);
}
