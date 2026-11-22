// 水槽の探索スポットと軽い発見システム（ゲームロジック側。Three.js に依存しない）。
// - Spot：名前の付いた場所（ふつうの場所 / 隠れた場所）。楕円体の範囲で判定し、重なっていれば小さい方を優先する。
//   見晴らしの良い場所（vista）には、立ち止まったときに冒険カメラが寄っていく眺めの向きを持たせる。
// - Find：景色のご褒美として置く発見物（貝殻・巻貝・光る石・泡の湧き場所）。見た目は AquariumBuild / AquariumRenderer が作る。
// - DiscoveryTracker：カニの位置から「いまいる場所」を決め、場所が変わったとき・初めて訪れたときに知らせる。
// 位置は AquariumWorld.landmarks（地形を作るときに決まる基準点）から求めるので、地形を動かしてもずれない。

import { TANK, type AquariumWorld } from './AquariumWorld';

export type SpotKind = 'area' | 'hidden';

/** 冒険カメラの眺めの向き（AquaCamera の Orbit と同じ yaw / pitch / zoom） */
export interface VistaView {
  yaw: number;
  pitch: number;
  zoom: number;
}

export interface Spot {
  id: string;
  name: string;
  kind: SpotKind;
  /** 初めて訪れたときに出す短い説明 */
  desc: string;
  /** 範囲（楕円体の中心と半径） */
  c: [number, number, number];
  r: [number, number, number];
  vista?: VistaView;
}

export type FindKind = 'shell' | 'spiral' | 'glow' | 'spring';

export interface Find {
  kind: FindKind;
  pos: [number, number, number];
  /** 向き（y 軸まわり）と大きさ */
  rot: number;
  scale: number;
  /** 色の番号（貝殻・光る石の色の違い） */
  tint: number;
}

export function buildSpots(world: AquariumWorld): { spots: Spot[]; finds: Find[] } {
  const L = world.landmarks;
  const g = (x: number, z: number) => world.groundAt(x, z);
  const mid = (a: number[], b: number[]): [number, number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const logMid = mid(L.logA, L.logB);
  const [hx, hz] = [L.hut.x, L.hut.z];
  const spots: Spot[] = [
    // ---- ふつうの場所 ----
    { id: 'meadow', name: '砂の広場', kind: 'area', desc: '絨毯のような水草が砂を覆う、明るい広場', c: [-8, 2, 6.8], r: [7.5, 4, 3.6] },
    { id: 'cave', name: '岩の洞窟', kind: 'area', desc: '岩を貫くトンネル。どこかに脇道があるらしい', c: [-10, g(-10, -1.5) + 0.6, -1.5], r: [5.8, 1.6, 1.4] },
    { id: 'forest', name: '水草の森', kind: 'area', desc: '背の高い水草が揺れる森。奥へ続く小道がある', c: [-10, 3.4, -7.2], r: [6.8, 4, 3.0] },
    { id: 'log', name: '流木のトンネル', kind: 'area', desc: '中が空洞の倒木。節穴から光が差し込む', c: logMid, r: [2.9, 1.1, 1.1] },
    { id: 'plateau', name: '浅瀬の高台', kind: 'area', desc: '水面から顔を出す平らな岩。水の中を見渡せる', c: [L.plateau[0], L.plateau[1] + 0.3, L.plateau[2]], r: [1.7, 0.9, 1.5], vista: { yaw: Math.PI / 2 + 0.35, pitch: 0.78, zoom: 5.2 } },
    { id: 'pillar', name: '岩の柱', kind: 'area', desc: '水面近くまでそびえる岩。てっぺんには届くだろうか', c: [-2.9, 2.8, -6.2], r: [2.6, 2.8, 2.4] },
    { id: 'shore', name: '流木の渡り橋', kind: 'area', desc: '陸と水をつなぐ大きな流木。水際の草が茂る', c: [5.5, 5.8, 1.4], r: [5.5, 1.8, 1.6] },
    { id: 'fall', name: '滝壺', kind: 'area', desc: '崖から落ちる水がしぶきと泡を立てる', c: [4.4, 4.4, -7.6], r: [2.6, 2.4, 2.2] },
    { id: 'mosshill', name: '苔むす丘', kind: 'area', desc: 'ふかふかの苔と苔玉が並ぶ、陸地の丘', c: [12.6, 7.6, 5.4], r: [5.6, 2.4, 4.2] },
    { id: 'ledges', name: '岩の段々', kind: 'area', desc: '一段ずつ高くなる岩の足場', c: [14, 8, -3.2], r: [3.6, 2.6, 3.0] },
    // ---- 隠れた場所 ----
    { id: 'forestRoom', name: '泡の湧く小部屋', kind: 'hidden', desc: '水草の奥の小道の先。砂の底から泡が湧き続けている', c: [L.forestRoom[0], L.forestRoom[1] + 0.6, L.forestRoom[2]], r: [1.4, 1.4, 1.3] },
    { id: 'caveRoom', name: '岩裏の光るくぼみ', kind: 'hidden', desc: '洞窟の脇道の先、岩の裏へ抜けるくぼみに光る石が眠っている', c: [L.caveRoom[0], L.caveRoom[1], L.caveRoom[2] - 0.4], r: [1.0, 0.9, 1.3] },
    { id: 'hut', name: '流木の小屋', kind: 'hidden', desc: '流木を立てかけた小さな部屋。誰かの隠れ家だろうか', c: [hx, g(hx, hz) + 0.6, hz], r: [1.3, 0.9, 1.3] },
    { id: 'pillarTop', name: '柱のてっぺん', kind: 'hidden', desc: 'ジャンプと遊泳でたどり着ける頂上。見上げると水面がきらめく', c: [-3.3, 5.45, -6.6], r: [1.5, 0.6, 1.4], vista: { yaw: 0.7, pitch: -0.14, zoom: 4.6 } },
    { id: 'tunnel', name: '崖の抜け道', kind: 'hidden', desc: '段々の岩の裏から崖の中を登る細い道', c: [14.6, 8.3, -8.9], r: [3.2, 1.9, 1.0] },
    { id: 'overlook', name: '滝の上の見晴らし台', kind: 'hidden', desc: '水槽でいちばん高い場所。滝の落ち口から全体を見下ろせる', c: [L.tunnelOut[0] - 0.6, L.tunnelOut[1] + 0.4, L.tunnelOut[2] + 0.2], r: [2.4, 1.0, 1.4], vista: { yaw: Math.PI / 2 + 0.28, pitch: 0.85, zoom: 5.5 } },
  ];

  // ---- 発見物 ----
  const finds: Find[] = [];
  const put = (kind: FindKind, x: number, z: number, scale: number, tint: number, yFrom?: number, rot = (x * 7.1 + z * 3.3) % (Math.PI * 2)) => {
    const y = yFrom === undefined ? g(x, z) : world.surfaceBelow(x, yFrom, z);
    finds.push({ kind, pos: [x, y, z], rot, scale, tint });
  };
  const [fx, , fz] = L.forestRoom;
  put('spring', fx + 0.1, fz - 0.1, 1, 0);
  put('spring', fx - 0.5, fz + 0.3, 0.7, 0);
  put('shell', fx + 0.6, fz + 0.4, 1, 0);
  put('spiral', fx - 0.4, fz - 0.4, 0.9, 1);
  const [cx, cy, cz] = L.caveRoom;
  put('glow', cx + 0.2, cz - 0.3, 1.1, 0, cy);
  put('glow', cx - 0.3, cz + 0.1, 0.8, 1, cy);
  put('glow', cx + 0.05, cz - 0.9, 0.7, 0, cy);
  put('shell', hx + 0.25, hz + 0.2, 1.1, 1, g(hx, hz) + 0.6);
  put('spiral', hx - 0.3, hz - 0.1, 1.2, 0, g(hx, hz) + 0.6);
  put('glow', hx + 0.05, hz + 0.45, 0.6, 1, g(hx, hz) + 0.6);
  put('shell', -3.2, -6.5, 1.2, 2, 6);
  put('glow', L.tunnelOut[0] - 0.9, L.tunnelOut[2] + 0.5, 0.9, 1, 12.5);
  put('spiral', L.tunnelIn[0] + 0.6, L.tunnelIn[2] + 0.5, 1, 2);
  // 景色の中に点在する貝殻・泡（ふつうの場所）
  put('shell', -6.4, 7.8, 0.9, 1);
  put('spiral', -11.6, 5.0, 0.8, 2);
  put('shell', L.plateau[0] + 0.4, L.plateau[2] - 0.3, 0.8, 0, L.plateau[1] + 0.5);
  put('spring', -13.6, 7.9, 0.6, 0);
  put('spring', -1.6, 1.4, 0.5, 0);
  return { spots, finds };
}

/** 点が楕円体の中か（0..1 の深さ。1 = 中心、0 以下 = 外） */
function inside(s: Spot, x: number, y: number, z: number): number {
  const dx = (x - s.c[0]) / s.r[0], dy = (y - s.c[1]) / s.r[1], dz = (z - s.c[2]) / s.r[2];
  return 1 - (dx * dx + dy * dy + dz * dz);
}

export type DiscoveryEvent = { kind: 'enter'; spot: Spot; first: boolean };

/**
 * いまいる場所の判定と、初めて訪れた場所の記録。
 * 境目で表示が行ったり来たりしないよう、別の場所に入ってから少し経ってから切り替える。
 */
export class DiscoveryTracker {
  readonly visited = new Set<string>();
  current: Spot | null = null;
  /** 場所の外にいる時間 */
  private outT = 0;
  private cand: Spot | null = null;
  private candT = 0;
  readonly events: DiscoveryEvent[] = [];

  constructor(readonly spots: Spot[]) {}

  get total() {
    return this.spots.length;
  }

  get hiddenTotal() {
    return this.spots.filter((s) => s.kind === 'hidden').length;
  }

  get hiddenFound() {
    return this.spots.filter((s) => s.kind === 'hidden' && this.visited.has(s.id)).length;
  }

  /** 点を含む場所のうち、いちばん小さいもの（隠れた場所・小部屋が広い場所より優先される） */
  locate(x: number, y: number, z: number): Spot | null {
    let best: Spot | null = null, bestV = Infinity;
    for (const s of this.spots) {
      if (inside(s, x, y, z) <= 0) continue;
      const v = s.r[0] * s.r[1] * s.r[2] * (s.kind === 'hidden' ? 0.25 : 1);
      if (v < bestV) {
        best = s;
        bestV = v;
      }
    }
    return best;
  }

  update(dt: number, x: number, y: number, z: number) {
    // 水槽の外（ガラスの外）にはいないので y だけ水槽の範囲に収める
    const s = this.locate(x, Math.min(y, TANK.topY), z);
    if (s === this.current) {
      this.cand = null;
      this.outT = 0;
      return;
    }
    if (!s) {
      this.outT += dt;
      if (this.outT > 0.8) this.current = null;
      return;
    }
    if (this.cand !== s) {
      this.cand = s;
      this.candT = 0;
    }
    this.candT += dt;
    // 隠れた場所は入ったらすぐ、ふつうの場所は少し留まってから切り替える
    if (this.candT >= (s.kind === 'hidden' ? 0.15 : 0.4)) {
      const first = !this.visited.has(s.id);
      this.visited.add(s.id);
      this.current = s;
      this.cand = null;
      this.outT = 0;
      this.events.push({ kind: 'enter', spot: s, first });
    }
  }

  drainEvents(): DiscoveryEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
