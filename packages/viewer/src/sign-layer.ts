// Street name signs (decision 35): a pole and two green blades per sign, the
// street names written on both faces of each blade. One mesh per cell, its
// blade texts drawn into one canvas atlas; lit and fogged like the buildings.
// Holds GPU handles only.

import type { StreetSign } from "@game/world";
import type { Frame } from "./flat-layer.ts";

const POLE = { height: 3.0, half: 0.04 };
const BLADE = { length: 0.95, height: 0.2, half: 0.012, at: [2.85, 2.6] };  // heights of the two blades' centers
const SLOT = { w: 256, h: 48 }, COLS = 4, MAX_ROWS = 80;  // atlas: COLS × rows text slots, row 0 holds the plain colors

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

/** A cell's signs as one mesh, or undefined when it has none. */
export function createSignLayer(gl: WebGL2RenderingContext, signs: StreetSign[]): SignLayer | undefined {
  if (signs.length === 0) return undefined;
  // The atlas: row 0 has the pole's gray and the blades' green; each blade text gets a slot below.
  const blades = signs.flatMap((s) => s.blades).slice(0, COLS * (MAX_ROWS - 1));
  const rows = 1 + Math.ceil(blades.length / COLS);
  const canvas = document.createElement("canvas");
  canvas.width = SLOT.w * COLS;
  canvas.height = SLOT.h * rows;
  const ctx = canvas.getContext("2d")!;
  const GREEN = "#1f6b3a";
  ctx.fillStyle = "#8d9096";
  ctx.fillRect(0, 0, SLOT.w, SLOT.h);
  ctx.fillStyle = GREEN;
  ctx.fillRect(SLOT.w, 0, SLOT.w, SLOT.h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  blades.forEach((b, i) => {
    const x = (i % COLS) * SLOT.w, y = (1 + Math.floor(i / COLS)) * SLOT.h;
    ctx.fillStyle = GREEN;
    ctx.fillRect(x, y, SLOT.w, SLOT.h);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 3, y + 3, SLOT.w - 6, SLOT.h - 6);
    let size = 30;
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    while (ctx.measureText(b.text).width > SLOT.w - 20 && size > 12) ctx.font = `bold ${--size}px system-ui, sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(b.text, x + SLOT.w / 2, y + SLOT.h / 2 + 1);
  });
  const W = canvas.width, H = canvas.height;
  const texel = (col: number) => [(col * SLOT.w + SLOT.w / 2) / W, (SLOT.h / 2) / H] as const;
  const slot = (i: number) => {
    const x = (i % COLS) * SLOT.w, y = (1 + Math.floor(i / COLS)) * SLOT.h;
    return { u0: x / W, u1: (x + SLOT.w) / W, v0: y / H, v1: (y + SLOT.h) / H };
  };

  // Boxes as triangles: a center, three unit axes (along, across, up) and half sizes along them.
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [];
  const quad = (p: number[][], n: number[], t: number[][]) => {
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...p[k]!); nrm.push(...n); uv.push(...t[k]!); }
  };
  const box = (c: number[], ax: number[][], h: number[], face: (side: number) => number[][] | undefined, plain: readonly [number, number]) => {
    const at = (s: number[]) => c.map((v, i) => v + ax[0]![i]! * h[0]! * s[0]! + ax[1]![i]! * h[1]! * s[1]! + ax[2]![i]! * h[2]! * s[2]!);
    const flat = [[...plain], [...plain], [...plain], [...plain]];
    // ±across faces may carry text; the rest are plain.
    for (const side of [1, -1]) {
      const pts = [[-side, side, -1], [side, side, -1], [side, side, 1], [-side, side, 1]].map(at);
      quad(pts, ax[1]!.map((v) => v * side), face(side) ?? flat);
    }
    for (const side of [1, -1]) quad([[side, -1, -1], [side, 1, -1], [side, 1, 1], [side, -1, 1]].map(at), ax[0]!.map((v) => v * side), flat);
    for (const side of [1, -1]) quad([[-1, -1, side], [1, -1, side], [1, 1, side], [-1, 1, side]].map(at), ax[2]!.map((v) => v * side), flat);
  };
  const up = [0, 0, 1];
  let k = 0;
  for (const s of signs) {
    box([s.x, s.y, s.z + POLE.height / 2], [[1, 0, 0], [0, 1, 0], up], [POLE.half, POLE.half, POLE.height / 2], () => undefined, texel(0));
    s.blades.forEach((b, i) => {
      const along = [Math.cos(b.dir), Math.sin(b.dir), 0], across = [-Math.sin(b.dir), Math.cos(b.dir), 0];
      const c = [s.x + along[0]! * BLADE.length / 2, s.y + along[1]! * BLADE.length / 2, s.z + BLADE.at[i]!];
      const t = k < blades.length ? slot(k) : undefined;
      k++;
      // Text reads left to right from either side: the far side's u runs the other way.
      const face = (side: number) => !t ? undefined : side > 0
        ? [[t.u1, t.v1], [t.u0, t.v1], [t.u0, t.v0], [t.u1, t.v0]]
        : [[t.u1, t.v1], [t.u0, t.v1], [t.u0, t.v0], [t.u1, t.v0]];
      box(c, [along, across, up], [BLADE.length / 2, BLADE.half, BLADE.height / 2], face, texel(1));
    });
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
