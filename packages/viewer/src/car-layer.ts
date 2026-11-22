// Vehicles (decision 27): one instanced draw per model per cell. Each model's
// mesh is uploaded once and shared; each cell uploads its instances once
// (position and forward vector in the cell frame) and is placed by the cell's
// model matrix, so a frame costs no CPU work per car. Colors come from the
// kit's shared palette texture. Models are double-sided (as the kit marks
// them), nudged toward the camera like the roads they stand on.
// Holds GPU handles only.

import type { ModelMesh, VehiclePlacements } from "@game/world";
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

export interface CarModels {
  /** One VAO-ready mesh per model index; the texture they share. */
  meshes: { vbo: WebGLBuffer[]; ibo: WebGLBuffer; count: number; triangles: number }[];
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

  const meshes = models.map((m) => {
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
  });

  // A palette of flat color swatches: nearest sampling keeps swatches from bleeding into each other.
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { meshes, texture, program: p };
}

export interface CarLayer {
  readonly count: number;
  draw(f: Frame, model: Float32Array, sun: readonly [number, number, number], bias: number): number;  // triangles drawn
  dispose(): void;
}

/** One cell's cars: an instance buffer and a VAO per model present. */
export function createCarLayer(gl: WebGL2RenderingContext, models: CarModels, cars: VehiclePlacements): CarLayer {
  const p = models.program;
  const u = (name: string) => gl.getUniformLocation(p, name);
  const uView = u("u_view"), uModel = u("u_model"), uEye = u("u_eye"), uBias = u("u_bias"), uTex = u("u_tex");
  const uSky = u("u_sky"), uFog = u("u_fog"), uSun = u("u_sun");

  // Instances grouped by model, so each model is one contiguous range.
  const order = Array.from({ length: cars.count }, (_, i) => i).sort((a, b) => cars.model[a]! - cars.model[b]!);
  const inst = new Float32Array(6 * cars.count);
  order.forEach((i, k) => {
    inst.set(cars.position.subarray(3 * i, 3 * i + 3), 6 * k);
    inst.set(cars.forward.subarray(3 * i, 3 * i + 3), 6 * k + 3);
  });
  const ibuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
  gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);

  const draws: { vao: WebGLVertexArrayObject; mesh: CarModels["meshes"][number]; instances: number }[] = [];
  for (let k = 0; k < order.length;) {
    const m = cars.model[order[k]!]!;
    let n = 0;
    while (k + n < order.length && cars.model[order[k + n]!] === m) n++;
    const mesh = models.meshes[m]!;
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
      gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 24, 24 * k + off);
      gl.vertexAttribDivisor(a, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bindVertexArray(null);
    draws.push({ vao, mesh, instances: n });
    k += n;
  }

  return {
    count: cars.count,
    draw(f, model, sun, bias) {
      if (draws.length === 0) return 0;
      gl.useProgram(p);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniformMatrix4fv(uModel, false, model);
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
      for (const d of draws) {
        gl.bindVertexArray(d.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, d.mesh.count, gl.UNSIGNED_INT, 0, d.instances);
        tris += d.mesh.triangles * d.instances;
      }
      gl.bindVertexArray(null);
      return tris;
    },
    dispose() {
      for (const d of draws) gl.deleteVertexArray(d.vao);
      gl.deleteBuffer(ibuf);
    },
  };
}
