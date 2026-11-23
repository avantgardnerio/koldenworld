// A lit 3D mesh: buildings, and the ground. Depth-tested against everything drawn before it
// and back-face culled (the operator emits front faces counterclockwise). A draw can be limited
// to runs of the index buffer (a coarse tile's buildings, less the fine cells that have their own).
// Buildings get windows, drawn here from where each fragment is on its façade (building-mesh.ts)
// and its material's window style: whole bays on full floors, the pattern's average color once a
// window is smaller than a pixel or so.
// Positions and normals are in a cell's frame, placed by its model matrix
// (rigid, so it rotates normals too). Holds GPU handles only.

import type { BuildingMesh } from "@game/world";
import { MAX_MATERIALS, type Frame } from "./flat-layer.ts";

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform mat4 u_model;
uniform vec3 u_colors[${MAX_MATERIALS}];
in vec3 a_pos;
in vec4 a_normal;     // x, y, z, and how occluded (0..1: walls darken toward the ground)
in uint a_mat;
in float a_shade;
in vec4 a_facade;     // m along the wall from its first bay, m above its bottom, the bays' width, the wall's height
in float a_floor;     // floor height, dm; 0: no windows
uniform vec4 u_windows[${MAX_MATERIALS}];  // per material: bay width, window width, sill, window height (m); 0: none
out vec3 v_world;
out vec4 v_facade;
out float v_floor;
out vec4 v_window;
out vec3 v_normal;
out vec3 v_color;
out float v_occluded;
void main() {
  vec4 world = u_model * vec4(a_pos, 1.0);
  gl_Position = u_view * world;
  v_world = world.xyz;
  v_normal = mat3(u_model) * a_normal.xyz;
  v_occluded = a_normal.w;
  v_color = u_colors[a_mat] * (0.9 + 0.2 * a_shade);
  v_facade = a_facade;
  v_floor = a_floor * 0.1;
  v_window = u_windows[a_mat];
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_eye;
uniform vec3 u_sky;
uniform vec2 u_fog;
uniform vec3 u_sun;   // unit vector toward the sun
in vec3 v_world;
in vec3 v_normal;
in vec3 v_color;
in float v_occluded;
in vec4 v_facade;
in float v_floor;
in vec4 v_window;
out vec4 color;
const vec3 GLASS = vec3(0.13, 0.17, 0.22);
void main() {
  vec3 n = normalize(v_normal);
  float light = (0.55 + 0.45 * max(dot(n, u_sun), 0.0) + 0.08 * n.z) * (1.0 - 0.45 * v_occluded);
  vec3 surface = v_color;
  vec2 fw = max(fwidth(v_facade.xy), vec2(1e-4));  // m per pixel along and up the wall (outside the branch)
  float fh = v_floor, bay = v_window.x;
  if (fh > 0.0 && bay > 0.0) {
    float ww = v_window.y, sill = v_window.z, wh = min(v_window.w, fh - sill - 0.3);
    float u = v_facade.x, v = v_facade.y, span = v_facade.z, top = v_facade.w;
    float floors = floor(top / fh + 0.01);
    float inside = step(0.0, u) * step(u, span) * step(v, floors * fh);
    vec2 cell = vec2(mod(u, bay) - 0.5 * bay, mod(v, fh) - sill);
    // How much of the pixel is glass, with a pixel's antialiasing at the window's edges.
    float glass = clamp((0.5 * ww - abs(cell.x)) / fw.x + 0.5, 0.0, 1.0) * clamp(min(cell.y, wh - cell.y) / fw.y + 0.5, 0.0, 1.0);
    float far = smoothstep(0.25, 0.6, max(fw.x / bay, fw.y / fh));
    glass = inside * mix(glass, (ww / bay) * (wh / fh), far);
    surface = mix(surface, GLASS, 0.85 * glass);
  }
  float d = distance(v_world, u_eye);
  color = vec4(mix(surface * light, u_sky, smoothstep(u_fog.x, u_fog.y, d)), 1.0);
}`;

export interface SolidLayer {
  /** runs: only these (first index, index count) pairs, the first `runCount` of them; triangles drawn. */
  draw(f: Frame, model: Float32Array, sun: readonly [number, number, number], runs?: Uint32Array, runCount?: number): number;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

const programs = new WeakMap<WebGL2RenderingContext, WebGLProgram>();

function program(gl: WebGL2RenderingContext): WebGLProgram {
  let p = programs.get(gl);
  if (p) return p;
  p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  ["a_pos", "a_normal", "a_mat", "a_shade", "a_facade", "a_floor"].forEach((name, i) => gl.bindAttribLocation(p!, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  programs.set(gl, p);
  return p;
}

export function createSolidLayer(
  gl: WebGL2RenderingContext,
  mesh: Omit<BuildingMesh, "indices" | "facade" | "floor"> & {
    indices: Uint16Array | Uint32Array; facade?: Float32Array; floor?: Uint8Array;
  },
  colors: Float32Array,
  windows?: Float32Array,  // vec4 per material (window style), for buildings
): SolidLayer {
  if (colors.length > 3 * MAX_MATERIALS) throw new Error("too many materials");
  const p = program(gl);
  const u = (name: string) => gl.getUniformLocation(p, name);
  const uWindows = u("u_windows"), noWindows = new Float32Array(4 * MAX_MATERIALS);
  const uView = u("u_view"), uModel = u("u_model"), uColors = u("u_colors"), uEye = u("u_eye"), uSky = u("u_sky"), uFog = u("u_fog"), uSun = u("u_sun");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [
    { data: mesh.positions, size: 3, type: gl.FLOAT, normalized: false, stride: 0 },
    { data: mesh.normals, size: 4, type: gl.BYTE, normalized: true, stride: 4 },
    { data: mesh.material, size: 1, type: gl.UNSIGNED_BYTE, normalized: false, stride: 0, integer: true },
    { data: mesh.shade, size: 1, type: gl.UNSIGNED_BYTE, normalized: true, stride: 0 },
    ...(mesh.facade && mesh.floor ? [
      { data: mesh.facade, size: 4, type: gl.FLOAT, normalized: false, stride: 0 },
      { data: mesh.floor, size: 1, type: gl.UNSIGNED_BYTE, normalized: false, stride: 0 },
    ] : []),
  ].map((a, i) => {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(i);
    if (a.integer) gl.vertexAttribIPointer(i, a.size, a.type, a.stride, 0);
    else gl.vertexAttribPointer(i, a.size, a.type, a.normalized, a.stride, 0);
    return buf;
  });
  const idx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const count = mesh.indices.length;
  const indexType = mesh.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
  const indexBytes = mesh.indices.BYTES_PER_ELEMENT;

  return {
    draw(f, model, sun, runs, runCount = 0) {
      if (count === 0 || (runs && runCount === 0)) return 0;
      gl.useProgram(p);
      // Without façades, their attributes are constants (context state, not the vertex array's): no windows.
      if (!mesh.facade) {
        gl.vertexAttrib4f(4, 0, 0, 0, 0);
        gl.vertexAttrib1f(5, 0);
      }
      gl.uniform4fv(uWindows, windows ?? noWindows);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniform3fv(uColors, colors);
      gl.uniform3f(uEye, f.eye[0], f.eye[1], f.eye[2]);
      gl.uniform3fv(uSky, f.sky);
      gl.uniform2f(uFog, f.fog[0], f.fog[1]);
      gl.uniform3f(uSun, sun[0], sun[1], sun[2]);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.bindVertexArray(vao);
      let drawn = count;
      if (runs) {
        drawn = 0;
        for (let r = 0; r < runCount; r++) {
          gl.drawElements(gl.TRIANGLES, runs[2 * r + 1]!, indexType, runs[2 * r]! * indexBytes);
          drawn += runs[2 * r + 1]!;
        }
      } else {
        gl.drawElements(gl.TRIANGLES, count, indexType, 0);
      }
      gl.bindVertexArray(null);
      gl.disable(gl.CULL_FACE);
      return drawn / 3;
    },
    dispose() {
      for (const b of buffers) gl.deleteBuffer(b);
      gl.deleteBuffer(idx);
      gl.deleteVertexArray(vao);
    },
  };
}
