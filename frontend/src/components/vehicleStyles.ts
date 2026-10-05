/**
 * Colours for signal states and junction control. Vehicle looks moved to the asset
 * manifest (assets/manifest.ts) in Sprint 5.
 */

/** Who drives a junction's signals: hidden for the normal program. */
export const CONTROL_COLORS: Record<string, string> = {
  clearing: "#f59e0b", // yellow + all-red before the ambulance's green
  preempted: "#3b82f6", // green held for the ambulance
  recovering: "#a855f7", // yellow + all-red back to the normal program
};

/** SUMO signal state char -> lamp colour. */
export function signalColor(state: string): string {
  switch (state) {
    case "G":
      return "#22c55e"; // green, priority
    case "g":
      return "#86efac"; // green, must yield
    case "y":
    case "Y":
      return "#facc15";
    case "u":
      return "#fb923c"; // red-yellow
    case "r":
    case "R":
    case "s":
      return "#ef4444";
    default:
      return "#6b7280"; // off / blinking
  }
}
