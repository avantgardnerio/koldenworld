// GPU side of a RoadLineMesh: buffers are uploaded once, then each draw is one
// call with the camera matrix. The layer holds GPU handles only, no game state.

import { ROAD_CLASSES, type RoadLineMesh } from "@game/world";

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform vec3 u_colors[${ROAD_CLASSES.length}];
in vec2 a_pos;
in uint a_class;
out vec3 v_color;
void main() {
  gl_Position = u_view * vec4(a_pos, 0.0, 1.0);
  v_color = u_colors[a_class];
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 color;
void main() { color = vec4(v_color, 1.0); }`;

export interface RoadLayer {
  draw(view: Float32Array): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}

function link(gl: WebGL2RenderingContext): WebGLProgram {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.bindAttribLocation(p, 0, "a_pos");
  gl.bindAttribLocation(p, 1, "a_class");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export function createRoadLayer(gl: WebGL2RenderingContext, mesh: RoadLineMesh, colors: Float32Array): RoadLayer {
  const program = link(gl);
  const uView = gl.getUniformLocation(program, "u_view");
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // The positions are views onto the fetched Arrow file: they go to the GPU as is.
  const pos = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const cls = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cls);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.pointClass, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_BYTE, 0, 0);

  const idx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  gl.useProgram(program);
  gl.uniform3fv(gl.getUniformLocation(program, "u_colors"), colors);
  const count = mesh.indices.length;

  return {
    draw(view) {
      gl.useProgram(program);
      gl.uniformMatrix4fv(uView, false, view);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.LINES, count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.deleteBuffer(pos);
      gl.deleteBuffer(cls);
      gl.deleteBuffer(idx);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
