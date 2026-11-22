// Terrain: each cell's height lattice, lit by the sun and colored by elevation
// and slope (decision 26). Bands, bottom up, each edge shifted by a smooth
// noise field so they don't look like contour lines:
//
//   grass (plains) → montane forest → alpine tundra (treeline) → rock → snow
//
// Steep slopes turn to rock at any height; snow doesn't hold on very steep
// ones. Flat ground below the forest band keeps exactly the base color, and
// flat ground keeps its brightness (light is relative to a flat surface).
// Draws one level of detail (a range of its indices); no back-face culling, as
// the skirts face either way. Holds GPU handles only.

import type { TerrainMesh } from "@game/world";
import type { Frame } from "./flat-layer.ts";

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform mat4 u_model;
in vec3 a_pos;
in vec3 a_normal;
in float a_height;
in float a_noise;
out vec3 v_world;
out vec3 v_normal;
out float v_height;
out float v_noise;
void main() {
  vec4 world = u_model * vec4(a_pos, 1.0);
  gl_Position = u_view * world;
  v_world = world.xyz;
  v_normal = mat3(u_model) * a_normal;
  v_height = a_height;
  v_noise = a_noise;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_eye;
uniform vec3 u_sky;
uniform vec2 u_fog;
uniform vec3 u_sun;
uniform vec3 u_colors[5];  // grass, forest, tundra, rock, snow
uniform vec4 u_bands;      // where forest, tundra, rock and snow begin, m
uniform vec4 u_jitter;     // how far noise moves each band's edge, m
uniform vec2 u_steep;      // n.z where slopes turn fully to rock, and start to
in vec3 v_world;
in vec3 v_normal;
in float v_height;
in float v_noise;
out vec4 color;
float band(float edge, float jitter, float width) {
  float e = edge + (v_noise - 0.5) * 2.0 * jitter;
  return smoothstep(e - width, e + width, v_height);
}
void main() {
  vec3 n = normalize(v_normal);
  vec3 c = u_colors[0];
  c = mix(c, u_colors[1], band(u_bands.x, u_jitter.x, 150.0));
  c = mix(c, u_colors[2], band(u_bands.y, u_jitter.y, 60.0));
  float rock = max(band(u_bands.z, u_jitter.z, 80.0), smoothstep(u_steep.y, u_steep.x, n.z));
  c = mix(c, u_colors[3], rock);
  c = mix(c, u_colors[4], band(u_bands.w, u_jitter.w, 60.0) * smoothstep(0.55, 0.7, n.z));
  float light = 0.25 + 0.75 * max(dot(n, u_sun), 0.0) / u_sun.z;
  float d = distance(v_world, u_eye);
  color = vec4(mix(c * light, u_sky, smoothstep(u_fog.x, u_fog.y, d)), 1.0);
}`;

export interface TerrainStyle {
  colors: Float32Array;  // 5 × vec3
  bands: readonly [forest: number, tundra: number, rock: number, snow: number];
  jitter: readonly [number, number, number, number];
  steep: readonly [full: number, start: number];
}

export interface TerrainLayer {
  draw(f: Frame, model: Float32Array, sun: readonly [number, number, number], range: { start: number; count: number }): void;
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
  ["a_pos", "a_normal", "a_height", "a_noise"].forEach((name, i) => gl.bindAttribLocation(p!, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  programs.set(gl, p);
  return p;
}

export function createTerrainLayer(gl: WebGL2RenderingContext, mesh: TerrainMesh, style: TerrainStyle): TerrainLayer {
  const p = program(gl);
  const u = (name: string) => gl.getUniformLocation(p, name);
  const uView = u("u_view"), uModel = u("u_model"), uEye = u("u_eye"), uSky = u("u_sky"), uFog = u("u_fog"), uSun = u("u_sun");
  const uColors = u("u_colors"), uBands = u("u_bands"), uJitter = u("u_jitter"), uSteep = u("u_steep");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [
    { data: mesh.positions, size: 3, type: gl.FLOAT, normalized: false, stride: 0 },
    { data: mesh.normals, size: 3, type: gl.BYTE, normalized: true, stride: 4 },
    { data: mesh.height, size: 1, type: gl.FLOAT, normalized: false, stride: 0 },
    { data: mesh.noise, size: 1, type: gl.UNSIGNED_BYTE, normalized: true, stride: 0 },
  ].map((a, i) => {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, a.size, a.type, a.normalized, a.stride, 0);
    return buf;
  });
  const idx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  return {
    draw(f, model, sun, range) {
      if (range.count === 0) return;
      gl.useProgram(p);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniform3f(uEye, f.eye[0], f.eye[1], f.eye[2]);
      gl.uniform3fv(uSky, f.sky);
      gl.uniform2f(uFog, f.fog[0], f.fog[1]);
      gl.uniform3f(uSun, sun[0], sun[1], sun[2]);
      gl.uniform3fv(uColors, style.colors);
      gl.uniform4f(uBands, ...style.bands);
      gl.uniform4f(uJitter, ...style.jitter);
      gl.uniform2f(uSteep, ...style.steep);
      gl.depthFunc(gl.LEQUAL);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, 4 * range.start);
      gl.bindVertexArray(null);
    },
    dispose() {
      for (const b of buffers) gl.deleteBuffer(b);
      gl.deleteBuffer(idx);
      gl.deleteVertexArray(vao);
    },
  };
}
