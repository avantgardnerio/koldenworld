// The sun's disc: a yellow point at infinity toward the sun (world sun.ts, in the view frame: east-north-up at the
// camera), larger than the real sun so it reads as one, softly edged. At the far plane's depth, so terrain and
// buildings in front hide it; drawn after them, blended, without writing depth. Holds GPU handles only.

import { FOV_Y } from "./camera.ts";
import type { Frame } from "./flat-layer.ts";

/** The disc's diameter, degrees (the real sun is 0.53°). */
const SUN_DIAMETER_DEG = 2.5;

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform vec3 u_dir;    // toward the sun
uniform float u_size;  // diameter, pixels
void main() {
  gl_Position = u_view * vec4(u_dir, 0.0);               // a direction: no translation, at infinity
  gl_Position.z = gl_Position.w * 0.99999;               // just inside the far plane
  gl_PointSize = u_size;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
out vec4 color;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;           // 0 at the center, 1 at the edge
  if (r > 1.0) discard;
  float edge = 1.0 - smoothstep(0.8, 1.0, r);
  color = vec4(1.0, 0.92, 0.45, edge);
}`;

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

export interface SunLayer {
  /** dir: toward the sun in the view frame (any length); heightPx: the drawing buffer's height. */
  draw(f: Frame, dir: readonly [number, number, number], heightPx: number): void;
}

export function createSunLayer(gl: WebGL2RenderingContext): SunLayer {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  const uView = gl.getUniformLocation(p, "u_view"), uDir = gl.getUniformLocation(p, "u_dir");
  const uSize = gl.getUniformLocation(p, "u_size");
  const vao = gl.createVertexArray();  // no attributes: one point, all from uniforms
  const [, maxPoint] = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
  return {
    draw(f, dir, heightPx) {
      const n = Math.hypot(dir[0], dir[1], dir[2]);
      if (n === 0 || dir[2] / n < -0.05) return;  // below the horizon
      gl.useProgram(p);
      gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniform3f(uDir, dir[0] / n, dir[1] / n, dir[2] / n);
      gl.uniform1f(uSize, Math.min(maxPoint, ((SUN_DIAMETER_DEG * Math.PI) / 180 / FOV_Y) * heightPx));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.depthFunc(gl.LEQUAL);
      gl.drawArrays(gl.POINTS, 0, 1);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
  };
}
