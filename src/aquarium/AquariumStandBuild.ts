// 水槽の外側の見た目（CPU 側。Three.js に依存しない）：AquariumStand の定義から三角形メッシュを作る。
// - stand：底板・台の天板（管の丸い穴あき）、水槽台の内側の面、濾過槽の中のろ材・ポンプ、段の箱、部屋の家具、
//   管が砂を貫く所の断面（管の内側から見える砂の層）、管の付け根の黒い留め具
// - cabinetOuter：水槽台の外側の面と扉（箱庭カメラでは手前の面を透かして中の濾過槽を見せる）
// - emissive：台の中の照明（LED の帯。照明の影響を受けずに光る）
// 透明な物（管・アクリル・水面）は AquariumPlumbingFx が Three.js で作る。

import { clamp, hash2, hex, mixRGB, mulberry32, noise3, type RGB } from '../core/math';
import { MeshBuilder, type TriMesh } from '../render/pixelmesh/MeshBuild';
import { TANK } from './aquaConst';
import { CABINET, DECK, SUMP, type Box, type BoxPart, type OrientedPart } from './AquariumStand';
import type { AquariumWorld } from './AquariumWorld';

const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export interface StandMeshes {
  stand: TriMesh;
  cabinetOuter: TriMesh;
  emissive: TriMesh;
}

type ColorFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => RGB;

/** 面を細かい格子に分けた箱（頂点ごとに色を変えられる：かごの格子・スポンジの気泡など） */
function gridBox(mb: MeshBuilder, b: Box, cell: number, color: ColorFn, sun: number, grain: number, keep: (face: string) => boolean = () => true) {
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
  const face = (name: string, o: [number, number, number], u: [number, number, number], v: [number, number, number], n: [number, number, number]) => {
    if (!keep(name)) return;
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    const nu = Math.max(1, Math.round(lu / cell)), nv = Math.max(1, Math.round(lv / cell));
    const ids: number[] = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const x = o[0] + (u[0] * i) / nu + (v[0] * j) / nv, y = o[1] + (u[1] * i) / nu + (v[1] * j) / nv, z = o[2] + (u[2] * i) / nu + (v[2] * j) / nv;
      const c = color(x, y, z, n[0], n[1], n[2]);
      ids.push(mb.vertex(x, y, z, n[0], n[1], n[2], u8(c[0]), u8(c[1]), u8(c[2]), sun, grain));
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = ids[j * (nu + 1) + i], bb = ids[j * (nu + 1) + i + 1], c = ids[(j + 1) * (nu + 1) + i], d = ids[(j + 1) * (nu + 1) + i + 1];
      mb.tri(a, bb, d, n[0], n[1], n[2]);
      mb.tri(a, d, c, n[0], n[1], n[2]);
    }
  };
  face('top', [x0, y1, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], [0, 1, 0]);
  face('bottom', [x0, y0, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], [0, -1, 0]);
  face('front', [x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], [0, 0, 1]);
  face('back', [x0, y0, z0], [x1 - x0, 0, 0], [0, y1 - y0, 0], [0, 0, -1]);
  face('right', [x1, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], [1, 0, 0]);
  face('left', [x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], [-1, 0, 0]);
}

/** 単色の箱（面ごとの色）。face の向きを keep で選べる */
function flatBox(mb: MeshBuilder, b: Box, colorOf: (face: string) => RGB, sun: number, keep: (face: string, n: [number, number, number], center: [number, number, number]) => boolean = () => true, grain = 0.15) {
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
  const face = (name: string, p: [number, number, number][], n: [number, number, number]) => {
    const cx = (p[0][0] + p[2][0]) / 2, cy = (p[0][1] + p[2][1]) / 2, cz = (p[0][2] + p[2][2]) / 2;
    if (!keep(name, n, [cx, cy, cz])) return;
    const c = colorOf(name);
    const ids = p.map((q) => mb.vertex(q[0], q[1], q[2], n[0], n[1], n[2], u8(c[0]), u8(c[1]), u8(c[2]), sun, grain));
    mb.tri(ids[0], ids[1], ids[2], n[0], n[1], n[2]);
    mb.tri(ids[0], ids[2], ids[3], n[0], n[1], n[2]);
  };
  face('top', [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]);
  face('bottom', [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
  face('front', [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
  face('back', [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1]);
  face('right', [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
  face('left', [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0]);
}

/** y 軸まわりに回した箱（開いた扉） */
function orientedBox(mb: MeshBuilder, o: OrientedPart, color: ColorFn, sun: number) {
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  const w = (lx: number, ly: number, lz: number): [number, number, number] => [o.c[0] + lx * c + lz * s, o.c[1] + ly, o.c[2] - lx * s + lz * c];
  const rn = (nx: number, ny: number, nz: number): [number, number, number] => [nx * c + nz * s, ny, -nx * s + nz * c];
  const [hx, hy, hz] = o.half;
  const quads: [[number, number, number][], [number, number, number]][] = [
    [[w(-hx, hy, -hz), w(hx, hy, -hz), w(hx, hy, hz), w(-hx, hy, hz)], rn(0, 1, 0)],
    [[w(-hx, -hy, hz), w(hx, -hy, hz), w(hx, hy, hz), w(-hx, hy, hz)], rn(0, 0, 1)],
    [[w(-hx, -hy, -hz), w(hx, -hy, -hz), w(hx, hy, -hz), w(-hx, hy, -hz)], rn(0, 0, -1)],
    [[w(hx, -hy, -hz), w(hx, hy, -hz), w(hx, hy, hz), w(hx, -hy, hz)], rn(1, 0, 0)],
    [[w(-hx, -hy, -hz), w(-hx, hy, -hz), w(-hx, hy, hz), w(-hx, -hy, hz)], rn(-1, 0, 0)],
  ];
  for (const [p, n] of quads) {
    const ids = p.map((q) => {
      const cc = color(q[0], q[1], q[2], n[0], n[1], n[2]);
      return mb.vertex(q[0], q[1], q[2], n[0], n[1], n[2], u8(cc[0]), u8(cc[1]), u8(cc[2]), sun, 0.2);
    });
    mb.tri(ids[0], ids[1], ids[2], n[0], n[1], n[2]);
    mb.tri(ids[0], ids[2], ids[3], n[0], n[1], n[2]);
  }
}

/** 縦の円柱（inward = true なら内向きの面：管の内側から見る砂の断面） */
function cylinder(mb: MeshBuilder, cx: number, cz: number, r: number, y0: number, y1: number, color: ColorFn, sun: number, opts: { inward?: boolean; caps?: boolean; seg?: number; topAt?: (x: number, z: number) => number } = {}) {
  const seg = opts.seg ?? 28;
  const sgn = opts.inward ? -1 : 1;
  const rows = Math.max(1, Math.ceil((y1 - y0) / 0.15));
  const cols: number[][] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const nx = Math.cos(a), nz = Math.sin(a);
    const x = cx + nx * r, z = cz + nz * r;
    const top = opts.topAt ? Math.min(y1, opts.topAt(x, z)) : y1;
    const col: number[] = [];
    for (let k = 0; k <= rows; k++) {
      const y = y0 + ((top - y0) * k) / rows;
      const c = color(x, y, z, nx * sgn, 0, nz * sgn);
      col.push(mb.vertex(x, y, z, nx * sgn, 0, nz * sgn, u8(c[0]), u8(c[1]), u8(c[2]), sun, 0.4));
    }
    cols.push(col);
  }
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const ex = Math.cos(a) * sgn, ez = Math.sin(a) * sgn;
    for (let k = 0; k < rows; k++) {
      mb.tri(cols[i][k], cols[i + 1][k], cols[i + 1][k + 1], ex, 0, ez);
      mb.tri(cols[i][k], cols[i + 1][k + 1], cols[i][k + 1], ex, 0, ez);
    }
  }
  if (opts.caps !== false && !opts.inward) {
    for (const [y, ny] of [[y1, 1], [y0, -1]] as const) {
      const c0 = color(cx, y, cz, 0, ny, 0);
      const center = mb.vertex(cx, y, cz, 0, ny, 0, u8(c0[0]), u8(c0[1]), u8(c0[2]), sun, 0.3);
      const ring: number[] = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const c = color(x, y, z, 0, ny, 0);
        ring.push(mb.vertex(x, y, z, 0, ny, 0, u8(c[0]), u8(c[1]), u8(c[2]), sun, 0.3));
      }
      for (let i = 0; i < seg; i++) mb.tri(center, ring[i], ring[i + 1], 0, ny, 0);
    }
  }
}

/** 管の周りの輪（留め具・吸い込み口の縁）。中心線の向き u の回りの、内径 r0・外径 r1・長さ len の筒 */
function collar(mb: MeshBuilder, c: [number, number, number], u: [number, number, number], r0: number, r1: number, len: number, col: RGB, sun: number) {
  // u に直交する 2 軸
  const t: [number, number, number] = Math.abs(u[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a: [number, number, number] = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]];
  const al = Math.hypot(...a);
  a[0] /= al; a[1] /= al; a[2] /= al;
  const b: [number, number, number] = [u[1] * a[2] - u[2] * a[1], u[2] * a[0] - u[0] * a[2], u[0] * a[1] - u[1] * a[0]];
  const seg = 24;
  const ring = (r: number, h: number, outward: number) => {
    const ids: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const ang = (i / seg) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const n: [number, number, number] = [(a[0] * ca + b[0] * sa) * outward, (a[1] * ca + b[1] * sa) * outward, (a[2] * ca + b[2] * sa) * outward];
      const p = [c[0] + u[0] * h + (a[0] * ca + b[0] * sa) * r, c[1] + u[1] * h + (a[1] * ca + b[1] * sa) * r, c[2] + u[2] * h + (a[2] * ca + b[2] * sa) * r];
      ids.push(mb.vertex(p[0], p[1], p[2], n[0], n[1], n[2], u8(col[0]), u8(col[1]), u8(col[2]), sun, 0.2));
    }
    return ids;
  };
  const strip = (A: number[], B: number[], dir: (i: number) => [number, number, number]) => {
    for (let i = 0; i < seg; i++) {
      const d = dir(i);
      mb.tri(A[i], A[i + 1], B[i + 1], d[0], d[1], d[2]);
      mb.tri(A[i], B[i + 1], B[i], d[0], d[1], d[2]);
    }
  };
  const radial = (sgn: number) => (i: number): [number, number, number] => {
    const ang = ((i + 0.5) / seg) * Math.PI * 2;
    return [(a[0] * Math.cos(ang) + b[0] * Math.sin(ang)) * sgn, (a[1] * Math.cos(ang) + b[1] * Math.sin(ang)) * sgn, (a[2] * Math.cos(ang) + b[2] * Math.sin(ang)) * sgn];
  };
  const h0 = -len / 2, h1 = len / 2;
  strip(ring(r1, h0, 1), ring(r1, h1, 1), radial(1));
  strip(ring(r0, h0, -1), ring(r0, h1, -1), radial(-1));
  strip(ring(r0, h1, 1), ring(r1, h1, 1), () => u);
  strip(ring(r0, h0, 1), ring(r1, h0, 1), () => [-u[0], -u[1], -u[2]]);
}

/**
 * 丸い穴の開いた板（上下の面・外周の側面・穴の内側の面）。穴は正方形の区画の中で、円と正方形の間を三角形でつなぐ。
 * 板の残りは、穴の区画の縁の座標で切った長方形の格子から作る。
 */
function slabWithHoles(mb: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, holes: { x: number; z: number; r: number }[], top: RGB, side: RGB, inner: RGB, sun: number) {
  const H = holes.map((h) => ({ ...h, s: h.r + 0.4 }));
  const xs = [x0, x1, ...H.flatMap((h) => [h.x - h.s, h.x + h.s])].sort((a, b) => a - b);
  const zs = [z0, z1, ...H.flatMap((h) => [h.z - h.s, h.z + h.s])].sort((a, b) => a - b);
  const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], n: [number, number, number], col: RGB) => {
    const ids = [a, b, c, d].map((q) => mb.vertex(q[0], q[1], q[2], n[0], n[1], n[2], u8(col[0]), u8(col[1]), u8(col[2]), sun, 0.15));
    mb.tri(ids[0], ids[1], ids[2], n[0], n[1], n[2]);
    mb.tri(ids[0], ids[2], ids[3], n[0], n[1], n[2]);
  };
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++) {
    const ax = xs[i], bx = xs[i + 1], az = zs[j], bz = zs[j + 1];
    if (bx - ax < 1e-4 || bz - az < 1e-4) continue;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (H.some((h) => Math.abs(mx - h.x) < h.s && Math.abs(mz - h.z) < h.s)) continue;
    quad([ax, y1, az], [bx, y1, az], [bx, y1, bz], [ax, y1, bz], [0, 1, 0], top);
    quad([ax, y0, az], [bx, y0, az], [bx, y0, bz], [ax, y0, bz], [0, -1, 0], side);
  }
  const N = 32;
  for (const h of H) {
    const circle: [number, number][] = [], square: [number, number][] = [];
    for (let k = 0; k <= N; k++) {
      const a = (k / N) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      circle.push([h.x + ca * h.r, h.z + sa * h.r]);
      const t = h.s / Math.max(Math.abs(ca), Math.abs(sa));
      square.push([h.x + ca * t, h.z + sa * t]);
    }
    for (let k = 0; k < N; k++) {
      const c0 = circle[k], c1 = circle[k + 1], s0 = square[k], s1 = square[k + 1];
      quad([c0[0], y1, c0[1]], [s0[0], y1, s0[1]], [s1[0], y1, s1[1]], [c1[0], y1, c1[1]], [0, 1, 0], top);
      quad([c0[0], y0, c0[1]], [s0[0], y0, s0[1]], [s1[0], y0, s1[1]], [c1[0], y0, c1[1]], [0, -1, 0], side);
      // 穴の内側の面（軸を向く。透明な管の中から板の厚みが見える）
      const ma = ((k + 0.5) / N) * Math.PI * 2;
      quad([c0[0], y0, c0[1]], [c1[0], y0, c1[1]], [c1[0], y1, c1[1]], [c0[0], y1, c0[1]], [-Math.cos(ma), 0, -Math.sin(ma)], inner);
    }
  }
  // 外周の側面
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], side);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], side);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], side);
  quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0], side);
}

/** 小さな輪（リングろ材）。中心 c、軸 n、輪の半径 R・太さ r */
function ring(mb: MeshBuilder, c: [number, number, number], n: [number, number, number], R: number, r: number, col: RGB, sun: number) {
  const t: [number, number, number] = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a: [number, number, number] = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  const al = Math.hypot(...a);
  a[0] /= al; a[1] /= al; a[2] /= al;
  const b: [number, number, number] = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  const U = 8, V = 4;
  const ids: number[] = [];
  for (let i = 0; i <= U; i++) {
    const u = (i / U) * Math.PI * 2;
    const dx = a[0] * Math.cos(u) + b[0] * Math.sin(u), dy = a[1] * Math.cos(u) + b[1] * Math.sin(u), dz = a[2] * Math.cos(u) + b[2] * Math.sin(u);
    for (let j = 0; j <= V; j++) {
      const v = (j / V) * Math.PI * 2;
      const nx = dx * Math.cos(v) + n[0] * Math.sin(v), ny = dy * Math.cos(v) + n[1] * Math.sin(v), nz = dz * Math.cos(v) + n[2] * Math.sin(v);
      const shade = 0.85 + 0.15 * Math.cos(v);
      ids.push(mb.vertex(c[0] + dx * R + nx * r, c[1] + dy * R + ny * r, c[2] + dz * R + nz * r, nx, ny, nz, u8(col[0] * shade), u8(col[1] * shade), u8(col[2] * shade), sun, 0.5));
    }
  }
  for (let i = 0; i < U; i++) for (let j = 0; j < V; j++) {
    const p = i * (V + 1) + j, q = (i + 1) * (V + 1) + j;
    mb.triByNormals(ids[p], ids[q], ids[q + 1]);
    mb.triByNormals(ids[p], ids[q + 1], ids[p + 1]);
  }
}

// ---------------- 色 ----------------

const WOOD = { top: hex('#5a4030'), side: hex('#3f2c21'), inner: hex('#33251c'), door: hex('#4a3427'), door2: hex('#523a2b'), dark: hex('#2a1d17') };
const PLATE = hex('#202225');
const SPONGE = [hex('#2c3a4c'), hex('#36485e'), hex('#1f2a38')];
const WOOL = [hex('#e8e6e0'), hex('#d4d2cc'), hex('#f4f2ec')];
const RING = [hex('#d8cfb8'), hex('#c4b89a'), hex('#e6dfcc'), hex('#a89c80')];
const BASKET = hex('#2b3a33');
const PUMP = [hex('#23272b'), hex('#3a4148')];
const BOXES = [hex('#b08a5c'), hex('#6a8fa6'), hex('#c9c3b5')];

function standColor(p: BoxPart): ColorFn {
  const tint = p.tint ?? 0;
  switch (p.look) {
    case 'sponge': {
      const base = SPONGE[tint % SPONGE.length];
      return (x, y, z) => {
        const n = noise3(x * 9, y * 9, z * 9, 71) * 0.5 + 0.5;
        return mixRGB(base, n > 0.62 ? SPONGE[2] : SPONGE[1], n * 0.6);
      };
    }
    case 'wool':
      return (x, y, z) => {
        const n = noise3(x * 6, y * 14, z * 6, 72) * 0.5 + 0.5;
        return WOOL[n > 0.7 ? 1 : n < 0.3 ? 2 : 0];
      };
    case 'basket':
      return (x, y, z, nx, ny, nz) => {
        // 格子の目（0.3 間隔。頂点の間隔 0.1 の 3 つに 1 つが格子）の向こうにリングろ材の色
        const ax = Math.abs(nx) > 0.5 ? z : x, ay = Math.abs(ny) > 0.5 ? z : y;
        const fx = ((ax / 0.3 + 0.05) % 1 + 1) % 1, fy = ((ay / 0.3 + 0.05) % 1 + 1) % 1;
        if (fx < 0.3 || fy < 0.3) return BASKET;
        const h = hash2(Math.floor(x * 11), Math.floor(y * 11 + z * 11), 73);
        return mixRGB(RING[Math.floor(h * RING.length)], hex('#6b6350'), 0.3);
      };
    case 'pump':
      return () => PUMP[tint % PUMP.length];
    case 'box': {
      const base = BOXES[tint % BOXES.length];
      return (x, y, z, nx, ny) => mixRGB(base, hex('#2a2420'), ny > 0.5 ? 0 : 0.18);
    }
    case 'rug':
      return (x, y, z) => {
        const stripe = Math.floor((x + 40) / 1.6) % 2;
        const border = Math.min(Math.abs(x + 16), Math.abs(x - 16), Math.abs(z - 13), Math.abs(z - 26)) < 0.8;
        return border ? hex('#5a3a2e') : stripe ? hex('#7a5a46') : hex('#6a4c3c');
      };
    case 'book':
      return (x, y) => [hex('#5c3a3a'), hex('#3a4a5c'), hex('#5c5a3a'), hex('#3a5c46')][Math.floor((y + 12) / 0.28 + tint) % 4];
    case 'door':
      return () => (tint ? WOOD.door2 : WOOD.door);
    default:
      return (_x, _y, _z, _nx, ny) => (ny > 0.5 ? WOOD.top : WOOD.side);
  }
}

// ---------------- 組み立て ----------------

export function buildStandMeshes(world: AquariumWorld): StandMeshes {
  const S = world.stand;
  const mb = new MeshBuilder();
  const outer = new MeshBuilder();
  const emissive = new MeshBuilder();
  const holes = S.columns.map((c) => ({ x: c.x, z: c.z, r: c.r + 0.005 }));

  // 水槽の底板（黒）と台の天板（木）
  slabWithHoles(mb, DECK.plate.minX, DECK.plate.maxX, DECK.plate.minZ, DECK.plate.maxZ, DECK.boardTop, DECK.top, holes, PLATE, PLATE, hex('#2c2f33'), 0.6);
  slabWithHoles(mb, DECK.board.minX, DECK.board.maxX, DECK.board.minZ, DECK.board.maxZ, DECK.y0, DECK.boardTop, holes, WOOD.top, WOOD.side, WOOD.side, 0.6);

  // 水槽台：内側を向く面は stand、外側を向く面は cabinetOuter（箱庭カメラで透かす）
  const C = CABINET;
  const insideCab = (p: [number, number, number]) => p[0] > C.minX + C.wall - 1e-3 && p[0] < C.maxX - C.wall + 1e-3 && p[2] > C.minZ + C.wall - 1e-3 && p[2] < C.maxZ - C.wall + 1e-3 && p[1] > C.floorTop - 1e-3 && p[1] < C.maxY + 1e-3;
  for (const p of S.opaque) {
    if (p.look !== 'cabinet' && p.look !== 'door') continue;
    const col = standColor(p);
    const colorOf = (f: string): RGB => (p.look === 'door' ? col(0, 0, 0, 0, 0, 0) : f === 'top' ? WOOD.top : WOOD.side);
    const probe = (n: [number, number, number], c: [number, number, number]): [number, number, number] => [c[0] + n[0] * 0.05, c[1] + n[1] * 0.05, c[2] + n[2] * 0.05];
    flatBox(mb, p, (f) => (f === 'top' && p.name === 'floor' ? WOOD.inner : mixRGB(colorOf(f), WOOD.inner, 0.5)), 0.25, (_f, n, c) => insideCab(probe(n, c)));
    flatBox(outer, p, colorOf, 0.6, (_f, n, c) => !insideCab(probe(n, c)));
  }
  for (const o of S.oriented) orientedBox(outer, o, () => WOOD.door, 0.6);
  // 扉の取っ手
  const hy = (C.floorTop + C.railY) / 2;
  const dw = (C.maxX - C.minX - C.wall * 2) / 3;
  for (const x of [C.minX + C.wall + dw - 0.6, C.minX + C.wall + dw + 0.6]) flatBox(outer, { min: [x - 0.12, hy - 1.0, C.maxZ], max: [x + 0.12, hy + 1.0, C.maxZ + 0.18] }, () => hex('#b8a888'), 0.7);

  // 濾過槽の中身・段の箱・部屋の家具
  for (const p of S.opaque) {
    if (p.look === 'cabinet' || p.look === 'door') continue;
    const col = standColor(p);
    const sun = p.look === 'rug' || p.look === 'book' || p.name === 'carton' ? 0.7 : 0.75;
    // 底面は床に接していて見えないので張らない（三角形の数を抑える）
    const noBottom = (f: string) => f !== 'bottom';
    if (p.look === 'basket') {
      gridBox(mb, p, 0.1, col, sun, 0.4, noBottom);
      // 上面にこぼれたリングろ材
      const rng = mulberry32(Math.round((p.min[0] + 20) * 100 + p.min[2] * 7));
      const area = (p.max[0] - p.min[0]) * (p.max[2] - p.min[2]);
      for (let i = 0; i < area * 5; i++) {
        const x = p.min[0] + 0.12 + rng() * (p.max[0] - p.min[0] - 0.24), z = p.min[2] + 0.12 + rng() * (p.max[2] - p.min[2] - 0.24);
        const tilt = rng() * 1.2, a = rng() * Math.PI * 2;
        const n: [number, number, number] = [Math.sin(tilt) * Math.cos(a), Math.cos(tilt), Math.sin(tilt) * Math.sin(a)];
        ring(mb, [x, p.max[1] + 0.03, z], n, 0.085, 0.035, RING[Math.floor(rng() * RING.length)], sun);
      }
    } else if (p.look === 'sponge' || p.look === 'wool') {
      gridBox(mb, p, 0.18, col, sun, 0.7, noBottom);
    } else if (p.look === 'rug') {
      gridBox(mb, p, 0.8, col, sun, 0.5, (f) => f === 'top');
    } else if (p.look === 'book') {
      gridBox(mb, p, 0.14, col, sun, 0.3, noBottom);
    } else {
      flatBox(mb, p, (f) => col(0, 0, 0, 0, f === 'top' ? 1 : 0, 0), sun);
    }
  }
  // 段の箱のラベル（前面の白い札）
  for (const p of S.opaque.filter((q) => q.name.startsWith('step'))) {
    const cx = (p.min[0] + p.max[0]) / 2, cy = p.max[1] - 0.3;
    flatBox(mb, { min: [cx - 0.45, cy - 0.18, p.max[2]], max: [cx + 0.45, cy + 0.12, p.max[2] + 0.02] }, () => hex('#e8e2d4'), 0.75);
  }
  for (const c of S.cyls) {
    const col: ColorFn = c.look === 'bucket' ? (_x, y) => (y > c.y1 - 0.25 ? hex('#3c6a8a') : hex('#4a7a9a')) : (_x, y) => (y > c.y1 - 0.12 || y < c.y0 + 0.12 ? hex('#c9c3b5') : y > c.y0 + 0.4 && y < c.y1 - 0.4 ? hex('#d06a3e') : hex('#ea9a62'));
    cylinder(mb, c.c[0], c.c[1], c.r, c.y0, c.y1, col, 0.7, { seg: 32 });
  }

  // 管の付け根の黒い留め具（天板の下）・吸い込み口の縁・ポンプの吐出口
  const black = hex('#1a1c1f');
  for (const h of holes) collar(mb, [h.x, DECK.y0 - 0.14, h.z], [0, 1, 0], h.r - 0.004, h.r + 0.17, 0.28, black, 0.4);
  const p0 = S.ret.pts[0], u0 = S.ret.tangentAt(0);
  collar(mb, [p0[0] + u0[0] * 0.12, p0[1] + u0[1] * 0.12, p0[2] + u0[2] * 0.12], u0, S.ret.outer, S.ret.outer + 0.16, 0.26, hex('#2f4a3a'), 0.75);
  collar(mb, [S.outlet[0], S.outlet[1], S.outlet[2] - 0.12], S.outletDir, S.ret.outer, S.ret.outer + 0.1, 0.22, hex('#2f4a3a'), 0.8);
  // 排水管の下端の落水口（短い黒い筒の縁）
  const de = S.drain.pts[1];
  collar(mb, [de[0], de[1] + 0.12, de[2]], [0, 1, 0], S.drain.outer, S.drain.outer + 0.1, 0.24, black, 0.6);

  // 管が砂を貫く所：管の内側から見える砂の層（内向きの円筒。外からは裏面で見えない）
  for (const c of S.columns) sandSleeve(mb, world, c.x, c.z, c.r + 0.012);

  // 台の中の照明：濾過槽の真上、天板の裏の LED の帯
  flatBox(emissive, { min: [SUMP.minX + 0.5, DECK.y0 - 0.1, -0.35], max: [SUMP.maxX - 0.5, DECK.y0 - 0.01, 0.35] }, () => hex('#fff4dc'), 1);
  flatBox(mb, { min: [SUMP.minX + 0.3, DECK.y0 - 0.06, -0.5], max: [SUMP.maxX - 0.3, DECK.y0, 0.5] }, () => hex('#9a9da0'), 0.5, (f) => f !== 'top');

  return { stand: mb.finish(), cabinetOuter: outer.finish(), emissive: emissive.finish() };
}

/** 砂の断面（地表から底板まで、層の色）。管の内側から見える */
function sandSleeve(mb: MeshBuilder, world: AquariumWorld, cx: number, cz: number, r: number) {
  const sand = [hex('#c5b085'), hex('#a48f6a'), hex('#dccba0')], gravel = hex('#3a322b');
  cylinder(
    mb,
    cx,
    cz,
    r,
    DECK.top,
    TANK.waterY,
    (x, y, z) => {
      if (y < 0.3) return gravel;
      const band = Math.sin(y * 9 + noise3(x * 0.7, y, z * 0.7, 9) * 3) * 0.5 + 0.5;
      const top = world.groundAt(x, z);
      // 管の中の陰（光が届きにくい）なので暗めに
      const c = y > top - 0.12 ? sand[2] : mixRGB(sand[0], sand[1], clamp(band, 0, 1) * 0.6);
      return [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55] as RGB;
    },
    0.15,
    { inward: true, caps: false, seg: 32, topAt: (x, z) => world.groundAt(x, z) },
  );
}
