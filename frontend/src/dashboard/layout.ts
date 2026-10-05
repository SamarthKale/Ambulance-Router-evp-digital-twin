/**
 * Screen space the HUD panels cover, shared by the CSS (app.css uses the same widths) and the
 * camera, which centres the map or the ambulance in the free area between the panels.
 */
export const HUD_LEFT_PX = 300;
export const HUD_RIGHT_PX = 290;
export const HUD_MARGIN_PX = 12;
/** Below this width the panels stack on the left and the camera stays centred. */
export const WIDE_MIN_PX = 1100;

export function hudInsets(width: number): { left: number; right: number } {
  if (width < WIDE_MIN_PX) return { left: 0, right: 0 };
  return { left: HUD_LEFT_PX + 2 * HUD_MARGIN_PX, right: HUD_RIGHT_PX + 2 * HUD_MARGIN_PX };
}
