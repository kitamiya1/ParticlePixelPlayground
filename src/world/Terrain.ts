// 浮き島の地形データ（ゲームロジック側）。高さ・島の範囲・道の位置を提供する。
// 描画方式（粒／メッシュ）には依存しない。

import { clamp, fbm2, lerp, noise2, smoothstep } from '../core/math';

export interface TerrainConfig {
  seed: number;
  radius: number;
  /** ロジック用グリッドの間隔 */
  cell: number;
  /** 道の中心線の制御点 (x, z) */
  pathPoints: [number, number][];
  pathHalfWidth: number;
  plaza: { x: number; z: number; r: number };
}

export class Terrain {
  readonly cfg: TerrainConfig;
  readonly extent: number;
  private readonly n: number;
  private readonly top: Float32Array;
  private readonly bottom: Float32Array;
  private readonly pathSD: Float32Array;
  private readonly pathPolyline: [number, number][] = [];
  maxTop = -Infinity;

  constructor(cfg: TerrainConfig) {
    this.cfg = cfg;
    this.extent = cfg.radius * 1.15 + 1;
    this.n = Math.ceil((this.extent * 2) / cfg.cell) + 1;
    const nn = this.n * this.n;
    this.top = new Float32Array(nn);
    this.bottom = new Float32Array(nn);
    this.pathSD = new Float32Array(nn);
    this.buildPolyline();
    this.bake();
  }

  /** 角度 θ における島の縁までの半径 */
  edgeRadius(theta: number): number {
    const c = Math.cos(theta), s = Math.sin(theta);
    const R = this.cfg.radius;
    return R * (0.86 + 0.07 * Math.sin(3 * theta + 1.2) + 0.09 * noise2(c * 1.6 + 5, s * 1.6 + 5, this.cfg.seed + 3));
  }

  /** 0 = 中心, 1 = 縁 */
  mask(x: number, z: number): number {
    const r = Math.hypot(x, z);
    return r / this.edgeRadius(Math.atan2(z, x));
  }

  isInside(x: number, z: number, margin = 1): boolean {
    return this.mask(x, z) < margin;
  }

  private buildPolyline() {
    const pts = this.cfg.pathPoints;
    // Catmull-Rom で滑らかな折れ線を作る
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let k = 0; k < 12; k++) {
        const t = k / 12, t2 = t * t, t3 = t2 * t;
        const f = (a: number, b: number, c: number, d: number) =>
          0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        this.pathPolyline.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
    this.pathPolyline.push(pts[pts.length - 1]);
  }

  /** 道の符号付き距離（負 = 道の上） */
  private rawPathSD(x: number, z: number): number {
    let best = 1e9;
    const pl = this.pathPolyline;
    for (let i = 0; i < pl.length - 1; i++) {
      const [ax, az] = pl[i], [bx, bz] = pl[i + 1];
      const dx = bx - ax, dz = bz - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < best) best = d;
    }
    const wobble = 0.15 * noise2(x * 0.7, z * 0.7, this.cfg.seed + 41);
    const p = this.cfg.plaza;
    const dp = Math.hypot(x - p.x, z - p.z) - p.r;
    return Math.min(best - this.cfg.pathHalfWidth + wobble, dp + wobble);
  }

  private rawHeight(x: number, z: number, pathW: number, m: number): number {
    const seed = this.cfg.seed;
    let low = 1.1 + 1.4 * fbm2(x * 0.045, z * 0.045, 3, seed);
    low += 2.6 * Math.exp(-((x - 9) ** 2 + (z + 8) ** 2) / 45);
    low += 1.7 * Math.exp(-((x + 11) ** 2 + (z + 7) ** 2) / 30);
    low += 1.0 * Math.exp(-((x + 2) ** 2 + (z - 13) ** 2) / 25);
    const bumps = 0.35 * fbm2(x * 0.2, z * 0.2, 3, seed + 5);
    let h = low + bumps * (1 - pathW);
    const e = smoothstep(0.72, 1.0, m);
    h = h * (1 - 0.55 * e) - 0.2 * e;
    return h;
  }

  private bake() {
    const { n, cfg } = this;
    const seed = cfg.seed;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -this.extent + i * cfg.cell;
        const z = -this.extent + j * cfg.cell;
        const idx = j * n + i;
        const m = this.mask(x, z);
        const sd = this.rawPathSD(x, z);
        this.pathSD[idx] = sd;
        const pw = 1 - smoothstep(-0.3, 0.6, sd);
        const h = this.rawHeight(x, z, pw, Math.min(m, 1));
        this.top[idx] = h;
        if (m < 1 && h > this.maxTop) this.maxTop = h;
        const t = clamp(1 - m, 0, 1);
        let depth = 1.2 + 15 * Math.pow(t, 0.65) * (0.75 + 0.35 * fbm2(x * 0.08, z * 0.08, 3, seed + 9));
        const spike = noise2(x * 0.32, z * 0.32, seed + 21);
        depth += Math.max(0, spike - 0.35) * 14 * Math.pow(t, 0.5);
        this.bottom[idx] = Math.min(h - 0.9, 0.3 - depth);
      }
    }
  }

  private sample(arr: Float32Array, x: number, z: number): number {
    const { n, cfg } = this;
    const fx = clamp((x + this.extent) / cfg.cell, 0, n - 1.001);
    const fz = clamp((z + this.extent) / cfg.cell, 0, n - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const a = arr[j * n + i], b = arr[j * n + i + 1];
    const c = arr[(j + 1) * n + i], d = arr[(j + 1) * n + i + 1];
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  /** 地表の高さ（島の外は -1e6） */
  heightAt(x: number, z: number): number {
    if (this.mask(x, z) >= 1) return -1e6;
    return this.sample(this.top, x, z);
  }

  /** 島の外でも外挿した高さを返す（描画補助用） */
  heightRaw(x: number, z: number): number {
    return this.sample(this.top, x, z);
  }

  bottomAt(x: number, z: number): number {
    return this.sample(this.bottom, x, z);
  }

  pathSignedDistance(x: number, z: number): number {
    return this.sample(this.pathSD, x, z);
  }

  /** 1 = 道の上、0 = 道の外 */
  pathWeight(x: number, z: number): number {
    return 1 - smoothstep(-0.15, 0.15, this.pathSignedDistance(x, z));
  }

  normalAt(x: number, z: number): [number, number, number] {
    const e = 0.2;
    const hx = this.heightRaw(x - e, z) - this.heightRaw(x + e, z);
    const hz = this.heightRaw(x, z - e) - this.heightRaw(x, z + e);
    const len = Math.hypot(hx, 2 * e, hz);
    return [hx / len, (2 * e) / len, hz / len];
  }
}
