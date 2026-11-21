// オブジェクト種別 (Placement.kind) → 見た目の生成器 の対応表。
// 新しいオブジェクトを追加するときは、ここに 1 エントリ登録するだけでよい。

import * as THREE from 'three';
import type { Rng } from '../core/math';
import type { IslandLayout, Placement } from '../world/IslandLayout';
import type { ParticleBuilder } from './ParticleBuilder';
import type { SphereOccluder } from './ShadowBaker';
import type { MeshHints } from './meshHints';
import { emitFlowerPatch } from './emitters/flora';
import { emitRock, planRock, rockOccluders, type RockPlan } from './emitters/rock';
import { emitTree, planTree, treeOccluders, type TreePlan } from './emitters/tree';

export interface VisualContext {
  layout: IslandLayout;
  rng: Rng;
  /** 方式 E のポリゴン化用に形の計画を書き留める先（任意） */
  hints?: MeshHints;
}

export interface ObjectVisual<Plan> {
  /** 配置データから形の計画を作る（粒・メッシュ・影で共有） */
  plan(p: Placement): Plan;
  /** 粒を生成する */
  emit(b: ParticleBuilder, plan: Plan, ctx: VisualContext): void;
  /** 影を落とす遮蔽物 */
  occluders?(plan: Plan): SphereOccluder[];
  /** 比較用の簡易メッシュ */
  proxy?(plan: Plan): THREE.Object3D;
}

const registry = new Map<string, ObjectVisual<unknown>>();

export function registerVisual<P>(kind: string, v: ObjectVisual<P>) {
  registry.set(kind, v as ObjectVisual<unknown>);
}

export function getVisual(kind: string): ObjectVisual<unknown> | undefined {
  return registry.get(kind);
}

const srgb = (c: readonly number[]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
const lambert = (c: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

registerVisual<TreePlan>('tree', {
  plan: planTree,
  emit: (b, plan, ctx) => emitTree(b, plan, ctx.rng),
  occluders: treeOccluders,
  proxy: (plan) => {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(plan.trunkR * 0.7, plan.trunkR * 1.1, plan.trunkH, 8), lambert(srgb(plan.bark[0])));
    trunk.position.set(plan.x + plan.bend[0] * 0.4, plan.y + plan.trunkH / 2, plan.z + plan.bend[1] * 0.4);
    g.add(trunk);
    const leafMat = lambert(srgb(plan.leaf[1]));
    for (const bl of plan.blobs) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(bl.r, 1), leafMat);
      m.position.set(bl.x, bl.y, bl.z);
      m.scale.y = 0.88;
      g.add(m);
    }
    for (const c of plan.cones) {
      const m = new THREE.Mesh(new THREE.ConeGeometry(c.r, c.h, 10), leafMat);
      m.position.set(plan.x, plan.y + c.y + c.h / 2, plan.z);
      g.add(m);
    }
    return g;
  },
});

registerVisual<RockPlan>('rock', {
  plan: planRock,
  emit: (b, plan, ctx) => emitRock(b, plan, ctx.layout.terrain, ctx.rng),
  occluders: rockOccluders,
  proxy: (plan) => {
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), lambert('#8f8a84'));
    m.position.set(plan.x, plan.y, plan.z);
    m.scale.set(plan.rx, plan.ry, plan.rz);
    m.rotation.y = plan.rot;
    return m;
  },
});

registerVisual<Placement>('flowerPatch', {
  plan: (p) => p,
  emit: (b, p, ctx) => emitFlowerPatch(b, ctx.layout, p, ctx.rng, ctx.hints),
});
