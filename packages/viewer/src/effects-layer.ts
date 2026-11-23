// Effects: short-lived flashes and trails, such as a gunshot's. Each is kept in
// ECEF (Effects, one row per effect in columns) and drawn in the view frame,
// blended, without writing depth.
//
// - A muzzle flash: a bright orange point at the muzzle, for FLASH s.
// - A tracer: a pale line from the muzzle to where the shot stopped, for
//   TRACER s.
// - A puff: grey dust where the shot hit something, growing and fading over
//   PUFF s, with a bright spark at first.
//
// Points are sized in meters (gl_PointSize from the distance) and drawn round.
// Holds GPU handles only, besides the effects themselves.

import { ecefToLocal, type Frame as CellFrame, type Vec3 } from "@game/world";
import { FOV_Y } from "./camera.ts";
import { compile } from "./car-layer.ts";
import type { Frame } from "./flat-layer.ts";

const FLASH = 0.05, TRACER = 0.06, PUFF = 0.6;  // s
const CAPACITY = 64;
/** Kinds of effect. */
const KIND = { flash: 0, tracer: 1, puff: 2 } as const;

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform float u_px;  // pixels per meter at a distance of 1 m
in vec3 a_pos;
in vec4 a_color;
in float a_size;
out vec4 v_color;
void main() {
  gl_Position = u_view * vec4(a_pos, 1.0);
  gl_PointSize = max(2.0, a_size * u_px / max(gl_Position.w, 0.1));
  v_color = a_color;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform bool u_points;
in vec4 v_color;
out vec4 color;
void main() {
  // Points round and soft-edged; lines as they are.
  float a = 1.0;
  if (u_points) {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    a = 1.0 - r * r;
  }
  color = vec4(v_color.rgb, v_color.a * a);
}`;

/** The effects alive now, as columns: kind, born (s), and one or two points (ECEF). */
export class Effects {
  count = 0;
  kind = new Uint8Array(CAPACITY);
  born = new Float64Array(CAPACITY);
  a = new Float64Array(3 * CAPACITY);
  b = new Float64Array(3 * CAPACITY);

  /** A shot at time `now` (s): flash and tracer from the muzzle to where it stopped; a puff there if it hit something. */
  shot(muzzle: Vec3, end: Vec3, hit: boolean, now: number): void {
    this.add(KIND.flash, muzzle, muzzle, now);
    this.add(KIND.tracer, muzzle, end, now);
    if (hit) this.add(KIND.puff, end, end, now);
  }

  /** Drops the effects that are over by `now`. */
  expire(now: number): void {
    for (let i = this.count - 1; i >= 0; i--) {
      if (now - this.born[i]! <= LIFE[this.kind[i]!]!) continue;
      const last = --this.count;
      this.kind[i] = this.kind[last]!;
      this.born[i] = this.born[last]!;
      this.a.copyWithin(3 * i, 3 * last, 3 * last + 3);
      this.b.copyWithin(3 * i, 3 * last, 3 * last + 3);
    }
  }

  private add(kind: number, a: Vec3, b: Vec3, now: number): void {
    if (this.count === CAPACITY) this.expire(Infinity);  // full: start again (only ever briefly this busy)
    const i = this.count++;
    this.kind[i] = kind;
    this.born[i] = now;
    this.a.set(a, 3 * i);
    this.b.set(b, 3 * i);
  }
}
const LIFE = [FLASH, TRACER, PUFF];

export interface EffectsLayer {
  draw(f: Frame, view: CellFrame, effects: Effects, now: number, height: number): void;
}

export function createEffectsLayer(gl: WebGL2RenderingContext): EffectsLayer {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  ["a_pos", "a_color", "a_size"].forEach((name, i) => gl.bindAttribLocation(p, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  const uView = gl.getUniformLocation(p, "u_view"), uPx = gl.getUniformLocation(p, "u_px"), uPoints = gl.getUniformLocation(p, "u_points");
  const vao = gl.createVertexArray(), vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  for (const [a, size, off] of [[0, 3, 0], [1, 4, 12], [2, 1, 28]] as const) {
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, size, gl.FLOAT, false, 32, off);
  }
  gl.bindVertexArray(null);
  // Vertices: position (3), color (4), size (1); points first (up to two an effect), then line ends (two a tracer).
  const verts = new Float32Array(8 * 4 * CAPACITY);

  return {
    draw(f, view, effects, now, height) {
      effects.expire(now);
      if (effects.count === 0) return;
      let points = 0;
      const put = (k: number, pos: Vec3, rgba: [number, number, number, number], size: number) => verts.set([...pos, ...rgba, size], 8 * k);
      const at = (arr: Float64Array, i: number) => ecefToLocal(view, [arr[3 * i]!, arr[3 * i + 1]!, arr[3 * i + 2]!]);
      for (let i = 0; i < effects.count; i++) {
        const age = (now - effects.born[i]!) / LIFE[effects.kind[i]!]!;
        if (effects.kind[i] === KIND.flash) put(points++, at(effects.a, i), [1, 0.75, 0.3, 1 - age], 0.35);
        else if (effects.kind[i] === KIND.puff) {
          put(points++, at(effects.a, i), [0.62, 0.58, 0.52, 0.8 * (1 - age)], 0.15 + 0.5 * age);
          if (age < 0.15) put(points++, at(effects.a, i), [1, 0.9, 0.6, 1], 0.12);
        }
      }
      let lines = 0;
      for (let i = 0; i < effects.count; i++) {
        if (effects.kind[i] !== KIND.tracer) continue;
        const fade = 1 - (now - effects.born[i]!) / TRACER;
        put(points + lines++, at(effects.a, i), [1, 0.95, 0.75, 0.9 * fade], 0);
        put(points + lines++, at(effects.b, i), [1, 0.95, 0.75, 0.3 * fade], 0);
      }
      gl.useProgram(p);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniform1f(uPx, height / 2 / Math.tan(FOV_Y / 2));
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, 8 * (points + lines)), gl.DYNAMIC_DRAW);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1i(uPoints, 1);
      if (points) gl.drawArrays(gl.POINTS, 0, points);
      gl.uniform1i(uPoints, 0);
      if (lines) gl.drawArrays(gl.LINES, points, lines);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
  };
}
