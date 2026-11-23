// Vehicles (decisions 27, 28): one instanced draw per model. Each model's mesh
// is uploaded once; every frame the cars' poses (position and forward vector,
// already in the view frame) are written into one instance buffer per model.
// Colors come from the kit's shared palette texture. Models are double-sided (as the kit marks
// them), nudged toward the camera like the roads they stand on. Past a renderer's LOD distance a
// model is drawn as its stand-in instead: a body and a cabin, two boxes from its bounding box (24
// triangles, not ~1,400), in the swatch its largest triangles use.
// Holds GPU handles only.

import type { ModelMesh } from "@game/world";
import type { Frame } from "./flat-layer.ts";

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform mat4 u_model;
uniform vec3 u_eye;
uniform float u_bias;
in vec3 a_pos;
in vec3 a_normal;
in vec2 a_uv;
in vec3 i_pos;
in vec3 i_fwd;
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
void main() {
  vec3 f = normalize(i_fwd);
  vec3 r = normalize(cross(f, vec3(0.0, 0.0, 1.0)));
  vec3 u = cross(r, f);
  mat3 basis = mat3(r, f, u);
  vec4 world = u_model * vec4(i_pos + basis * a_pos, 1.0);
  v_world = world.xyz;
  vec3 toEye = u_eye - world.xyz;
  float d = length(toEye);
  world.xyz += toEye / d * min(d * 0.5, u_bias + 0.001 * d);
  gl_Position = u_view * world;
  v_normal = mat3(u_model) * (basis * a_normal);
  v_uv = a_uv;
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
  float light = 0.55 + 0.45 * max(dot(n, u_sun), 0.0) + 0.08 * n.z;
  vec3 c = texture(u_tex, v_uv).rgb * light;
  float d = distance(v_world, u_eye);
  color = vec4(mix(c, u_sky, smoothstep(u_fog.x, u_fog.y, d)), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

type GpuMesh = { vbo: WebGLBuffer[]; ibo: WebGLBuffer; count: number; triangles: number };

export interface CarModels {
  /** One VAO-ready mesh per model index, and its far stand-in; the texture they share. */
  meshes: GpuMesh[];
  standIns: GpuMesh[];
  texture: WebGLTexture;
  program: WebGLProgram;
}

/** Uploads the models and their palette texture once. */
export function createCarModels(gl: WebGL2RenderingContext, models: ModelMesh[], image: TexImageSource): CarModels {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  ["a_pos", "a_normal", "a_uv", "i_pos", "i_fwd"].forEach((name, i) => gl.bindAttribLocation(p, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);

  const upload = (m: ModelMesh): GpuMesh => {
    const vbo = [m.positions, m.normals, m.uvs].map((data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return b;
    });
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    return { vbo, ibo, count: m.indices.length, triangles: m.indices.length / 3 };
  };
  const meshes = models.map(upload);
  const standIns = models.map((m) => upload(standIn(m)));

  // A palette of flat color swatches: nearest sampling keeps swatches from bleeding into each other.
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { meshes, standIns, texture, program: p };
}

/** A model's far stand-in: a body (the bounding box's lower 55%) and a cabin above it (inset), in its main swatch. */
export function standIn(m: ModelMesh): ModelMesh {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, m.positions[i + k]!);
      hi[k] = Math.max(hi[k]!, m.positions[i + k]!);
    }
  }
  // The swatch of the largest triangle: the body's color, for a car.
  let best = 0, uv: [number, number] = [0, 0];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!].map((v) => 3 * v);
    const e = [0, 1, 2].map((k) => m.positions[b! + k]! - m.positions[a! + k]!);
    const g = [0, 1, 2].map((k) => m.positions[c! + k]! - m.positions[a! + k]!);
    const area = Math.hypot(e[1]! * g[2]! - e[2]! * g[1]!, e[2]! * g[0]! - e[0]! * g[2]!, e[0]! * g[1]! - e[1]! * g[0]!);
    if (area > best) [best, uv] = [area, [m.uvs[(2 * a!) / 3]!, m.uvs[(2 * a!) / 3 + 1]!]];
  }
  const [w, l, h] = [0, 1, 2].map((k) => hi[k]! - lo[k]!);
  const split = lo[2]! + 0.55 * h!;
  const boxes: [number[], number[]][] = [
    [[lo[0]!, lo[1]!, lo[2]!], [hi[0]!, hi[1]!, split]],
    [[lo[0]! + 0.12 * w!, lo[1]! + 0.25 * l!, split], [hi[0]! - 0.12 * w!, hi[1]! - 0.2 * l!, hi[2]!]],
  ];
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const [a, b] of boxes) {
    // Six faces, four corners each, counterclockwise from outside.
    for (const [axis, side] of [[0, -1], [0, 1], [1, -1], [1, 1], [2, -1], [2, 1]] as const) {
      const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
      const at = (du: number, dv: number) => {
        const p = [0, 0, 0];
        p[axis] = side < 0 ? a[axis]! : b[axis]!;
        p[u] = du ? b[u]! : a[u]!;
        p[v] = dv ? b[v]! : a[v]!;
        return p;
      };
      const first = positions.length / 3;
      const corners = side > 0 ? [at(0, 0), at(1, 0), at(1, 1), at(0, 1)] : [at(0, 0), at(0, 1), at(1, 1), at(1, 0)];
      for (const p of corners) {
        positions.push(...p);
        const n = [0, 0, 0];
        n[axis] = side;
        normals.push(...n);
        uvs.push(...uv);
      }
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  }
  return {
    positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}

export interface CarInstances {
  /** Per model: position (x, y, z) and forward (x, y, z) per car, in the view frame. */
  data: Float32Array[];
  count: number[];
}

export interface CarRenderer {
  draw(f: Frame, sun: readonly [number, number, number], bias: number, cars: CarInstances): number;  // triangles drawn
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Moving cars: one instance buffer per model, refilled every frame. Cars farther than `lodDistance` m from the eye
 * are drawn as their model's stand-in.
 */
export function createCarRenderer(gl: WebGL2RenderingContext, models: CarModels, lodDistance = Infinity): CarRenderer {
  const p = models.program;
  const u = (name: string) => gl.getUniformLocation(p, name);
  const uView = u("u_view"), uModel = u("u_model"), uEye = u("u_eye"), uBias = u("u_bias"), uTex = u("u_tex");
  const uSky = u("u_sky"), uFog = u("u_fog"), uSun = u("u_sun");

  const bind = (mesh: GpuMesh) => {
    const ibuf = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    [3, 3, 2].forEach((size, a) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo[a]!);
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, size, gl.FLOAT, false, 0, 0);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    for (const [a, off] of [[3, 0], [4, 12]] as const) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 24, off);
      gl.vertexAttribDivisor(a, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bindVertexArray(null);
    return { vao, ibuf, mesh };
  };
  const near = models.meshes.map(bind), far = models.standIns.map(bind);
  // Each model's instances split by distance, reused every frame.
  let nearData = new Float32Array(0), farData = new Float32Array(0);

  return {
    draw(f, sun, bias, cars) {
      gl.useProgram(p);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniformMatrix4fv(uModel, false, IDENTITY);
      gl.uniform3f(uEye, f.eye[0], f.eye[1], f.eye[2]);
      gl.uniform1f(uBias, bias);
      gl.uniform3fv(uSky, f.sky);
      gl.uniform2f(uFog, f.fog[0], f.fog[1]);
      gl.uniform3f(uSun, sun[0], sun[1], sun[2]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, models.texture);
      gl.uniform1i(uTex, 0);
      gl.depthFunc(gl.LEQUAL);
      let tris = 0;
      const lod2 = lodDistance * lodDistance;
      const drawSet = ({ vao, ibuf, mesh }: (typeof near)[number], data: Float32Array, n: number) => {
        if (n === 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
        gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, 6 * n), gl.DYNAMIC_DRAW);
        gl.bindVertexArray(vao);
        gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0, n);
        tris += mesh.triangles * n;
      };
      for (let m = 0; m < near.length; m++) {
        const n = cars.count[m]!, data = cars.data[m]!;
        if (n === 0) continue;
        if (nearData.length < 6 * n) [nearData, farData] = [new Float32Array(12 * n), new Float32Array(12 * n)];
        let nn = 0, nf = 0;
        for (let i = 0; i < n; i++) {
          const o = 6 * i;
          const dx = data[o]! - f.eye[0], dy = data[o + 1]! - f.eye[1], dz = data[o + 2]! - f.eye[2];
          if (dx * dx + dy * dy + dz * dz > lod2) farData.set(data.subarray(o, o + 6), 6 * nf++);
          else nearData.set(data.subarray(o, o + 6), 6 * nn++);
        }
        drawSet(near[m]!, nearData, nn);
        drawSet(far[m]!, farData, nf);
      }
      gl.bindVertexArray(null);
      return tris;
    },
  };
}
