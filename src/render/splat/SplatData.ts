// 粒データ → Gaussian Splat データへの変換。
// 各スプラットは「位置・色・向き（クォータニオン）・広がり（3 軸のスケール）」を持つ。
// 向きは粒の法線を円盤（サーフェル）の法線 = ローカル +Z 軸に合わせ、ローカル +Y 軸は世界の上方向を
// 円盤面に投影した向きに揃える（異方性の伸ばし方向が「縦」になる）。

import * as THREE from 'three';
import { PackedSplats, utils } from '@sparkjsdev/spark';
import type { CharacterSplatSource } from '../../visual/sdf/sdfObjects';
import type { SplatPointSet } from '../shared/PointSet';

// 点群の型と生成関数は Spark に依存しない共通モジュールへ移した（既存の import 先を保つため再公開する）
export type { SplatPointSet } from '../shared/PointSet';

/** スプラットの基準標準偏差 = 粒サイズ（直径）× この係数（設定の「広がり」で実行時に拡大縮小） */
export const SIGMA_PER_SIZE = 0.34;
/** 1 枚あたりの属性テクスチャ幅 */
export const ATTR_TEX_WIDTH = 2048;

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
