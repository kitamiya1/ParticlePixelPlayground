// 描画方式 D：ボクセル化（CPU 側。Three.js に依存しない）。
// 3D 空間を一辺 h の立方体の格子に分け、立体形状の内外判定から占有グリッドを作り、
// 空気に面した面（露出面）だけを取り出す。描画は面 1 枚 = インスタンス 1 個（VoxelRenderer）。
//
// 占有の作り方
// - 地形：高さ場の柱（島の底 bottomAt 〜 地表 heightRaw）。柱ごとに [下端, 上端] の区間だけを持ち、内部を 1 個ずつ埋めない。
// - 樹木・岩：既存の SDF（visual/sdf/sdfObjects）で内外判定（d ≤ 0 が内側）。4×4×4 のブロック単位で、
//   表面から遠いブロックは 1 回の評価で丸ごと「外」または「内」と判定して評価回数を減らす。
// - 草花・雲：立体の定義が無い（粒だけの）ので、粒の位置を含むボクセルを埋める（雲は粒の半径ぶんの球）。
// - 色・焼き込み日照・風の影響度：形状データの点群（A・B・C と共通）から、ボクセル中心の近くの点の値を写す。
// - キャラクター：部位 SDF のなめらかな和集合で内外判定し、各ボクセルを最も近い部位のボーンに割り当てる
//   （ボーンごとに剛体として動かすので、アニメーション中も形が崩れず、ボクセルが組み替わってちらつくこともない）。

import { BONE_COUNT } from '../../visual/emitters/character';
import { planRock } from '../../visual/emitters/rock';
import { planTree } from '../../visual/emitters/tree';
import type { Box3Like, Sdf } from '../../visual/sdf/sdf';
import { barkSdf, canopySdf, CHARACTER_BLEND, characterSdfParts, rockBox, rockSdf, treeBox } from '../../visual/sdf/sdfObjects';
import { smin } from '../../visual/sdf/sdf';
import type { IslandLayout } from '../../world/IslandLayout';
import type { SplatPointSet } from '../shared/PointSet';

/** 面の向き：0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z */
export const FACE_N: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
/** 面内の 2 軸（U × V = 法線。頂点シェーダーと同じ並び。四角形の頂点は (U,V) = (-,-), (+,-), (+,+), (-,+) の順） */
const FACE_U: readonly (readonly [number, number, number])[] = [[0, 1, 0], [0, 0, 1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [0, 1, 0]];
const FACE_V: readonly (readonly [number, number, number])[] = [[0, 0, 1], [0, 1, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0]];

/** 面のリスト（1 面 = 1 インスタンス） */
export interface FaceList {
  count: number;
  /** 格子座標（i, j, k） */
  cell: Int16Array;
  /** RGB + 焼き込み日照（0..255） */
  col: Uint8Array;
  /** 向き, 4 隅の遮蔽（2 bit × 4）, 風の影響度（0..255）, ボーン番号 */
  misc: Uint8Array;
}

class FaceBuilder {
  count = 0;
  cell = new Int16Array(3 * 1024);
  col = new Uint8Array(4 * 1024);
  misc = new Uint8Array(4 * 1024);

  push(i: number, j: number, k: number, r: number, g: number, b: number, sun: number, dir: number, ao: number, wind: number, bone: number) {
    if (this.count * 3 >= this.cell.length) {
      const grow = <T extends Int16Array | Uint8Array>(a: T): T => {
        const n = new (a.constructor as { new (n: number): T })(a.length * 2);
        n.set(a);
        return n;
      };
      this.cell = grow(this.cell);
      this.col = grow(this.col);
      this.misc = grow(this.misc);
    }
    const n = this.count++;
    this.cell[n * 3] = i;
    this.cell[n * 3 + 1] = j;
    this.cell[n * 3 + 2] = k;
    this.col[n * 4] = r;
    this.col[n * 4 + 1] = g;
    this.col[n * 4 + 2] = b;
    this.col[n * 4 + 3] = sun;
    this.misc[n * 4] = dir;
    this.misc[n * 4 + 1] = ao;
    this.misc[n * 4 + 2] = wind;
    this.misc[n * 4 + 3] = bone;
  }

  finish(): FaceList {
    const n = this.count;
    return { count: n, cell: this.cell.slice(0, n * 3), col: this.col.slice(0, n * 4), misc: this.misc.slice(0, n * 4) };
  }
}

/** 4 隅の遮蔽（環境光の遮り）を 2 bit × 4 にまとめる。3 = 遮りなし、0 = 最も暗い（隣の 2 辺がふさがっている） */
function faceAO(solid: (i: number, j: number, k: number) => boolean, i: number, j: number, k: number, d: number): number {
  const N = FACE_N[d], U = FACE_U[d], V = FACE_V[d];
  const fi = i + N[0], fj = j + N[1], fk = k + N[2];
  const u0 = solid(fi - U[0], fj - U[1], fk - U[2]) ? 1 : 0;
  const u1 = solid(fi + U[0], fj + U[1], fk + U[2]) ? 1 : 0;
  const v0 = solid(fi - V[0], fj - V[1], fk - V[2]) ? 1 : 0;
  const v1 = solid(fi + V[0], fj + V[1], fk + V[2]) ? 1 : 0;
  // 隣の 2 辺がふさがっていれば角は見なくてよい
  const c00 = u0 && v0 ? 0 : 3 - (u0 + v0 + (solid(fi - U[0] - V[0], fj - U[1] - V[1], fk - U[2] - V[2]) ? 1 : 0));
  const c10 = u1 && v0 ? 0 : 3 - (u1 + v0 + (solid(fi + U[0] - V[0], fj + U[1] - V[1], fk + U[2] - V[2]) ? 1 : 0));
  const c11 = u1 && v1 ? 0 : 3 - (u1 + v1 + (solid(fi + U[0] + V[0], fj + U[1] + V[1], fk + U[2] + V[2]) ? 1 : 0));
  const c01 = u0 && v1 ? 0 : 3 - (u0 + v1 + (solid(fi - U[0] + V[0], fj - U[1] + V[1], fk - U[2] + V[2]) ? 1 : 0));
  return c00 | (c10 << 2) | (c11 << 4) | (c01 << 6);
}

/** 疎な整数の格子：8×8×8 のチャンクに分け、値のあるチャンクだけ確保する（既定値 -1）。隣のボクセルの参照が局所的で速い */
class ChunkInts {
  private readonly cx: number;
  private readonly cz: number;
  private readonly chunks: (Int32Array | undefined)[];

  constructor(nx: number, ny: number, nz: number) {
    this.cx = Math.ceil(nx / 8);
    this.cz = Math.ceil(nz / 8);
    this.chunks = new Array(this.cx * Math.ceil(ny / 8) * this.cz);
  }

  get(i: number, j: number, k: number): number {
    const c = this.chunks[((j >> 3) * this.cz + (k >> 3)) * this.cx + (i >> 3)];
    return c ? c[((j & 7) << 6) | ((k & 7) << 3) | (i & 7)] : -1;
  }

  set(i: number, j: number, k: number, v: number) {
    const ci = ((j >> 3) * this.cz + (k >> 3)) * this.cx + (i >> 3);
    let c = this.chunks[ci];
    if (!c) c = this.chunks[ci] = new Int32Array(512).fill(-1);
    c[((j & 7) << 6) | ((k & 7) << 3) | (i & 7)] = v;
  }
}

/**
 * 疎な占有ビット：格子を 16×16×16 のチャンクに分け、ボクセルのあるチャンクだけビット列（512 バイト）を確保する。
 * ハッシュ表より参照が局所的で速く（隣のボクセルはたいてい同じチャンク）、メモリも 1 ボクセル 1 ビット。
 */
class ChunkBits {
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;
  private readonly chunks: (Uint32Array | undefined)[];
  count = 0;

  constructor(private readonly nx: number, private readonly ny: number, private readonly nz: number) {
    this.cx = Math.ceil(nx / 16);
    this.cy = Math.ceil(ny / 16);
    this.cz = Math.ceil(nz / 16);
    this.chunks = new Array(this.cx * this.cy * this.cz);
  }

  has(i: number, j: number, k: number): boolean {
    const c = this.chunks[((j >> 4) * this.cz + (k >> 4)) * this.cx + (i >> 4)];
    if (!c) return false;
    const b = ((j & 15) << 8) | ((k & 15) << 4) | (i & 15);
    return (c[b >> 5] & (1 << (b & 31))) !== 0;
  }

  set(i: number, j: number, k: number) {
    const ci = ((j >> 4) * this.cz + (k >> 4)) * this.cx + (i >> 4);
    let c = this.chunks[ci];
    if (!c) c = this.chunks[ci] = new Uint32Array(128);
    const b = ((j & 15) << 8) | ((k & 15) << 4) | (i & 15);
    const m = 1 << (b & 31);
    if (!(c[b >> 5] & m)) {
      c[b >> 5] |= m;
      this.count++;
    }
  }

  /** 立っているビットを順に呼ぶ（チャンク順） */
  forEach(fn: (i: number, j: number, k: number) => void) {
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const c = this.chunks[ci];
      if (!c) continue;
      const bx = (ci % this.cx) << 4, rest = Math.floor(ci / this.cx), bz = (rest % this.cz) << 4, by = Math.floor(rest / this.cz) << 4;
      for (let w = 0; w < 128; w++) {
        let word = c[w];
        while (word) {
          const t = 31 - Math.clz32(word & -word);
          word &= word - 1;
          const b = (w << 5) | t;
          fn(bx + (b & 15), by + (b >> 8), bz + ((b >> 4) & 15));
        }
      }
    }
  }
}

// ---------------- 浮き島 ----------------

export interface VoxelWorldOptions {
  /** ボクセルの一辺（ワールド単位） */
  size: number;
  /** 草の粒を立体ボクセルにする割合（0..1） */
  decor: number;
  /** 花の粒を立体ボクセルにする */
  flowers: boolean;
}

export interface VoxelWorld {
  size: number;
  origin: [number, number, number];
  /** 向きごとの面（0..5） */
  faces: FaceList[];
  /** 向きごとの面の中心の範囲（透視投影で裏向きの組を丸ごと省く判定に使う） */
  bounds: Box3Like[];
  /** 占有ボクセル数（地形の柱の内部を含む） */
  solidCount: number;
  /** 空気に面したボクセル数 */
  surfaceCount: number;
  faceCount: number;
  buildMs: number;
  /** 生成の内訳（ms）：地形の柱 / SDF の内外判定 / 草花・雲 / 点群の索引 / 露出面の取り出し（色・遮蔽を含む） */
  phases: { terrain: number; sdf: number; points: number; index: number; faces: number };
}

const WORLD_MIN: [number, number, number] = [-64, -26, -64];

/** 緑が主な色の粒（草）か。草花の粒のうち、そうでないもの（赤・桃・青・黄など）を花として扱う */
function isGreen(col: Uint8Array, p: number): boolean {
  const r = col[p * 3], g = col[p * 3 + 1], b = col[p * 3 + 2];
  return g >= r && g >= b;
}
const WORLD_SPAN: [number, number, number] = [128, 44, 128];

/**
 * 浮き島全体をボクセル化する。
 * colorSrc：色・日照・風を写す点群（形状データ）。decor：草花の粒。clouds：雲の粒。
 */
export function buildVoxelWorld(layout: IslandLayout, colorSrc: SplatPointSet, decor: SplatPointSet, clouds: SplatPointSet, opt: VoxelWorldOptions): VoxelWorld {
  const t0 = performance.now();
  const h = opt.size;
  const [ox, oy, oz] = WORLD_MIN;
  const NX = Math.ceil(WORLD_SPAN[0] / h), NY = Math.ceil(WORLD_SPAN[1] / h), NZ = Math.ceil(WORLD_SPAN[2] / h);
  // 色の検索をまとめるための鍵（一辺 0.1 で約 7.2 億。整数の範囲に収める）
  if (NX * NY * NZ >= 2 ** 31) throw new Error(`ボクセルが細かすぎます（一辺 ${h}）`);
  const key = (i: number, j: number, k: number) => (j * NZ + k) * NX + i;
  const t = layout.terrain;

  // 地形：柱ごとの占有区間 [lo, hi]（lo > hi なら柱なし）
  const lo = new Int16Array(NX * NZ).fill(32767);
  const hi = new Int16Array(NX * NZ).fill(-1);
  let solidCount = 0;
  const e = t.extent;
  const i0 = Math.max(0, Math.floor((-e - ox) / h)), i1 = Math.min(NX - 1, Math.ceil((e - ox) / h));
  const k0 = Math.max(0, Math.floor((-e - oz) / h)), k1 = Math.min(NZ - 1, Math.ceil((e - oz) / h));
  for (let k = k0; k <= k1; k++) {
    for (let i = i0; i <= i1; i++) {
      const x = ox + (i + 0.5) * h, z = oz + (k + 0.5) * h;
      if (!t.isInside(x, z)) continue;
      const top = t.heightRaw(x, z), bot = t.bottomAt(x, z);
      // ボクセルの中心が [底, 地表] に入るものを埋める（薄い縁でも最低 1 個）
      const jl = Math.max(0, Math.ceil((bot - oy) / h - 0.5));
      const jh = Math.max(jl, Math.min(NY - 1, Math.floor((top - oy) / h - 0.5)));
      lo[k * NX + i] = jl;
      hi[k * NX + i] = jh;
      solidCount += jh - jl + 1;
    }
  }
  const tTerrain = performance.now();
  const terrainSolid = (i: number, j: number, k: number) => {
    const c = k * NX + i;
    return j >= lo[c] && j <= hi[c];
  };

  // 樹木・岩・草花・雲：疎な占有ビット
  const objs = new ChunkBits(NX, NY, NZ);
  /** 柱ごとに「樹木・岩・草花・雲のボクセルがあるか」（無い柱ではビットを引かずに済む） */
  const objCol = new Uint8Array(NX * NZ);
  const addObj = (i: number, j: number, k: number) => {
    objs.set(i, j, k);
    objCol[k * NX + i] = 1;
  };
  const inGrid = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < NX && j < NY && k < NZ;
  const fillSdf = (sdf: Sdf, box: Box3Like) => {
    const a0 = Math.max(0, Math.floor((box.min[0] - ox) / h)), a1 = Math.min(NX - 1, Math.ceil((box.max[0] - ox) / h));
    const b0 = Math.max(0, Math.floor((box.min[1] - oy) / h)), b1 = Math.min(NY - 1, Math.ceil((box.max[1] - oy) / h));
    const c0 = Math.max(0, Math.floor((box.min[2] - oz) / h)), c1 = Math.min(NZ - 1, Math.ceil((box.max[2] - oz) / h));
    const B = 4;
    // ブロックの半対角 × 余裕（ノイズで距離が正確でない分。sampleSdfSurface と同じ係数）
    const far = B * h * 0.87 * 1.6;
    for (let bk = c0; bk <= c1; bk += B) for (let bj = b0; bj <= b1; bj += B) for (let bi = a0; bi <= a1; bi += B) {
      const d = sdf(ox + (bi + B / 2) * h, oy + (bj + B / 2) * h, oz + (bk + B / 2) * h);
      if (d > far) continue;
      const all = d < -far;
      for (let k = bk; k < Math.min(bk + B, c1 + 1); k++) for (let j = bj; j < Math.min(bj + B, b1 + 1); j++) for (let i = bi; i < Math.min(bi + B, a1 + 1); i++) {
        if (all || sdf(ox + (i + 0.5) * h, oy + (j + 0.5) * h, oz + (k + 0.5) * h) <= 0) addObj(i, j, k);
      }
    }
  };
  for (const p of layout.placements) {
    if (p.kind === 'tree') {
      const plan = planTree(p);
      const canopy = canopySdf(plan), bark = barkSdf(plan);
      fillSdf((x, y, z) => Math.min(canopy(x, y, z), bark(x, y, z)), treeBox(plan));
    } else if (p.kind === 'rock') {
      const plan = planRock(p);
      fillSdf(rockSdf(plan), rockBox(plan));
    }
  }
  const tSdf = performance.now();
  // 草花：地表より上に出ている粒の位置を埋める。花（緑が主でない色の粒）は opt.flowers で、草は割合 opt.decor で
  // （点群はシャッフル済みなので、草は数えながら先頭から取れば均一に間引ける）
  const grassTotal = (() => {
    let n = 0;
    for (let p = 0; p < decor.count; p++) if (isGreen(decor.col, p)) n++;
    return n;
  })();
  const grassMax = Math.round(grassTotal * Math.max(0, Math.min(1, opt.decor)));
  let grassUsed = 0;
  for (let p = 0; p < decor.count; p++) {
    if (isGreen(decor.col, p)) {
      if (grassUsed >= grassMax) continue;
      grassUsed++;
    } else if (!opt.flowers) continue;
    const i = Math.floor((decor.pos[p * 3] - ox) / h), j = Math.floor((decor.pos[p * 3 + 1] - oy) / h), k = Math.floor((decor.pos[p * 3 + 2] - oz) / h);
    if (inGrid(i, j, k) && !terrainSolid(i, j, k)) addObj(i, j, k);
  }
  // 雲：粒の半径ぶんの球を埋めて、粒の間に隙間が出ないようにする
  for (let p = 0; p < clouds.count; p++) {
    const x = clouds.pos[p * 3], y = clouds.pos[p * 3 + 1], z = clouds.pos[p * 3 + 2];
    const r = Math.max(h * 0.5, clouds.size[p] * 0.5);
    const ia = Math.floor((x - r - ox) / h), ib = Math.floor((x + r - ox) / h);
    const ja = Math.floor((y - r - oy) / h), jb = Math.floor((y + r - oy) / h);
    const ka = Math.floor((z - r - oz) / h), kb = Math.floor((z + r - oz) / h);
    for (let k = ka; k <= kb; k++) for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
      if (!inGrid(i, j, k)) continue;
      const dx = ox + (i + 0.5) * h - x, dy = oy + (j + 0.5) * h - y, dz = oz + (k + 0.5) * h - z;
      if (dx * dx + dy * dy + dz * dz <= r * r || (i === Math.floor((x - ox) / h) && j === Math.floor((y - oy) / h) && k === Math.floor((z - oz) / h))) addObj(i, j, k);
    }
  }

  const solid = (i: number, j: number, k: number) => {
    if (!inGrid(i, j, k)) return false;
    const c = k * NX + i;
    if (j >= lo[c] && j <= hi[c]) return true;
    return objCol[c] === 1 && objs.has(i, j, k);
  };

  const tPoints = performance.now();
  // 色を写す点の索引：各ボクセル（空気側も含む）に、その中に入る点のうち中心に最も近いものを 1 つ記録する。
  // 表面の点はたいてい「表面のボクセル」か「その外側の空気のボクセル」に入るので、周囲 3×3×3 を見れば見つかる
  const pointAt = new ChunkInts(NX, NY, NZ);
  {
    const pos = colorSrc.pos;
    for (let p = 0; p < colorSrc.count; p++) {
      const fx = (pos[p * 3] - ox) / h, fy = (pos[p * 3 + 1] - oy) / h, fz = (pos[p * 3 + 2] - oz) / h;
      const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
      if (!inGrid(i, j, k)) continue;
      const q = pointAt.get(i, j, k);
      if (q >= 0) {
        // 中心に近い方を残す
        const d = (fx - i - 0.5) ** 2 + (fy - j - 0.5) ** 2 + (fz - k - 0.5) ** 2;
        const e = ((pos[q * 3] - ox) / h - i - 0.5) ** 2 + ((pos[q * 3 + 1] - oy) / h - j - 0.5) ** 2 + ((pos[q * 3 + 2] - oz) / h - k - 0.5) ** 2;
        if (d >= e) continue;
      }
      pointAt.set(i, j, k, p);
    }
  }
  /**
   * ボクセル中心に近い点：自分と面で接する 6 個のボクセルに記録された点から最も近いもの。
   * 無ければ周囲 3×3×3、5×5×5、7×7×7 の外周へ広げる（無ければ -1）
   */
  const nearestPoint = (i: number, j: number, k: number) => {
    const pos = colorSrc.pos;
    const x = ox + (i + 0.5) * h, y = oy + (j + 0.5) * h, z = oz + (k + 0.5) * h;
    // まず自分と面で接する 6 個（表面の点の多くはここに入る）
    let best = -1, bd = Infinity;
    for (let d = -1; d < 6; d++) {
      const a = d < 0 ? i : i + FACE_N[d][0], b = d < 0 ? j : j + FACE_N[d][1], c = d < 0 ? k : k + FACE_N[d][2];
      if (!inGrid(a, b, c)) continue;
      const p = pointAt.get(a, b, c);
      if (p < 0) continue;
      const dx = pos[p * 3] - x, dy = pos[p * 3 + 1] - y, dz = pos[p * 3 + 2] - z;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bd) {
        bd = dd;
        best = p;
      }
    }
    if (best >= 0) return best;
    for (let r = 1; r <= 3; r++) {
      let best = -1, bd = Infinity;
      for (let c = k - r; c <= k + r; c++) for (let b = j - r; b <= j + r; b++) for (let a = i - r; a <= i + r; a++) {
        if (r > 1 && Math.abs(a - i) < r && Math.abs(b - j) < r && Math.abs(c - k) < r) continue; // 内側は調べ済み
        if (!inGrid(a, b, c)) continue;
        const p = pointAt.get(a, b, c);
        if (p < 0) continue;
        const dx = pos[p * 3] - x, dy = pos[p * 3 + 1] - y, dz = pos[p * 3 + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  };
  const tIndex = performance.now();
  const fb = FACE_N.map(() => new FaceBuilder());
  const bounds: Box3Like[] = FACE_N.map(() => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  const surface = new ChunkBits(NX, NY, NZ);
  // 同じボクセルの面は続けて出すので、色の検索は直前の結果を使い回す
  let cKey = -1, cr = 128, cg = 128, cb = 128, cSun = 255, cWind = 0;
  const emit = (i: number, j: number, k: number, d: number) => {
    const kk = key(i, j, k);
    if (kk !== cKey) {
      cKey = kk;
      const p = nearestPoint(i, j, k);
      if (p >= 0) {
        cr = colorSrc.col[p * 3];
        cg = colorSrc.col[p * 3 + 1];
        cb = colorSrc.col[p * 3 + 2];
        cSun = Math.round(Math.max(0, Math.min(1, colorSrc.sun[p])) * 255);
        cWind = Math.round(Math.max(0, Math.min(1, colorSrc.wind[p])) * 255);
      } else {
        cr = 120; cg = 100; cb = 90; cSun = 255; cWind = 0;
      }
    }
    surface.set(i, j, k);
    fb[d].push(i, j, k, cr, cg, cb, cSun, d, faceAO(solid, i, j, k, d), cWind, 0);
    const bx = bounds[d];
    const x = ox + (i + 0.5) * h, y = oy + (j + 0.5) * h, z = oz + (k + 0.5) * h;
    if (x < bx.min[0]) bx.min[0] = x;
    if (y < bx.min[1]) bx.min[1] = y;
    if (z < bx.min[2]) bx.min[2] = z;
    if (x > bx.max[0]) bx.max[0] = x;
    if (y > bx.max[1]) bx.max[1] = y;
    if (z > bx.max[2]) bx.max[2] = z;
  };

  // 地形の柱：上面・底面と、隣の柱の区間から外れた高さの側面だけを調べる（柱の内部は 1 個ずつ見ない）
  const SIDE: [number, number, number][] = [[1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]];
  for (let k = k0; k <= k1; k++) {
    for (let i = i0; i <= i1; i++) {
      const c = k * NX + i;
      const jl = lo[c], jh = hi[c];
      if (jl > jh) continue;
      if (!solid(i, jh + 1, k)) emit(i, jh, k, 2);
      if (!solid(i, jl - 1, k)) emit(i, jl, k, 3);
      for (const [di, dk, d] of SIDE) {
        const ni = i + di, nk = k + dk;
        const inside = inGrid(ni, 0, nk);
        const nl = inside ? lo[nk * NX + ni] : 32767, nh = inside ? hi[nk * NX + ni] : -1;
        const side = (ja: number, jb: number) => {
          for (let j = ja; j <= jb; j++) if (!inside || !objCol[nk * NX + ni] || !objs.has(ni, j, nk)) emit(i, j, k, d);
        };
        if (nl > nh) side(jl, jh);
        else {
          side(jl, Math.min(jh, nl - 1));
          side(Math.max(jl, nh + 1), jh);
        }
      }
    }
  }
  // 樹木・岩・草花・雲（地形の柱に含まれるものは地形側で数える）
  objs.forEach((i, j, k) => {
    if (terrainSolid(i, j, k)) return;
    solidCount++;
    for (let d = 0; d < 6; d++) {
      const N = FACE_N[d];
      if (!solid(i + N[0], j + N[1], k + N[2])) emit(i, j, k, d);
    }
  });

  const faces = fb.map((b) => b.finish());
  const tEnd = performance.now();
  return {
    size: h,
    origin: [ox, oy, oz],
    faces,
    bounds,
    solidCount,
    surfaceCount: surface.count,
    faceCount: faces.reduce((a, f) => a + f.count, 0),
    buildMs: tEnd - t0,
    phases: { terrain: tTerrain - t0, sdf: tSdf - tTerrain, points: tPoints - tSdf, index: tIndex - tPoints, faces: tEnd - tIndex },
  };
}

// ---------------- キャラクター ----------------

export interface VoxelCharacter {
  size: number;
  origin: [number, number, number];
  faces: FaceList;
  solidCount: number;
  surfaceCount: number;
  buildMs: number;
}

/**
 * キャラクターを静止姿勢でボクセル化する。部位 SDF のなめらかな和集合（方式 B・C の SDF 生成と同じ形）で内外を判定し、
 * 各ボクセルを最も近い部位のボーンに割り当てる。面の省略は同じボーンのボクセル同士だけで行う
 * （ボーンが動くと別ボーンとの境目の面が見えるようになるため。静止姿勢では奥に隠れるだけ）。
 */
export function buildVoxelCharacter(size: number): VoxelCharacter {
  const t0 = performance.now();
  const h = size;
  const parts = characterSdfParts();
  const origin: [number, number, number] = [-0.45, -0.1, -0.35];
  const NX = Math.ceil(0.9 / h), NY = Math.ceil(1.55 / h), NZ = Math.ceil(0.7 / h);
  // 0 = 空、1 + ボーン番号 = 占有
  const grid = new Uint8Array(NX * NY * NZ);
  const idx = (i: number, j: number, k: number) => (j * NZ + k) * NX + i;
  const at = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ ? 0 : grid[idx(i, j, k)]);
  const center = (i: number, j: number, k: number): [number, number, number] => [origin[0] + (i + 0.5) * h, origin[1] + (j + 0.5) * h, origin[2] + (k + 0.5) * h];
  const nearestPart = (x: number, y: number, z: number) => {
    let best = 0, bd = Infinity;
    for (let p = 0; p < parts.length; p++) {
      const d = parts[p].d(x, y, z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };
  let solidCount = 0;
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const [x, y, z] = center(i, j, k);
    let d = Infinity;
    for (const p of parts) d = smin(d, p.d(x, y, z), CHARACTER_BLEND);
    if (d > 0) continue;
    grid[idx(i, j, k)] = 1 + parts[nearestPart(x, y, z)].bone;
    solidCount++;
  }
  const any = (i: number, j: number, k: number) => at(i, j, k) > 0;
  const fb = new FaceBuilder();
  let surfaceCount = 0;
  const eps = h * 0.3;
  for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const g = grid[idx(i, j, k)];
    if (!g) continue;
    const bone = g - 1;
    let colored = false, r = 0, gg = 0, b = 0;
    for (let d = 0; d < 6; d++) {
      const N = FACE_N[d];
      if (at(i + N[0], j + N[1], k + N[2]) === g) continue;
      if (!colored) {
        // 色は部位の色関数（法線は SDF の勾配）。粒版・SDF 版のキャラクターと同じ塗り分け
        colored = true;
        surfaceCount++;
        const [x, y, z] = center(i, j, k);
        const part = parts[nearestPart(x, y, z)];
        let nx = part.d(x + eps, y, z) - part.d(x - eps, y, z);
        let ny = part.d(x, y + eps, z) - part.d(x, y - eps, z);
        let nz = part.d(x, y, z + eps) - part.d(x, y, z - eps);
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const c = part.color(x, y, z, nx, ny, nz);
        r = Math.round(Math.min(1, Math.max(0, c[0])) * 255);
        gg = Math.round(Math.min(1, Math.max(0, c[1])) * 255);
        b = Math.round(Math.min(1, Math.max(0, c[2])) * 255);
      }
      fb.push(i, j, k, r, gg, b, 255, d, faceAO(any, i, j, k, d), 0, bone);
    }
  }
  if (BONE_COUNT > 255) throw new Error('ボーン数が多すぎます');
  return { size: h, origin, faces: fb.finish(), solidCount, surfaceCount, buildMs: performance.now() - t0 };
}
