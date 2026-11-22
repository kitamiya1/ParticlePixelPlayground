// 水槽の外側の定義（ゲームロジック側。Three.js に依存しない）：水槽台・濾過槽（サンプ）・配管・部屋。
// 位置関係（上から）：水槽本体（y 0〜13）→ 底板・台の天板（y -1〜0）→ 水槽台の箱（y -12〜-1）の中に濾過槽 → 部屋の床（y -12）。
// - 排水管（drain）：水面の少し下に開いた縦穴（透明な管の上端）から真下へ。水槽の底・台の天板を貫いて濾過槽の落水室へ。
// - 給水管（ret）：ポンプ室の吸い込み口 → ポンプ → 台の中を回って天板・水槽の底を貫き、水槽の奥の水中へ吐き出す。
// - 濾過槽：落水室 →（下をくぐる仕切り）→ スポンジ室 →（越流の仕切り）→ ろ材室 →（越流・水位差）→ ポンプ室。
// 当たり判定はすべて距離関数（箱・円柱・管）で、AquariumWorld.contactSolid が水槽の中身と合わせて使う。
// 見た目は AquariumStandBuild（三角形）と AquariumPlumbingFx（透明な管・水面・水流）が、この定義から作る。

import { clamp } from '../core/math';
import { TANK } from './aquaConst';

export type Vec3 = [number, number, number];

/** カニのいる区画（カメラ・表示・水の判定に使う） */
export type Region = 'tank' | 'drain' | 'return' | 'sump' | 'stand' | 'room';
export const REGION_LABEL: Record<Region, string> = { tank: '水槽', drain: '排水管', return: '給水管', sump: '濾過槽', stand: '水槽台', room: '部屋' };

const G = TANK.glass;

/** 水槽の底板（ガラスの内側）と台の天板（ガラスの外へ張り出す） */
export const DECK = {
  y0: -1.0,
  boardTop: -0.35,
  top: TANK.floorY,
  plate: { minX: TANK.minX - G, maxX: TANK.maxX + G, minZ: TANK.minZ - G, maxZ: TANK.maxZ + G },
  board: { minX: TANK.minX - G - 1.4, maxX: TANK.maxX + G + 1.4, minZ: TANK.minZ - G - 1.4, maxZ: TANK.maxZ + G + 1.4 },
} as const;

/** 水槽台の箱（中は空洞。前面は 3 枚の扉で、右の扉が開いている） */
export const CABINET = {
  minX: TANK.minX - G - 1.0,
  maxX: TANK.maxX + G + 1.0,
  minZ: TANK.minZ - G - 1.0,
  maxZ: TANK.maxZ + G + 1.0,
  minY: -12,
  maxY: DECK.y0,
  wall: 0.4,
  /** 台の中の床の上面 */
  floorTop: -11.6,
  /** 扉の上の桟の下端 */
  railY: -1.4,
} as const;

/** 部屋（内向きの箱。床の高さ = 水槽台の下端） */
export const ROOM = { minX: -80, maxX: 80, minZ: -42, maxZ: 80, floorY: -12, ceilY: 48 } as const;

export interface Chamber {
  id: 'drop' | 'sponge' | 'media' | 'pump';
  name: string;
  /** 内側の x の範囲（仕切りの面まで） */
  x0: number;
  x1: number;
  /** 水面の高さ */
  level: number;
}

/** 濾過槽（透明なアクリルの箱。上は開いていて、上縁には内向きのつば） */
export const SUMP = {
  minX: -9.5,
  maxX: 8.5,
  minZ: -7.0,
  maxZ: 7.8,
  bottomY: CABINET.floorTop,
  floorTop: CABINET.floorTop + 0.15,
  rimY: -7.0,
  wall: 0.12,
  /** 上縁のつばの幅・厚み（カニが歩ける） */
  flange: 0.6,
  flangeT: 0.12,
  /** 仕切りの位置（x）と種類：under = 下をくぐる、over = 上を越える */
  baffles: [
    { x: -4.5, kind: 'under' as const, top: -7.0, bottom: -10.45 },
    { x: -0.5, kind: 'over' as const, top: -7.75, bottom: CABINET.floorTop + 0.15 },
    { x: 4.0, kind: 'over' as const, top: -7.9, bottom: CABINET.floorTop + 0.15 },
  ],
  chambers: [
    { id: 'drop', name: '落水室', x0: -9.38, x1: -4.56, level: -7.6 },
    { id: 'sponge', name: 'スポンジ室', x0: -4.44, x1: -0.56, level: -7.6 },
    { id: 'media', name: 'ろ材室', x0: -0.44, x1: 3.94, level: -7.85 },
    { id: 'pump', name: 'ポンプ室', x0: 4.06, x1: 8.38, level: -8.5 },
  ] as Chamber[],
} as const;

/** 濾過槽の内側の範囲 */
export const SUMP_IN = {
  minX: SUMP.minX + SUMP.wall,
  maxX: SUMP.maxX - SUMP.wall,
  minZ: SUMP.minZ + SUMP.wall,
  maxZ: SUMP.maxZ - SUMP.wall,
} as const;

// ---------------- 形の部品 ----------------

export interface Box {
  min: Vec3;
  max: Vec3;
}

/** 見た目の種類（AquariumStandBuild が色・作りを決める） */
export type PartLook = 'cabinet' | 'door' | 'sponge' | 'wool' | 'basket' | 'pump' | 'box' | 'bucket' | 'rug' | 'book' | 'can';

export interface BoxPart extends Box {
  look: PartLook;
  name: string;
  /** 色の番号（同じ種類での色違い） */
  tint?: number;
}

/** 縦の円柱（バケツ・缶など） */
export interface CylPart {
  look: PartLook;
  name: string;
  c: [number, number];
  r: number;
  y0: number;
  y1: number;
  tint?: number;
}

/** y 軸まわりに回した箱（開いた扉）。中心・半分の大きさ・回転角 */
export interface OrientedPart {
  look: PartLook;
  name: string;
  c: Vec3;
  half: Vec3;
  rot: number;
}

export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box {
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

/** 箱までの符号付き距離 */
export function sdBox(x: number, y: number, z: number, b: Box): number {
  const qx = Math.abs(x - (b.min[0] + b.max[0]) * 0.5) - (b.max[0] - b.min[0]) * 0.5;
  const qy = Math.abs(y - (b.min[1] + b.max[1]) * 0.5) - (b.max[1] - b.min[1]) * 0.5;
  const qz = Math.abs(z - (b.min[2] + b.max[2]) * 0.5) - (b.max[2] - b.min[2]) * 0.5;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0);
}

function sdCyl(x: number, y: number, z: number, c: CylPart): number {
  const dx = Math.hypot(x - c.c[0], z - c.c[1]) - c.r;
  const dy = Math.max(c.y0 - y, y - c.y1);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function sdOriented(x: number, y: number, z: number, o: OrientedPart): number {
  const dx = x - o.c[0], dz = z - o.c[2];
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  // ワールド → 箱のローカル（rot だけ逆に回す）
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return sdBox(lx, y - o.c[1], lz, { min: [-o.half[0], -o.half[1], -o.half[2]], max: [o.half[0], o.half[1], o.half[2]] });
}

function inBox(b: Box, x: number, y: number, z: number, m = 0): boolean {
  return x > b.min[0] - m && x < b.max[0] + m && y > b.min[1] - m && y < b.max[1] + m && z > b.min[2] - m && z < b.max[2] + m;
}

// ---------------- 管 ----------------

interface Seg {
  a: Vec3;
  u: Vec3;
  len: number;
  s0: number;
}

/** 管の中心線への最も近い点の情報（毎回の割り当てを避けて使い回す） */
export interface PipeHit {
  /** 中心線までの距離 */
  d: number;
  /** 中心線に沿った位置（0..length） */
  s: number;
  /** 端の外側か（-1 = 始点の外, 1 = 終点の外, 0 = 管の範囲） */
  end: -1 | 0 | 1;
  /** 端の外側のとき、端の面からの距離と、軸からの距離 */
  axial: number;
  radial: number;
  seg: number;
}

/**
 * 管：折れ線の中心線（角は丸める）+ 内径・肉厚。両端は開いている。
 * - wall：管の壁（肉厚の筒。端は丸い縁）までの距離 → 当たり判定
 * - interior：管の中（端は平らに切る）までの距離。負なら管の中 → 管が貫く物（砂・底板・天板・ポンプ）を削る
 */
export class Pipe {
  readonly pts: Vec3[];
  readonly segs: Seg[] = [];
  readonly length: number;
  readonly rMid: number;
  readonly halfT: number;
  readonly outer: number;
  readonly box: Box;
  private readonly hit: PipeHit = { d: 0, s: 0, end: 0, axial: 0, radial: 0, seg: 0 };

  constructor(readonly name: string, corners: Vec3[], readonly inner: number, wall: number, fillet = 0) {
    this.pts = fillet > 0 ? filletPolyline(corners, fillet) : corners.map((p) => [...p] as Vec3);
    let s = 0;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i], b = this.pts[i + 1];
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len < 1e-6) continue;
      this.segs.push({ a, u: [d[0] / len, d[1] / len, d[2] / len], len, s0: s });
      s += len;
    }
    this.length = s;
    this.rMid = inner + wall * 0.5;
    this.halfT = wall * 0.5;
    this.outer = inner + wall;
    const m = this.outer + 0.6;
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of this.pts) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k] - m);
      max[k] = Math.max(max[k], p[k] + m);
    }
    this.box = { min, max };
  }

  /** 中心線に最も近い点（結果は使い回しの PipeHit） */
  closest(x: number, y: number, z: number): PipeHit {
    let best = Infinity, bs = 0, bseg = 0, bt = 0, braw = 0;
    for (let i = 0; i < this.segs.length; i++) {
      const g = this.segs[i];
      const vx = x - g.a[0], vy = y - g.a[1], vz = z - g.a[2];
      const raw = vx * g.u[0] + vy * g.u[1] + vz * g.u[2];
      const t = clamp(raw, 0, g.len);
      const qx = vx - g.u[0] * t, qy = vy - g.u[1] * t, qz = vz - g.u[2] * t;
      const d2 = qx * qx + qy * qy + qz * qz;
      if (d2 < best) {
        best = d2;
        bs = g.s0 + t;
        bseg = i;
        bt = t;
        braw = raw;
      }
    }
    const h = this.hit;
    h.d = Math.sqrt(best);
    h.s = bs;
    h.seg = bseg;
    h.end = 0;
    const g = this.segs[bseg];
    if (bseg === 0 && bt <= 0 && braw < 0) {
      h.end = -1;
      h.axial = -braw;
    } else if (bseg === this.segs.length - 1 && bt >= g.len && braw > g.len) {
      h.end = 1;
      h.axial = braw - g.len;
    }
    if (h.end !== 0) h.radial = Math.sqrt(Math.max(0, best - h.axial * h.axial));
    return h;
  }

  /** 管の壁までの距離 */
  wall(x: number, y: number, z: number): number {
    if (!inBox(this.box, x, y, z)) return boxOutside(this.box, x, y, z) + 0.5;
    const h = this.closest(x, y, z);
    if (h.end !== 0) return Math.hypot(h.radial - this.rMid, h.axial) - this.halfT;
    return Math.abs(h.d - this.rMid) - this.halfT;
  }

  /** 管の中までの距離（負 = 管の中）。端は平らに切る */
  interior(x: number, y: number, z: number): number {
    if (!inBox(this.box, x, y, z)) return boxOutside(this.box, x, y, z) + 0.5;
    const h = this.closest(x, y, z);
    if (h.end !== 0) return Math.max(h.radial - this.inner, h.axial);
    return h.d - this.inner;
  }

  pointAt(s: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const g = this.segAt(s);
    const t = clamp(s - g.s0, 0, g.len);
    out[0] = g.a[0] + g.u[0] * t;
    out[1] = g.a[1] + g.u[1] * t;
    out[2] = g.a[2] + g.u[2] * t;
    return out;
  }

  tangentAt(s: number): Vec3 {
    return this.segAt(s).u;
  }

  private segAt(s: number): Seg {
    let g = this.segs[0];
    for (const q of this.segs) if (s >= q.s0) g = q;
    return g;
  }
}

function boxOutside(b: Box, x: number, y: number, z: number): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.hypot(dx, dy, dz);
}

/** 折れ線の角を丸める（角ごとに二次ベジェで 6 分割。半径は隣の辺の半分まで） */
function filletPolyline(c: Vec3[], radius: number): Vec3[] {
  const out: Vec3[] = [[...c[0]] as Vec3];
  for (let i = 1; i < c.length - 1; i++) {
    const p = c[i], a = c[i - 1], b = c[i + 1];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]);
    const r = Math.min(radius, la * 0.5, lb * 0.5);
    const p0: Vec3 = [p[0] + ((a[0] - p[0]) / la) * r, p[1] + ((a[1] - p[1]) / la) * r, p[2] + ((a[2] - p[2]) / la) * r];
    const p2: Vec3 = [p[0] + ((b[0] - p[0]) / lb) * r, p[1] + ((b[1] - p[1]) / lb) * r, p[2] + ((b[2] - p[2]) / lb) * r];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6, u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * p[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p[1] + t * t * p2[1], u * u * p0[2] + 2 * u * t * p[2] + t * t * p2[2]]);
    }
  }
  out.push([...c[c.length - 1]] as Vec3);
  return out;
}

// ---------------- 水の流れ ----------------

/** 流れ：目標の速度と、そこへ寄せる強さ（1/秒）。ride = 管の中（重力・ジャンプ・遊泳なし） */
export interface Flow {
  vx: number;
  vy: number;
  vz: number;
  k: number;
  ride: boolean;
}

// ---------------- 全体 ----------------

export class AquaStand {
  /** 縦穴式の排水管（透明）。上端が水面の少し下に開く */
  readonly drain: Pipe;
  /** ポンプからの給水管（透明） */
  readonly ret: Pipe;
  /** 排水管の軸（x, z）と上端の高さ */
  readonly drainAxis: [number, number];
  readonly drainRim: number;
  /** 水面の穴の半径（渦の外側） */
  readonly mouthR = 1.6;
  /** 砂・底板・天板を縦に貫く管の柱（x, z, 外径, 内径, 上端の高さ）：排水管・給水管の縦の部分 */
  readonly columns: { x: number; z: number; r: number; inner: number; top: number }[];
  /** 給水管の吐き出し口と向き */
  readonly outlet: Vec3;
  readonly outletDir: Vec3;
  /** 不透明な箱（水槽台・濾過槽の中のろ材・ポンプ・段・家具） */
  readonly opaque: BoxPart[] = [];
  readonly cyls: CylPart[] = [];
  readonly oriented: OrientedPart[] = [];
  /** 透明な箱（濾過槽のアクリルの壁・仕切り・つば） */
  readonly acrylic: Box[] = [];
  /** 水槽のガラス */
  readonly glass: Box[] = [];
  /** ポンプの外箱（給水管の中だけ削る） */
  readonly pumpHousing: Box;
  private readonly deckBoard: Box;
  private readonly deckPlate: Box;

  constructor() {
    // ---- 配管 ----
    const dx = -6.5, dz = 5.6;
    this.drainAxis = [dx, dz];
    this.drainRim = TANK.waterY - 0.85;
    this.drain = new Pipe('drain', [[dx, this.drainRim, dz], [dx, -8.1, dz]], 0.75, 0.08);
    // 吸い込み口（ポンプ室の床ぎわ、手前 +z を向く）→ ポンプ → 上へ → 台の中を奥・左へ → 天板と水槽の底を貫いて上へ → 手前へ吐き出す
    const fy = SUMP.floorTop + 0.5;
    const retPts: Vec3[] = [
      [6.6, fy, -3.6],
      [6.6, fy, -5.0],
      [6.6, -3.0, -5.0],
      [6.6, -3.0, -9.3],
      [1.5, -3.0, -9.3],
      [1.5, TANK.waterY - 0.95, -9.3],
      [1.5, TANK.waterY - 0.95, -8.2],
    ];
    this.ret = new Pipe('return', retPts, 0.5, 0.07, 0.9);
    this.outlet = retPts[retPts.length - 1];
    this.outletDir = [0, 0, 1];
    this.columns = [
      { x: dx, z: dz, r: this.drain.outer, inner: this.drain.inner, top: this.drainRim },
      // 給水管の縦の部分の上端（吐き出し口へ曲がる手前。角の丸めの分だけ下）
      { x: retPts[4][0], z: retPts[4][2], r: this.ret.outer, inner: this.ret.inner, top: retPts[5][1] - 0.9 },
    ];

    // ---- 底板・天板（管の通る穴は interior で削る） ----
    this.deckPlate = box(DECK.plate.minX, DECK.boardTop, DECK.plate.minZ, DECK.plate.maxX, DECK.top, DECK.plate.maxZ);
    this.deckBoard = box(DECK.board.minX, DECK.y0, DECK.board.minZ, DECK.board.maxX, DECK.boardTop, DECK.board.maxZ);

    // ---- 水槽のガラス ----
    const gy0 = DECK.boardTop, gy1 = TANK.topY;
    this.glass.push(
      box(TANK.minX - G, gy0, TANK.minZ - G, TANK.minX, gy1, TANK.maxZ + G),
      box(TANK.maxX, gy0, TANK.minZ - G, TANK.maxX + G, gy1, TANK.maxZ + G),
      box(TANK.minX, gy0, TANK.minZ - G, TANK.maxX, gy1, TANK.minZ),
      box(TANK.minX, gy0, TANK.maxZ, TANK.maxX, gy1, TANK.maxZ + G),
    );

    // ---- 水槽台の箱 ----
    const C = CABINET, w = C.wall;
    const cab = (name: string, b: Box) => this.opaque.push({ ...b, look: 'cabinet', name });
    cab('floor', box(C.minX, C.minY, C.minZ, C.maxX, C.floorTop, C.maxZ));
    cab('left', box(C.minX, C.floorTop, C.minZ, C.minX + w, C.maxY, C.maxZ));
    cab('right', box(C.maxX - w, C.floorTop, C.minZ, C.maxX, C.maxY, C.maxZ));
    cab('back', box(C.minX + w, C.floorTop, C.minZ, C.maxX - w, C.maxY, C.minZ + w));
    cab('rail', box(C.minX + w, C.railY, C.maxZ - w, C.maxX - w, C.maxY, C.maxZ));
    // 前面の扉：左・中は閉じている、右は開いている（蝶番は右端）
    const ix0 = C.minX + w, ix1 = C.maxX - w;
    const dw = (ix1 - ix0) / 3;
    this.opaque.push({ ...box(ix0, C.floorTop, C.maxZ - w, ix0 + dw, C.railY, C.maxZ), look: 'door', name: 'doorL' });
    this.opaque.push({ ...box(ix0 + dw, C.floorTop, C.maxZ - w, ix0 + dw * 2, C.railY, C.maxZ), look: 'door', name: 'doorM', tint: 1 });
    // 閉じていると蝶番（右端・前面の角）から −x へ伸び、厚みは −z 側。蝶番まわりに y 軸で ang だけ外へ開く
    // （ローカル → ワールド：x' = x cos + z sin, z' = −x sin + z cos）
    const ang = (105 * Math.PI) / 180;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const along: [number, number] = [-ca, sa], thick: [number, number] = [-sa, -ca];
    this.oriented.push({
      look: 'door',
      name: 'doorR',
      c: [ix1 + along[0] * dw * 0.5 + thick[0] * w * 0.5, (C.floorTop + C.railY) / 2 + 0.05, C.maxZ + along[1] * dw * 0.5 + thick[1] * w * 0.5],
      half: [dw * 0.5, (C.railY - C.floorTop) / 2 - 0.05, w * 0.5],
      rot: ang,
    });
    /** 開口部（右の扉の跡） */
    this.doorway = { x0: ix0 + dw * 2, x1: ix1, y0: C.floorTop, y1: C.railY };

    // ---- 濾過槽（アクリル） ----
    const S = SUMP, t = S.wall;
    this.acrylic.push(
      box(S.minX, S.bottomY, S.minZ, S.maxX, S.floorTop, S.maxZ),
      box(S.minX, S.floorTop, S.minZ, S.minX + t, S.rimY, S.maxZ),
      box(S.maxX - t, S.floorTop, S.minZ, S.maxX, S.rimY, S.maxZ),
      box(S.minX + t, S.floorTop, S.minZ, S.maxX - t, S.rimY, S.minZ + t),
      box(S.minX + t, S.floorTop, S.maxZ - t, S.maxX - t, S.rimY, S.maxZ),
    );
    // 上縁のつば（内向き。四辺）
    const f = S.flange, fy0 = S.rimY - S.flangeT;
    this.acrylic.push(
      box(S.minX + t, fy0, S.maxZ - t - f, S.maxX - t, S.rimY, S.maxZ - t),
      box(S.minX + t, fy0, S.minZ + t, S.maxX - t, S.rimY, S.minZ + t + f),
      box(S.minX + t, fy0, S.minZ + t + f, S.minX + t + f, S.rimY, S.maxZ - t - f),
      box(S.maxX - t - f, fy0, S.minZ + t + f, S.maxX - t, S.rimY, S.maxZ - t - f),
    );
    for (const b of S.baffles) this.acrylic.push(box(b.x - t / 2, b.bottom, S.minZ + t, b.x + t / 2, b.top, S.maxZ - t));

    // ---- 濾過槽の中身 ----
    const ft = S.floorTop;
    const put = (look: PartLook, name: string, b: Box, tint = 0) => this.opaque.push({ ...b, look, name, tint });
    // スポンジ室：段になったスポンジと、いちばん上のウールマット。奥はスポンジの壁で仕切られた隙間（隠れた場所）
    // （落水室から仕切りの下をくぐって出た所は空けておく：x −4.44〜−3.75）
    put('sponge', 'sponge1', box(-3.75, ft, -2.6, -2.4, -10.25, 3.6));
    put('sponge', 'sponge2', box(-2.4, ft, -1.6, -0.6, -9.05, 4.6), 1);
    put('wool', 'wool', box(-1.9, -9.05, -0.6, -0.6, -8.1, 4.2));
    put('sponge', 'spongeWall', box(-4.4, ft, -3.4, -1.45, -8.0, -2.6), 1);
    // ろ材室：リングろ材を詰めたかごの階段（手前の壁ぎわ。いちばん上は水面より上）と、奥の低いかご
    put('basket', 'basket1', box(-0.4, ft, 3.4, 1.1, -10.35, 7.0));
    put('basket', 'basket2', box(1.1, ft, 3.4, 2.5, -9.25, 7.0));
    put('basket', 'basket3', box(2.5, ft, 3.4, 3.9, -8.15, 7.0));
    put('basket', 'basket4', box(2.5, -8.15, 5.4, 3.9, -7.45, 7.0));
    put('basket', 'basket5', box(-0.4, ft, -6.8, 3.9, -10.0, -3.0));
    // ポンプ室：給水管の付け根のポンプ（外箱）とモーター
    this.pumpHousing = box(5.75, ft, -5.85, 7.45, -9.1, -4.15);
    put('pump', 'pump', this.pumpHousing);
    put('pump', 'motor', box(7.45, ft + 0.15, -5.55, 8.2, -9.6, -4.45), 1);

    // ---- 台の中：濾過槽の手前に積んだ用品の箱（濾過槽の上縁へ登る段。いちばん上はろ材かごの階段の正面） ----
    const st = [-10.85, -10.1, -9.35, -8.6, -7.85, -7.1];
    st.forEach((top, i) => put('box', `step${i + 1}`, box(10.4 - i * 1.6, C.floorTop, S.maxZ + 0.05, 12.0 - i * 1.6, top, S.maxZ + 2.6), i % 3));

    // ---- 部屋の家具 ----
    const fl = ROOM.floorY;
    put('rug', 'rug', box(-16, fl, 13, 16, fl + 0.06, 26));
    put('book', 'books1', box(-31, fl, 2, -24, fl + 1.1, 7.5));
    put('book', 'books2', box(-30.2, fl + 1.1, 2.6, -25, fl + 2.0, 7.0), 1);
    put('box', 'carton', box(26, fl, -6, 33, fl + 3.4, 1), 2);
    this.cyls.push({ look: 'bucket', name: 'bucket', c: [-24, 16], r: 1.6, y0: fl, y1: fl + 2.8 });
    this.cyls.push({ look: 'can', name: 'foodcan', c: [3.5, 17.5], r: 0.7, y0: fl, y1: fl + 1.4 });
  }

  /** 右の扉の開口部（x の範囲・高さ） */
  readonly doorway: { x0: number; x1: number; y0: number; y1: number };

  // ---------------- 距離関数 ----------------

  pipeWalls(x: number, y: number, z: number): number {
    return Math.min(this.drain.wall(x, y, z), this.ret.wall(x, y, z));
  }

  /**
   * 縦の管の柱の中までの距離（負 = 柱の中）。砂・底板・天板を削るのに使う（管の折れ線を調べるより速い）。
   * 柱は上端より下の無限の円柱として扱う（柱が貫く物は、どれも柱の範囲の高さにしか無い）
   */
  columnInterior(x: number, y: number, z: number): number {
    let d = Infinity;
    for (const c of this.columns) {
      if (y > c.top) continue;
      const dx = x - c.x, dz = z - c.z;
      d = Math.min(d, Math.sqrt(dx * dx + dz * dz) - c.inner);
    }
    return d;
  }

  /** 底板・天板（管の穴あき） */
  deck(x: number, y: number, z: number): number {
    if (y > DECK.top + 1.5 || y < DECK.y0 - 1.5) return Math.min(Math.abs(y - DECK.top), Math.abs(y - DECK.y0));
    const d = Math.min(sdBox(x, y, z, this.deckPlate), sdBox(x, y, z, this.deckBoard));
    if (d > 1.2) return d;
    return Math.max(d, -this.columnInterior(x, y, z));
  }

  glassSolid(x: number, y: number, z: number): number {
    let d = Infinity;
    for (const b of this.glass) d = Math.min(d, sdBox(x, y, z, b));
    return d;
  }

  acrylicSolid(x: number, y: number, z: number): number {
    // 濾過槽から離れていれば箱までの距離（下限）
    const o = boxOutside({ min: [SUMP.minX, SUMP.bottomY, SUMP.minZ], max: [SUMP.maxX, SUMP.rimY, SUMP.maxZ] }, x, y, z);
    if (o > 0.6) return o;
    let d = Infinity;
    for (const b of this.acrylic) d = Math.min(d, sdBox(x, y, z, b));
    return d;
  }

  /** 不透明な物（水槽台・ろ材・ポンプ・段・家具・部屋の床と壁） */
  opaqueSolid(x: number, y: number, z: number): number {
    let d = y - ROOM.floorY;
    d = Math.min(d, x - ROOM.minX, ROOM.maxX - x, z - ROOM.minZ, ROOM.maxZ - z, ROOM.ceilY - y);
    for (const b of this.opaque) {
      let e = sdBox(x, y, z, b);
      if (e < 0.8 && b.name === 'pump') e = Math.max(e, -this.ret.interior(x, y, z));
      d = Math.min(d, e);
    }
    for (const c of this.cyls) d = Math.min(d, sdCyl(x, y, z, c));
    for (const o of this.oriented) d = Math.min(d, sdOriented(x, y, z, o));
    return d;
  }

  // ---------------- 区画・水・流れ ----------------

  regionAt(x: number, y: number, z: number): Region {
    if (this.drain.interior(x, y, z) < 0) return 'drain';
    if (this.ret.interior(x, y, z) < 0) return 'return';
    if (x > TANK.minX && x < TANK.maxX && z > TANK.minZ && z < TANK.maxZ && y > DECK.top - 0.1) return 'tank';
    if (x > SUMP_IN.minX && x < SUMP_IN.maxX && z > SUMP_IN.minZ && z < SUMP_IN.maxZ && y > SUMP.floorTop - 0.1 && y < SUMP.rimY) return 'sump';
    if (x > CABINET.minX + CABINET.wall && x < CABINET.maxX - CABINET.wall && z > CABINET.minZ + CABINET.wall && z < CABINET.maxZ - CABINET.wall && y > CABINET.floorTop - 0.1 && y < CABINET.maxY) return 'stand';
    return 'room';
  }

  /** 濾過槽の x の位置の部屋 */
  chamberAt(x: number): Chamber {
    const ch = SUMP.chambers;
    for (const c of ch) if (x <= c.x1 + 0.06) return c;
    return ch[ch.length - 1];
  }

  /**
   * 点のある水の水面の高さ。管の中は水といっしょに流れるので常に水中（大きな値）、水の無い所は小さな値。
   * 水槽の中は水面より上（陸地）でも水槽の水面の高さを返す（submerged の計算は水面との比較で決まる）
   */
  waterLevelAt(x: number, y: number, z: number): number {
    const r = this.regionAt(x, y, z);
    if (r === 'drain' || r === 'return') return 1e3;
    if (r === 'tank') return TANK.waterY;
    if (r === 'sump') return this.chamberAt(x).level;
    return -1e3;
  }

  /** 水の流れ（排水口の渦・管の中・吸い込み口・吐き出し口・落水口）。out に書いて返す */
  flowAt(x: number, y: number, z: number, out: Flow): Flow {
    out.vx = out.vy = out.vz = 0;
    out.k = 0;
    out.ride = false;
    const [ax, az] = this.drainAxis;
    const rx = x - ax, rz = z - az;
    const r = Math.hypot(rx, rz) || 1e-4;
    const inv = 1 / r;
    // 排水管の中：水といっしょに真下へ。軸へ寄せ、少し回る
    const hd = this.drain.closest(x, y, z);
    if (hd.end === 0 && hd.d < this.drain.inner) {
      out.vx = -rx * 1.4 + -rz * inv * 0.35;
      out.vz = -rz * 1.4 + rx * inv * 0.35;
      out.vy = -6.2;
      out.k = 5;
      out.ride = true;
      return out;
    }
    // 排水口の渦：水面の近くで穴へ向かう緩やかな流れ + 回転。穴の真上では下向き
    if (r < 2.9 && y > TANK.waterY - 1.7 && y < TANK.waterY + 0.4 && y > this.drainRim - 0.2) {
      const f = 1 - r / 2.9;
      const toward = 0.45 + 1.7 * f;
      out.vx = -rx * inv * toward - rz * inv * 0.9 * f;
      out.vz = -rz * inv * toward + rx * inv * 0.9 * f;
      if (r < this.drain.inner) {
        out.vx *= 0.3;
        out.vz *= 0.3;
        out.vy = -2.8;
        out.k = 8;
      } else {
        out.vy = r < this.drain.outer + 0.15 ? -0.2 : 0;
        out.k = 0.9 + 2.2 * f;
      }
      return out;
    }
    // 給水管の中：ポンプの流れで吐き出し口へ
    const R = this.ret;
    const hr = R.closest(x, y, z);
    if (hr.end === 0 && hr.d < R.inner) {
      const u = R.tangentAt(hr.s);
      const p = R.pointAt(hr.s, this.tmp);
      out.vx = u[0] * 6.4 + (p[0] - x) * 3;
      out.vy = u[1] * 6.4 + (p[1] - y) * 3;
      out.vz = u[2] * 6.4 + (p[2] - z) * 3;
      out.k = 5;
      out.ride = true;
      return out;
    }
    // 吸い込み口のまわり（ポンプ室の床ぎわ）
    const p0 = R.pts[0];
    const ix = p0[0] - x, iy = p0[1] - y, iz = p0[2] - z;
    const id = Math.hypot(ix, iy, iz);
    if (id < 1.7 && hr.end === -1) {
      const f = 1 - id / 1.7;
      const sp = 0.5 + 2.2 * f;
      const u = R.tangentAt(0);
      out.vx = (ix / id) * sp * 0.6 + u[0] * sp * 0.6;
      out.vy = (iy / id) * sp * 0.6 + u[1] * sp * 0.6;
      out.vz = (iz / id) * sp * 0.6 + u[2] * sp * 0.6;
      out.k = 1.2 + 3 * f;
      return out;
    }
    // 吐き出し口の先：手前へ押し出す水流
    const o = this.outlet;
    const ox = x - o[0], oy = y - o[1], oz = z - o[2];
    const od = Math.hypot(ox, oy, oz);
    if (od < 2.6 && oz > -0.3) {
      const f = 1 - od / 2.6;
      out.vz = 3.6 * f;
      out.vy = 0.3 * f;
      out.k = 2.5 * f;
      return out;
    }
    // 落水室：排水管の出口の下は、落ちた水が下と外へ押す（管へ戻りにくい）
    if (r < 1.3 && y < this.drain.pts[1][1] && y > this.drain.pts[1][1] - 1.6) {
      const f = 1 - r / 1.3;
      out.vx = rx * inv * 0.8 * f;
      out.vz = rz * inv * 0.8 * f;
      out.vy = -1.4 * f;
      out.k = 2 * f;
      return out;
    }
    return out;
  }

  private readonly tmp: Vec3 = [0, 0, 0];

  /** 縦の管の柱からの水平距離 − 外径（負 = 柱の中。底床の網はここに張らない） */
  columnClear(x: number, z: number): number {
    let d = Infinity;
    for (const c of this.columns) d = Math.min(d, Math.hypot(x - c.x, z - c.z) - c.r);
    return d;
  }

  /** 水槽の中の管（縦の柱 + 給水管の吐き出し口）からの水平の余白（植物・小石・生き物を管に重ねないため） */
  pipeClear(x: number, z: number): number {
    const r = this.outlet, c = this.columns[1];
    const d2 = Math.hypot(x - r[0], z - Math.min(Math.max(z, c.z), r[2])) - this.ret.outer;
    return Math.min(this.columnClear(x, z), d2);
  }
}
