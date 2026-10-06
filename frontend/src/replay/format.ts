/** Text for numbers on the replay page. A value the simulation did not report is "Not recorded". */
export const NOT_RECORDED = "Not recorded";

export function num(value: number | null | undefined, digits = 1, unit = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NOT_RECORDED;
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? NOT_RECORDED : String(value);
}

/** m:ss.s from seconds. */
export function clockText(t: number): string {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function signed(value: number, digits = 1, unit = ""): string {
  const text = Math.abs(value).toFixed(digits);
  const zero = Number(text) === 0;
  const sign = zero ? "" : value > 0 ? "+" : "−";
  return `${sign}${text}${unit ? ` ${unit}` : ""}`;
}

export const KIND_LABEL: Record<string, string> = {
  dispatch: "Dispatch",
  preempt: "Preemption",
  green: "Green held",
  release: "Released",
  resume: "Normal program resumed",
  timeout: "Preemption timed out",
  fail_safe: "Fail-safe",
  route_review: "Route reviewed",
  reroute: "Reroute",
  accident: "Accident",
  collision: "Collision",
  violation: "Safety violation",
  arrival: "Arrival",
};

export const KIND_COLOR: Record<string, string> = {
  dispatch: "#34d399",
  preempt: "#22d3ee",
  green: "#22c55e",
  release: "#94a3b8",
  resume: "#94a3b8",
  timeout: "#f59e0b",
  fail_safe: "#f97316",
  route_review: "#64748b",
  reroute: "#fbbf24",
  accident: "#f97316",
  collision: "#ef4444",
  violation: "#ef4444",
  arrival: "#f87171",
};
