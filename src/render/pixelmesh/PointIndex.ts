// 点群の近傍検索（方式 E の頂点へ色・日照・風を写すため）。Three.js に依存しない。
// 空間を一辺 cell の格子に分け、格子のハッシュ値ごとに点を並べ替えて持つ（計数ソート。ハッシュの衝突は距離で弾く）。

import type { SplatPointSet } from '../shared/PointSet';

export interface PointSample {
  /** 最も近い点（見つからなければ -1） */
  nearest: number;
  /** 半径 rAvg 内の点の日照・風の加重平均（点が無ければ最も近い点の値） */
  sun: number;
  wind: number;
}

export class PointIndex {
  private readonly start: Int32Array;
  private readonly order: Int32Array;
  private readonly mask: number;
  private readonly inv: number;

  constructor(readonly set: SplatPointSet, readonly cell = 0.25, bits = 19) {
    const size = 1 << bits;
    this.mask = size - 1;
    this.inv = 1 / cell;
    const n = set.count;
    const bucketOf = new Int32Array(n);
    const count = new Int32Array(size + 1);
    const p = set.pos;
    for (let i = 0; i < n; i++) {
      const b = this.bucket(Math.floor(p[i * 3] * this.inv), Math.floor(p[i * 3 + 1] * this.inv), Math.floor(p[i * 3 + 2] * this.inv));
      bucketOf[i] = b;
      count[b + 1]++;
    }
    for (let b = 0; b < size; b++) count[b + 1] += count[b];
    this.start = count;
    this.order = new Int32Array(n);
    const fill = count.slice(0, size);
    for (let i = 0; i < n; i++) this.order[fill[bucketOf[i]]++] = i;
  }

  private bucket(i: number, j: number, k: number) {
    return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) & this.mask;
  }

  /**
   * (x, y, z) の近くの点を調べる。最も近い点は周囲 3×3×3 の格子で探し、無ければ maxRing まで広げる。
   * 日照・風は半径 rAvg 内の点を距離で重み付けして平均する（メッシュの頂点ごとに値がばらつかないように）。
   */
  sample(x: number, y: number, z: number, rAvg: number, out: PointSample, maxRing = 3): PointSample {
    const s = this.set, p = s.pos;
    const ci = Math.floor(x * this.inv), cj = Math.floor(y * this.inv), ck = Math.floor(z * this.inv);
    let best = -1, bd = Infinity, ws = 0, sun = 0, wind = 0;
    const r2 = rAvg * rAvg;
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let c = ck - ring; c <= ck + ring; c++) for (let b = cj - ring; b <= cj + ring; b++) for (let a = ci - ring; a <= ci + ring; a++) {
        if (ring > 1 && Math.abs(a - ci) < ring && Math.abs(b - cj) < ring && Math.abs(c - ck) < ring) continue; // 内側は調べ済み
        const h = this.bucket(a, b, c);
        for (let q = this.start[h], e = this.start[h + 1]; q < e; q++) {
          const i = this.order[q];
          const dx = p[i * 3] - x, dy = p[i * 3 + 1] - y, dz = p[i * 3 + 2] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) {
            bd = d;
            best = i;
          }
          if (d < r2) {
            const w = 1 - d / r2;
            ws += w;
            sun += s.sun[i] * w;
            wind += s.wind[i] * w;
          }
        }
      }
      // 調べた範囲の内接球より近い点が見つかれば、それより外に近い点はない
      if (best >= 0 && Math.sqrt(bd) <= ring * this.cell) break;
    }
    out.nearest = best;
    if (ws > 0) {
      out.sun = sun / ws;
      out.wind = wind / ws;
    } else if (best >= 0) {
      out.sun = s.sun[best];
      out.wind = s.wind[best];
    } else {
      out.sun = 1;
      out.wind = 0;
    }
    return out;
  }
}
