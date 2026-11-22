// Polygon booleans by slabs, tracked by index. No tolerances, no objects:
// vertices are indices into a Verts table, and everything else is columns.
//
// 1. Every polygon's edges; edges two polygons share (the same two vertices)
//    are one line, so whatever crosses it crosses it once. Lines are split
//    where they cross (one new vertex, shared) and where a vertex lies exactly
//    on them (at that vertex's own index). Exact zeros that indices don't
//    explain are counted in `events`, not hidden.
// 2. Pieces: lines cut at their vertices. Pieces with the same two ends are one
//    piece, carrying each polygon's winding change across it.
// 3. A sweep upward through every vertex's y (equal y: one line). In a slab no
//    pieces cross, so they sort left to right; walking them, winding numbers
//    change at each piece, and each operand keeps a count of its polygons
//    winding non-zero and winding positive: `inside(nz, pos)` picks the cells
//    (Vatti's part).
// 4. The outline: pieces with the result on one side only (decided once per
//    piece; nothing crosses one, so its sides never change along it),
//    directed with the result on their left, stitched by index into loops,
//    taking the sharpest right turn where several continue from a vertex, and
//    split where a loop touches itself into simple loops (Weiler's part).
//
// Polygons are turned counterclockwise as a whole first, so winding +1 is a
// polygon's normal inside and −1 a part of it turned inside out.

import { F64, I32, RingsBuilder, ringArea, ringCount, sortBy, type Rings, type Verts } from "./arrays.ts";

export interface SlabEvents {
  crossings: number;   // new vertices made where two lines cross
  touches: number;     // a vertex exactly on another polygon's line
  overlaps: number;    // two lines exactly collinear and overlapping
  ties: number;        // two different pieces at exactly the same place in a slab
  disagree: number;    // a piece whose sides came out differently in two slabs
}

export interface SlabResult {
  loops: Rings;        // the result on their left: outer loops counterclockwise, holes clockwise
  events: SlabEvents;
  tied: Int32Array;    // per tie: the two pieces' ends (lo, hi, lo, hi)
}

const KEY = 67108864;  // 2^26: vertex index pairs as one number (fewer than 2^26 vertices)

/**
 * rings: every polygon's rings (vertex indices into V); ringPoly: each ring's polygon;
 * polyOp: each polygon's operand (0 .. nOps − 1). inside(nz, pos): for each operand, how many of
 * its polygons wind non-zero and positive in a cell.
 */
export function slabs(
  V: Verts, rings: Rings, ringPoly: Int32Array, polyOp: Int32Array, nOps: number,
  inside: (nz: Int32Array, pos: Int32Array) => boolean,
): SlabResult {
  const nPolys = polyOp.length, nRings = ringCount(rings);
  const events: SlabEvents = { crossings: 0, touches: 0, overlaps: 0, ties: 0, disagree: 0 };

  // Each polygon counterclockwise as a whole.
  const polyArea = new Float64Array(nPolys);
  for (let r = 0; r < nRings; r++) polyArea[ringPoly[r]!]! += ringArea(V, rings, r);

  // 1. Edges and the lines they lie on.
  const EI = new I32(), EJ = new I32(), EP = new I32(), EL = new I32();
  const LI = new I32(), LJ = new I32(), lineOf = new Map<number, number>();
  for (let r = 0; r < nRings; r++) {
    const p = ringPoly[r]!, a = rings.start[r]!, b = rings.start[r + 1]!, flip = polyArea[p]! < 0;
    for (let k = a; k < b; k++) {
      const nx = k + 1 < b ? k + 1 : a;
      const i = flip ? rings.verts[nx]! : rings.verts[k]!, j = flip ? rings.verts[k]! : rings.verts[nx]!;
      if (i === j) continue;
      const key = i < j ? i * KEY + j : j * KEY + i;
      let l = lineOf.get(key);
      if (l === undefined) {
        l = LI.length;
        lineOf.set(key, l);
        LI.push(i);
        LJ.push(j);
      }
      EI.push(i); EJ.push(j); EP.push(p); EL.push(l);
    }
  }
  const nLines = LI.length, li = LI.view(), lj = LJ.view();

  // Crossings: lines whose boxes share a grid cell, each pair tested once (in the first cell both cover).
  const lens = new Float64Array(nLines);
  for (let l = 0; l < nLines; l++) lens[l] = Math.hypot(V.x(lj[l]!) - V.x(li[l]!), V.y(lj[l]!) - V.y(li[l]!));
  const sortedLens = lens.slice().sort();
  const cell = Math.max(1, 4 * (sortedLens[nLines >> 1] ?? 1));
  const gx0 = new Int32Array(nLines), gx1 = new Int32Array(nLines), gy0 = new Int32Array(nLines), gy1 = new Int32Array(nLines);
  const cellKeys = new F64(), cellLine = new I32();
  for (let l = 0; l < nLines; l++) {
    const ax = V.x(li[l]!), ay = V.y(li[l]!), bx = V.x(lj[l]!), by = V.y(lj[l]!);
    gx0[l] = Math.floor(Math.min(ax, bx) / cell); gx1[l] = Math.floor(Math.max(ax, bx) / cell);
    gy0[l] = Math.floor(Math.min(ay, by) / cell); gy1[l] = Math.floor(Math.max(ay, by) / cell);
    for (let gx = gx0[l]!; gx <= gx1[l]!; gx++) {
      for (let gy = gy0[l]!; gy <= gy1[l]!; gy++) { cellKeys.push((gx + 1048576) * 2097152 + (gy + 1048576)); cellLine.push(l); }
    }
  }
  const order = new Int32Array(cellKeys.length);
  for (let k = 0; k < order.length; k++) order[k] = k;
  sortBy(order, cellKeys.view());
  const splitLine = new I32(), splitVert = new I32();  // vertices splitting each line

  /** Splits line l at vertex k if k lies exactly on it (o, the orientation test, exactly zero) inside its box. */
  const touch = (l: number, k: number, o: number) => {
    if (o !== 0 || k === li[l] || k === lj[l]) return 0;
    const px = V.x(li[l]!), py = V.y(li[l]!), qx = V.x(lj[l]!), qy = V.y(lj[l]!), x = V.x(k), y = V.y(k);
    if (x < Math.min(px, qx) || x > Math.max(px, qx) || y < Math.min(py, qy) || y > Math.max(py, qy)) return 0;
    splitLine.push(l);
    splitVert.push(k);
    return 1;
  };
  const ck = cellKeys.view(), cl = cellLine.view();
  for (let s = 0; s < order.length;) {
    let e = s;
    while (e < order.length && ck[order[e]!] === ck[order[s]!]) e++;
    const key = ck[order[s]!]!, gx = Math.floor(key / 2097152) - 1048576, gy = key - (gx + 1048576) * 2097152 - 1048576;
    for (let x = s; x < e; x++) {
      for (let y = x + 1; y < e; y++) {
        const m = cl[order[x]!]!, n = cl[order[y]!]!;
        if (Math.max(gx0[m]!, gx0[n]!) !== gx || Math.max(gy0[m]!, gy0[n]!) !== gy) continue;
        const ei = li[m]!, ej = lj[m]!, fi = li[n]!, fj = lj[n]!;
        const ax = V.x(ei), ay = V.y(ei), bx = V.x(ej), by = V.y(ej), cx = V.x(fi), cy = V.y(fi), dx = V.x(fj), dy = V.y(fj);
        if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx)) continue;
        if (Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)) continue;
        const shared = ei === fi || ei === fj || ej === fi || ej === fj;
        const o1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), o2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
        const o3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), o4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
        if (!shared && Math.sign(o1) * Math.sign(o2) < 0 && Math.sign(o3) * Math.sign(o4) < 0) {
          // A proper crossing: one new vertex, both lines split at it. Its height from whichever line has heights.
          const t = o3 / (o3 - o4), u = o1 / (o1 - o2);
          const za = V.z(ei), zb = V.z(ej), zc = V.z(fi), zd = V.z(fj);
          const z = za === za && zb === zb ? za + (zb - za) * t : zc + (zd - zc) * u;
          const v = V.push(ax + (bx - ax) * t, ay + (by - ay) * t, z);
          splitLine.push(m); splitVert.push(v);
          splitLine.push(n); splitVert.push(v);
          events.crossings++;
          continue;
        }
        const hits = touch(m, fi, o1) + touch(m, fj, o2) + touch(n, ei, o3) + touch(n, ej, o4);
        if (hits) {
          if (o1 === 0 && o2 === 0) events.overlaps++;
          else if (!shared) events.touches++;
        }
      }
    }
    s = e;
  }

  // 2. Pieces: each line cut at its vertices, in order along it; then each edge's pieces with its winding change.
  const nSplits = splitLine.length, sl = splitLine.view(), sv = splitVert.view();
  const splitKey = new Float64Array(nSplits), splitOrder = new Int32Array(nSplits);
  for (let k = 0; k < nSplits; k++) {
    const l = sl[k]!, a = li[l]!, b = lj[l]!;
    // Along the line from li to lj, as a fraction, ordered within the line.
    const t = ((V.x(sv[k]!) - V.x(a)) * (V.x(b) - V.x(a)) + (V.y(sv[k]!) - V.y(a)) * (V.y(b) - V.y(a))) / (lens[l]! * lens[l]! || 1);
    splitKey[k] = l * 4 + Math.min(Math.max(t, 0), 1) * 2 + 1;
    splitOrder[k] = k;
  }
  sortBy(splitOrder, splitKey);
  const lineSplitStart = new Int32Array(nLines + 1);
  for (let k = 0; k < nSplits; k++) lineSplitStart[sl[k]! + 1]!++;
  for (let l = 0; l < nLines; l++) lineSplitStart[l + 1]! += lineSplitStart[l]!;
  const lineSplits = new Int32Array(nSplits);
  for (let k = 0; k < nSplits; k++) lineSplits[k] = sv[splitOrder[k]!]!;  // by line, then along it

  const pieceOf = new Map<number, number>(), PLo = new I32(), PHi = new I32();
  const turnPiece = new I32(), turnPoly = new I32(), turnDelta = new I32(), chain = new I32();
  const eiv = EI.view(), ejv = EJ.view(), epv = EP.view(), elv = EL.view();
  for (let e = 0; e < eiv.length; e++) {
    const l = elv[e]!, forward = eiv[e] === li[l], s0 = lineSplitStart[l]!, s1 = lineSplitStart[l + 1]!;
    chain.length = 0;
    chain.push(eiv[e]!);
    if (forward) for (let k = s0; k < s1; k++) chain.push(lineSplits[k]!);
    else for (let k = s1 - 1; k >= s0; k--) chain.push(lineSplits[k]!);
    chain.push(ejv[e]!);
    for (let k = 0; k + 1 < chain.length; k++) {
      const u = chain.data[k]!, v = chain.data[k + 1]!;
      if (u === v) continue;
      // Stored bottom to top. Crossing, west to east, a piece that runs down goes into a counterclockwise polygon.
      const up = V.y(u) < V.y(v) || (V.y(u) === V.y(v) && V.x(u) < V.x(v));
      const lo = up ? u : v, hi = up ? v : u, key = lo * KEY + hi;
      let piece = pieceOf.get(key);
      if (piece === undefined) {
        piece = PLo.length;
        pieceOf.set(key, piece);
        PLo.push(lo);
        PHi.push(hi);
      }
      turnPiece.push(piece); turnPoly.push(epv[e]!); turnDelta.push(up ? -1 : 1);
    }
  }
  // Each piece's winding changes, summed per polygon (CSR, zeros dropped).
  const nPieces = PLo.length, plo = PLo.view(), phi = PHi.view();
  const nTurns = turnPiece.length, tkey = new Float64Array(nTurns), torder = new Int32Array(nTurns);
  for (let k = 0; k < nTurns; k++) { tkey[k] = turnPiece.data[k]! * (nPolys + 1) + turnPoly.data[k]!; torder[k] = k; }
  sortBy(torder, tkey);
  const turnStart = new Int32Array(nPieces + 1), TP = new I32(), TD = new I32();
  for (let s = 0, piece = 0; piece < nPieces; piece++) {
    turnStart[piece] = TP.length;
    while (s < nTurns && turnPiece.data[torder[s]!] === piece) {
      const poly = turnPoly.data[torder[s]!]!;
      let d = 0;
      while (s < nTurns && turnPiece.data[torder[s]!] === piece && turnPoly.data[torder[s]!] === poly) d += turnDelta.data[torder[s++]!]!;
      if (d !== 0) { TP.push(poly); TD.push(d); }
    }
  }
  turnStart[nPieces] = TP.length;
  const tp = TP.view(), td = TD.view();
  const live = (p: number) => turnStart[p] !== turnStart[p + 1];

  // 3. The sweep.
  const ysAll = new Float64Array(2 * nPieces);
  let nY = 0;
  for (let p = 0; p < nPieces; p++) if (live(p)) { ysAll[nY++] = V.y(plo[p]!); ysAll[nY++] = V.y(phi[p]!); }
  const ysSorted = ysAll.subarray(0, nY).sort();
  const ys = new F64();
  for (let k = 0; k < nY; k++) if (k === 0 || ysSorted[k] !== ysSorted[k - 1]) ys.push(ysSorted[k]!);
  const Y = ys.view(), nSlabs = Math.max(0, Y.length - 1);
  const rising = new I32();
  for (let p = 0; p < nPieces; p++) if (live(p) && V.y(plo[p]!) !== V.y(phi[p]!)) rising.push(p);
  const riseKey = new Float64Array(nPieces);
  for (let p = 0; p < nPieces; p++) riseKey[p] = V.y(plo[p]!);
  const rise = rising.view().slice();
  sortBy(rise, riseKey);

  const side = new Int8Array(nPieces).fill(-1);  // 0 none, 1 result to its west, 2 to its east
  const w = new Int32Array(nPolys), nz = new Int32Array(nOps), pos = new Int32Array(nOps), touched = new I32(), tied = new I32();
  let active = new Int32Array(64), nActive = 0;
  const xm = new Float64Array(nPieces), x0 = new Float64Array(nPieces), x1 = new Float64Array(nPieces);
  const pickStart = new Int32Array(nSlabs + 1), pick0 = new F64(), pick1 = new F64(), pickT0 = new F64(), pickT1 = new F64();
  const xAt = (p: number, y: number) => {
    const a = plo[p]!, b = phi[p]!;
    if (y === V.y(a)) return V.x(a);
    if (y === V.y(b)) return V.x(b);
    return V.x(a) + ((V.x(b) - V.x(a)) * (y - V.y(a))) / (V.y(b) - V.y(a));
  };
  let next = 0;
  for (let s = 0; s < nSlabs; s++) {
    const y0 = Y[s]!, y1 = Y[s + 1]!, ym = (y0 + y1) / 2;
    while (next < rise.length && V.y(plo[rise[next]!]!) <= y0) {
      if (nActive === active.length) { const grown = new Int32Array(active.length * 2); grown.set(active); active = grown; }
      active[nActive++] = rise[next++]!;
    }
    let keep = 0;
    for (let k = 0; k < nActive; k++) if (V.y(phi[active[k]!]!) >= y1) active[keep++] = active[k]!;
    nActive = keep;
    const span = active.subarray(0, nActive);
    for (let k = 0; k < nActive; k++) { const p = span[k]!; xm[p] = xAt(p, ym); x0[p] = xAt(p, y0); x1[p] = xAt(p, y1); }
    sortBy(span, xm);
    for (let k = 0; k + 1 < nActive; k++) {
      if (xm[span[k]!] !== xm[span[k + 1]!]) continue;
      events.ties++;
      tied.push(plo[span[k]!]!); tied.push(phi[span[k]!]!); tied.push(plo[span[k + 1]!]!); tied.push(phi[span[k + 1]!]!);
    }
    pickStart[s] = pick0.length;
    let wasIn = false;
    for (let k = 0; k < nActive; k++) {
      const p = span[k]!;
      for (let t = turnStart[p]!; t < turnStart[p + 1]!; t++) {
        const poly = tp[t]!, op = polyOp[poly]!, old = w[poly]!, now = old + td[t]!;
        if (old === 0) touched.push(poly);
        if (old !== 0 && now === 0) nz[op]!--;
        if (old === 0 && now !== 0) nz[op]!++;
        if (old > 0 && now <= 0) pos[op]!--;
        if (old <= 0 && now > 0) pos[op]!++;
        w[poly] = now;
      }
      const isIn = k + 1 < nActive && inside(nz, pos);
      const here = isIn === wasIn ? 0 : wasIn ? 1 : 2;
      if (side[p] === -1) side[p] = here;
      else if (side[p] !== here) events.disagree++;
      wasIn = isIn;
      if (isIn) {
        const q = span[k + 1]!;
        pick0.push(x0[p]!); pick1.push(x0[q]!); pickT0.push(x1[p]!); pickT1.push(x1[q]!);
      }
    }
    // Back to zero for the next slab: only what changed.
    for (let k = 0; k < touched.length; k++) w[touched.data[k]!] = 0;
    touched.length = 0;
    nz.fill(0);
    pos.fill(0);
  }
  pickStart[nSlabs] = pick0.length;

  // 4. The outline, the result on its left: up (low to high) when it's to the west, down when to the east.
  const OF = new I32(), OT = new I32();
  for (let p = 0; p < nPieces; p++) {
    if (side[p] === 1) { OF.push(plo[p]!); OT.push(phi[p]!); }
    else if (side[p] === 2) { OF.push(phi[p]!); OT.push(plo[p]!); }
  }
  // Horizontal pieces: outline where the result is on one side of them only.
  const slabAt = new Map<number, number>();
  for (let s = 0; s < Y.length; s++) slabAt.set(Y[s]!, s);
  const covered = (s: number, x: number, top: boolean) => {
    if (s < 0 || s >= nSlabs) return false;
    for (let k = pickStart[s]!; k < pickStart[s + 1]!; k++) {
      if (top ? pickT0.data[k]! < x && x < pickT1.data[k]! : pick0.data[k]! < x && x < pick1.data[k]!) return true;
    }
    return false;
  };
  for (let p = 0; p < nPieces; p++) {
    if (!live(p) || V.y(plo[p]!) !== V.y(phi[p]!)) continue;
    const s = slabAt.get(V.y(plo[p]!))!, x = (V.x(plo[p]!) + V.x(phi[p]!)) / 2;
    const above = covered(s, x, false), below = covered(s - 1, x, true);
    if (above && !below) { OF.push(plo[p]!); OT.push(phi[p]!); }       // result above: east keeps it on the left
    else if (below && !above) { OF.push(phi[p]!); OT.push(plo[p]!); }  // result below: west
  }

  // Stitch by index, taking the sharpest right turn; split loops where they touch themselves.
  const nOut = OF.length, of = OF.view(), ot = OT.view();
  const fromKey = new Float64Array(nOut), fromOrder = new Int32Array(nOut);
  for (let k = 0; k < nOut; k++) { fromKey[k] = of[k]!; fromOrder[k] = k; }
  sortBy(fromOrder, fromKey);
  const firstFrom = new Map<number, number>();
  for (let k = nOut - 1; k >= 0; k--) firstFrom.set(of[fromOrder[k]!]!, k);
  const used = new Uint8Array(nOut), out = new RingsBuilder(), loop = new I32(), stack = new I32();
  const seenAt = new Int32Array(V.count).fill(-1);
  for (let start = 0; start < nOut; start++) {
    if (used[start]) continue;
    loop.length = 0;
    for (let cur = start; cur >= 0 && !used[cur];) {
      used[cur] = 1;
      const u = of[cur]!, v = ot[cur]!;
      loop.push(u);
      const back = Math.atan2(V.y(u) - V.y(v), V.x(u) - V.x(v));
      let best = -1, bestTurn = Infinity;
      const f = firstFrom.get(v);
      if (f !== undefined) {
        for (let k = f; k < nOut && of[fromOrder[k]!] === v; k++) {
          const c = fromOrder[k]!;
          if (used[c]) continue;
          const by = ((Math.atan2(V.y(ot[c]!) - V.y(v), V.x(ot[c]!) - V.x(v)) - back) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
          if (by < bestTurn) { bestTurn = by; best = c; }  // counterclockwise from straight back: smallest is the sharpest right
        }
      }
      cur = best;
    }
    unpinch(loop, stack, seenAt, out, V);
  }
  return { loops: out.rings(), events, tied: tied.view().slice() };
}

/** Adds a loop to `out`, split wherever it comes back to a vertex it has passed: simple loops, none of zero area. */
function unpinch(loop: I32, stack: I32, seenAt: Int32Array, out: RingsBuilder, V: Verts): void {
  stack.length = 0;
  for (let k = 0; k < loop.length; k++) {
    const v = loop.data[k]!, at = seenAt[v]!;
    if (at >= 0 && at < stack.length && stack.data[at] === v) {
      // Back at v: what's on the stack since it is a loop of its own.
      emit(stack, at, stack.length, out, V);
      for (let j = at; j < stack.length; j++) seenAt[stack.data[j]!] = -1;
      stack.length = at;
    }
    seenAt[v] = stack.length;
    stack.push(v);
  }
  emit(stack, 0, stack.length, out, V);
  for (let j = 0; j < stack.length; j++) seenAt[stack.data[j]!] = -1;
}

function emit(stack: I32, a: number, b: number, out: RingsBuilder, V: Verts): void {
  if (b - a < 3) return;
  let s = 0;
  for (let k = a; k < b; k++) {
    const p = stack.data[k]!, q = stack.data[k + 1 < b ? k + 1 : a]!;
    s += V.x(p) * V.y(q) - V.x(q) * V.y(p);
  }
  if (s === 0) return;
  for (let k = a; k < b; k++) out.add(stack.data[k]!);
  out.close();
}
