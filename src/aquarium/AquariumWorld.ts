// 水槽（アクアテラリウム）のワールド定義（ゲームロジック側。Three.js に依存しない）。
// - 水槽の内寸・水面の高さ（全域で一定）
// - 底床の高さ場（水中の砂地 → 浅瀬の斜面 → 陸地）
// - 岩（洞窟・水中の柱・陸地の足場・滝の崖）と流木の SDF
// - 当たり判定用の距離関数 solid()（高さ場 + 岩 + 流木。見た目の三角形も同じ関数から作るので形が一致する）
// 見た目（メッシュ・サーフェル）は AquariumBuild が、この定義から作る。

import { clamp, fbm2, lerp, noise3, smoothstep } from '../core/math';
import { sdCapsule, sdEllipsoid, smin, type Box3Like, type Sdf } from '../visual/sdf/sdf';

/** 水槽の内寸（ワールド単位。カニの甲羅の幅が約 0.6） */
export const TANK = {
  minX: -18,
  maxX: 18,
  minZ: -10,
  maxZ: 10,
  floorY: 0,
  topY: 13,
  /** 水面の高さ（全域で一定） */
  waterY: 5.5,
  /** ガラスの厚み（見た目用） */
  glass: 0.22,
} as const;

/** 水槽の照明の向き（光が来る向き。真上からやや手前） */
export const LAMP_DIR: [number, number, number] = (() => {
  const v = [0.22, 1, 0.3];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as [number, number, number];
})();

export type RockZone = 'water' | 'land';

/** 岩のかたまり（なめらかに合成した楕円体 + でこぼこ + くり抜き） */
export interface RockFormation {
  name: string;
  zone: RockZone;
  parts: { c: [number, number, number]; r: [number, number, number] }[];
  /** くり抜くカプセル（洞窟のトンネル） */
  holes: { a: [number, number, number]; b: [number, number, number]; r: number }[];
  seed: number;
  rough: number;
  box: Box3Like;
  sdf: Sdf;
}

/** 流木（カプセルの枝の集まり） */
export interface Driftwood {
  name: string;
  branches: { a: [number, number, number]; b: [number, number, number]; ra: number; rb: number }[];
  seed: number;
  box: Box3Like;
  sdf: Sdf;
}

function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** 点から箱までの距離（箱の中なら 0） */
function boxDist(b: Box3Like, x: number, y: number, z: number): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.hypot(dx, dy, dz);
}

function makeRock(name: string, zone: RockZone, parts: RockFormation['parts'], seed: number, rough: number, holes: RockFormation['holes'] = []): RockFormation {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p.c[k] - p.r[k] - 0.6);
      max[k] = Math.max(max[k], p.c[k] + p.r[k] + 0.6);
    }
  }
  min[1] = Math.max(min[1], TANK.floorY - 0.2);
  const k = Math.min(...parts.map((p) => Math.min(p.r[0], p.r[1], p.r[2]))) * 0.9;
  const sdf: Sdf = (x, y, z) => {
    let d = Infinity;
    for (const p of parts) d = smin(d, sdEllipsoid(x, y, z, p.c[0], p.c[1], p.c[2], p.r[0], p.r[1], p.r[2]), k);
    // 大きなうねり + 角ばった細かい凹凸（層状の割れ目に見えるよう、縦方向に圧縮したノイズ）
    d -= noise3(x * 0.55, y * 0.55, z * 0.55, seed) * rough * 0.55;
    d -= noise3(x * 1.7, y * 2.6, z * 1.7, seed + 7) * rough * 0.16;
    for (const h of holes) d = smax(d, -sdCapsule(x, y, z, h.a[0], h.a[1], h.a[2], h.b[0], h.b[1], h.b[2], h.r), 0.3);
    return d;
  };
  return { name, zone, parts, holes, seed, rough, box: { min, max }, sdf };
}

function makeWood(name: string, branches: Driftwood['branches'], seed: number): Driftwood {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of branches) {
    const r = Math.max(b.ra, b.rb) + 0.25;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.a[k] - r, b.b[k] - r);
      max[k] = Math.max(max[k], b.a[k] + r, b.b[k] + r);
    }
  }
  const sdf: Sdf = (x, y, z) => {
    let d = Infinity;
    for (const b of branches) d = smin(d, sdCapsule(x, y, z, b.a[0], b.a[1], b.a[2], b.b[0], b.b[1], b.b[2], b.ra, b.rb), 0.18);
    // 木目に沿った溝（枝の向きにかかわらず効くよう、3 軸のノイズを細く）
    return d - noise3(x * 2.2, y * 2.2, z * 2.2, seed) * 0.035;
  };
  return { name, branches, seed, box: { min, max }, sdf };
}

export class AquariumWorld {
  readonly rocks: RockFormation[] = [];
  readonly woods: Driftwood[] = [];
  /** 高さ場（底床の上面）。格子の一辺 cell */
  readonly cell = 0.2;
  private readonly nx: number;
  private readonly nz: number;
  private readonly height: Float32Array;
  readonly spawn = { x: -4, z: 5 };
  /**
   * 滝：崖の上の流れの始まり（source。x, z）→ 落ち口（top）→ 滝壺（bottom。水面）。
   * 落ち口は崖の西の肩、落ちる弧は崖の面から 0.4 以上離れる（崖の SDF で確認した値）
   */
  readonly waterfall = { source: [7.9, -8.3] as [number, number], top: [5.9, 10.3, -8.3] as [number, number, number], bottom: [3.9, TANK.waterY, -8.0] as [number, number, number], width: 1.2 };
  /** エアストーン（泡が出る所） */
  readonly airStone: [number, number, number];

  constructor() {
    this.nx = Math.round((TANK.maxX - TANK.minX) / this.cell) + 1;
    this.nz = Math.round((TANK.maxZ - TANK.minZ) / this.cell) + 1;
    this.height = new Float32Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        this.height[j * this.nx + i] = this.rawHeight(TANK.minX + i * this.cell, TANK.minZ + j * this.cell);
      }
    }
    this.buildRocks();
    this.buildWoods();
    this.airStone = [-16.6, this.groundAt(-16.6, -8.6) + 0.12, -8.6];
  }

  /** 底床の形：水中の砂地（手前が低く奥が高い）→ 曲がった汀線の緩やかな斜面 → 陸地 */
  private rawHeight(x: number, z: number): number {
    // 汀線を z 方向にうねらせる
    const xs = x + 2.4 * Math.sin(z * 0.26 + 0.6);
    const back = (TANK.maxZ - z) / (TANK.maxZ - TANK.minZ); // 0 = 手前, 1 = 奥
    const sand = 0.75 + 1.25 * back + 0.28 * fbm2(x * 0.18, z * 0.18, 3, 11) + 0.06 * fbm2(x * 0.9, z * 0.9, 2, 12);
    const land = 6.7 + 0.45 * fbm2(x * 0.16, z * 0.16, 3, 13) + 0.1 * fbm2(x * 0.7, z * 0.7, 2, 14);
    const t = smoothstep(-6, 11, xs);
    let h = lerp(sand, land, t);
    // ガラス際は少しだけ下げる（底床の断面が見えるように）
    const edge = Math.min(x - TANK.minX, TANK.maxX - x, z - TANK.minZ, TANK.maxZ - z);
    h -= (1 - smoothstep(0, 0.8, edge)) * 0.12;
    return Math.max(h, TANK.floorY + 0.25);
  }

  private buildRocks() {
    const sandY = (x: number, z: number) => this.rawHeight(x, z);
    // 水中：カニが通れる洞窟（x 方向に貫くトンネル）
    const tz0 = -1.2, tz1 = -1.9;
    this.rocks.push(
      makeRock(
        'cave',
        'water',
        [
          { c: [-10, 1.7, -1.6], r: [3.5, 2.3, 2.5] },
          { c: [-7.4, 1.3, -2.4], r: [2.2, 1.8, 2.0] },
          { c: [-12.6, 1.1, -0.7], r: [2.0, 1.6, 2.0] },
          { c: [-9.4, 3.3, -2.3], r: [1.9, 1.3, 1.6] },
        ],
        21,
        0.55,
        [{ a: [-15.2, sandY(-14, tz0) + 0.62, tz0], b: [-4.8, sandY(-6, tz1) + 0.62, tz1], r: 0.82 }],
      ),
    );
    // 水中：水面のすぐ下まで届く岩の柱（泳いで乗れる）
    this.rocks.push(makeRock('pillar', 'water', [{ c: [-3.3, 2.6, -6.6], r: [1.5, 2.6, 1.35] }, { c: [-2.2, 1.3, -5.7], r: [1.4, 1.3, 1.3] }], 31, 0.5));
    // 水中：低い平らな岩（手前左）
    this.rocks.push(makeRock('step', 'water', [{ c: [-14.6, 1.25, 5.4], r: [2.2, 0.95, 1.6] }, { c: [-12.9, 1.0, 6.3], r: [1.2, 0.8, 1.1] }], 41, 0.4));
    // 浅瀬：汀線の近くの岩
    this.rocks.push(makeRock('shore', 'water', [{ c: [2.8, 2.9, 6.4], r: [1.6, 1.0, 1.3] }], 51, 0.4));
    // 陸地：高低差のある足場（約 1 単位ずつ高くなる）
    this.rocks.push(makeRock('ledge1', 'land', [{ c: [11.2, 6.75, -0.6], r: [1.7, 0.85, 1.5] }], 61, 0.35));
    this.rocks.push(makeRock('ledge2', 'land', [{ c: [13.2, 7.1, -4.4], r: [2.4, 1.55, 2.0] }, { c: [14.8, 6.8, -6.2], r: [1.6, 1.3, 1.4] }], 71, 0.45));
    this.rocks.push(makeRock('ledge3', 'land', [{ c: [15.9, 7.9, -1.6], r: [1.7, 1.85, 1.7] }], 81, 0.45));
    this.rocks.push(makeRock('landfront', 'land', [{ c: [14.6, 6.9, 6.4], r: [1.8, 1.25, 1.5] }], 91, 0.4));
    // 陸地の奥：滝の崖（西側の面は水中に立つ）
    this.rocks.push(
      makeRock(
        'cliff',
        'land',
        [
          { c: [9.6, 7.6, -8.4], r: [3.9, 3.7, 1.8] },
          { c: [6.6, 6.6, -8.3], r: [1.6, 3.7, 1.7] },
          { c: [12.8, 7.0, -8.0], r: [2.0, 2.6, 1.9] },
        ],
        101,
        0.5,
      ),
    );
  }

  private buildWoods() {
    // 陸地から水中へ斜めに入る流木（上を歩いて上陸・入水できる）
    this.woods.push(
      makeWood(
        'log',
        [
          { a: [12.0, 7.0, 2.6], b: [4.2, 4.6, 1.0], ra: 0.42, rb: 0.36 },
          { a: [4.2, 4.6, 1.0], b: [-1.6, 2.35, -0.6], ra: 0.36, rb: 0.26 },
          { a: [4.2, 4.6, 1.0], b: [2.4, 7.6, 3.3], ra: 0.22, rb: 0.1 },
          { a: [7.6, 5.9, 1.7], b: [8.8, 6.6, 5.6], ra: 0.2, rb: 0.1 },
          { a: [0.8, 3.3, 0.1], b: [-0.6, 3.9, -2.6], ra: 0.16, rb: 0.07 },
        ],
        5,
      ),
    );
    // 水中の奥：苔の付いた枝分かれした流木
    this.woods.push(
      makeWood(
        'branchy',
        [
          { a: [-16.4, 1.55, -6.6], b: [-11.6, 2.1, -8.2], ra: 0.32, rb: 0.24 },
          { a: [-13.5, 1.85, -7.6], b: [-12.4, 4.4, -8.9], ra: 0.2, rb: 0.09 },
          { a: [-12.2, 2.0, -8.0], b: [-9.6, 3.6, -6.4], ra: 0.17, rb: 0.07 },
          { a: [-15.0, 1.7, -7.1], b: [-15.8, 3.5, -4.8], ra: 0.15, rb: 0.06 },
        ],
        6,
      ),
    );
  }

  // ---------------- 高さ場 ----------------

  /** 底床の上面の高さ（双一次補間） */
  groundAt(x: number, z: number): number {
    const fx = clamp((x - TANK.minX) / this.cell, 0, this.nx - 1.001);
    const fz = clamp((z - TANK.minZ) / this.cell, 0, this.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const n = this.nx, h = this.height;
    return lerp(lerp(h[j * n + i], h[j * n + i + 1], u), lerp(h[(j + 1) * n + i], h[(j + 1) * n + i + 1], u), v);
  }

  groundNormal(x: number, z: number): [number, number, number] {
    const e = 0.15;
    const hx = this.groundAt(x - e, z) - this.groundAt(x + e, z);
    const hz = this.groundAt(x, z - e) - this.groundAt(x, z + e);
    const l = Math.hypot(hx, 2 * e, hz);
    return [hx / l, (2 * e) / l, hz / l];
  }

  // ---------------- 当たり判定 ----------------

  /**
   * 固体（底床・岩・流木）までのおおよその符号付き距離（内側が負）。
   * 岩・流木は外接箱から離れていれば箱までの距離を返す（下限なので球の追跡にそのまま使える）。
   */
  solid(x: number, y: number, z: number): number {
    const n = this.groundNormal(x, z);
    let d = (y - this.groundAt(x, z)) * n[1];
    for (const r of this.rocks) {
      const bd = boxDist(r.box, x, y, z);
      d = Math.min(d, bd > 0.5 ? bd : r.sdf(x, y, z));
    }
    for (const w of this.woods) {
      const bd = boxDist(w.box, x, y, z);
      d = Math.min(d, bd > 0.5 ? bd : w.sdf(x, y, z));
    }
    return d;
  }

  /** solid の勾配（外向きの単位法線） */
  solidNormal(x: number, y: number, z: number): [number, number, number] {
    const e = 0.03;
    const gx = this.solid(x + e, y, z) - this.solid(x - e, y, z);
    const gy = this.solid(x, y + e, z) - this.solid(x, y - e, z);
    const gz = this.solid(x, y, z + e) - this.solid(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  }

  /**
   * 点 (x, y, z) から光の向きへ固体を追跡した日照（0 = 影, 1 = 日なた。半影つき）。
   * 見た目の焼き込み用（ゲームロジックでは使わない）
   */
  sunVisibility(x: number, y: number, z: number, dir: readonly number[] = LAMP_DIR): number {
    let t = 0.12, vis = 1;
    for (let i = 0; i < 40 && t < 16; i++) {
      const px = x + dir[0] * t, py = y + dir[1] * t, pz = z + dir[2] * t;
      if (py > TANK.topY) break;
      const d = this.solid(px, py, pz);
      if (d < 0.02) return 0.08;
      vis = Math.min(vis, (5 * d) / t);
      t += Math.max(d * 0.9, 0.08);
    }
    return clamp(vis, 0.08, 1);
  }

  /** 点が水槽の内側か */
  insideTank(x: number, z: number, margin = 0): boolean {
    return x > TANK.minX + margin && x < TANK.maxX - margin && z > TANK.minZ + margin && z < TANK.maxZ - margin;
  }
}
