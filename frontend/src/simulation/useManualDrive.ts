import { useEffect, useRef } from "react";

import { AMBULANCE_ID, useSim, type CommandBody, type Direction } from "./state";

/**
 * Manual ambulance control (keyboard = intent; the backend and SUMO decide what happens).
 *  W / S : throttle / brake (hold)
 *  A / D : turn left / right at the next junction (tap)
 *  Q / E : change lane left / right (tap)
 *
 * Reworked in Sprint 2 from the reference demo: physical key codes (layout-independent,
 * unaffected by Shift/CapsLock), typed commands, a stable `send` (an unstable one used to
 * re-run the effect and send throttle 0 on every render), keys ignored while typing,
 * input released when the window loses focus or the tab is hidden.
 */
export type Send = (command: CommandBody) => void;

export type KeyAction =
  | { kind: "throttle" }
  | { kind: "brake" }
  | { kind: "turn"; direction: Direction }
  | { kind: "lane"; direction: Direction };

export function keyAction(code: string): KeyAction | null {
  switch (code) {
    case "KeyW":
      return { kind: "throttle" };
    case "KeyS":
      return { kind: "brake" };
    case "KeyA":
      return { kind: "turn", direction: "left" };
    case "KeyD":
      return { kind: "turn", direction: "right" };
    case "KeyQ":
      return { kind: "lane", direction: "left" };
    case "KeyE":
      return { kind: "lane", direction: "right" };
    default:
      return null;
  }
}

function isTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

const HEARTBEAT_MS = 100; // keeps the backend's 0.5 s deadman timer alive

export function useManualDrive(send: Send, vehicle = AMBULANCE_ID, enabled = true): void {
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    if (!enabled) return;
    const held = { throttle: false, brake: false };

    const pushDrive = () => {
      sendRef.current({
        cmd: "drive",
        vehicle,
        control: { throttle: held.throttle ? 1 : 0, brake: held.brake ? 1 : 0 },
      });
      useSim.getState().setKeys({ ...held }, performance.now());
    };

    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || isTyping(e.target)) return;
      const action = keyAction(e.code);
      if (!action) return;
      e.preventDefault();
      switch (action.kind) {
        case "throttle":
        case "brake":
          held[action.kind] = true;
          pushDrive();
          break;
        case "turn":
          sendRef.current({ cmd: "turn", vehicle, direction: action.direction });
          break;
        case "lane":
          sendRef.current({ cmd: "lane", vehicle, direction: action.direction });
          break;
      }
    };

    const onUp = (e: KeyboardEvent) => {
      const action = keyAction(e.code);
      if (action?.kind === "throttle" || action?.kind === "brake") {
        held[action.kind] = false;
        pushDrive();
      }
    };

    const releaseAll = () => {
      held.throttle = false;
      held.brake = false;
      pushDrive();
    };
    const onVisibility = () => {
      if (document.hidden) releaseAll();
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibility);
    const heartbeat = setInterval(pushDrive, HEARTBEAT_MS);

    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(heartbeat);
      releaseAll();
    };
  }, [vehicle, enabled]);
}
