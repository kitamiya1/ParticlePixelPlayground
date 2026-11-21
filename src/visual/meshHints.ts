// 粒だけで表していた草・花・雲の「形の計画」を、粒の生成と同時に書き留める（描画方式 E のポリゴン化用）。
// 記録は乱数を消費しないので、記録の有無で粒（方式 A・B・C・D）の結果は変わらない。

import type { RGB } from '../core/math';

/** 草の葉 1 枚：根元 (x, y, z)、長さ、先端の傾き（粒版と同じ式で曲げる）、根元と先端の色 */
export interface BladeHint {
  x: number; y: number; z: number;
  len: number; leanX: number; leanZ: number;
  base: RGB; tip: RGB;
}

/** 花 1 輪：根元 (x, y, z)、茎の長さ、花びらの色、中心の色、花びらの回転 */
export interface FlowerHint {
  x: number; y: number; z: number;
  stem: number; petal: RGB; center: RGB; rot: number;
}

/** 雲のかたまり 1 個：中心と半径（粒版は縦 0.6 倍の楕円体の表面に粒を並べ、下側 dy < -0.45 を省く） */
export interface CloudLumpHint { x: number; y: number; z: number; r: number }

export interface MeshHints {
  blades: BladeHint[];
  flowers: FlowerHint[];
  cloudLumps: CloudLumpHint[];
}

export function createMeshHints(): MeshHints {
  return { blades: [], flowers: [], cloudLumps: [] };
}
