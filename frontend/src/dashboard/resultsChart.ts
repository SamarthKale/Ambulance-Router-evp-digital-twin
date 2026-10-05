/** Pure helpers for the in-app comparison chart (Results panel). */
import type { PairedMsg, ResultArmMsg, ResultSignals } from "../simulation/state";

export const SIGNAL_COLORS: Record<ResultSignals, string> = {
  off_strict: "#9ca3af",
  off_realistic: "#d97706",
  basic: "#3b82f6",
  coord: "#10b981",
};

export interface Bar {
  arm: string;
  label: string;
  color: string;
  mean: number;
  low: number;
  high: number;
  dashed: boolean; // static routing
}

/** One bar per arm with a mean, in the given order; axis maximum rounded up to 50 s. */
export function travelBars(arms: ResultArmMsg[]): { bars: Bar[]; max: number } {
  const bars = arms
    .filter((a) => a.travelMean !== null)
    .map((a) => ({
      arm: a.arm,
      label: a.label,
      color: SIGNAL_COLORS[a.signals],
      mean: a.travelMean!,
      low: a.travelCi[0] ?? a.travelMean!,
      high: a.travelCi[1] ?? a.travelMean!,
      dashed: a.routing === "static",
    }));
  const top = Math.max(0, ...bars.map((b) => b.high));
  return { bars, max: Math.max(50, Math.ceil(top / 50) * 50) };
}

export function formatP(p: number | null): string {
  if (p === null) return "";
  return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(p < 0.01 ? 3 : 2)}`;
}

/** "-62 s [-75, -50], p < 0.001": the paired difference against the baseline. */
export function formatPaired(paired: PairedMsg | null, unit: string, digits = 0): string {
  if (!paired || paired.meanDiff === null) return "";
  const n = (v: number | null) => (v === null ? "?" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`);
  return `${n(paired.meanDiff)} ${unit} [${n(paired.ci[0])}, ${n(paired.ci[1])}], ${formatP(paired.p)}`;
}
