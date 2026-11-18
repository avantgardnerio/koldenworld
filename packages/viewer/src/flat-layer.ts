// A mesh lying on the ground plane (z = 0) with a material index per vertex:
// the ground, the road surface, the graph overlay. Buffers are uploaded once;
// each draw is one call. Layers hold GPU handles only, no game state.
//
// Ground layers are coplanar, so they are painted in order (depth test
// ALWAYS) while still writing depth, so that buildings drawn afterwards are
// depth-tested against the ground and against each other. Fog blends toward the sky color by distance; "fade" materials (the
// thin lane markings) blend into material 0 at a distance, before they would
// shimmer at sub-pixel widths.

export const MAX_MATERIALS = 16;

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform vec3 u_colors[${MAX_MATERIALS}];
uniform bool u_fadeToBase;
in vec2 a_pos;
in uint a_mat;
out vec2 v_world;
out vec3 v_color;
out vec3 v_base;
void main() {
  gl_Position = u_view * vec4(a_pos, 0.0, 1.0);
  v_world = a_pos;
  v_color = u_colors[a_mat];
  v_base = u_fadeToBase && a_mat > 0u ? u_colors[0] : v_color;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_eye;
uniform vec3 u_sky;
uniform vec2 u_fog;   // start, end (m)
uniform vec2 u_fade;  // start, end (m)
in vec2 v_world;
in vec3 v_color;
in vec3 v_base;
out vec4 color;
void main() {
  float d = distance(vec3(v_world, 0.0), u_eye);
  vec3 c = mix(v_color, v_base, smoothstep(u_fade.x, u_fade.y, d));
  color = vec4(mix(c, u_sky, smoothstep(u_fog.x, u_fog.y, d)), 1.0);
}`;

export interface FlatMesh {
  positions: Float32Array;  // x, y interleaved, m
  material: Uint8Array;     // per vertex
  indices: Uint32Array;
}

export interface Frame {
  view: Float32Array;  // world → clip
  eye: readonly [number, number, number];
  sky: Float32Array;
  fog: readonly [number, number];
  fade: readonly [number, number];
}

export interface FlatLayer {
  draw(f: Frame): void;
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
  opts: { mode: GLenum; colors: Float32Array; fadeToBase: boolean },
): FlatLayer {
  if (opts.colors.length > 3 * MAX_MATERIALS) throw new Error("too many materials");
  const p = program(gl);
  const u = (name: string) => gl.getUniformLocation(p, name);
  const uView = u("u_view"), uColors = u("u_colors"), uFadeToBase = u("u_fadeToBase");
  const uEye = u("u_eye"), uSky = u("u_sky"), uFog = u("u_fog"), uFade = u("u_fade");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pos = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
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
    draw(f) {
      gl.useProgram(p);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniform3fv(uColors, opts.colors);
      gl.uniform1i(uFadeToBase, opts.fadeToBase ? 1 : 0);
      gl.uniform3f(uEye, f.eye[0], f.eye[1], f.eye[2]);
      gl.uniform3fv(uSky, f.sky);
      gl.uniform2f(uFog, f.fog[0], f.fog[1]);
      gl.uniform2f(uFade, f.fade[0], f.fade[1]);
      gl.depthFunc(gl.ALWAYS);
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

/** A square of ground centered on (cx, cy), one material. */
export function groundMesh(cx: number, cy: number, half: number): FlatMesh {
  return {
    positions: new Float32Array([cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half]),
    material: new Uint8Array(4),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}
