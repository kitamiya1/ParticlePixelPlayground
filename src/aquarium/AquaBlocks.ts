// 積み木・物理パズルの検証エリア（ハサミ集中モードの遊びの土台。2026-11-28）。
// 砂の平らな所に、形の違う箱の物（PropKind block / slab / rod / pillar。剛体：AquaGrab の PropSystem.stepBox）を並べる。
// - 積み木（10 cm の立方体）6 個：積む・並べる
// - 石の台 2 個（重い。1 本のハサミでは持ち上がらない）：間に細長い棒を渡して橋にする
// - 細長い棒 2 本（42 cm）・平たい石 2 枚（30 × 20 × 5 cm）：橋・足場（カニが乗れる。カニの当たり判定に箱が入る）
// 置いた物・組み立てた状態は保存する（保存の版 4：tanks[id].props）。読み込んだ位置が水槽の外・固体の中なら置いた所へ戻す。

import { PROP_KIND, type Prop, type PropKind, type PropSystem } from './AquaGrab';
import type { PropSave } from './AquaSave';
import type { AquariumWorld } from './AquariumWorld';

/** 並べ方（中心からのずれ x, z・種類・向き） */
const LAYOUT: [number, number, PropKind, number][] = [
  [-0.62, 0, 'block', 0.1],
  [-0.38, 0.02, 'block', -0.2],
  [-0.14, -0.02, 'block', 0.3],
  [0.12, 0.03, 'block', 0],
  [0.36, -0.02, 'block', 0.5],
  [0.6, 0.01, 'block', -0.1],
  [-0.26, 0.62, 'pillar', 0],
  [0.26, 0.62, 'pillar', 0],
  [-0.42, -0.52, 'slab', 0.2],
  [0.42, -0.52, 'slab', -0.15],
  [0, -0.95, 'rod', 0.05],
  [0.05, 1.05, 'rod', -0.1],
];

/** 検証エリアの物の id（保存の id） */
export const blockId = (i: number, kind: PropKind) => `area-${kind}-${i}`;

/**
 * 検証エリアの物を置く（cx, cz = エリアの中心。yaw = エリアの向き）。保存する印を付ける。
 * 先に平らな石の床（動かない箱。上面は床の下の砂のいちばん高い所より少し上・下面は砂に埋まる）を置き、その上に並べる
 */
export function addBlocks(props: PropSystem, world: AquariumWorld, cx: number, cz: number, yaw = 0): { list: Prop[]; floor: Prop } {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const fs = PROP_KIND.floor.semi;
  let top = -Infinity;
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
    const lx = (i / 4) * fs[0], lz = (j / 4) * fs[2];
    top = Math.max(top, world.groundAt(cx + lx * c + lz * s, cz - lx * s + lz * c));
  }
  top += 0.035;
  const floor = props.addFixed('area-floor', 'floor', [cx, top - fs[1], cz], fs, yaw);
  const list = LAYOUT.map(([dx, dz, kind, a], i) => {
    const x = cx + dx * c + dz * s, z = cz - dx * s + dz * c;
    const pr = props.add(blockId(i, kind), kind, x, z, top + 0.4, 1, yaw + a);
    pr.save = true;
    return pr;
  });
  return { list, floor };
}

/** 床の上面の四隅（世界。植物・小石を床の下に隠す範囲） */
export function floorRect(floor: Prop): { x0: number; x1: number; z0: number; z1: number; top: number } {
  const [a, b, c] = floor.semi;
  // （向きは y 軸まわりだけ。外接する矩形）
  const yaw = 2 * Math.atan2(floor.q[1], floor.q[3]);
  const ex = Math.abs(Math.cos(yaw)) * a + Math.abs(Math.sin(yaw)) * c, ez = Math.abs(Math.sin(yaw)) * a + Math.abs(Math.cos(yaw)) * c;
  return { x0: floor.p[0] - ex, x1: floor.p[0] + ex, z0: floor.p[2] - ez, z1: floor.p[2] + ez, top: floor.p[1] + b };
}

/** 保存する形（位置・向き） */
export function blocksToSave(list: readonly Prop[]): PropSave[] {
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return list.map((p) => ({ id: p.id, x: r(p.p[0]), y: r(p.p[1]), z: r(p.p[2]), q: [r(p.q[0]), r(p.q[1]), r(p.q[2]), r(p.q[3])] }));
}

/** 保存から戻す（知らない id は無視。戻した数を返す） */
export function restoreBlocks(props: PropSystem, list: readonly Prop[], saved: readonly PropSave[]): number {
  let n = 0;
  for (const s of saved) {
    const pr = list.find((p) => p.id === s.id);
    if (!pr) continue;
    props.place(pr, [s.x, s.y, s.z], s.q);
    n++;
  }
  return n;
}

/** 置いた所へ並べ直す（設定・検証用） */
export function resetBlocks(props: PropSystem, list: readonly Prop[]) {
  for (const p of list) props.reset(p);
}
