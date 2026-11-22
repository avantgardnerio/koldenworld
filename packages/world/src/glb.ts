// A minimal binary glTF (.glb) reader for static models (decision 27): every
// mesh node in the default scene, with its node transforms applied, merged
// into one indexed mesh. Enough for the Kenney vehicles: triangles, float
// positions / normals / UVs, 8/16/32-bit indices, one texture referenced by
// URI. No skins, morphs, animations or Draco.
//
// glTF is Y-up with models facing +Z, so the model's right is -X. We are Z-up,
// facing +Y, right +X: (x, y, z)_ours = (-x, z, y)_glTF, a proper rotation.

export interface ModelMesh {
  positions: Float32Array;  // x right, y forward, z up, m
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  image?: string;           // the base color texture's URI, if any
}

interface Gltf {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: { mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number; material?: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; type: string; count: number }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: { pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  textures?: { source: number }[];
  images?: { uri?: string }[];
}

type Mat4 = number[];  // column-major

const SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

function trs(n: Gltf["nodes"][number]): Mat4 {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, 2 * (x! * y! + z! * w!) * sx!, 2 * (x! * z! - y! * w!) * sx!, 0,
    2 * (x! * y! - z! * w!) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, 2 * (y! * z! + x! * w!) * sy!, 0,
    2 * (x! * z! + y! * w!) * sz!, 2 * (y! * z! - x! * w!) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

export function readGlb(bytes: Uint8Array, scale = 1): ModelMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file");
  let json: Gltf | undefined, bin: Uint8Array | undefined;
  for (let pos = 12; pos < bytes.length;) {
    const len = view.getUint32(pos, true), type = view.getUint32(pos + 4, true);
    const chunk = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
    else if (type === 0x004e4942) bin = chunk;
    pos += 8 + len;
  }
  if (!json || !bin) throw new Error("GLB without JSON or BIN chunk");
  const g = json, b = bin;

  /** An accessor's values as plain numbers, `size` per element, honoring byte stride. */
  const read = (index: number): { size: number; values: number[] } => {
    const a = g.accessors[index]!, bv = g.bufferViews[a.bufferView]!, size = SIZE[a.type]!;
    const width = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
    if (!width) throw new Error(`unsupported component type ${a.componentType}`);
    const stride = bv.byteStride ?? width * size;
    const dv = new DataView(b.buffer, b.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0));
    const values: number[] = [];
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < size; k++) {
        const o = i * stride + k * width;
        values.push(a.componentType === 5126 ? dv.getFloat32(o, true)
          : a.componentType === 5125 ? dv.getUint32(o, true)
          : a.componentType === 5123 ? dv.getUint16(o, true)
          : a.componentType === 5122 ? dv.getInt16(o, true)
          : a.componentType === 5121 ? dv.getUint8(o) : dv.getInt8(o));
      }
    }
    return { size, values };
  };

  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  let image: string | undefined;
  const visit = (nodeIndex: number, parent: Mat4) => {
    const node = g.nodes[nodeIndex]!, m = mul(parent, trs(node));
    if (node.mesh !== undefined) {
      for (const prim of g.meshes[node.mesh]!.primitives) {
        if ((prim.mode ?? 4) !== 4) continue;  // triangles only
        const base = positions.length / 3;
        const p = read(prim.attributes.POSITION!).values;
        const n = prim.attributes.NORMAL !== undefined ? read(prim.attributes.NORMAL).values : null;
        const t = prim.attributes.TEXCOORD_0 !== undefined ? read(prim.attributes.TEXCOORD_0).values : null;
        for (let i = 0; i < p.length / 3; i++) {
          const [x, y, z] = [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
          const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
          const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
          positions.push(-wx * scale, wz * scale, wy * scale);
          if (n) {
            const [a, c, d] = [n[3 * i]!, n[3 * i + 1]!, n[3 * i + 2]!];
            const nx = m[0]! * a + m[4]! * c + m[8]! * d, ny = m[1]! * a + m[5]! * c + m[9]! * d, nz = m[2]! * a + m[6]! * c + m[10]! * d;
            const len = Math.hypot(nx, ny, nz) || 1;
            normals.push(-nx / len, nz / len, ny / len);
          } else normals.push(0, 0, 1);
          uvs.push(t ? t[2 * i]! : 0, t ? t[2 * i + 1]! : 0);
        }
        const idx = prim.indices !== undefined ? read(prim.indices).values : p.map((_, i) => i).filter((i) => i < p.length / 3);
        for (const i of idx) indices.push(base + i);
        const tex = prim.material !== undefined ? g.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture : undefined;
        if (tex && !image) image = g.images?.[g.textures?.[tex.index]?.source ?? -1]?.uri;
      }
    }
    for (const c of node.children ?? []) visit(c, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const n of g.scenes[g.scene ?? 0]!.nodes) visit(n, identity);

  return {
    positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices), ...(image ? { image } : {}),
  };
}
