// ゴカイの見た目（AquaWorm の節の位置から、毎フレーム三角形の頂点を作り直す。AquariumRenderer が描く）。
// - 体：節ごとに 6 角の輪をつなぐ管。輪の向きは頭から順に平行移動して決め（ねじれない）、暴れている間は体の軸のまわりに回す（roll）。
//   伸びた節の間は細く・淡く（体積を保つ：半径 ∝ 1/√伸び。透けて見える）、縮んだ所は太く。節ごとに明暗を交互に（体節の輪）。
//   背は暗い赤（背の血管の筋）、腹は明るい。
// - 疣足：節ごとに左右の小さな三角（波に合わせて前後に動く）。頭：短い触角 2・触鬚（太く短い）2・長い触手 2。尾：尾の糸 2。
//   目・口などの顔は描かない（愛嬌は動きで）。
// - 光は E 側と同じ meshFragment（WORM：縁を体の色で明るくして柔らかさ・半透明に見せる）。画面は他と同じ低解像度 → ドット絵の後処理。
// 頂点の数は個体の節の数で決まる（三角形のつなぎ方は固定。保存から戻して節の数が変わったら作り直す）。

import * as THREE from 'three';
import { clamp, lerp, mulberry32 } from '../core/math';
import type { Worm, WormSystem } from './AquaWorm';

const RING = 6;
/** 頭の触手（触角 2・触鬚 2・触手 2）・尾の糸 */
const TENT = 6;
const CIRRI = 2;

type C3 = [number, number, number];

/** 体色（0 = 赤褐色 … 1 = 淡いピンク）と個体の模様 */
function palette(w: Worm): { base: C3; dorsal: C3; belly: C3; para: C3; tent: C3; pale: C3 } {
  const t = w.traits.tone;
  const r = mulberry32(w.traits.seed + 3);
  const j = (r() - 0.5) * 0.06;
  const base: C3 = [lerp(0.62, 0.94, t) + j, lerp(0.16, 0.48, t) + j * 0.5, lerp(0.22, 0.58, t)];
  const dorsal: C3 = [lerp(0.5, 0.78, t), lerp(0.06, 0.16, t), lerp(0.14, 0.3, t)];
  const belly: C3 = [lerp(0.8, 0.98, t), lerp(0.42, 0.7, t), lerp(0.44, 0.72, t)];
  const para: C3 = [lerp(0.58, 0.78, t), lerp(0.2, 0.34, t) + 0.02, lerp(0.16, 0.3, t)];
  const tent: C3 = [0.86, 0.7, 0.6];
  const pale: C3 = [0.98, 0.76, 0.8];
  return { base, dorsal, belly, para, tent, pale };
}

interface Slot {
  worm: Worm;
  v0: number;
  nv: number;
  pal: ReturnType<typeof palette>;
}

export class WormView {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private slots: Slot[] = [];
  private sig = '';
  private pos = new Float32Array(0);
  private nrm = new Float32Array(0);
  private col = new Float32Array(0);
  stats = { verts: 0, tris: 0, ms: 0 };

  constructor(private readonly sys: WormSystem, material: THREE.Material) {
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.rebuild();
  }

  /** 個体の節の数から頂点と三角形のつなぎ方を作り直す */
  private rebuild() {
    const worms = this.sys.worms;
    this.sig = worms.map((w) => `${w.id}:${w.N}`).join(',');
    this.slots = [];
    const idx: number[] = [];
    let v = 0;
    for (const w of worms) {
      const N = w.N;
      const nv = N * RING + 2 + TENT * 3 + CIRRI * 3 + (N - 2) * 6;
      const s: Slot = { worm: w, v0: v, nv, pal: palette(w) };
      this.slots.push(s);
      // 体の管
      for (let i = 0; i < N - 1; i++) {
        for (let k = 0; k < RING; k++) {
          const a = v + i * RING + k, b = v + i * RING + ((k + 1) % RING), c = a + RING, d = b + RING;
          idx.push(a, c, b, b, c, d);
        }
      }
      // 頭・尾のふた
      const hd = v + N * RING, tl = hd + 1;
      for (let k = 0; k < RING; k++) {
        idx.push(hd, v + ((k + 1) % RING), v + k);
        idx.push(tl, v + (N - 1) * RING + k, v + (N - 1) * RING + ((k + 1) % RING));
      }
      // 触手・尾の糸・疣足（3 頂点ずつの三角）
      const t0 = tl + 1;
      for (let q = 0; q < TENT + CIRRI + (N - 2) * 2; q++) idx.push(t0 + q * 3, t0 + q * 3 + 1, t0 + q * 3 + 2);
      v += nv;
    }
    this.pos = new Float32Array(v * 3);
    this.nrm = new Float32Array(v * 3);
    this.col = new Float32Array(v * 3);
    const misc = new Float32Array(v * 2);
    for (let i = 0; i < v; i++) {
      misc[i * 2] = 1;
      misc[i * 2 + 1] = 0.12;
    }
    this.geo.dispose();
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aMisc', new THREE.BufferAttribute(misc, 2));
    this.geo.setIndex(idx);
    this.mesh.geometry = this.geo;
    this.stats.verts = v;
    this.stats.tris = idx.length / 3;
  }

  /** 毎フレーム：節の位置から頂点を作る */
  update(time: number) {
    const t0 = performance.now();
    if (this.sys.worms.map((w) => `${w.id}:${w.N}`).join(',') !== this.sig) this.rebuild();
    for (let k = 0; k < this.slots.length; k++) {
      // 保存から戻して個体を作り直した（節の数が同じ）：参照を新しい個体へ
      if (this.slots[k].worm !== this.sys.worms[k]) {
        this.slots[k].worm = this.sys.worms[k];
        this.slots[k].pal = palette(this.sys.worms[k]);
      }
      this.write(this.slots[k], time);
    }
    for (const n of ['position', 'normal', 'aColor']) (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
    this.stats.ms = performance.now() - t0;
  }

  private write(s: Slot, time: number) {
    const w = s.worm, N = w.N, X = w.x, P = this.pos, Nr = this.nrm, Cl = this.col;
    let o = s.v0;
    // 全身が砂の中・食べ終えて消えた：見えないので 1 点に潰す
    if (w.nb >= N || w.gone) {
      const m = w.gone ? [X[0], X[1] - 50, X[2]] : w.mouth;
      for (let i = 0; i < s.nv; i++) {
        P[(o + i) * 3] = m[0];
        P[(o + i) * 3 + 1] = m[1] - 0.2;
        P[(o + i) * 3 + 2] = m[2];
      }
      return;
    }
    const pal = s.pal;
    const S = w.spec;
    // 輪の向き：頭から平行移動（u = 背、s = 右）
    let ux = 0, uy = 1, uz = 0;
    const T: number[] = new Array(N * 3), U: number[] = new Array(N * 3), Sd: number[] = new Array(N * 3), R: number[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(N - 1, i + 1) * 3;
      let tx = X[a] - X[b], ty = X[a + 1] - X[b + 1], tz = X[a + 2] - X[b + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      let d = ux * tx + uy * ty + uz * tz;
      let px = ux - tx * d, py = uy - ty * d, pz = uz - tz * d;
      let pl = Math.hypot(px, py, pz);
      if (pl < 1e-3) {
        // 体が真上・真下を向いた：別の向きから
        d = tx;
        px = 1 - tx * d;
        py = -ty * d;
        pz = -tz * d;
        pl = Math.hypot(px, py, pz) || 1;
      }
      ux = px / pl;
      uy = py / pl;
      uz = pz / pl;
      // ねじれ（暴れている間）
      const rr = w.roll[i];
      let sx = ty * uz - tz * uy, sy = tz * ux - tx * uz, sz = tx * uy - ty * ux;
      const c = Math.cos(rr), sn = Math.sin(rr);
      const rux = ux * c + sx * sn, ruy = uy * c + sy * sn, ruz = uz * c + sz * sn;
      sx = sx * c - ux * sn;
      sy = sy * c - uy * sn;
      sz = sz * c - uz * sn;
      T[i * 3] = tx;
      T[i * 3 + 1] = ty;
      T[i * 3 + 2] = tz;
      U[i * 3] = rux;
      U[i * 3 + 1] = ruy;
      U[i * 3 + 2] = ruz;
      Sd[i * 3] = sx;
      Sd[i * 3 + 1] = sy;
      Sd[i * 3 + 2] = sz;
      // 半径：伸びた所は細く（体積を保つ）、縮んだ所は太く
      const st = (i > 0 ? w.strain[i - 1] : w.strain[0]) * 0.5 + (i < N - 1 ? w.strain[i] : w.strain[N - 2]) * 0.5;
      // （食べられている間は少し細く）
      R[i] = (w.rad[i] / Math.sqrt(clamp(st, 0.6, 2.4))) * (w.life === 'dead' ? 0.78 + 0.22 * w.left : 1);
    }
    const put = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, c: C3, k = 1) => {
      P[o * 3] = px;
      P[o * 3 + 1] = py;
      P[o * 3 + 2] = pz;
      Nr[o * 3] = nx;
      Nr[o * 3 + 1] = ny;
      Nr[o * 3 + 2] = nz;
      Cl[o * 3] = c[0] * k;
      Cl[o * 3 + 1] = c[1] * k;
      Cl[o * 3 + 2] = c[2] * k;
      o++;
    };
    const mix = (a: C3, b: C3, f: number): C3 => [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
    // 体の輪
    for (let i = 0; i < N; i++) {
      const st = i < N - 1 ? w.strain[i] : w.strain[N - 2];
      const pale = clamp((st - 1) / Math.max(0.2, S.maxStrain - 1), 0, 1) * 0.5;
      const band = i % 2 ? 0.82 : 1;
      const headK = i === 0 ? 0.84 : i === 1 ? 0.93 : 1;
      for (let k = 0; k < RING; k++) {
        const th = (k / RING) * Math.PI * 2;
        const cu = Math.cos(th), su = Math.sin(th);
        const dx = U[i * 3] * cu + Sd[i * 3] * su, dy = U[i * 3 + 1] * cu + Sd[i * 3 + 1] * su, dz = U[i * 3 + 2] * cu + Sd[i * 3 + 2] * su;
        // 少し平たい（背と腹が近い）
        const r = R[i] * (0.9 + 0.15 * Math.abs(su));
        const c0 = k === 0 ? pal.dorsal : k === 3 ? pal.belly : k === 2 || k === 4 ? mix(pal.base, pal.belly, 0.4) : pal.base;
        put(X[i * 3] + dx * r, X[i * 3 + 1] + dy * r, X[i * 3 + 2] + dz * r, dx, dy, dz, mix(c0, pal.pale, pale), band * headK);
      }
    }
    // 頭・尾の先
    const r0 = R[0], rn = R[N - 1], n1 = (N - 1) * 3;
    put(X[0] + T[0] * r0 * 1.15, X[1] + T[1] * r0 * 1.15, X[2] + T[2] * r0 * 1.15, T[0], T[1], T[2], pal.dorsal, 0.95);
    put(X[n1] - T[n1] * rn * 1.4, X[n1 + 1] - T[n1 + 1] * rn * 1.4, X[n1 + 2] - T[n1 + 2] * rn * 1.4, -T[n1], -T[n1 + 1], -T[n1 + 2], pal.base, 0.9);
    // 三角（a, b = 根元、tip = 先）
    const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, n: number, c: C3, ct: C3) => {
      put(ax, ay, az, U[n], U[n + 1], U[n + 2], c);
      put(bx, by, bz, U[n], U[n + 1], U[n + 2], c);
      put(cx, cy, cz, U[n], U[n + 1], U[n + 2], ct);
    };
    // 頭の触手：触角（短く上へ）・触鬚（太く短く下へ）・触手（長く横へ）。先はゆっくり揺れる（もがくと速く）
    const hx = X[0] + T[0] * r0 * 0.9, hy = X[1] + T[1] * r0 * 0.9, hz = X[2] + T[2] * r0 * 0.9;
    const wig = 1 + w.wr * 3;
    for (const [up, side, fw, len, wb] of [[0.55, 0.35, 1.6, 1.6, 0.1], [-0.45, 0.6, 1.1, 1.0, 0.25], [0.1, 1.0, 0.7, 2.6, 0.12]] as const) {
      for (const sg of [1, -1]) {
        const ph = Math.sin(time * 3.1 * wig + sg * 1.7 + up * 3) * 0.5;
        const bx = hx + (U[0] * up + Sd[0] * side * sg) * r0 * 0.7, by = hy + (U[1] * up + Sd[1] * side * sg) * r0 * 0.7, bz = hz + (U[2] * up + Sd[2] * side * sg) * r0 * 0.7;
        const e = r0 * wb + 0.004;
        const tx = bx + (T[0] * fw + Sd[0] * side * sg * (1 + ph) + U[0] * up * 0.8) * r0 * len;
        const ty = by + (T[1] * fw + Sd[1] * side * sg * (1 + ph) + U[1] * up * 0.8) * r0 * len;
        const tz = bz + (T[2] * fw + Sd[2] * side * sg * (1 + ph) + U[2] * up * 0.8) * r0 * len;
        tri(bx - T[0] * e, by - T[1] * e, bz - T[2] * e, bx + Sd[0] * e * sg, by + Sd[1] * e * sg, bz + Sd[2] * e * sg, tx, ty, tz, 0, pal.tent, pal.tent);
      }
    }
    // 尾の糸
    for (const sg of [1, -1]) {
      const bx = X[n1] + Sd[n1] * rn * 0.5 * sg, by = X[n1 + 1] + Sd[n1 + 1] * rn * 0.5 * sg, bz = X[n1 + 2] + Sd[n1 + 2] * rn * 0.5 * sg;
      const ph = Math.sin(time * 2.3 + sg) * 0.4;
      tri(bx, by, bz, bx + T[n1] * rn, by + T[n1 + 1] * rn, bz + T[n1 + 2] * rn,
        bx - (T[n1] * 3.2 - Sd[n1] * sg * (1.4 + ph)) * rn, by - (T[n1 + 1] * 3.2 - Sd[n1 + 1] * sg * (1.4 + ph)) * rn, bz - (T[n1 + 2] * 3.2 - Sd[n1 + 2] * sg * (1.4 + ph)) * rn, n1, pal.tent, pal.tent);
    }
    // 疣足（節ごとに左右。波に合わせて前後に漕ぐ）
    for (let i = 1; i < N - 1; i++) {
      const n = i * 3, r = R[i];
      const row = Math.sin(time * 7 - i * 0.9) * 0.5 * (0.4 + w.wr);
      for (const sg of [1, -1]) {
        const cx = X[n] + Sd[n] * r * 0.85 * sg, cy = X[n + 1] + Sd[n + 1] * r * 0.85 * sg, cz = X[n + 2] + Sd[n + 2] * r * 0.85 * sg;
        const e = r * 0.42;
        const tx = cx + (Sd[n] * sg * 1.0 - U[n] * 0.3 + T[n] * row) * r, ty = cy + (Sd[n + 1] * sg * 1.0 - U[n + 1] * 0.3 + T[n + 1] * row) * r, tz = cz + (Sd[n + 2] * sg * 1.0 - U[n + 2] * 0.3 + T[n + 2] * row) * r;
        tri(cx + T[n] * e, cy + T[n + 1] * e, cz + T[n + 2] * e, cx - T[n] * e, cy - T[n + 1] * e, cz - T[n + 2] * e, tx, ty, tz, n, pal.para, mix(pal.para, pal.dorsal, 0.4));
      }
    }
  }
}
