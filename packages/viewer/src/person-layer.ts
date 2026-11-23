// People: one instanced draw of the figure (world's personMesh), walking in
// the vertex shader. Each instance is a position and forward vector (in the
// view frame, as the cars') and a walk: its phase (radians; a full turn is
// two steps), gait (0 standing, 1 walking, more running) and pose (POSE).
//
// The walk swings rigid parts, no skeleton: each leg about the hip by
// ±LEG_SWING·gait·sin(phase), the left and right opposite; each arm about the
// shoulder opposite its own side's leg, by ARM_SWING. The figure drops by as
// much as the swung leg rises (hip × (1 − cos angle)), so its feet stay on the
// ground. Sitting, the legs point straight ahead and the figure sits on the
// ground; lying, it lies on its back, head behind where it faced; shouting,
// both arms wave over its head; staggering, the body sways side to side
// about the feet, a sway each step. Same
// lighting and fog as the cars (car-layer's fragment shader). Holds GPU
// handles only.

import { HIP, PART, SHOULDER, type PersonMesh } from "@game/world";
import { compile, FRAGMENT } from "./car-layer.ts";
import type { Frame } from "./flat-layer.ts";

/** Radians at full gait. */
const LEG_SWING = 0.45, ARM_SWING = 0.35;
/** Floats per instance: position, forward, phase, gait, pose. */
export const PERSON_STRIDE = 9;
/** How a figure holds itself: upright, sitting, lying, shouting (arms up, waving), staggering (swaying side to side). */
export const POSE = { upright: 0, sit: 1, lie: 2, shout: 3, stagger: 4 } as const;
/** Staggering: how far the body sways either side, radians. */
const SWAY = 0.14;
/** Sitting on the ground: how far the hips are above it, m (the legs' half thickness). */
const SEAT = 0.08;

const VERTEX = `#version 300 es
uniform mat4 u_view;
uniform vec3 u_eye;
uniform float u_bias;
in vec3 a_pos;
in vec3 a_normal;
in vec2 a_uv;
in float a_part;
in vec3 i_pos;
in vec3 i_fwd;
in vec3 i_walk;
out vec3 v_world;
out vec3 v_normal;
out vec2 v_uv;
// Turns about the x axis (the figure's left–right) through a pivot at height h: positive swings forward.
vec3 swing(vec3 p, float a, float h) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, p.y * c - (p.z - h) * s, p.y * s + (p.z - h) * c + h);
}
vec3 turn(vec3 n, float a) {
  float c = cos(a), s = sin(a);
  return vec3(n.x, n.y * c - n.z * s, n.y * s + n.z * c);
}
void main() {
  float leg = ${LEG_SWING.toFixed(3)} * i_walk.y * sin(i_walk.x);  // the left leg's angle; the right's is −leg
  int part = int(a_part + 0.5);
  float a = 0.0, h = 0.0;
  if (part == ${PART.leftLeg}) { a = leg; h = ${HIP.toFixed(3)}; }
  else if (part == ${PART.rightLeg}) { a = -leg; h = ${HIP.toFixed(3)}; }
  else if (part == ${PART.leftArm}) { a = -leg * ${(ARM_SWING / LEG_SWING).toFixed(3)}; h = ${SHOULDER.toFixed(3)}; }
  else if (part == ${PART.rightArm}) { a = leg * ${(ARM_SWING / LEG_SWING).toFixed(3)}; h = ${SHOULDER.toFixed(3)}; }
  float pose = i_walk.z;
  bool legs = part == ${PART.leftLeg} || part == ${PART.rightLeg}, arms = part == ${PART.leftArm} || part == ${PART.rightArm};
  bool sit = pose > 0.5 && pose < 1.5, lie = pose > 1.5 && pose < 2.5, shout = pose > 2.5 && pose < 3.5, stagger = pose > 3.5;
  if (sit) {
    // Sitting: legs straight out ahead, hands on the knees.
    if (legs) { a = 1.571; h = ${HIP.toFixed(3)}; }
    if (arms) { a = 0.5; h = ${SHOULDER.toFixed(3)}; }
  }
  if (shout && arms) {
    // Shouting: both arms up over the head, waving, out of step with each other.
    a = 2.7 + 0.4 * sin(2.0 * i_walk.x + (part == ${PART.leftArm} ? 0.0 : 3.14));
    h = ${SHOULDER.toFixed(3)};
  }
  vec3 p = swing(a_pos, a, h);
  vec3 n = turn(a_normal, a);
  if (sit) p.z -= ${(HIP - SEAT).toFixed(3)};
  else if (lie) {
    // Lying on the back: the whole figure tipped over backward about its heels, then up off the ground by its back.
    p = swing(p, 1.571, 0.0);
    p.z += 0.1;
    n = turn(n, 1.571);
  } else p.z -= ${HIP.toFixed(3)} * (1.0 - cos(leg));
  if (stagger) {
    // Staggering: the whole body sways side to side about the feet, a sway each step.
    float r = ${SWAY.toFixed(3)} * sin(i_walk.x), c = cos(r), s = sin(r);
    p = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
    n = vec3(n.x * c - n.z * s, n.y, n.x * s + n.z * c);
  }
  vec3 f = normalize(i_fwd);
  vec3 r = normalize(cross(f, vec3(0.0, 0.0, 1.0)));
  vec3 u = cross(r, f);
  mat3 basis = mat3(r, f, u);
  vec3 world = i_pos + basis * p;
  v_world = world;
  vec3 toEye = u_eye - world;
  float d = length(toEye);
  world += toEye / d * min(d * 0.5, u_bias + 0.001 * d);
  gl_Position = u_view * vec4(world, 1.0);
  v_normal = basis * n;
  v_uv = a_uv;
}`;

export interface PersonInstances {
  /** PERSON_STRIDE floats per person, in the view frame. */
  data: Float32Array;
  count: number;
}

export interface PersonRenderer {
  draw(f: Frame, sun: readonly [number, number, number], bias: number, people: PersonInstances): number;  // triangles drawn
}

/** Uploads the figure and its palette texture once; draws every person in one call. */
export function createPersonRenderer(gl: WebGL2RenderingContext, mesh: PersonMesh, image: TexImageSource): PersonRenderer {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  ["a_pos", "a_normal", "a_uv", "a_part", "i_pos", "i_fwd", "i_walk"].forEach((name, i) => gl.bindAttribLocation(p, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  const u = (name: string) => gl.getUniformLocation(p, name);
  const uView = u("u_view"), uEye = u("u_eye"), uBias = u("u_bias"), uTex = u("u_tex");
  const uSky = u("u_sky"), uFog = u("u_fog"), uSun = u("u_sun");

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const parts = Float32Array.from(mesh.parts);
  [[mesh.positions, 3], [mesh.normals, 3], [mesh.uvs, 2], [parts, 1]].forEach(([data, size], a) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data as Float32Array, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, size as number, gl.FLOAT, false, 0, 0);
  });
  const ibuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
  for (const [a, size, off] of [[4, 3, 0], [5, 3, 12], [6, 3, 24]] as const) {
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, size, gl.FLOAT, false, 4 * PERSON_STRIDE, off);
    gl.vertexAttribDivisor(a, 1);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const count = mesh.indices.length;

  // A palette of flat color swatches: nearest sampling keeps swatches from bleeding into each other.
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return {
    draw(f, sun, bias, people) {
      if (people.count === 0) return 0;
      gl.useProgram(p);
      gl.uniformMatrix4fv(uView, false, f.view);
      gl.uniform3f(uEye, f.eye[0], f.eye[1], f.eye[2]);
      gl.uniform1f(uBias, bias);
      gl.uniform3fv(uSky, f.sky);
      gl.uniform2f(uFog, f.fog[0], f.fog[1]);
      gl.uniform3f(uSun, sun[0], sun[1], sun[2]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(uTex, 0);
      gl.depthFunc(gl.LEQUAL);
      gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
      gl.bufferData(gl.ARRAY_BUFFER, people.data.subarray(0, PERSON_STRIDE * people.count), gl.DYNAMIC_DRAW);
      gl.bindVertexArray(vao);
      gl.drawElementsInstanced(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0, people.count);
      gl.bindVertexArray(null);
      return (count / 3) * people.count;
    },
  };
}
