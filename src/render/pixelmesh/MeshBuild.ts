// 描画方式 E：ピクセル化メッシュの形状生成（CPU 側。Three.js に依存しない）。
// 通常のポリゴンメッシュ（三角形）を作り、描画側（PixelMeshRenderer）で低解像度に描いてから
// 方式 A・C・D と同じ後処理（輪郭・ディザ・減色・整数倍拡大）をかける。
//
// 形状の出どころ（できるだけ既存の形状データ・SDF を共有する）
// - 地形：高さ場（Terrain の heightRaw / bottomAt）と島の縁（edgeRadius）から、極座標の同心円の網で
//   上面・底面・縁の側面を張る（縁の形は粒・ボクセルと同じ関数）。
// - 樹木・岩：既存の SDF（visual/sdf/sdfObjects。方式 D の内外判定と同じ関数）を Surface Nets で三角形化。
// - キャラクター：部位 SDF（characterSdfParts）を部位 = ボーンごとに三角形化し、ボーン行列で剛体として動かす。
// - 草・花・雲：粒の生成時に書き留めた形の計画（visual/meshHints）から、葉の帯・花の円盤・楕円体を作る。
// - 色・焼き込み日照・風の影響度：形状データの点群（A〜D と共通）の近くの点から写す（キャラクターは部位の色関数）。

import { mulberry32 } from '../../core/math';
import { BONE_PIVOTS } from '../../visual/emitters/character';
import { planRock } from '../../visual/emitters/rock';
import { planTree } from '../../visual/emitters/tree';
import type { MeshHints } from '../../visual/meshHints';
import type { Box3Like, Sdf } from '../../visual/sdf/sdf';
import { barkSdf, canopySdf, characterSdfParts, rockBox, rockSdf, treeBox } from '../../visual/sdf/sdfObjects';
import type { IslandLayout } from '../../world/IslandLayout';
import type { SplatPointSet } from '../shared/PointSet';
import { PointIndex, type PointSample } from './PointIndex';

/** 三角形メッシュ（頂点ごとに位置・法線・色・日照・風・ボーン番号） */
export interface TriMesh {
  vertexCount: number;
  triCount: number;
  pos: Float32Array;
  nrm: Float32Array;
  /** RGB（0..255） */
  col: Uint8Array;
  /** 日照, 風の影響度（0..255） */
  misc: Uint8Array;
  /** ボーン番号（キャラクターのみ） */
  bone: Uint8Array | null;
  index: Uint32Array;
}

class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private misc: number[] = [];
  private bone: number[] = [];
  private idx: number[] = [];

  get vertexCount() {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, sun: number, wind: number, bone = 0): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z);
    this.nrm.push(nx / l, ny / l, nz / l);
    this.col.push(r, g, b);
    this.misc.push(Math.round(Math.max(0, Math.min(1, sun)) * 255), Math.round(Math.max(0, Math.min(1, wind)) * 255));
    this.bone.push(bone);
    return this.pos.length / 3 - 1;
  }

  /**
   * 三角形を足す。expected（外向きの向きの目安）と面の法線が逆なら頂点の順を入れ替え、
   * 表（反時計回り）が常に外を向くようにする（裏面を描かないので向きが大事）。
   */
  tri(a: number, b: number, c: number, ex: number, ey: number, ez: number) {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) return; // つぶれた三角形
    if (nx * ex + ny * ey + nz * ez < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }

  /** 頂点の法線の和を目安にして三角形を足す */
  triByNormals(a: number, b: number, c: number) {
    const n = this.nrm;
    this.tri(a, b, c, n[a * 3] + n[b * 3] + n[c * 3], n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1], n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2]);
  }

  finish(withBones = false): TriMesh {
    return {
      vertexCount: this.pos.length / 3,
      triCount: this.idx.length / 3,
      pos: Float32Array.from(this.pos),
      nrm: Float32Array.from(this.nrm),
      col: Uint8Array.from(this.col),
      misc: Uint8Array.from(this.misc),
      bone: withBones ? Uint8Array.from(this.bone) : null,
      index: Uint32Array.from(this.idx),
    };
  }
}

// ---------------- Surface Nets（SDF → 三角形） ----------------

/** 立方体の 8 隅（ビット 0 = x, 1 = y, 2 = z）を結ぶ 12 本の辺 */
const CUBE_EDGES: [number, number][] = (() => {
  const e: [number, number][] = [];
  for (let c = 0; c < 8; c++) for (const bit of [1, 2, 4]) if (!(c & bit)) e.push([c, c | bit]);
  return e;
})();

/**
 * SDF の表面を Surface Nets で三角形にする（d ≤ 0 が内側）。格子の一辺 h。
 * 4×4×4 のブロック単位で、表面から遠いブロックは 1 回の評価で値を埋めて評価回数を減らす（方式 D と同じ考え方）。
 * vertex(x, y, z, nx, ny, nz) で頂点を登録し、その番号を返させる（色付けは呼び出し側）。
 */
function surfaceNets(sdf: Sdf, box: Box3Like, h: number, mb: MeshBuilder, vertex: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number) {
  const [ox, oy, oz] = box.min;
  const nx = Math.max(2, Math.ceil((box.max[0] - ox) / h) + 1);
  const ny = Math.max(2, Math.ceil((box.max[1] - oy) / h) + 1);
  const nz = Math.max(2, Math.ceil((box.max[2] - oz) / h) + 1);
  const v = new Float32Array(nx * ny * nz);
  const id = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const B = 4;
  const far = B * h * 0.87 * 1.6;
  for (let bk = 0; bk < nz; bk += B) for (let bj = 0; bj < ny; bj += B) for (let bi = 0; bi < nx; bi += B) {
    const d = sdf(ox + (bi + B / 2) * h, oy + (bj + B / 2) * h, oz + (bk + B / 2) * h);
    const exact = Math.abs(d) <= far;
    for (let k = bk; k < Math.min(bk + B, nz); k++) for (let j = bj; j < Math.min(bj + B, ny); j++) for (let i = bi; i < Math.min(bi + B, nx); i++) {
      v[id(i, j, k)] = exact ? sdf(ox + i * h, oy + j * h, oz + k * h) : d;
    }
  }
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const cid = (i: number, j: number, k: number) => (k * cy + j) * cx + i;
  const cv = new Float32Array(8);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const val = v[id(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
      cv[c] = val;
      if (val <= 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    // 符号が変わる辺の交点の平均を頂点にする
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of CUBE_EDGES) {
      const va = cv[a], vb = cv[b];
      if ((va <= 0) === (vb <= 0)) continue;
      const t = va / (va - vb);
      sx += (a & 1) + (((b & 1) - (a & 1)) * t);
      sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t);
      sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t);
      n++;
    }
    const x = ox + (i + sx / n) * h, y = oy + (j + sy / n) * h, z = oz + (k + sz / n) * h;
    // 法線は SDF の勾配（セルの 8 隅の値の差から求める。SDF を追加で評価しない）
    const gx = cv[1] - cv[0] + cv[3] - cv[2] + cv[5] - cv[4] + cv[7] - cv[6];
    const gy = cv[2] - cv[0] + cv[3] - cv[1] + cv[6] - cv[4] + cv[7] - cv[5];
    const gz = cv[4] - cv[0] + cv[5] - cv[1] + cv[6] - cv[2] + cv[7] - cv[3];
    cellVert[cid(i, j, k)] = vertex(x, y, z, gx, gy, gz);
  }
  // 符号が変わる格子の辺ごとに、その辺を囲む 4 つのセルの頂点で四角形を張る
  const quad = (a: number, b: number, c: number, d: number, ex: number, ey: number, ez: number) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    mb.tri(a, b, c, ex, ey, ez);
    mb.tri(a, c, d, ex, ey, ez);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v0 = v[id(i, j, k)];
    const in0 = v0 <= 0;
    // 内側 → 外側へ向かう辺なら、表は +軸を向く
    if (i < cx && j > 0 && k > 0 && in0 !== (v[id(i + 1, j, k)] <= 0)) {
      const s = in0 ? 1 : -1;
      quad(cellVert[cid(i, j - 1, k - 1)], cellVert[cid(i, j, k - 1)], cellVert[cid(i, j, k)], cellVert[cid(i, j - 1, k)], s, 0, 0);
    }
    if (j < cy && i > 0 && k > 0 && in0 !== (v[id(i, j + 1, k)] <= 0)) {
      const s = in0 ? 1 : -1;
      quad(cellVert[cid(i - 1, j, k - 1)], cellVert[cid(i, j, k - 1)], cellVert[cid(i, j, k)], cellVert[cid(i - 1, j, k)], 0, s, 0);
    }
    if (k < cz && i > 0 && j > 0 && in0 !== (v[id(i, j, k + 1)] <= 0)) {
      const s = in0 ? 1 : -1;
      quad(cellVert[cid(i - 1, j - 1, k)], cellVert[cid(i, j - 1, k)], cellVert[cid(i, j, k)], cellVert[cid(i - 1, j, k)], 0, 0, s);
    }
  }
}

// ---------------- 浮き島 ----------------

export interface PixelMeshWorldOptions {
  /** 樹木・岩の SDF を三角形にする格子の一辺（地形の網はこの 1.8 倍） */
  detail: number;
  /**
   * 方式 F（ハイブリッド）用：樹冠を作らず（葉は C の円盤で描く）、objects = 岩だけ、trunks = 幹・枝を別のメッシュにする。
   * 幹を E / C で切り替えても作り直さないよう、幹は別に持つ。
   */
  hybrid?: boolean;
}

export interface BladeInstances {
  count: number;
  /** 根元 xyz */
  base: Float32Array;
  /** 長さ, 傾き x, 傾き z, 幅 */
  shape: Float32Array;
  /** 根元の RGB + 日照 / 先端の RGB + 風の強さ（0..255） */
  colA: Uint8Array;
  colB: Uint8Array;
}

export interface PixelMeshWorld {
  /** 地形・樹木・岩・雲（静的な三角形メッシュ。風は頂点ごとの影響度で揺らす） */
  terrain: TriMesh;
  objects: TriMesh;
  /** 幹・枝（hybrid のときだけ。通常は objects に樹冠と一体で含む） */
  trunks: TriMesh | null;
  clouds: TriMesh;
  /** 草の葉と花の茎（細い帯のインスタンス。並びはシャッフル済みで、先頭から必要数だけ描けば均一に間引ける） */
  blades: BladeInstances;
  /** 草の葉の数（blades の先頭からこの数が草、残りが花の茎） */
  grassCount: number;
  /** 花の頭（星形の円盤のインスタンス。shape = 半径, 回転, 茎の長さ, 0） */
  heads: BladeInstances;
  detail: number;
  buildMs: number;
  phases: { index: number; terrain: number; objects: number; decor: number };
}

const DEFAULT_COLOR: [number, number, number] = [120, 100, 90];

/** 形状データの点群から、頂点に色・日照・風を写す */
function colorizer(index: PointIndex, rAvg: number) {
  const s: PointSample = { nearest: -1, sun: 1, wind: 0 };
  const col = index.set.col;
  return (x: number, y: number, z: number): [number, number, number, number, number] => {
    index.sample(x, y, z, rAvg, s, 4);
    const p = s.nearest;
    if (p < 0) return [...DEFAULT_COLOR, s.sun, s.wind];
    return [col[p * 3], col[p * 3 + 1], col[p * 3 + 2], s.sun, s.wind];
  };
}

/** 地形：極座標の同心円の網で、上面・底面・縁の側面を張る */
function buildTerrain(layout: IslandLayout, step: number, paint: ReturnType<typeof colorizer>): TriMesh {
  const t = layout.terrain;
  const mb = new MeshBuilder();
  const Rmax = t.cfg.radius * 1.1;
  const M = Math.max(4, Math.ceil(Rmax / step));
  /** リング i の点の数（角度方向の間隔がおよそ step になるように） */
  const ringN = (i: number) => (i === 0 ? 1 : Math.max(6, Math.ceil((2 * Math.PI * (i / M) * Rmax) / step)));
  const edgeCache = new Map<number, number>();
  const edge = (th: number) => {
    let r = edgeCache.get(th);
    if (r === undefined) edgeCache.set(th, (r = t.edgeRadius(th)));
    return r;
  };
  const xz = (i: number, a: number, n: number): [number, number] => {
    if (i === 0) return [0, 0];
    const th = (a / n) * Math.PI * 2;
    const r = (i / M) * edge(th);
    return [Math.cos(th) * r, Math.sin(th) * r];
  };
  const e = 0.2;
  const surface = (bottom: boolean) => {
    const rings: number[][] = [];
    for (let i = 0; i <= M; i++) {
      const n = ringN(i), ids: number[] = [];
      for (let a = 0; a < n; a++) {
        const [x, z] = xz(i, a, n);
        let y: number, nx: number, ny: number, nz: number;
        if (bottom) {
          y = t.bottomAt(x, z);
          nx = t.bottomAt(x + e, z) - t.bottomAt(x - e, z);
          nz = t.bottomAt(x, z + e) - t.bottomAt(x, z - e);
          ny = -2 * e;
        } else {
          y = t.heightRaw(x, z);
          [nx, ny, nz] = t.normalAt(x, z);
        }
        const [r, g, b, sun, wind] = paint(x, y + (bottom ? -0.02 : 0.02), z);
        ids.push(mb.vertex(x, y, z, nx, ny, nz, r, g, b, sun, wind));
      }
      rings.push(ids);
    }
    // 隣り合うリングを角度順に縫い合わせる（点の数が違ってもよい）
    const ey = bottom ? -1 : 1;
    for (let i = 0; i < M; i++) {
      const A = rings[i], Bv = rings[i + 1];
      if (A.length === 1) {
        for (let b = 0; b < Bv.length; b++) mb.tri(A[0], Bv[b], Bv[(b + 1) % Bv.length], 0, ey, 0);
        continue;
      }
      let a = 0, b = 0;
      while (a < A.length || b < Bv.length) {
        if (b >= Bv.length || (a < A.length && (a + 1) / A.length < (b + 1) / Bv.length)) {
          mb.tri(A[a % A.length], A[(a + 1) % A.length], Bv[b % Bv.length], 0, ey, 0);
          a++;
        } else {
          mb.tri(A[a % A.length], Bv[(b + 1) % Bv.length], Bv[b % Bv.length], 0, ey, 0);
          b++;
        }
      }
    }
  };
  surface(false);
  surface(true);
  // 縁の側面（上面の縁 → 底面の縁）。法線は外向きの水平
  const n = ringN(M);
  const cols: number[][] = [];
  for (let a = 0; a < n; a++) {
    const th = (a / n) * Math.PI * 2;
    const [x, z] = xz(M, a, n);
    const top = t.heightRaw(x, z), bot = t.bottomAt(x, z);
    const K = Math.max(1, Math.ceil((top - bot) / step));
    const ids: number[] = [];
    for (let q = 0; q <= K; q++) {
      const y = top + ((bot - top) * q) / K;
      const [r, g, b, sun, wind] = paint(x + Math.cos(th) * 0.02, y, z + Math.sin(th) * 0.02);
      ids.push(mb.vertex(x, y, z, Math.cos(th), 0, Math.sin(th), r, g, b, sun, wind));
    }
    cols.push(ids);
  }
  for (let a = 0; a < n; a++) {
    const A = cols[a], Bv = cols[(a + 1) % n];
    const th = ((a + 0.5) / n) * Math.PI * 2;
    const ex = Math.cos(th), ez = Math.sin(th);
    const K = Math.max(A.length, Bv.length) - 1;
    for (let q = 0; q < K; q++) {
      const a0 = A[Math.min(q, A.length - 1)], a1 = A[Math.min(q + 1, A.length - 1)];
      const b0 = Bv[Math.min(q, Bv.length - 1)], b1 = Bv[Math.min(q + 1, Bv.length - 1)];
      mb.tri(a0, a1, b1, ex, 0, ez);
      mb.tri(a0, b1, b0, ex, 0, ez);
    }
  }
  return mb.finish();
}

/** 樹木・岩：既存の SDF を三角形にする。hybrid なら樹冠を省き、幹・枝を別のメッシュ（trunks）にする */
function buildObjects(layout: IslandLayout, h: number, paint: ReturnType<typeof colorizer>, hybrid = false): { objects: TriMesh; trunks: TriMesh | null } {
  const mb = new MeshBuilder();
  const tb = hybrid ? new MeshBuilder() : null;
  const add = (sdf: Sdf, box: Box3Like, to = mb) =>
    surfaceNets(sdf, box, h, to, (x, y, z, nx, ny, nz) => {
      const l = Math.hypot(nx, ny, nz) || 1;
      // 表面の点は SDF の表面から少し外にあるので、法線方向に少しずらした位置で探す
      const [r, g, b, sun, wind] = paint(x + (nx / l) * 0.03, y + (ny / l) * 0.03, z + (nz / l) * 0.03);
      return to.vertex(x, y, z, nx, ny, nz, r, g, b, sun, wind);
    });
  for (const p of layout.placements) {
    if (p.kind === 'tree') {
      const plan = planTree(p);
      const bark = barkSdf(plan);
      if (tb) add(bark, treeBox(plan), tb);
      else {
        const canopy = canopySdf(plan);
        add((x, y, z) => Math.min(canopy(x, y, z), bark(x, y, z)), treeBox(plan));
      }
    } else if (p.kind === 'rock') {
      const plan = planRock(p);
      add(rockSdf(plan), rockBox(plan));
    }
  }
  return { objects: mb.finish(), trunks: tb ? tb.finish() : null };
}

/** 雲：かたまりごとの楕円体（縦 0.6 倍、下側は粒版と同じく dy = -0.45 で平らに切る） */
function buildClouds(hints: MeshHints, paint: ReturnType<typeof colorizer>): TriMesh {
  const mb = new MeshBuilder();
  const rows = 10, segs = 20;
  for (const L of hints.cloudLumps) {
    const ids: number[][] = [];
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      // 緯度は下側を dy = -0.45 で止める（底面は平らな蓋）
      const dy = Math.max(-0.45, Math.cos(v * Math.PI));
      const rr = Math.sqrt(Math.max(0, 1 - dy * dy));
      const row: number[] = [];
      for (let s = 0; s < (r === 0 ? 1 : segs); s++) {
        const a = (s / segs) * Math.PI * 2;
        const dx = Math.cos(a) * rr, dz = Math.sin(a) * rr;
        const x = L.x + dx * L.r, y = L.y + dy * 0.6 * L.r, z = L.z + dz * L.r;
        const [cr, cg, cb, sun] = paint(x, y, z);
        row.push(mb.vertex(x, y, z, dx, dy / 0.6, dz, cr, cg, cb, sun, 0));
      }
      ids.push(row);
      if (dy <= -0.45) break;
    }
    const cx = L.x, cz = L.z;
    // 三角形の表裏は頂点の法線（楕円体の外向き）で決める
    for (let r = 0; r + 1 < ids.length; r++) {
      const A = ids[r], Bv = ids[r + 1];
      for (let s = 0; s < segs; s++) {
        const a0 = A[A.length === 1 ? 0 : s], a1 = A[A.length === 1 ? 0 : (s + 1) % segs];
        const b0 = Bv[s], b1 = Bv[(s + 1) % segs];
        mb.triByNormals(a0, b0, b1);
        if (a0 !== a1) mb.triByNormals(a0, b1, a1);
      }
    }
    // 底の蓋
    const last = ids[ids.length - 1];
    const by = L.y - 0.45 * 0.6 * L.r;
    const [cr, cg, cb, sun] = paint(cx, by, cz);
    const c = mb.vertex(cx, by, cz, 0, -1, 0, cr, cg, cb, sun, 0);
    for (let s = 0; s < segs; s++) mb.tri(c, last[s], last[(s + 1) % segs], 0, -1, 0);
  }
  return mb.finish();
}

const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** 草の葉・花の茎・花の頭のインスタンスを作る（色は記録した計画の色、日照は点群から写す） */
function buildDecor(hints: MeshHints, index: PointIndex): { blades: BladeInstances; grassCount: number; heads: BladeInstances } {
  const s: PointSample = { nearest: -1, sun: 1, wind: 0 };
  const rng = mulberry32(17);
  // 草はシャッフルして、先頭から必要数だけ描けば均一に間引けるようにする
  const order = hints.blades.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const nb = hints.blades.length + hints.flowers.length;
  const blades: BladeInstances = { count: nb, base: new Float32Array(nb * 3), shape: new Float32Array(nb * 4), colA: new Uint8Array(nb * 4), colB: new Uint8Array(nb * 4) };
  let o = 0;
  const pushBlade = (x: number, y: number, z: number, len: number, lx: number, lz: number, w: number, a: readonly number[], b: readonly number[], wind: number) => {
    index.sample(x, y + len * 0.5, z, 0.2, s, 2);
    blades.base.set([x, y, z], o * 3);
    blades.shape.set([len, lx, lz, w], o * 4);
    blades.colA.set([u8(a[0]), u8(a[1]), u8(a[2]), u8(s.sun)], o * 4);
    blades.colB.set([u8(b[0]), u8(b[1]), u8(b[2]), u8(wind)], o * 4);
    o++;
  };
  // 先頭に花の茎（常に描く）、続いてシャッフルした草の葉
  const stemC = [0x4b / 255, 0x8a / 255, 0x3c / 255];
  for (const f of hints.flowers) pushBlade(f.x, f.y, f.z, f.stem, 0, 0, 0.05, stemC, stemC, 0.9);
  for (const i of order) {
    const bl = hints.blades[i];
    pushBlade(bl.x, bl.y, bl.z, bl.len, bl.leanX, bl.leanZ, 0.07, bl.base, bl.tip, 1);
  }
  const nh = hints.flowers.length;
  const heads: BladeInstances = { count: nh, base: new Float32Array(nh * 3), shape: new Float32Array(nh * 4), colA: new Uint8Array(nh * 4), colB: new Uint8Array(nh * 4) };
  hints.flowers.forEach((f, i) => {
    const y = f.y + f.stem + 0.04;
    index.sample(f.x, y, f.z, 0.2, s, 2);
    heads.base.set([f.x, y, f.z], i * 3);
    heads.shape.set([0.11, f.rot, f.stem + 0.04, 0], i * 4);
    heads.colA.set([u8(f.petal[0]), u8(f.petal[1]), u8(f.petal[2]), u8(s.sun)], i * 4);
    heads.colB.set([u8(f.center[0]), u8(f.center[1]), u8(f.center[2]), u8(0.9)], i * 4);
  });
  return { blades, grassCount: hints.blades.length, heads };
}

function emptyDecor(): { blades: BladeInstances; grassCount: number; heads: BladeInstances } {
  const none = (): BladeInstances => ({ count: 0, base: new Float32Array(0), shape: new Float32Array(0), colA: new Uint8Array(0), colB: new Uint8Array(0) });
  return { blades: none(), grassCount: 0, heads: none() };
}

/** 形状データの点群の索引（色の写し元が変わらなければ使い回す） */
export function buildPointIndex(colorSrc: SplatPointSet): PointIndex {
  return new PointIndex(colorSrc, 0.25);
}

/** 浮き島全体をポリゴンメッシュにする */
export function buildPixelMeshWorld(layout: IslandLayout, index: PointIndex, hints: MeshHints, opt: PixelMeshWorldOptions, indexMs = 0): PixelMeshWorld {
  const t0 = performance.now();
  const paint = colorizer(index, 0.22);
  const terrain = buildTerrain(layout, opt.detail * 1.8, paint);
  const t1 = performance.now();
  const { objects, trunks } = buildObjects(layout, opt.detail, paint, opt.hybrid);
  const t2 = performance.now();
  const clouds = buildClouds(hints, paint);
  // hybrid では草花を C の円盤で描くので、葉の帯・花の頭は作らない（空のインスタンス）
  const decor = opt.hybrid ? emptyDecor() : buildDecor(hints, index);
  const t3 = performance.now();
  return {
    terrain, objects, trunks, clouds, ...decor, detail: opt.detail,
    buildMs: t3 - t0 + indexMs,
    phases: { index: indexMs, terrain: t1 - t0, objects: t2 - t1, decor: t3 - t2 },
  };
}

// ---------------- キャラクター ----------------

export interface PixelMeshCharacter {
  mesh: TriMesh;
  cell: number;
  buildMs: number;
}

/**
 * キャラクター：部位 SDF（方式 B・C の SDF 生成・方式 D のボクセル化と同じ関数）を部位ごとに三角形にする。
 * 1 部位 = 1 ボーンなので、ボーン行列で剛体として動かせる（位置はボーン支点からの相対座標で持つ）。
 * 部位どうしのなめらかなつなぎ（smin）は、部位を別々の剛体にするため使わない（関節は重なりで隠す）。
 */
export function buildPixelMeshCharacter(cell: number): PixelMeshCharacter {
  const t0 = performance.now();
  const mb = new MeshBuilder();
  const box: Box3Like = { min: [-0.42, -0.08, -0.34], max: [0.42, 1.42, 0.34] };
  for (const part of characterSdfParts()) {
    const pv = BONE_PIVOTS[part.bone];
    surfaceNets(part.d, box, cell, mb, (x, y, z, nx, ny, nz) => {
      const l = Math.hypot(nx, ny, nz) || 1;
      const c = part.color(x, y, z, nx / l, ny / l, nz / l);
      return mb.vertex(x - pv[0], y - pv[1], z - pv[2], nx, ny, nz, u8(c[0]), u8(c[1]), u8(c[2]), 1, 0, part.bone);
    });
  }
  return { mesh: mb.finish(true), cell, buildMs: performance.now() - t0 };
}
