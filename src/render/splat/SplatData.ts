// 粒データ → Gaussian Splat データへの変換。
// 各スプラットは「位置・色・向き（クォータニオン）・広がり（3 軸のスケール）」を持つ。
// 向きは粒の法線を円盤（サーフェル）の法線 = ローカル +Z 軸に合わせ、ローカル +Y 軸は世界の上方向を
// 円盤面に投影した向きに揃える（異方性の伸ばし方向が「縦」になる）。

import * as THREE from 'three';
import { PackedSplats, utils } from '@sparkjsdev/spark';
import { mulberry32 } from '../../core/math';
import type { ParticleBuilder } from '../../visual/ParticleBuilder';
import type { CharacterSplatSource } from '../../visual/sdf/sdfObjects';

/** スプラットの基準標準偏差 = 粒サイズ（直径）× この係数（設定の「広がり」で実行時に拡大縮小） */
export const SIGMA_PER_SIZE = 0.34;
/** 1 枚あたりの属性テクスチャ幅 */
export const ATTR_TEX_WIDTH = 2048;

/** スプラット化する前の点群（CPU 側。破棄・再生成時に再利用する） */
export interface SplatPointSet {
  count: number;
  pos: Float32Array;
  /** 0..255 の RGB */
  col: Uint8Array;
  nrm: Float32Array;
  size: Float32Array;
  wind: Float32Array;
  /** 焼き込んだ日照（0..1） */
  sun: Float32Array;
}

/** 粒ジオメトリから点群を取り出す。excludeCats に含まれるカテゴリの粒は除く */
export function pointSetFromGeometry(g: THREE.BufferGeometry, excludeCats: string[] = []): SplatPointSet {
  const pos = g.getAttribute('position').array as Float32Array;
  const col = g.getAttribute('aColor').array as Uint8Array;
  const nrm = g.getAttribute('normal').array as Int8Array;
  const misc = g.getAttribute('aMisc').array as Float32Array;
  const n = g.getAttribute('position').count;
  const cat = g.userData.cat as Uint8Array | undefined;
  const names = (g.userData.catNames as string[] | undefined) ?? [];
  const excl = new Set(excludeCats.map((c) => names.indexOf(c)).filter((i) => i >= 0));
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (!cat || !excl.has(cat[i])) keep.push(i);
  const m = keep.length;
  const out = allocPointSet(m);
  for (let o = 0; o < m; o++) {
    const i = keep[o];
    for (let k = 0; k < 3; k++) {
      out.pos[o * 3 + k] = pos[i * 3 + k];
      out.col[o * 3 + k] = col[i * 3 + k];
      out.nrm[o * 3 + k] = nrm[i * 3 + k] / 127;
    }
    out.size[o] = misc[i * 3];
    out.wind[o] = misc[i * 3 + 1];
    out.sun[o] = misc[i * 3 + 2];
  }
  return out;
}

export function pointSetFromBuilder(b: ParticleBuilder): SplatPointSet {
  const n = b.count;
  const out = allocPointSet(n);
  for (let i = 0; i < n * 3; i++) {
    out.pos[i] = b.pos[i];
    out.col[i] = b.col[i];
    out.nrm[i] = b.nrm[i] / 127;
  }
  for (let i = 0; i < n; i++) {
    out.size[i] = b.misc[i * 3];
    out.wind[i] = b.misc[i * 3 + 1];
    out.sun[i] = b.misc[i * 3 + 2];
  }
  return out;
}

function allocPointSet(n: number): SplatPointSet {
  return {
    count: n,
    pos: new Float32Array(n * 3),
    col: new Uint8Array(n * 3),
    nrm: new Float32Array(n * 3),
    size: new Float32Array(n),
    wind: new Float32Array(n),
    sun: new Float32Array(n),
  };
}

/** 点群をつなげてシャッフルする（先頭から N 個描けば全体から均一に間引ける） */
export function mergeAndShuffle(sets: SplatPointSet[], seed = 3): SplatPointSet {
  const n = sets.reduce((a, s) => a + s.count, 0);
  const out = allocPointSet(n);
  let o = 0;
  for (const s of sets) {
    out.pos.set(s.pos, o * 3);
    out.col.set(s.col, o * 3);
    out.nrm.set(s.nrm, o * 3);
    out.size.set(s.size, o);
    out.wind.set(s.wind, o);
    out.sun.set(s.sun, o);
    o += s.count;
  }
  const rng = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    for (let k = 0; k < 3; k++) {
      swap(out.pos, i * 3 + k, j * 3 + k);
      swap(out.col, i * 3 + k, j * 3 + k);
      swap(out.nrm, i * 3 + k, j * 3 + k);
    }
    swap(out.size, i, j);
    swap(out.wind, i, j);
    swap(out.sun, i, j);
  }
  return out;
}

function swap(a: Float32Array | Uint8Array, i: number, j: number) {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

/** 法線 n を +Z、世界の上方向の投影を +Y とする回転 */
function orientFromNormal(nx: number, ny: number, nz: number, out: THREE.Quaternion) {
  _n.set(nx, ny, nz);
  if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
  _n.normalize();
  const ref = Math.abs(_n.y) > 0.95 ? FWD : UP;
  _x.crossVectors(ref, _n).normalize();
  _y.crossVectors(_n, _x);
  _m.makeBasis(_x, _y, _n);
  out.setFromRotationMatrix(_m);
}

/** 点群 → PackedSplats（基準スケールは等方。平たさ・異方性は実行時のモディファイアで掛ける） */
export function packPointSet(set: SplatPointSet): PackedSplats {
  const n = set.count;
  const packed = new PackedSplats({ maxSplats: n });
  const arr = packed.ensureSplats(n);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    orientFromNormal(set.nrm[i3], set.nrm[i3 + 1], set.nrm[i3 + 2], _q);
    const s = Math.max(1e-4, set.size[i] * SIGMA_PER_SIZE);
    utils.setPackedSplat(arr, i, set.pos[i3], set.pos[i3 + 1], set.pos[i3 + 2], s, s, s, _q.x, _q.y, _q.z, _q.w, 1, set.col[i3] / 255, set.col[i3 + 1] / 255, set.col[i3 + 2] / 255);
  }
  packed.numSplats = n;
  packed.needsUpdate = true;
  return packed;
}

/** 点ごとの付加情報（R: 焼き込み日照, G: 風の影響度）をスプラット番号で引けるテクスチャにする */
export function attrTexture(set: SplatPointSet): THREE.DataTexture {
  const n = set.count;
  const h = Math.max(1, Math.ceil(n / ATTR_TEX_WIDTH));
  const data = new Uint8Array(ATTR_TEX_WIDTH * h * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round(Math.min(1, Math.max(0, set.sun[i])) * 255);
    data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, set.wind[i])) * 255);
  }
  const tex = new THREE.DataTexture(data, ATTR_TEX_WIDTH, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** キャラクター（静止姿勢）→ PackedSplats */
export function packCharacter(src: CharacterSplatSource): PackedSplats {
  const n = src.count;
  const packed = new PackedSplats({ maxSplats: n });
  const arr = packed.ensureSplats(n);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    orientFromNormal(src.nrm[i3], src.nrm[i3 + 1], src.nrm[i3 + 2], _q);
    const s = Math.max(1e-4, src.size[i] * SIGMA_PER_SIZE);
    utils.setPackedSplat(arr, i, src.pos[i3], src.pos[i3 + 1], src.pos[i3 + 2], s, s, s, _q.x, _q.y, _q.z, _q.w, 1, src.col[i3] / 255, src.col[i3 + 1] / 255, src.col[i3 + 2] / 255);
  }
  packed.numSplats = n;
  packed.needsUpdate = true;
  return packed;
}
