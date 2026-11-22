// Contrails (decision 31): white ribbons behind planes in the air, facing the
// camera, widening and fading with age. They're how high or distant planes are
// seen, so they never get thinner than about a pixel, take only a little fog,
// and are pulled in from beyond the far plane instead of being clipped. Drawn
// last, blended, without writing depth. Holds GPU handles only.

import { FOV_Y } from "./camera.ts";
import type { Frame } from "./flat-layer.ts";
import type { ContrailMesh } from "./air-traffic.ts";

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform vec3 u_eye;
uniform float u_pixel;  // radians per pixel
in vec3 a_pos;
in vec3 a_dir;
in float a_age;
in float a_side;
out float v_alpha;
void main() {
  vec3 toEye = u_eye - a_pos;
  float d = length(toEye);
  vec3 c = cross(a_dir, toEye / d);
  vec3 side = length(c) > 1e-4 ? normalize(c) : vec3(0.0, 0.0, 1.0);
  float hw = max(mix(3.0, 28.0, a_age), d * u_pixel * 0.8);
  gl_Position = u_view * vec4(a_pos + side * hw * a_side, 1.0);
  gl_Position.z = min(gl_Position.z, gl_Position.w * 0.99999);  // beyond the far plane: just inside it
  float fade = 1.0 - a_age;
  v_alpha = 0.8 * fade * fade * mix(1.0, 0.6, smoothstep(30000.0, 120000.0, d));
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in float v_alpha;
out vec4 color;
void main() {
  color = vec4(1.0, 1.0, 1.0, v_alpha);
}`;

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

export interface ContrailLayer {
  /** heightPx: the drawing buffer's height, for the one-pixel minimum width. */
  draw(f: Frame, mesh: ContrailMesh, heightPx: number): void;
}

export function createContrailLayer(gl: WebGL2RenderingContext): ContrailLayer {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  ["a_pos", "a_dir", "a_age", "a_side"].forEach((name, i) => gl.bindAttribLocation(p, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  const uView = gl.getUniformLocation(p, "u_view"), uEye = gl.getUniformLocation(p, "u_eye"), uPixel = gl.getUniformLocation(p, "u_pixel");

  const vbo = gl.createBuffer(), ibo = gl.createBuffer(), vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  [[0, 3, 0], [1, 3, 12], [2, 1, 24], [3, 1, 28]].forEach(([a, size, off]) => {
    gl.enableVertexAttribArray(a!);
    gl.vertexAttribPointer(a!, size!, gl.FLOAT, false, 32, off!);
  });
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bindVertexArray(null);

  return {
    draw(f, mesh, heightPx) {
      if (mesh.count === 0) return;
      gl.useProgram(p);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniform3f(uEye, f.eye[0], f.eye[1], f.eye[2]);
      gl.uniform1f(uPixel, (2 * Math.tan(FOV_Y / 2)) / Math.max(1, heightPx));
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.data.subarray(0, 8 * mesh.vertices), gl.DYNAMIC_DRAW);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices.subarray(0, mesh.count), gl.DYNAMIC_DRAW);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
  };
}
