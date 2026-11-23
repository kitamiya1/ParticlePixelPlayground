// 水槽（アクアテラリウム）のワールド定義（ゲームロジック側。Three.js に依存しない）。
// - 水槽の内寸・水面の高さ（全域で一定）
// - 底床の高さ場（水中の砂地 → 浅瀬の斜面 → 陸地）
// - 岩（洞窟・水中の柱・陸地の足場・滝の崖）と流木の SDF
// - 当たり判定用の距離関数 solid()（高さ場 + 岩 + 流木。見た目の三角形も同じ関数から作るので形が一致する）
//   縦の管（排水管・給水管）が砂を貫く柱の中は空けてある
// - 水槽の外（水槽台・濾過槽・配管・部屋）は AquariumStand（stand）。カニの当たり判定は contactSolid（水槽の中身 +
//   ガラス・底板・天板・管・濾過槽・水槽台・部屋）、カメラの遮蔽は viewSolid、水面の高さは waterLevelAt、水流は flowAt
// 見た目（メッシュ・サーフェル）は AquariumBuild が、この定義から作る。

import { clamp, fbm2, lerp, noise3, smoothstep } from '../core/math';
import { sdCapsule, sdEllipsoid, smin, type Box3Like, type Sdf } from '../visual/sdf/sdf';
import { LAMP_DIR, TANK } from './aquaConst';
import { AquaStand, DECK, ROOM, type Flow, type Region } from './AquariumStand';

export { TANK, LAMP_DIR };

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

/** 流木（カプセルの枝の集まり。holes で中をくり抜くと中空の倒木になる） */
export interface Driftwood {
  name: string;
  branches: { a: [number, number, number]; b: [number, number, number]; ra: number; rb: number }[];
  holes: { a: [number, number, number]; b: [number, number, number]; r: number }[];
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

/** cap を指定すると、その高さで上面を平らに削る（台地・高台） */
function makeRock(name: string, zone: RockZone, parts: RockFormation['parts'], seed: number, rough: number, holes: RockFormation['holes'] = [], cap?: number): RockFormation {
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
    if (cap !== undefined) d = smax(d, y - cap, 0.18);
    for (const h of holes) d = smax(d, -sdCapsule(x, y, z, h.a[0], h.a[1], h.a[2], h.b[0], h.b[1], h.b[2], h.r), 0.3);
    return d;
  };
  return { name, zone, parts, holes, seed, rough, box: { min, max }, sdf };
}

function makeWood(name: string, branches: Driftwood['branches'], seed: number, holes: Driftwood['holes'] = []): Driftwood {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of branches) {
    const r = Math.max(b.ra, b.rb) + 0.25;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.a[k] - r, b.b[k] - r);
      max[k] = Math.max(max[k], b.a[k] + r, b.b[k] + r);
    }
  }
  // 枝ごとの外接球（中心・半径）。smin(d, e, k) は e ≥ d + k なら d のままなので、
  // 外接球までの距離がそれ以上の枝は計算を省いても結果は変わらない（枝の多い流木の生成を速くする）
  const K = 0.18;
  const spheres = branches.map((b) => {
    const c = [(b.a[0] + b.b[0]) / 2, (b.a[1] + b.b[1]) / 2, (b.a[2] + b.b[2]) / 2];
    return { c, r: Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1], b.b[2] - b.a[2]) / 2 + Math.max(b.ra, b.rb) };
  });
  const sdf: Sdf = (x, y, z) => {
    let d = Infinity;
    for (let i = 0; i < branches.length; i++) {
      const s = spheres[i];
      const dx = x - s.c[0], dy = y - s.c[1], dz = z - s.c[2];
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) - s.r >= d + K) continue;
      const b = branches[i];
      d = smin(d, sdCapsule(x, y, z, b.a[0], b.a[1], b.a[2], b.b[0], b.b[1], b.b[2], b.ra, b.rb), K);
    }
    // 木目に沿った溝（枝の向きにかかわらず効くよう、3 軸のノイズを細く）
    d -= noise3(x * 2.2, y * 2.2, z * 2.2, seed) * 0.035;
    for (const h of holes) d = smax(d, -sdCapsule(x, y, z, h.a[0], h.a[1], h.a[2], h.b[0], h.b[1], h.b[2], h.r), 0.06);
    return d;
  };
  return { name, branches, holes, seed, box: { min, max }, sdf };
}

export class AquariumWorld {
  /** 水槽の外側：水槽台・濾過槽・配管・部屋（AquariumStand） */
  readonly stand = new AquaStand();
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
  /**
   * 探索スポットの基準点（AquariumSpots・AquariumBuild が参照する。地形を作るときに決まる位置）
   * - forestPath：水草の森の奥へ続く細い通路（折れ線。x, z）、forestRoom：通路の先の小部屋（x, z, 半径）
   * - caveRoom：洞窟の脇道の先の小部屋の中心、caveCrack：小部屋から岩の裏へ抜ける割れ目の出口
   * - logA / logB：中空の倒木の両端（軸の中心）、hut：流木の小屋の中心（x, z）と入口の向き
   * - plateau：浅瀬の高台の上面の中心、tunnelIn / tunnelOut：崖の抜け道の入口・出口（崖の上）
   */
  readonly landmarks = {
    forestPath: [] as [number, number][],
    forestRoom: [0, 0, 0] as [number, number, number],
    caveRoom: [0, 0, 0] as [number, number, number],
    caveCrack: [0, 0, 0] as [number, number, number],
    logA: [0, 0, 0] as [number, number, number],
    logB: [0, 0, 0] as [number, number, number],
    hut: { x: 0, z: 0, door: 0 },
    plateau: [0, 0, 0] as [number, number, number],
    tunnelIn: [0, 0, 0] as [number, number, number],
    tunnelOut: [0, 0, 0] as [number, number, number],
    /** 中空の倒木の節穴（光の差し込む穴の中心と半径）。光の筋・床の光だまりの位置になる */
    knots: [] as { c: [number, number, number]; r: number }[],
  };

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
    this.buildForestPath();
    this.airStone = [-16.6, this.groundAt(-16.6, -8.6) + 0.12, -8.6];
  }

  /** 底床の形：水中の砂地（手前が低く奥が高い）→ 曲がった汀線の緩やかな斜面 → 陸地 */
  private rawHeight(x: number, z: number): number {
    // 汀線を z 方向にうねらせる
    const xs = x + 2.4 * Math.sin(z * 0.26 + 0.6);
    const back = (TANK.maxZ - z) / (TANK.maxZ - TANK.minZ); // 0 = 手前, 1 = 奥
    const sand = 0.75 + 1.25 * back + 0.28 * fbm2(x * 0.18, z * 0.18, 3, 11) + 0.06 * fbm2(x * 0.9, z * 0.9, 2, 12);
    // 陸地：手前右に苔の丘のふくらみ
    const hill = 0.6 * Math.exp(-((x - 12.5) ** 2 + (z - 5.5) ** 2) / 8);
    const land = 6.7 + 0.45 * fbm2(x * 0.16, z * 0.16, 3, 13) + 0.1 * fbm2(x * 0.7, z * 0.7, 2, 14) + hill;
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
    const ta: [number, number, number] = [-15.2, sandY(-14, tz0) + 0.62, tz0];
    const tb: [number, number, number] = [-4.8, sandY(-6, tz1) + 0.62, tz1];
    // 隠れた場所：トンネルの途中から奥（-z）へ細い脇道 → 小部屋（光る石）→ 岩の裏（水草の森の側）へ抜ける割れ目
    const sx = -10.8, sz = lerp(tz0, tz1, (sx - ta[0]) / (tb[0] - ta[0]));
    const room: [number, number, number] = [-10.2, sandY(-10.2, -3.0) + 0.5, -3.0];
    const crackOut: [number, number, number] = [-9.8, sandY(-9.8, -5.0) + 0.42, -5.0];
    this.landmarks.caveRoom = room;
    this.landmarks.caveCrack = [crackOut[0], crackOut[1] - 0.42, -4.4];
    const caveHoles: RockFormation['holes'] = [
      { a: ta, b: tb, r: 0.82 },
      { a: [sx, sandY(sx, sz) + 0.42, sz], b: [room[0] - 0.3, room[1] - 0.08, room[2] + 0.4], r: 0.42 },
      { a: [room[0] - 0.35, room[1], room[2] + 0.1], b: [room[0] + 0.35, room[1] + 0.05, room[2] - 0.1], r: 0.8 },
      { a: [room[0] + 0.1, room[1] - 0.08, room[2] - 0.3], b: crackOut, r: 0.42 },
    ];
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
        caveHoles,
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
    // 隠れた場所：陸地の奥の角（段々の岩の裏）から崖の中を登って崖の上（滝の落ち口の東）へ抜ける道
    // 入口は地面の高さのまま崖の中まで水平に入り、そこから登る（入口で段差にならないように）
    const gin = sandY(16.9, -8.9);
    const tin: [number, number, number] = [16.9, gin + 0.3, -8.9];
    const tbend: [number, number, number] = [14.2, gin + 0.38, -8.9];
    const tmid: [number, number, number] = [12.0, 9.0, -8.9];
    const tout: [number, number, number] = [10.0, 11.1, -8.7];
    this.landmarks.tunnelIn = [15.5, gin, -8.9];
    this.landmarks.tunnelOut = tout;
    const cliffHoles: RockFormation['holes'] = [
      { a: tin, b: tbend, r: 0.55 },
      { a: tbend, b: tmid, r: 0.55 },
      { a: tmid, b: tout, r: 0.55 },
    ];
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
        cliffHoles,
      ),
    );
    // 浅瀬の高台：汀線の水中から立ち上がる上の平らな岩（上面は水面より少し上。西の水中を見渡せる）
    this.rocks.push(
      makeRock(
        'plateau',
        'water',
        [
          { c: [2.4, 4.9, 3.6], r: [1.9, 1.4, 1.6] },
          { c: [1.0, 4.3, 4.9], r: [1.2, 0.85, 1.0] },
          { c: [3.6, 5.1, 2.6], r: [1.1, 0.75, 0.9] },
        ],
        111,
        0.3,
        [],
        6.0,
      ),
    );
    this.landmarks.plateau = [2.4, 6.0, 3.6];
    // 陸地の苔の丘：苔に覆われた丸い石（苔玉）
    for (const [i, [x, z, r]] of ([[10.0, 5.0, 0.85], [11.4, 7.8, 0.65], [16.4, 2.4, 0.75], [13.6, 3.6, 0.5]] as const).entries()) {
      const g = sandY(x, z);
      this.rocks.push(makeRock(`mossball${i + 1}`, 'land', [{ c: [x, g + r * 0.35, z], r: [r, r * 0.78, r] }], 121 + i * 10, 0.2));
    }
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
    // 中空の倒木（流木のトンネル）：砂の広場と洞窟の間に横たわり、中をくぐって抜けられる。上に節穴が開いている
    const g = (x: number, z: number) => this.groundAt(x, z);
    const la: [number, number, number] = [-9.6, g(-9.6, 3.4) + 0.5, 3.4];
    const lb: [number, number, number] = [-5.0, g(-5.0, 2.9) + 0.5, 2.9];
    this.landmarks.logA = la;
    this.landmarks.logB = lb;
    const ld = [lb[0] - la[0], lb[1] - la[1], lb[2] - la[2]];
    const ll = Math.hypot(ld[0], ld[1], ld[2]);
    const u = ld.map((v) => v / ll);
    const ext = (p: number[], s: number): [number, number, number] => [p[0] + u[0] * s, p[1] + u[1] * s, p[2] + u[2] * s];
    const knot = ext(la, ll * 0.58);
    // 節穴：真上の穴（既存）に加え、照明の向きに沿って開いた穴を 2 つ（光の筋がまっすぐ中へ届く）
    const lampHole = (p: [number, number, number], r: number) => ({ a: [p[0] + LAMP_DIR[0] * 0.3, p[1] + LAMP_DIR[1] * 0.3, p[2] + LAMP_DIR[2] * 0.3] as [number, number, number], b: [p[0] + LAMP_DIR[0] * 1.4, p[1] + LAMP_DIR[1] * 1.4, p[2] + LAMP_DIR[2] * 1.4] as [number, number, number], r });
    const knot2 = ext(la, ll * 0.3), knot3 = ext(la, ll * 0.8);
    this.landmarks.knots = [
      { c: [knot[0], knot[1] + 0.85, knot[2]], r: 0.3 },
      { c: [knot2[0] + LAMP_DIR[0] * 0.85, knot2[1] + LAMP_DIR[1] * 0.85, knot2[2] + LAMP_DIR[2] * 0.85], r: 0.24 },
      { c: [knot3[0] + LAMP_DIR[0] * 0.85, knot3[1] + LAMP_DIR[1] * 0.85, knot3[2] + LAMP_DIR[2] * 0.85], r: 0.2 },
    ];
    this.woods.push(
      makeWood(
        'hollowlog',
        [
          { a: la, b: lb, ra: 0.9, rb: 0.82 },
          // 折れた枝の付け根と、根元の張り出し
          { a: ext(la, ll * 0.3), b: [la[0] + 1.2, la[1] + 1.5, la[2] + 1.1], ra: 0.2, rb: 0.08 },
          { a: ext(la, 0.2), b: [la[0] - 0.9, la[1] - 0.3, la[2] - 0.9], ra: 0.32, rb: 0.14 },
          { a: ext(la, 0.2), b: [la[0] - 0.6, la[1] + 0.9, la[2] + 0.5], ra: 0.26, rb: 0.08 },
        ],
        7,
        [
          { a: ext(la, -0.9), b: ext(lb, 0.9), r: 0.62 },
          { a: [knot[0], knot[1] + 0.4, knot[2]], b: [knot[0] + 0.1, knot[1] + 1.3, knot[2]], r: 0.3 },
          lampHole(knot2, 0.24),
          lampHole(knot3, 0.2),
        ],
      ),
    );
    // 流木の小屋（隠れた場所）：細い流木を円錐に立てかけた小部屋。入口は奥（岩の柱の側）を向き、手前からは見えない
    const hx = 0.6, hz = -3.6, door = -Math.PI / 2;
    this.landmarks.hut = { x: hx, z: hz, door };
    const top: [number, number, number] = [hx, g(hx, hz) + 2.1, hz];
    const sticks: Driftwood['branches'] = [];
    const N = 14;
    for (let i = 0; i < N; i++) {
      const a = door + (i / N) * Math.PI * 2;
      if (i === 0) continue; // 入口
      const bx = hx + Math.cos(a) * 1.5, bz = hz + Math.sin(a) * 1.5;
      const base: [number, number, number] = [bx, g(bx, bz) - 0.12, bz];
      // 先端は頂点を少し越えて突き出す
      const tip: [number, number, number] = [top[0] + (top[0] - base[0]) * 0.22 + Math.sin(i * 2.3) * 0.08, top[1] + (top[1] - base[1]) * 0.22, top[2] + (top[2] - base[2]) * 0.22];
      sticks.push({ a: base, b: tip, ra: 0.14 + 0.03 * Math.sin(i * 1.7), rb: 0.06 });
    }
    // 外側に絡んだ枝（屋根の上）
    sticks.push({ a: [hx - 1.0, top[1] - 0.8, hz + 0.75], b: [hx + 0.9, top[1] - 0.15, hz - 0.3], ra: 0.09, rb: 0.05 });
    sticks.push({ a: [hx + 0.95, top[1] - 0.9, hz + 0.8], b: [hx - 0.5, top[1] + 0.1, hz - 0.6], ra: 0.08, rb: 0.04 });
    this.woods.push(makeWood('hut', sticks, 8));
  }

  /** 水草の森の細い通路と、その先の小部屋（植物の配置で作る。当たり判定は無い） */
  private buildForestPath() {
    this.landmarks.forestPath = [[-4.6, -4.4], [-6.0, -5.6], [-5.6, -7.0], [-7.0, -8.0], [-8.2, -8.5]];
    this.landmarks.forestRoom = [-8.6, this.groundAt(-8.6, -8.9), -8.9];
  }

  /** 点から水草の森の通路・小部屋までの距離（植物を避けて置くのに使う） */
  forestPathDist(x: number, z: number): number {
    const P = this.landmarks.forestPath;
    let d = Infinity;
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1];
      const vx = bx - ax, vz = bz - az;
      const t = clamp(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz), 0, 1);
      d = Math.min(d, Math.hypot(x - ax - vx * t, z - az - vz * t));
    }
    const [rx, , rz] = this.landmarks.forestRoom;
    return Math.min(d, Math.hypot(x - rx, z - rz) - 0.9);
  }

  /** (x, y, z) から真下へ探って、最初に当たる固体の上面の高さ（無ければ底床） */
  surfaceBelow(x: number, y: number, z: number): number {
    let py = y;
    for (let i = 0; i < 40; i++) {
      const d = this.solid(x, py, z);
      if (d < 0.01) return py;
      py -= Math.max(d * 0.9, 0.015);
      if (py < TANK.floorY) break;
    }
    return this.groundAt(x, z);
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
    // 縦の管が砂を貫く所は、管の中を空ける（管の中を落ちられる・登れる）
    const pi = this.stand.columnInterior(x, y, z);
    if (pi < 0.6) d = Math.max(d, -pi);
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

  // ---------------- 水槽の外まで含めた当たり判定（カニ・カメラ） ----------------

  /**
   * カニの当たり判定：水槽の中身（solid）+ ガラス・底板・台の天板・透明な管・濾過槽・水槽台・部屋。
   * solid は水槽の中身だけ（植物の配置・日照の焼き込み・生き物が使う）で、こちらはカニの移動用。
   */
  contactSolid(x: number, y: number, z: number): number {
    const S = this.stand;
    let d = Math.min(S.deck(x, y, z), S.glassSolid(x, y, z), S.acrylicSolid(x, y, z), S.opaqueSolid(x, y, z), S.pipeWalls(x, y, z));
    if (x > TANK.minX && x < TANK.maxX && z > TANK.minZ && z < TANK.maxZ && y > DECK.top - 0.5) d = Math.min(d, this.solid(x, y, z));
    return d;
  }

  contactNormal(x: number, y: number, z: number): [number, number, number] {
    return gradient((a, b, c) => this.contactSolid(a, b, c), x, y, z);
  }

  /**
   * カメラの遮蔽判定：不透明な物だけ。透明な物（ガラス・濾過槽・管）は、カニがその内側にいないときだけ遮る
   * （外からカメラが入り込まない。内側にいるときはカメラを内側に留める範囲で別に制限する）
   */
  viewSolid(x: number, y: number, z: number, region: Region): number {
    const S = this.stand;
    let d = Math.min(S.deck(x, y, z), S.opaqueSolid(x, y, z));
    if (x > TANK.minX && x < TANK.maxX && z > TANK.minZ && z < TANK.maxZ && y > DECK.top - 0.5) d = Math.min(d, this.solid(x, y, z));
    if (region !== 'tank') d = Math.min(d, S.glassSolid(x, y, z));
    if (region !== 'sump') d = Math.min(d, S.acrylicSolid(x, y, z));
    if (region !== 'drain' && region !== 'return') d = Math.min(d, S.pipeWalls(x, y, z));
    return d;
  }

  viewNormal(x: number, y: number, z: number, region: Region): [number, number, number] {
    return gradient((a, b, c) => this.viewSolid(a, b, c, region), x, y, z);
  }

  /**
   * カメラ自身が入ってはいけない所（カニの当たり判定 contactSolid とは別）。遮蔽（viewSolid）と同じ物に加えて、
   * 水槽の中を追うときは砂の高さを水槽の外へも延ばす（ガラスの外へ出たカメラが、砂の断面より下へ潜って中が見えなくならない）。
   * 透明な板（ガラス・アクリル）はカメラが通り抜けてよい物として含めない（板の中に留まらないことだけ panelSolid で守る）
   */
  cameraSolid(x: number, y: number, z: number, region: Region): number {
    let d = this.viewSolid(x, y, z, region);
    if (region === 'tank' && (x < TANK.minX || x > TANK.maxX || z < TANK.minZ || z > TANK.maxZ)) d = Math.min(d, y - this.groundAt(x, z));
    return d;
  }

  cameraNormal(x: number, y: number, z: number, region: Region): [number, number, number] {
    return gradient((a, b, c) => this.cameraSolid(a, b, c, region), x, y, z);
  }

  /** カメラが通り抜けてよい透明な板（カニが水槽の中ならガラス、濾過槽の中ならアクリル）。無ければ大きな値 */
  panelSolid(x: number, y: number, z: number, region: Region): number {
    if (region === 'tank') return this.stand.glassSolid(x, y, z);
    if (region === 'sump') return this.stand.acrylicSolid(x, y, z);
    return 1e3;
  }

  panelNormal(x: number, y: number, z: number, region: Region): [number, number, number] {
    return gradient((a, b, c) => this.panelSolid(a, b, c, region), x, y, z);
  }

  regionAt(x: number, y: number, z: number): Region {
    return this.stand.regionAt(x, y, z);
  }

  /** 点のある水の水面の高さ（水の外は −1000、管の中は +1000） */
  waterLevelAt(x: number, y: number, z: number): number {
    return this.stand.waterLevelAt(x, y, z);
  }

  flowAt(x: number, y: number, z: number, out: Flow): Flow {
    return this.stand.flowAt(x, y, z, out);
  }

  /** 縦の管からの水平の余白（植物・小石を管に重ねない） */
  pipeClear(x: number, z: number): number {
    return this.stand.pipeClear(x, z);
  }

  /** contactSolid で真下へ探った最初の上面（水槽の外の床・濾過槽の中でも使える） */
  contactSurfaceBelow(x: number, y: number, z: number): number {
    let py = y;
    for (let i = 0; i < 80; i++) {
      const d = this.contactSolid(x, py, z);
      if (d < 0.01) return py;
      py -= Math.max(d * 0.9, 0.015);
      if (py < ROOM.floorY) return ROOM.floorY;
    }
    return py;
  }

  /** 点が水槽の内側か */
  insideTank(x: number, z: number, margin = 0): boolean {
    return x > TANK.minX + margin && x < TANK.maxX - margin && z > TANK.minZ + margin && z < TANK.maxZ - margin;
  }
}

function gradient(f: (x: number, y: number, z: number) => number, x: number, y: number, z: number): [number, number, number] {
  const e = 0.03;
  const gx = f(x + e, y, z) - f(x - e, y, z);
  const gy = f(x, y + e, z) - f(x, y - e, z);
  const gz = f(x, y, z + e) - f(x, y, z - e);
  const l = Math.hypot(gx, gy, gz) || 1;
  return [gx / l, gy / l, gz / l];
}
