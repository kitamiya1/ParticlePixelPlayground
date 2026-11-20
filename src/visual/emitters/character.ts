// 操作キャラクターの粒モデル。各部位をボーン（0..5）に割り当て、ボーン行列でアニメーションする。
// 粒の座標は「各ボーンの支点からの相対位置」で保持する。

import { hex, scaleRGB, type RGB, type Rng } from '../../core/math';
import type { ParticleBuilder } from '../ParticleBuilder';
import { capsule, ellipsoid, type Emit } from '../shapes';

export const BONE = { body: 0, head: 1, armL: 2, armR: 3, legL: 4, legR: 5 } as const;
export const BONE_COUNT = 6;

/** 各ボーンの静止姿勢での支点（キャラクターのローカル座標、足元が原点、+Z が正面） */
export const BONE_PIVOTS: [number, number, number][] = [
  [0, 0.5, 0], // body
  [0, 0.86, 0], // head
  [0.22, 0.8, 0], // armL
  [-0.22, 0.8, 0], // armR
  [0.09, 0.5, 0], // legL
  [-0.09, 0.5, 0], // legR
];

/** 部位の色（SDF 生成版のキャラクターと共有） */
export const CHARACTER_COLORS = {
  skin: hex('#f3c9a0'),
  hair: hex('#6b3f2a'),
  tunic: hex('#3a8fb7'),
  tunicDark: hex('#2d6f93'),
  scarf: hex('#e0503e'),
  belt: hex('#6b4a2b'),
  pants: hex('#4b3b5c'),
  boots: hex('#3a2a20'),
  eye: hex('#1e1e2a'),
  cheek: hex('#f09a8a'),
};

/** 簡易メッシュ比較用に部位の形も公開する */
export interface CharacterPart {
  bone: number;
  kind: 'ellipsoid' | 'capsule';
  a: [number, number, number];
  b?: [number, number, number];
  r: [number, number, number] | number;
  color: RGB;
}

const C = CHARACTER_COLORS;

export const CHARACTER_PARTS: CharacterPart[] = [
  { bone: BONE.body, kind: 'ellipsoid', a: [0, 0.66, 0], r: [0.19, 0.2, 0.15], color: C.tunic },
  { bone: BONE.head, kind: 'ellipsoid', a: [0, 1.06, 0.01], r: [0.21, 0.2, 0.2], color: C.skin },
  { bone: BONE.armL, kind: 'capsule', a: [0.24, 0.78, 0], b: [0.27, 0.5, 0], r: 0.055, color: C.tunic },
  { bone: BONE.armR, kind: 'capsule', a: [-0.24, 0.78, 0], b: [-0.27, 0.5, 0], r: 0.055, color: C.tunic },
  { bone: BONE.legL, kind: 'capsule', a: [0.09, 0.46, 0], b: [0.09, 0.07, 0], r: 0.07, color: C.pants },
  { bone: BONE.legR, kind: 'capsule', a: [-0.09, 0.46, 0], b: [-0.09, 0.07, 0], r: 0.07, color: C.pants },
];

export function emitCharacter(b: ParticleBuilder, rng: Rng) {
  b.setCategory('キャラクター');
  const sp = 0.042;
  const size = 0.085;
  const put = (bone: number, color: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => RGB): Emit =>
    (x, y, z, nx, ny, nz) => {
      const p = BONE_PIVOTS[bone];
      const c = color(x, y, z, nx, ny, nz);
      b.push(x - p[0], y - p[1], z - p[2], scaleRGB(c, 0.96 + rng() * 0.08), nx, ny, nz, { size, bone });
    };

  // 胴体（チュニック・ベルト・マフラー）
  ellipsoid(0, 0.66, 0, 0.19, 0.2, 0.15, sp, put(BONE.body, (_x, y, _z, _nx, ny) => {
    if (y > 0.8) return C.scarf;
    if (Math.abs(y - 0.53) < 0.03) return C.belt;
    return ny < -0.3 ? C.tunicDark : C.tunic;
  }));
  // マフラーの垂れ
  capsule(0.06, 0.8, -0.14, 0.1, 0.62, -0.2, 0.035, sp, put(BONE.body, () => C.scarf));

  // 頭（髪・目・頬）
  ellipsoid(0, 1.06, 0.01, 0.21, 0.2, 0.2, sp * 0.9, put(BONE.head, (x, y, z, _nx, ny, nz) => {
    const front = nz > 0.55;
    if (front && Math.abs(Math.abs(x) - 0.075) < 0.03 && Math.abs(y - 1.05) < 0.04) return C.eye;
    if (front && Math.abs(Math.abs(x) - 0.12) < 0.035 && Math.abs(y - 0.99) < 0.025) return C.cheek;
    if (ny > 0.25 || nz < -0.2 || (ny > -0.1 && nz < 0.35)) return C.hair;
    if (front && y > 1.14) return C.hair; // 前髪
    return C.skin;
  }));
  // 頭頂のアホ毛
  capsule(0, 1.25, 0.02, -0.04, 1.33, -0.03, 0.025, sp, put(BONE.head, () => C.hair));

  // 腕（袖 + 手）
  for (const [bone, sx] of [[BONE.armL, 1], [BONE.armR, -1]] as const) {
    capsule(0.24 * sx, 0.78, 0, 0.27 * sx, 0.53, 0, 0.055, sp, put(bone, (_x, y) => (y < 0.56 ? C.skin : C.tunic)));
  }
  // 脚（ズボン + ブーツ）
  for (const [bone, sx] of [[BONE.legL, 1], [BONE.legR, -1]] as const) {
    capsule(0.09 * sx, 0.46, 0, 0.09 * sx, 0.07, 0.02, 0.068, sp, put(bone, (_x, y) => (y < 0.17 ? C.boots : C.pants)));
    ellipsoid(0.09 * sx, 0.05, 0.05, 0.075, 0.05, 0.11, sp, put(bone, () => C.boots));
  }
}
