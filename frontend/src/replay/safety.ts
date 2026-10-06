/**
 * The safety card: SAFE / WARNING / VIOLATION from the recorded result, never from a guess.
 * "violations" is the independent monitor's count; collisions and emergency brakings are SUMO's
 * (any vehicles, over the run's whole 600 s window). Missing data is "unknown", never "safe".
 */
import type { ReplaySummaryMsg, ReplayVerificationMsg } from "../simulation/state";

export type SafetyLevel = "safe" | "warning" | "violation" | "unknown";

export interface SafetyStatus {
  level: SafetyLevel;
  headline: string;
  reasons: string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function safetyStatus(summary: ReplaySummaryMsg | null, verification: ReplayVerificationMsg | null): SafetyStatus {
  if (summary === null) return { level: "unknown", headline: "Not recorded", reasons: ["This run has no result in runs.csv."] };
  const { violations, collisions, emergencyBrakings, teleports, ambulanceCollisions } = summary;
  if (violations === null || collisions === null) {
    return { level: "unknown", headline: "Not recorded", reasons: ["Monitor or collision counts are missing."] };
  }
  const reasons: string[] = [];
  let level: SafetyLevel = "safe";
  if (violations > 0) {
    level = "violation";
    reasons.push(`independent monitor: ${plural(violations, "signal-safety violation")}`);
  }
  if (ambulanceCollisions !== null && ambulanceCollisions > 0) {
    level = "violation";
    reasons.push(`ambulance involved in ${plural(ambulanceCollisions, "collision event")} (SUMO)`);
  } else if (collisions > 0) {
    if (level === "safe") level = "warning";
    const who = ambulanceCollisions === null ? "ambulance involvement not classified" : "none involved the ambulance";
    reasons.push(`SUMO reported ${plural(collisions, "collision")} in the window (any vehicles; ${who})`);
  }
  if (emergencyBrakings !== null && emergencyBrakings > 0) {
    if (level === "safe") level = "warning";
    reasons.push(`${plural(emergencyBrakings, "emergency braking")} after the dispatch (any vehicle, SUMO log)`);
  }
  if (teleports !== null && teleports > 0) {
    if (level === "safe") level = "warning";
    reasons.push(`${plural(teleports, "teleport")}: the run is not valid`);
  }
  if (verification !== null && !verification.matchesRecorded) {
    if (level === "safe") level = "warning";
    reasons.push("this playback is a re-run that differs from the recorded result");
  }
  if (level === "safe") reasons.push("0 monitor violations, 0 collisions, 0 emergency brakings");
  const headline = level === "safe" ? "SAFE" : level === "warning" ? "WARNING" : "VIOLATION";
  return { level, headline, reasons };
}
