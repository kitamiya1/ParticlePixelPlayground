// 水槽ゲームの寸法の定数（ワールドの定義・水槽台と配管の定義の両方が使う。循環 import を避けるため別ファイル）。
// AquariumWorld からも同じ名前で再公開しているので、既存の import { TANK } from './AquariumWorld' はそのまま使える。

/** 水槽の内寸（ワールド単位。カニの甲羅の幅が約 0.6） */
export const TANK = {
  minX: -18,
  maxX: 18,
  minZ: -10,
  maxZ: 10,
  floorY: 0,
  topY: 13,
  /** 水面の高さ（全域で一定） */
  waterY: 5.5,
  /** ガラスの厚み（見た目用） */
  glass: 0.22,
} as const;

/** 水槽の照明の向き（光が来る向き。真上からやや手前） */
export const LAMP_DIR: [number, number, number] = (() => {
  const v = [0.22, 1, 0.3];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as [number, number, number];
})();
