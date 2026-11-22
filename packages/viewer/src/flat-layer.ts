// A mesh on the ground with a material index per vertex: the graph overlay. Positions are in a cell's frame, 2D (z = 0) or 3D; each
// draw places the mesh with that cell's model matrix. Buffers are uploaded
// once; each draw is one call. Layers hold GPU handles only, no game state.
//
// On terrain, ground layers are depth-tested like everything else, nudged
// toward the camera (`bias` m, growing slightly with distance) so they win
// against the ground they lie on but still hide behind hills. With bias 0 they
// are painted in order instead.
//
// Ground layers are coplanar, so they are painted in order (depth test
// ALWAYS) while still writing depth, so that buildings drawn afterwards are
// depth-tested against the ground and against each other. Fog blends toward the sky color by distance.

export const MAX_MATERIALS = 16;

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform mat4 u_model;
uniform vec3 u_colors[${MAX_MATERIALS}];
uniform vec3 u_eye;
uniform float u_bias;
in vec3 a_pos;  // z defaults to 0 for 2D positions
in uint a_mat;
out vec3 v_world;
out vec3 v_color;
void main() {
  vec4 world = u_model * vec4(a_pos, 1.0);
  v_world = world.xyz;
  if (u_bias > 0.0) {
    vec3 toEye = u_eye - world.xyz;
    float d = length(toEye);
    world.xyz += toEye / d * min(d * 0.5, u_bias + 0.001 * d);
  }
  gl_Position = u_view * world;
  v_color = u_colors[a_mat];
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_eye;
uniform vec3 u_sky;
uniform vec2 u_fog;   // start, end (m)
in vec3 v_world;
in vec3 v_color;
out vec4 color;
void main() {
  float d = distance(v_world, u_eye);
  color = vec4(mix(v_color, u_sky, smoothstep(u_fog.x, u_fog.y, d)), 1.0);
}`;

export interface FlatMesh {
  positions: Float32Array;  // x, y (or x, y, z with dims 3) interleaved, m
  dims?: 2 | 3;             // default 2
  material: Uint8Array;     // per vertex
  indices: Uint32Array;
}

export interface Frame {
  view: Float32Array;  // view frame → clip
  eye: readonly [number, number, number];
  sky: Float32Array;
  fog: readonly [number, number];
}

export interface FlatLayer {
  draw(f: Frame, model: Float32Array): void;  // model: mesh frame → view frame, column-major
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
  gl.bindAttribLocation(p, 0, "a_pos");
  gl.bindAttribLocation(p, 1, "a_mat");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  programs.set(gl, p);
  return p;
}

export function createFlatLayer(
  gl: WebGL2RenderingContext,
  mesh: FlatMesh,
  opts: { mode: GLenum; colors: Float32Array; bias?: number },
): FlatLayer {
  if (opts.colors.length > 3 * MAX_MATERIALS) throw new Error("too many materials");
  const p = program(gl);
  const u = (name: string) => gl.getUniformLocation(p, name);
  const uView = u("u_view"), uModel = u("u_model"), uColors = u("u_colors");
  const uEye = u("u_eye"), uSky = u("u_sky"), uFog = u("u_fog"), uBias = u("u_bias");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pos = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, mesh.dims ?? 2, gl.FLOAT, false, 0, 0);
  const mat = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, mat);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.material, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_BYTE, 0, 0);
  const idx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const count = mesh.indices.length;

  return {
    draw(f, model) {
      if (count === 0) return;
      gl.useProgram(p);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniform3fv(uColors, opts.colors);
      gl.uniform3f(uEye, f.eye[0], f.eye[1], f.eye[2]);
      gl.uniform3fv(uSky, f.sky);
      gl.uniform2f(uFog, f.fog[0], f.fog[1]);
      gl.uniform1f(uBias, opts.bias ?? 0);
      gl.depthFunc(opts.bias ? gl.LEQUAL : gl.ALWAYS);
      gl.bindVertexArray(vao);
      gl.drawElements(opts.mode, count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.deleteBuffer(pos);
      gl.deleteBuffer(mat);
      gl.deleteBuffer(idx);
      gl.deleteVertexArray(vao);
    },
  };
}
