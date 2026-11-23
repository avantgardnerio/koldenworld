// Devices → CameraInput. The DOM listeners only record raw state (held key
// codes, accumulated mouse movement); decoding is a pure function of it.
// Key codes are physical positions (KeyW is W on QWERTY, Z on AZERTY).

import type { CameraInput } from "./camera.ts";

const AXES: Record<string, [axis: 0 | 1 | 2, sign: 1 | -1]> = {
  KeyD: [0, 1], ArrowRight: [0, 1],
  KeyA: [0, -1], ArrowLeft: [0, -1],
  KeyW: [1, 1], ArrowUp: [1, 1],
  KeyS: [1, -1], ArrowDown: [1, -1],
  KeyE: [2, 1], Space: [2, 1],
  KeyQ: [2, -1], KeyC: [2, -1],
};

export const isControlKey = (code: string) => code in AXES || code === "ShiftLeft" || code === "ShiftRight";

export function decodeInput(held: ReadonlySet<string>, look: [number, number], fire = 0, aim = false): CameraInput {
  const move: [number, number, number] = [0, 0, 0];
  for (const code of held) {
    const a = AXES[code];
    if (a) move[a[0]] = Math.max(-1, Math.min(1, move[a[0]] + a[1]));
  }
  return { move, look, fast: held.has("ShiftLeft") || held.has("ShiftRight"), fire, aim };
}

export const isIdle = (i: CameraInput) =>
  i.move[0] === 0 && i.move[1] === 0 && i.move[2] === 0 && i.look[0] === 0 && i.look[1] === 0;

/** Raw device state for a canvas: held keys and mouse movement since the last take(). */
export function attachInput(canvas: HTMLCanvasElement, onActivity: () => void) {
  const held = new Set<string>();
  let dx = 0, dy = 0;
  let dragging = false;

  addEventListener("keydown", (e) => {
    if (!isControlKey(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    held.add(e.code);
    onActivity();
  });
  addEventListener("keyup", (e) => { held.delete(e.code); });
  addEventListener("blur", () => { held.clear(); dragging = false; });

  // Click to capture the mouse (Esc releases). Dragging also looks, if capture is refused. Captured, the left button
  // fires (each press counted) and the right one aims (while held).
  let fire = 0, aim = false;
  const captured = () => document.pointerLockElement === canvas;
  canvas.addEventListener("click", () => { if (!captured()) canvas.requestPointerLock?.()?.catch?.(() => {}); });
  canvas.addEventListener("mousedown", (e) => {
    if (!captured()) return;
    if (e.button === 0) fire++;
    if (e.button === 2) aim = true;
    onActivity();
  });
  addEventListener("mouseup", (e) => { if (e.button === 2) aim = false; });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("pointerlockchange", () => { if (!captured()) aim = false; });
  canvas.addEventListener("pointerdown", () => { dragging = true; });
  addEventListener("pointerup", () => { dragging = false; });
  addEventListener("pointermove", (e) => {
    if (document.pointerLockElement !== canvas && !dragging) return;
    dx += e.movementX;
    dy += e.movementY;
    onActivity();
  });

  return {
    take(): CameraInput {
      const input = decodeInput(held, [dx, dy], fire, aim);
      dx = 0;
      dy = 0;
      fire = 0;
      return input;
    },
  };
}
