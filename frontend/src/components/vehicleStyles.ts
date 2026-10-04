/**
 * Placeholder look per vType (= asset key), in real-world metres.
 * Interim until the asset manifest (Sprint 5) takes over sizes and models.
 */
export interface VehicleStyle {
  size: [width: number, height: number, length: number]; // length along +Z (model forward)
  color: string;
}

export const VEHICLE_STYLES: Record<string, VehicleStyle> = {
  ambulance: { size: [2.2, 2.4, 6.0], color: "#f8fafc" },
  car_sedan: { size: [1.8, 1.4, 4.5], color: "#64748b" },
  car_hatchback: { size: [1.7, 1.45, 3.9], color: "#0e7490" },
  truck: { size: [2.4, 3.0, 7.5], color: "#a16207" },
  bus: { size: [2.5, 3.0, 12.0], color: "#15803d" },
};

export const FALLBACK_STYLE: VehicleStyle = { size: [1.8, 1.5, 4.5], color: "#9ca3af" };

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
