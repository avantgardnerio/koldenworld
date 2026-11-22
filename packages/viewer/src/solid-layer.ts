// A lit 3D mesh: buildings. Depth-tested against everything drawn before it
// and back-face culled (the operator emits front faces counterclockwise).
// Positions and normals are in a cell's frame, placed by its model matrix
// (rigid, so it rotates normals too). Holds GPU handles only.

import type { BuildingMesh } from "@game/world";
import { MAX_MATERIALS, type Frame } from "./flat-layer.ts";

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform mat4 u_model;
uniform vec3 u_colors[${MAX_MATERIALS}];
in vec3 a_pos;
in vec3 a_normal;
in uint a_mat;
in float a_shade;
out vec3 v_world;
out vec3 v_normal;
out vec3 v_color;
void main() {
  vec4 world = u_model * vec4(a_pos, 1.0);
  gl_Position = u_view * world;
  v_world = world.xyz;
  v_normal = mat3(u_model) * a_normal;
  v_color = u_colors[a_mat] * (0.9 + 0.2 * a_shade);
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
out vec4 color;
void main() {
  vec3 n = normalize(v_normal);
  float light = 0.55 + 0.45 * max(dot(n, u_sun), 0.0) + 0.08 * n.z;
  float d = distance(v_world, u_eye);
  color = vec4(mix(v_color * light, u_sky, smoothstep(u_fog.x, u_fog.y, d)), 1.0);
}`;

export interface SolidLayer {
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

const programs = new WeakMap<WebGL2RenderingContext, WebGLProgram>();

function program(gl: WebGL2RenderingContext): WebGLProgram {
  let p = programs.get(gl);
  if (p) return p;
  p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  ["a_pos", "a_normal", "a_mat", "a_shade"].forEach((name, i) => gl.bindAttribLocation(p!, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  programs.set(gl, p);
  return p;
}

export function createSolidLayer(
  gl: WebGL2RenderingContext, mesh: Omit<BuildingMesh, "indices"> & { indices: Uint16Array | Uint32Array }, colors: Float32Array,
): SolidLayer {
  if (colors.length > 3 * MAX_MATERIALS) throw new Error("too many materials");
  const p = program(gl);
  const u = (name: string) => gl.getUniformLocation(p, name);
  const uView = u("u_view"), uModel = u("u_model"), uColors = u("u_colors"), uEye = u("u_eye"), uSky = u("u_sky"), uFog = u("u_fog"), uSun = u("u_sun");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [
    { data: mesh.positions, size: 3, type: gl.FLOAT, normalized: false, stride: 0 },
    { data: mesh.normals, size: 3, type: gl.BYTE, normalized: true, stride: 4 },
    { data: mesh.material, size: 1, type: gl.UNSIGNED_BYTE, normalized: false, stride: 0, integer: true },
    { data: mesh.shade, size: 1, type: gl.UNSIGNED_BYTE, normalized: true, stride: 0 },
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

  return {
    draw(f, model, sun) {
      if (count === 0) return;
      gl.useProgram(p);
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
      gl.drawElements(gl.TRIANGLES, count, indexType, 0);
      gl.bindVertexArray(null);
      gl.disable(gl.CULL_FACE);
    },
    dispose() {
      for (const b of buffers) gl.deleteBuffer(b);
      gl.deleteBuffer(idx);
      gl.deleteVertexArray(vao);
    },
  };
}
