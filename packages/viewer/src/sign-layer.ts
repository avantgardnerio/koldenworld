// Signs as boxes with text: street name signs (decision 35: a pole and two
// green blades, the names on both faces of each blade) and business signs (a
// colored panel on a wall, its name on the front). One mesh per cell, every
// distinct color and text drawn into one canvas atlas; lit and fogged like the
// buildings. Holds GPU handles only.

import { SIGN, type BusinessSign, type StreetSign } from "@game/world";
import { businessColor } from "./style.ts";
import type { Frame } from "./flat-layer.ts";

const POLE = { height: 3.0, half: 0.04 };
const BLADE = { length: 0.95, height: 0.2, half: 0.012, at: [2.85, 2.6] };  // heights of the two blades' centers
const SLOT = { w: 256, h: 48 }, COLS = 8, MAX_ROWS = 85;  // atlas: COLS × rows slots, one per color and text

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform mat4 u_model;
in vec3 a_pos;
in vec3 a_normal;
in vec2 a_uv;
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
void main() {
  vec4 world = u_model * vec4(a_pos, 1.0);
  v_world = world.xyz;
  v_normal = mat3(u_model) * a_normal;
  v_uv = a_uv;
  gl_Position = u_view * world;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec3 u_eye;
uniform vec3 u_sky;
uniform vec2 u_fog;
uniform vec3 u_sun;
in vec3 v_world;
in vec3 v_normal;
in vec2 v_uv;
out vec4 color;
void main() {
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n;
  float light = 0.6 + 0.4 * max(dot(n, u_sun), 0.0);
  vec3 c = texture(u_tex, v_uv).rgb * light;
  color = vec4(mix(c, u_sky, smoothstep(u_fog.x, u_fog.y, distance(v_world, u_eye))), 1.0);
}`;

export interface SignLayer {
  draw(f: Frame, model: Float32Array, sun: readonly [number, number, number]): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

let program: WebGLProgram | undefined;

/**
 * A box (a sign's pole, blade or panel): its center, unit axes (along, across, up) and half sizes along them, its color,
 * and optional text on its across faces: both (a street sign's blade, read from either side) or the front (+across:
 * a business sign on a wall, read from outside).
 */
export interface TextBox {
  center: number[];
  axes: [number[], number[], number[]];
  half: [number, number, number];
  color: string;
  text?: string;
  textColor?: string;
  border?: string;   // a frame inside the text face's edge
  faces?: "both" | "front";
}

const GREEN = "#1f6b3a";

/** Street signs as boxes: a gray pole, and green blades with white names. */
export function streetSignBoxes(signs: StreetSign[]): TextBox[] {
  const up = [0, 0, 1], boxes: TextBox[] = [];
  for (const s of signs) {
    boxes.push({ center: [s.x, s.y, s.z + POLE.height / 2], axes: [[1, 0, 0], [0, 1, 0], up], half: [POLE.half, POLE.half, POLE.height / 2], color: "#8d9096" });
    s.blades.forEach((b, i) => {
      const along = [Math.cos(b.dir), Math.sin(b.dir), 0], across = [-Math.sin(b.dir), Math.cos(b.dir), 0];
      boxes.push({
        center: [s.x + along[0]! * BLADE.length / 2, s.y + along[1]! * BLADE.length / 2, s.z + BLADE.at[i]!],
        axes: [along, across, up], half: [BLADE.length / 2, BLADE.half, BLADE.height / 2],
        color: GREEN, text: b.text, textColor: "#ffffff", border: "#ffffff", faces: "both",
      });
    });
  }
  return boxes;
}

/** Business signs as boxes: a panel on the wall in its business's color, its name in white on the front. */
export function businessSignBoxes(signs: BusinessSign[]): TextBox[] {
  return signs.map((s) => {
    const along = [Math.cos(s.dir), Math.sin(s.dir), 0], out = [Math.sin(s.dir), -Math.cos(s.dir), 0];
    return {
      center: [s.x, s.y, s.z], axes: [along, out, [0, 0, 1]], half: [s.width / 2, SIGN.thick / 2, SIGN.height / 2],
      color: businessColor(s.category, s.kind), text: s.text, textColor: "#ffffff", faces: "front",
    };
  });
}

/** A cell's signs (boxes, some with text) as one mesh, or undefined when it has none. */
export function createSignLayer(gl: WebGL2RenderingContext, boxes: TextBox[]): SignLayer | undefined {
  if (boxes.length === 0) return undefined;
  // The atlas: a slot per distinct look (color, text): filled with the color, the text written on it.
  const slots = new Map<string, number>();
  const key = (b: TextBox) => `${b.color}|${b.text ?? ""}|${b.textColor ?? ""}|${b.border ?? ""}`;
  const looks: TextBox[] = [];
  for (const b of boxes) {
    if (!slots.has(key(b)) && looks.length < COLS * MAX_ROWS) {
      slots.set(key(b), looks.length);
      looks.push(b);
    }
  }
  const rows = Math.ceil(looks.length / COLS);
  const canvas = document.createElement("canvas");
  canvas.width = SLOT.w * COLS;
  canvas.height = SLOT.h * rows;
  const ctx = canvas.getContext("2d")!;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  looks.forEach((b, i) => {
    const x = (i % COLS) * SLOT.w, y = Math.floor(i / COLS) * SLOT.h;
    ctx.fillStyle = b.color;
    ctx.fillRect(x, y, SLOT.w, SLOT.h);
    if (b.border) {
      ctx.strokeStyle = b.border;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 3, y + 3, SLOT.w - 6, SLOT.h - 6);
    }
    if (!b.text) return;
    let size = 30;
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    while (ctx.measureText(b.text).width > SLOT.w - 20 && size > 12) ctx.font = `bold ${--size}px system-ui, sans-serif`;
    ctx.fillStyle = b.textColor ?? "#ffffff";
    ctx.fillText(b.text, x + SLOT.w / 2, y + SLOT.h / 2 + 1);
  });
  const W = canvas.width, H = canvas.height;
  const slot = (i: number) => {
    const x = (i % COLS) * SLOT.w, y = Math.floor(i / COLS) * SLOT.h;
    return { u0: x / W, u1: (x + SLOT.w) / W, v0: y / H, v1: (y + SLOT.h) / H, plain: [(x + 1.5) / W, (y + 1.5) / H] };
  };

  const pos: number[] = [], nrm: number[] = [], uv: number[] = [];
  const quad = (p: number[][], n: number[], t: number[][]) => {
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...p[k]!); nrm.push(...n); uv.push(...t[k]!); }
  };
  for (const b of boxes) {
    const look = slots.get(key(b));
    if (look === undefined) continue;  // the atlas is full
    const t = slot(look), [c, ax, h] = [b.center, b.axes, b.half];
    const at = (s: number[]) => c.map((v, i) => v + ax[0][i]! * h[0] * s[0]! + ax[1][i]! * h[1] * s[1]! + ax[2][i]! * h[2] * s[2]!);
    const flat = [t.plain, t.plain, t.plain, t.plain];
    // ±across faces may carry text: read left to right from either side (both), or from the front only.
    const face = (side: number) => !b.text ? flat
      : b.faces === "front" ? (side > 0 ? [[t.u0, t.v1], [t.u1, t.v1], [t.u1, t.v0], [t.u0, t.v0]] : flat)
      : [[t.u1, t.v1], [t.u0, t.v1], [t.u0, t.v0], [t.u1, t.v0]];
    for (const side of [1, -1]) {
      const pts = [[-side, side, -1], [side, side, -1], [side, side, 1], [-side, side, 1]].map(at);
      quad(pts, ax[1].map((v) => v * side), face(side));
    }
    for (const side of [1, -1]) quad([[side, -1, -1], [side, 1, -1], [side, 1, 1], [side, -1, 1]].map(at), ax[0].map((v) => v * side), flat);
    for (const side of [1, -1]) quad([[-1, -1, side], [1, -1, side], [1, 1, side], [-1, 1, side]].map(at), ax[2].map((v) => v * side), flat);
  }

  if (!program) {
    program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    ["a_pos", "a_normal", "a_uv"].forEach((name, i) => gl.bindAttribLocation(program!, i, name));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  }
  const p = program, u = (name: string) => gl.getUniformLocation(p, name);
  const vao = gl.createVertexArray(), buffers = [pos, nrm, uv].map((data, a) => {
    const b = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, a === 2 ? 2 : 3, gl.FLOAT, false, 0, 0);
    return b;
  });
  gl.bindVertexArray(null);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const count = pos.length / 3;

  return {
    draw(f, model, sun) {
      gl.useProgram(p);
      gl.uniformMatrix4fv(u("u_view"), false, f.view);
      gl.uniformMatrix4fv(u("u_model"), false, model);
      gl.uniform3f(u("u_eye"), f.eye[0], f.eye[1], f.eye[2]);
      gl.uniform3fv(u("u_sky"), f.sky);
      gl.uniform2f(u("u_fog"), f.fog[0], f.fog[1]);
      gl.uniform3f(u("u_sun"), sun[0], sun[1], sun[2]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(u("u_tex"), 0);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, count);
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.deleteVertexArray(vao);
      for (const b of buffers) gl.deleteBuffer(b);
      gl.deleteTexture(texture);
    },
  };
}
