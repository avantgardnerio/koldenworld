// People: one instanced draw of the figure (world's personMesh), walking in
// the vertex shader. Each instance is a position and forward vector (in the
// view frame, as the cars') and a walk: its phase (radians; a full turn is
// two steps), gait (0 standing, 1 walking, more running) and pose (POSE).
//
// The walk swings rigid parts, no skeleton: each thigh about the hip by
// ±LEG_SWING·gait·sin(phase), the left and right opposite; each upper arm
// about the shoulder opposite its own side's leg, by ARM_SWING. A shin bends
// back at the knee as its leg swings forward (up to KNEE_BEND·gait), lifting
// the foot clear; the elbows stay a little bent walking and bend toward a
// right angle running. The figure drops by as much as the straight standing
// leg rises (hip × (1 − cos angle)), so its feet stay on the ground. Sitting, the legs point straight ahead and the figure sits on the
// ground; lying, it lies on its back, head behind where it faced; shouting,
// both arms wave over its head; staggering, the body sways side to side
// about the feet, a sway each step. Same
// lighting and fog as the cars (car-layer's fragment shader). Holds GPU
// handles only.

import { ELBOW, HIP, KNEE, PART, SHOULDER, type PersonMesh } from "@game/world";
import { compile, FRAGMENT } from "./car-layer.ts";
import type { Frame } from "./flat-layer.ts";

/** Radians at full gait. */
const LEG_SWING = 0.45, ARM_SWING = 0.35;
/** Radians: the most a knee bends at a walk (more running); the elbows' bend at a walk, and how much more running. */
const KNEE_BEND = 0.9, ELBOW_BEND = 0.15, ELBOW_RUN = 1.1;
/** Floats per instance: position, forward, phase, gait, pose, aim (radians up, aiming). */
export const PERSON_STRIDE = 10;
/**
 * How a figure holds itself: upright, sitting, lying, shouting (arms up, waving), staggering (swaying side to side),
 * aiming (the right arm straight out, `aim` radians up from level), carrying (a gun in the right hand: the arm
 * locked straight down, so it points at the ground, however they move). Aiming and carrying walk as upright.
 */
export const POSE = { upright: 0, sit: 1, lie: 2, shout: 3, stagger: 4, aim: 5, carry: 6 } as const;
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
in vec4 i_walk;
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
  float ph = i_walk.x, gait = i_walk.y, pose = i_walk.z;
  bool sit = pose > 0.5 && pose < 1.5, lie = pose > 1.5 && pose < 2.5, shout = pose > 2.5 && pose < 3.5;
  bool stagger = pose > 3.5 && pose < 4.5, aim = pose > 4.5 && pose < 5.5, carry = pose > 5.5;
  float leg = ${LEG_SWING.toFixed(3)} * gait * sin(ph);  // the left thigh's angle; the right's is −leg
  // Each side's joints (x left, y right): thigh and upper arm swing, knee and elbow bend. A knee bends as its leg
  // swings forward; elbows bend a little walking and toward a right angle running.
  vec2 thigh = vec2(leg, -leg);
  vec2 knee = ${KNEE_BEND.toFixed(3)} * gait * max(vec2(cos(ph), -cos(ph)), 0.0);
  vec2 arm = vec2(-leg, leg) * ${(ARM_SWING / LEG_SWING).toFixed(3)};
  vec2 elbow = vec2(${ELBOW_BEND.toFixed(3)} + ${ELBOW_RUN.toFixed(3)} * clamp(gait - 1.0, 0.0, 1.0));
  if (sit) {
    // Sitting: legs straight out ahead, hands on the knees.
    thigh = vec2(1.571);
    knee = vec2(0.0);
    arm = vec2(0.5);
    elbow = vec2(0.5);
  }
  if (shout) {
    // Shouting: both arms up over the head, waving, out of step with each other.
    arm = 2.7 + 0.4 * vec2(sin(2.0 * ph), sin(2.0 * ph + 3.14));
    elbow = vec2(0.3);
  }
  if (aim) {
    // Aiming: the right arm straight out ahead, tipped up (or down) with the aim.
    arm.y = 1.571 + i_walk.w;
    elbow.y = 0.0;
  }
  if (carry) {
    // Carrying a gun: the right arm locked straight down, no swing, no bend.
    arm.y = 0.0;
    elbow.y = 0.0;
  }
  int part = int(a_part + 0.5);
  bool left = part == ${PART.leftLeg} || part == ${PART.leftShin} || part == ${PART.leftArm} || part == ${PART.leftForearm};
  bool shin = part == ${PART.leftShin} || part == ${PART.rightShin};
  bool forearm = part == ${PART.leftForearm} || part == ${PART.rightForearm};
  bool legs = shin || part == ${PART.leftLeg} || part == ${PART.rightLeg};
  bool arms = forearm || part == ${PART.leftArm} || part == ${PART.rightArm};
  // This side's joints.
  float th = left ? thigh.x : thigh.y, kn = left ? knee.x : knee.y, ar = left ? arm.x : arm.y, el = left ? elbow.x : elbow.y;
  vec3 p = a_pos, n = a_normal;
  // A shin bends back at the knee, then swings with its thigh at the hip; a forearm bends forward at the elbow, then
  // swings with its upper arm at the shoulder.
  if (shin) { p = swing(p, -kn, ${KNEE.toFixed(3)}); n = turn(n, -kn); }
  if (legs) { p = swing(p, th, ${HIP.toFixed(3)}); n = turn(n, th); }
  if (forearm) { p = swing(p, el, ${ELBOW.toFixed(3)}); n = turn(n, el); }
  if (arms) { p = swing(p, ar, ${SHOULDER.toFixed(3)}); n = turn(n, ar); }
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
  for (const [a, size, off] of [[4, 3, 0], [5, 3, 12], [6, 4, 24]] as const) {
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
