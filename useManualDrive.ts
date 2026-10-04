import { useEffect, useRef } from "react";

type Send = (msg: Record<string, unknown>) => void;

/**
 * Manual ambulance control.
 *  W / S : throttle / brake (hold)
 *  A / D : choose left / right turn at the next junction (tap)
 *  Q / E : change lane left / right (tap)
 *
 * The frontend only sends intent. SUMO decides what actually happens.
 */
export function useManualDrive(send: Send, vehicle = "ambulance_01", enabled = true) {
  const held = useRef({ w: false, s: false });

  useEffect(() => {
    if (!enabled) return;

    const pushDrive = () =>
      send({
        cmd: "drive",
        vehicle,
        control: { throttle: held.current.w ? 1 : 0, brake: held.current.s ? 1 : 0 },
      });

    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === "w" || k === "s") {
        held.current[k] = true;
        pushDrive();
      } else if (k === "a") send({ cmd: "turn", vehicle, direction: "left" });
      else if (k === "d") send({ cmd: "turn", vehicle, direction: "right" });
      else if (k === "q") send({ cmd: "lane", vehicle, direction: "left" });
      else if (k === "e") send({ cmd: "lane", vehicle, direction: "right" });
    };

    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w" || k === "s") {
        held.current[k] = false;
        pushDrive();
      }
    };

    const releaseAll = () => {
      held.current = { w: false, s: false };
      pushDrive();
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", releaseAll);
    const heartbeat = setInterval(pushDrive, 100); // keeps the backend deadman alive

    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", releaseAll);
      clearInterval(heartbeat);
      releaseAll();
    };
  }, [send, vehicle, enabled]);
}
