// カニの穴掘り（ゲームロジック側。Three.js に依存しない）。
// 方式：高さ場（AquariumWorld の 0.2 間隔の底床）はそのまま残し、掘った空洞だけを 3 次元の SDF で持つハイブリッド。
// - 空洞 = 平らな床を付けたカプセル（球はカプセルの両端が同じ点のもの）の集まり。1 回かき出すたびに 1 個足すか、
//   直前のものを伸ばす・太らせる（掘り続けると徐々に広がる）。
// - 砂（底床）の距離 d に対して smax(d, −空洞, RIM_K) を取る（cut）。縁は丸く盛り上がらずに落ち込む。
//   AquariumWorld.solid がこれを使うので、カニ・カメラ・泡・日照の当たり判定は自動で掘った形に従う。
// - 岩・流木・ガラス・底板・管は solid / contactSolid で砂のあとに min するので削れない。
//   さらに空洞自体を、水槽の底の少し上・ガラス際・縦の管のまわりの区画・発見物のまわりで打ち切る（clip）。
// - 見た目：水槽を 1×1 の区画（高さ場 5 マス分）に分け、空洞が触れた区画だけを「汚れた」印にする。
//   描画側（AquariumDigFx）がその区画の高さ場の三角形を隠し、同じ関数を Surface Nets（MeshBuild）で三角形にし直す。
// - 見た目と当たり判定を同じ瞬間に変える（2 つの版）：かき出し（stroke）が書き換えるのは「最新の形」だけ。
//   描画側は作り直しを始めるときに最新の形を写し（snapshot = 'snap' の版）、その版で区画を何フレームかかけて
//   三角形にし、全部できたら同時に差し替えて commit する（'snap' → 'live'）。当たり判定（solid・カメラ・照準）は
//   'live' の版だけを見るので、見た目のメッシュがまだ無い空洞にカニ・カメラが入らない
//   （入ると、見た目では固体の中＝裏面しか描かれず、向こう側が透けて見える）。
//
// 空洞の値は、近くに空洞が無い所では PAD（下限）を返す。区画ごとの登録は空洞の外接箱 + PAD で行うので、
// PAD より近い空洞は必ず登録されていて、どの場所でも値は「真の距離以下」になる（球の追跡・Surface Nets の間引きが安全）。

import { clamp } from '../core/math';
import { sdCapsule, smin } from '../visual/sdf/sdf';
import { TANK } from './aquaConst';

type V3 = [number, number, number];

/** 穴掘りの寸法（ワールド単位。カニの脚を広げた幅が約 0.9、当たり判定の球の半径 0.24） */
export const DIG = {
  /** 区画の一辺（高さ場 5 マス分）と、区画を三角形にする Surface Nets の格子 */
  chunk: 1.0,
  cell: 0.1,
  /** 1 回目のかき出しの半径 → 1 回ごとに grow ずつ広がり、rMax で止まる */
  rMin: 0.3,
  rMax: 0.58,
  grow: 0.07,
  /** 平らな床：中心から r × floorK 下。rMax のとき床の幅 ≈ 1.04（脚を広げても入る）、高さ ≈ 0.84 */
  floorK: 0.45,
  /** 掘れる距離（体の中心から） */
  reach: 1.05,
  /** 地表から斜め下へ掘るときの、足元の深さの目標（これより深くなったら水平に掘る） */
  tunnelDepth: 1.15,
  /** 水槽の底（ガラス）の上に残す砂の厚み・ガラス際に残す幅 */
  floorClip: TANK.floorY + 0.3,
  glassClip: 0.7,
  /** 地表と空洞のつなぎの丸み・空洞どうしのつなぎの丸み */
  rimK: 0.12,
  unionK: 0.08,
  /** 何回まで空洞を足せるか（超えたら古い区画をまとめ直さず、それ以上は太らせるだけ） */
  maxPrims: 6000,
} as const;

/** 近くに空洞が無いときの下限（区画への登録の余白と同じ） */
const PAD = 0.45;
/** 打ち切り（clip）を調べるのは空洞の値がこれより小さい所だけ */
const CLIP_NEAR = 0.4;

export interface CarvePrim {
  a: V3;
  b: V3;
  r: number;
  min: V3;
  max: V3;
}

/** 空洞の形のどの版を使うか（live = 当たり判定・いま見えている形、snap = 作り直し中の区画の形） */
export type DigView = 'live' | 'snap';

export type DigMaterial = 'sand' | 'soil' | 'rock' | 'wood' | 'glass' | 'bottom' | 'pipe' | 'treasure' | 'none';

export const DIG_MATERIAL_LABEL: Record<DigMaterial, string> = {
  sand: '砂', soil: '土', rock: '岩', wood: '流木', glass: 'ガラス', bottom: '水槽の底', pipe: '配管', treasure: '宝物のそば', none: 'なし',
};

export function diggable(m: DigMaterial): boolean {
  return m === 'sand' || m === 'soil';
}

/** 1 回のかき出しの結果 */
export interface DigStrokeResult {
  changed: boolean;
  /** 新しい空洞の中心 */
  at: V3;
  r: number;
  ms: number;
}

function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

function boxDist(min: V3, max: V3, x: number, y: number, z: number): number {
  const dx = Math.max(min[0] - x, 0, x - max[0]);
  const dy = Math.max(min[1] - y, 0, y - max[1]);
  const dz = Math.max(min[2] - z, 0, z - max[2]);
  return Math.hypot(dx, dy, dz);
}

/** 平らな床を付けたカプセル（床は軸の高さから r × floorK 下。坂のカプセルは床も坂になる） */
function primDist(p: CarvePrim, x: number, y: number, z: number): number {
  const [ax, ay, az] = p.a, [bx, by, bz] = p.b;
  const d = sdCapsule(x, y, z, ax, ay, az, bx, by, bz, p.r);
  const vx = bx - ax, vy = by - ay, vz = bz - az;
  const L2 = vx * vx + vy * vy + vz * vz;
  const tr = L2 > 1e-9 ? ((x - ax) * vx + (y - ay) * vy + (z - az) * vz) / L2 : 0;
  const t = clamp(tr, 0, 1);
  // 両端の丸い部分では床を平らに伸ばさず、端から離れるほど上げる（約 42°）。平らなままだと、次に上・下へ向きを
  // 変えて掘った坂の床より下に「踊り場」が残り、カニがそこへ進んで坂の始まりの段差に引っかかる
  const over = (tr < 0 ? -tr : tr > 1 ? tr - 1 : 0) * Math.sqrt(L2);
  const floor = ay + vy * t - p.r * DIG.floorK + over * 0.9;
  return smax(d, floor - y, 0.06);
}

export class DigField {
  /** 最新の形（かき出しが書き換える） */
  readonly prims: CarvePrim[] = [];
  /** 版ごとの形（まだその版に無い空洞は null）。snapshot / commit で最新の形から写す */
  private readonly live: (CarvePrim | null)[] = [];
  private readonly snap: (CarvePrim | null)[] = [];
  /** 最後の snapshot から形が変わった空洞・snapshot で写したがまだ commit していない空洞 */
  private readonly changed = new Set<number>();
  private readonly staged = new Set<number>();
  /** 区画の数（x, z） */
  readonly ncx: number;
  readonly ncz: number;
  /** 区画ごとの登録（空洞の番号）。空洞の外接箱 + PAD に重なる区画に入れる */
  private readonly cells: number[][];
  /** 三角形を作り直す必要がある区画 */
  readonly dirty = new Set<number>();
  /** 縦の管が通る区画（作り直さない。空洞もここまで届かせない） */
  readonly locked: Uint8Array;
  private readonly lockRects: { x0: number; z0: number; x1: number; z1: number }[] = [];
  /** 掘らない場所（発見物のまわり） */
  private readonly protect: { x: number; y: number; z: number; r: number }[] = [];
  /** かき出しの続き（同じ場所で続けて掘ると、直前の空洞を伸ばす・太らせる） */
  private session = { last: -1, r: 0, time: -10, recent: [] as number[] };
  /** 計測（自動検証・表示用） */
  readonly stats = { strokes: 0, carves: 0, blocked: 0, carveMs: 0, lastCarveMs: 0, maxCarveMs: 0 };

  constructor(columns: readonly { x: number; z: number; r: number }[]) {
    this.ncx = Math.round((TANK.maxX - TANK.minX) / DIG.chunk);
    this.ncz = Math.round((TANK.maxZ - TANK.minZ) / DIG.chunk);
    this.cells = Array.from({ length: this.ncx * this.ncz }, () => []);
    this.locked = new Uint8Array(this.ncx * this.ncz);
    // 縦の管が砂を貫く所：管の円に重なる区画の外接矩形をまとめて固定する（そこの砂の網は管の丸い穴の形のまま残す）
    for (const c of columns) {
      const R = c.r + 0.1;
      const i0 = this.ci(c.x - R), i1 = this.ci(c.x + R), j0 = this.cj(c.z - R), j1 = this.cj(c.z + R);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.locked[j * this.ncx + i] = 1;
      this.lockRects.push({ x0: TANK.minX + i0 * DIG.chunk, z0: TANK.minZ + j0 * DIG.chunk, x1: TANK.minX + (i1 + 1) * DIG.chunk, z1: TANK.minZ + (j1 + 1) * DIG.chunk });
    }
  }

  /** 発見物（貝殻・光る石・泡の湧く所）のまわりは掘らない（掘ると宙に浮くので） */
  protectPoint(x: number, y: number, z: number, r: number) {
    this.protect.push({ x, y, z, r });
  }

  get count(): number {
    return this.prims.length;
  }

  ci(x: number): number {
    return clamp(Math.floor((x - TANK.minX) / DIG.chunk), 0, this.ncx - 1);
  }

  cj(z: number): number {
    return clamp(Math.floor((z - TANK.minZ) / DIG.chunk), 0, this.ncz - 1);
  }

  chunkId(i: number, j: number): number {
    return j * this.ncx + i;
  }

  /** 区画に登録された空洞の番号（読み取り専用で使う） */
  chunkPrims(id: number): readonly number[] {
    return this.cells[id];
  }

  /** 区画の中の空洞のいちばん低い所（区画を三角形にする縦の範囲を決める） */
  chunkMinY(id: number, view: DigView = 'live'): number {
    const V = view === 'live' ? this.live : this.snap;
    let y = Infinity;
    for (const k of this.cells[id]) {
      const p = V[k];
      if (p) y = Math.min(y, p.min[1]);
    }
    return y;
  }

  // ---------------- 版（見た目と当たり判定を同時に変える） ----------------

  /** 最新の形を 'snap' の版へ写す（区画の作り直しを始めるとき） */
  snapshot() {
    for (const id of this.changed) {
      this.snap[id] = copyPrim(this.prims[id]);
      this.staged.add(id);
    }
    this.changed.clear();
  }

  /** 'snap' の版を 'live'（当たり判定）にする（作り直した区画をすべて差し替えたとき） */
  commit() {
    for (const id of this.staged) this.live[id] = this.snap[id];
    this.staged.clear();
  }

  /** まだ当たり判定に入っていない形の変化があるか（自動検証・表示用） */
  get uncommitted(): number {
    return this.changed.size + this.staged.size;
  }

  // ---------------- 距離関数 ----------------

  /** 空洞の打ち切り（正 = 空洞を作らない所）。底の少し上・ガラス際・管の区画・発見物のまわり */
  clip(x: number, y: number, z: number): number {
    let c = DIG.floorClip - y;
    c = Math.max(c, DIG.glassClip - Math.min(x - TANK.minX, TANK.maxX - x, z - TANK.minZ, TANK.maxZ - z));
    for (const r of this.lockRects) {
      const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
      c = Math.max(c, 0.3 - Math.hypot(dx, dz));
    }
    for (const p of this.protect) c = Math.max(c, p.r - Math.hypot(x - p.x, y - p.y, z - p.z));
    return c;
  }

  /** 打ち切りの理由（掘れない場所の表示用） */
  clipReason(x: number, y: number, z: number): DigMaterial {
    const floor = DIG.floorClip - y;
    const glass = DIG.glassClip - Math.min(x - TANK.minX, TANK.maxX - x, z - TANK.minZ, TANK.maxZ - z);
    let pipe = -Infinity;
    for (const r of this.lockRects) {
      const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
      pipe = Math.max(pipe, 0.3 - Math.hypot(dx, dz));
    }
    let tr = -Infinity;
    for (const p of this.protect) tr = Math.max(tr, p.r - Math.hypot(x - p.x, y - p.y, z - p.z));
    const m = Math.max(floor, glass, pipe, tr);
    return m === floor ? 'bottom' : m === glass ? 'glass' : m === pipe ? 'pipe' : 'treasure';
  }

  /** 空洞までの距離（内側が負）。近くに空洞が無ければ PAD */
  carve(x: number, y: number, z: number, view: DigView = 'live'): number {
    const list = this.cells[this.cj(z) * this.ncx + this.ci(x)];
    if (list.length === 0) return PAD;
    const V = view === 'live' ? this.live : this.snap;
    let c = PAD;
    for (let i = 0; i < list.length; i++) {
      const p = V[list[i]];
      if (!p) continue;
      const bd = boxDist(p.min, p.max, x, y, z);
      // 外接箱から離れていれば箱までの距離（下限）で十分（つなぎの丸みが届かない）
      c = bd > 0.3 ? Math.min(c, bd) : smin(c, primDist(p, x, y, z), DIG.unionK);
    }
    if (c < CLIP_NEAR) c = Math.max(c, this.clip(x, y, z));
    return c;
  }

  /** 砂（底床）の距離 d を空洞で削る。近くに空洞が無ければ d のまま */
  cut(d: number, x: number, y: number, z: number, view: DigView = 'live'): number {
    if (this.prims.length === 0) return d;
    const list = this.cells[this.cj(z) * this.ncx + this.ci(x)];
    if (list.length === 0) return d;
    return smax(d, -this.carve(x, y, z, view), DIG.rimK);
  }

  /**
   * 区画を三角形にするときの値（buildDigChunk の Surface Nets 用）。符号と、表面のすぐ近く（|値| < 0.25）の値は cut と同じ。
   * 表面から離れた所は cut の代わりに砂の距離 d をそのまま返し、4×4×4 のブロックをまとめて飛ばせるようにする：
   * - 地表より 0.25 以上上：cut ≥ d（smax は max 以上）なので符号は同じ
   * - 近くに空洞が無い（carve が PAD = 空洞まで PAD 以上）深い砂：cut は −PAD 付近に張り付き（|値| < 飛ばす閾値）、
   *   ブロックを飛ばせずに全点を評価していた。ブロックの中心から隅まで（0.35）より空洞が遠いので、d を返しても安全
   */
  meshValue(d: number, x: number, y: number, z: number, view: DigView): number {
    if (d > 0.25) return d;
    if (this.prims.length === 0) return d;
    const list = this.cells[this.cj(z) * this.ncx + this.ci(x)];
    if (list.length === 0) return d;
    const c = this.carve(x, y, z, view);
    if (c >= PAD && d < -0.6) return d;
    return smax(d, -c, DIG.rimK);
  }

  /** 掘った空洞の中で、元の地表より下（トンネルの中）か。カメラの寄せ方に使う */
  tunnelDepth(x: number, y: number, z: number, ground: number): number {
    if (this.prims.length === 0 || this.carve(x, y, z) > -0.02) return 0;
    return ground - y;
  }

  // ---------------- かき出し ----------------

  private register(id: number) {
    const p = this.prims[id];
    const i0 = this.ci(p.min[0] - PAD), i1 = this.ci(p.max[0] + PAD), j0 = this.cj(p.min[2] - PAD), j1 = this.cj(p.max[2] + PAD);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const list = this.cells[j * this.ncx + i];
      if (!list.includes(id)) list.push(id);
    }
  }

  /** 形が変わった範囲の区画を作り直しの印にする（Surface Nets の重なり 0.1 + 縁の丸みの分だけ広げる） */
  private markDirty(min: V3, max: V3) {
    const m = 0.25;
    const i0 = this.ci(min[0] - m), i1 = this.ci(max[0] + m), j0 = this.cj(min[2] - m), j1 = this.cj(max[2] + m);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const id = j * this.ncx + i;
      if (!this.locked[id]) this.dirty.add(id);
    }
  }

  private bounds(p: CarvePrim) {
    for (let k = 0; k < 3; k++) {
      p.min[k] = Math.min(p.a[k], p.b[k]) - p.r;
      p.max[k] = Math.max(p.a[k], p.b[k]) + p.r;
    }
  }

  /** 空洞を足す（a = b なら球） */
  private add(a: V3, b: V3, r: number): number {
    const p: CarvePrim = { a: [...a], b: [...b], r, min: [0, 0, 0], max: [0, 0, 0] };
    this.bounds(p);
    const id = this.prims.push(p) - 1;
    this.live.push(null);
    this.snap.push(null);
    this.changed.add(id);
    this.register(id);
    this.markDirty(p.min, p.max);
    return id;
  }

  /** 空洞の形を変える（伸ばす・太らせる）。変わる前と後の両方の範囲を作り直す */
  private modify(id: number, b: V3 | null, r: number) {
    const p = this.prims[id];
    const oldMin: V3 = [...p.min], oldMax: V3 = [...p.max];
    if (b) p.b = [...b];
    p.r = Math.max(p.r, r);
    this.bounds(p);
    this.changed.add(id);
    this.register(id);
    this.markDirty([Math.min(oldMin[0], p.min[0]), Math.min(oldMin[1], p.min[1]), Math.min(oldMin[2], p.min[2])], [Math.max(oldMax[0], p.max[0]), Math.max(oldMax[1], p.max[1]), Math.max(oldMax[2], p.max[2])]);
  }

  /**
   * 1 回のかき出し。o = 体の中心、dir = 掘る向き（単位）、tHit = o から dir へ最初に当たった砂までの距離（届かなければ null）、
   * now = 時刻（秒）、floorMin = 空洞の床をこれより下げない高さ。続けて掘っている間は半径が広がり、直前の空洞を伸ばす。
   * 届かなくても直前の空洞を太らせる
   */
  stroke(o: V3, dir: V3, tHit: number | null, now: number, floorMin = -Infinity, reach: number = DIG.reach): DigStrokeResult {
    const t0 = performance.now();
    const S = this.session;
    if (now - S.time > 0.6) {
      S.last = -1;
      S.r = DIG.rMin - DIG.grow;
      S.recent = [];
    }
    S.time = now;
    S.r = Math.min(DIG.rMax, S.r + DIG.grow);
    const r = S.r;
    this.stats.strokes++;
    let changed = false;
    let at: V3 = [o[0] + dir[0] * reach * 0.6, o[1] + dir[1] * reach * 0.6, o[2] + dir[2] * reach * 0.6];
    const last = S.last >= 0 ? this.prims[S.last] : null;
    // 直前の空洞から離れすぎた（歩いて移動した）ら、新しく掘り始める
    if (last && Math.hypot(last.b[0] - o[0], last.b[1] - o[1], last.b[2] - o[2]) > 1.6) {
      S.last = -1;
      S.recent = [];
    }
    if (tHit !== null && this.prims.length < DIG.maxPrims) {
      const s = Math.min(tHit + r * 0.3, reach);
      const c: V3 = [o[0] + dir[0] * s, o[1] + dir[1] * s, o[2] + dir[2] * s];
      c[1] = Math.max(c[1], floorMin + r * DIG.floorK);
      at = c;
      const lp = S.last >= 0 ? this.prims[S.last] : null;
      const gap = lp ? Math.hypot(c[0] - lp.b[0], c[1] - lp.b[1], c[2] - lp.b[2]) : Infinity;
      if (lp && gap < 0.18) this.modify(S.last, c, r);
      else {
        // 新しい空洞はカニの体の位置から掘る所へ伸ばす（床がちょうど足元から始まる）。直前の空洞の端から伸ばすと、
        // 上・下へ向きを変えたときに坂の床が足元より上から始まり、越えられない段差が残る
        const start: V3 = [o[0], o[1] - 0.26 + r * DIG.floorK, o[2]];
        S.last = this.add(start, c, r);
        S.recent.push(S.last);
        if (S.recent.length > 3) S.recent.shift();
      }
      changed = true;
    }
    // 掘り続けると手前の空洞も広がる（入口が細いまま残ってカニが入れない、を防ぐ）
    for (const id of S.recent) {
      if (this.prims[id].r < r - 1e-3) {
        this.modify(id, null, r);
        // 届かずに太らせただけのときは、太らせた空洞の先を「掘った所」にする（砂粒を出す位置）
        if (tHit === null) at = [...this.prims[id].b];
        changed = true;
      }
    }
    const ms = performance.now() - t0;
    if (changed) {
      this.stats.carves++;
      this.stats.carveMs += ms;
      this.stats.lastCarveMs = ms;
      this.stats.maxCarveMs = Math.max(this.stats.maxCarveMs, ms);
    }
    return { changed, at, r, ms };
  }
}

function copyPrim(p: CarvePrim): CarvePrim {
  return { a: [...p.a], b: [...p.b], r: p.r, min: [...p.min], max: [...p.max] };
}
