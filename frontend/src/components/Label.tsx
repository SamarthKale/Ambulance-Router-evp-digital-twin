/**
 * Map label as a sprite with a canvas texture: constant size on screen, drawn on top,
 * no extra React root (unlike drei <Html>) and no font download (unlike drei <Text>).
 * Sizing assumes the orthographic top-down camera.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { CanvasTexture, SRGBColorSpace, type OrthographicCamera, type Sprite } from "three";

import type { WorldPoint } from "../simulation/coords";

const PX_RATIO = 3; // texture pixels per screen pixel, for crisp text
const HEIGHT_PX = 18;

interface LabelProps {
  text: string;
  position: WorldPoint;
  background: string;
  color?: string;
}

export function Label({ text, position, background, color = "#ffffff" }: LabelProps) {
  const sprite = useRef<Sprite>(null);
  const { texture, aspect } = useMemo(
    () => labelTexture(text, background, color),
    [text, background, color],
  );
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame(({ camera }) => {
    const zoom = (camera as OrthographicCamera).zoom || 1;
    sprite.current?.scale.set((HEIGHT_PX * aspect) / zoom, HEIGHT_PX / zoom, 1);
  });

  return (
    <sprite ref={sprite} position={position} renderOrder={10}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function labelTexture(text: string, background: string, color: string) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas not available");
  const font = `600 ${11 * PX_RATIO}px system-ui, "Segoe UI", sans-serif`;
  ctx.font = font;
  const pad = 6 * PX_RATIO;
  canvas.width = Math.ceil(ctx.measureText(text).width + 2 * pad);
  canvas.height = HEIGHT_PX * PX_RATIO;
  ctx.font = font; // resizing the canvas resets the context state
  ctx.fillStyle = background;
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 4 * PX_RATIO);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + PX_RATIO);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}
