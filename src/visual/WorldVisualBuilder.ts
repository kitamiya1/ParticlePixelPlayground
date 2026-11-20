// レイアウト（ゲームデータ）から、粒のジオメトリと比較用の簡易メッシュを組み立てる。

import * as THREE from 'three';
import { hex, mulberry32 } from '../core/math';
import type { IslandLayout } from '../world/IslandLayout';
import { ParticleBuilder } from './ParticleBuilder';
import { bakeSunShadows, type SphereOccluder } from './ShadowBaker';
import { emitCharacter } from './emitters/character';
import { emitGrass, emitVines } from './emitters/flora';
import { emitClouds } from './emitters/rock';
import { emitTerrain } from './emitters/terrain';
import { getVisual } from './registry';

/** 太陽の方向（ワールド座標、光が来る向き） */
export const SUN_DIR: [number, number, number] = (() => {
  const v = [-0.45, 0.78, 0.43];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as [number, number, number];
})();

export interface WorldVisuals {
  world: THREE.BufferGeometry;
  character: THREE.BufferGeometry;
  categories: Map<string, number>;
  proxies: THREE.Group;
  buildMs: number;
}

export function buildWorldVisuals(layout: IslandLayout, seed = 1): WorldVisuals {
  const t0 = performance.now();
  const rng = mulberry32(seed);
  const b = new ParticleBuilder(1 << 19);
  const ctx = { layout, rng };
  const occluders: SphereOccluder[] = [];
  const proxies = new THREE.Group();

  emitTerrain(b, layout.terrain, rng);
  emitGrass(b, layout, rng);
  emitVines(b, layout, rng);
  for (const p of layout.placements) {
    const v = getVisual(p.kind);
    if (!v) {
      console.warn(`未登録のオブジェクト種別: ${p.kind}`);
      continue;
    }
    const plan = v.plan(p);
    v.emit(b, plan, ctx);
    if (v.occluders) occluders.push(...v.occluders(plan));
    if (v.proxy) proxies.add(v.proxy(plan));
  }
  emitClouds(b, rng);
  bakeSunShadows(b, layout.terrain, occluders, SUN_DIR);
  b.shuffle(rng);
  proxies.add(buildTerrainProxy(layout));

  const cb = new ParticleBuilder(1 << 12, true);
  emitCharacter(cb, rng);

  const categories = new Map(b.categories);
  for (const [k, v] of cb.categories) categories.set(k, v);
  return { world: b.toGeometry(), character: cb.toGeometry(), categories, proxies, buildMs: performance.now() - t0 };
}

/** 比較用：地形の簡易メッシュ（高さ場の上面 + 円錐の底） */
function buildTerrainProxy(layout: IslandLayout): THREE.Object3D {
  const t = layout.terrain;
  const R = t.cfg.radius * 1.1;
  const cell = 0.5;
  const n = Math.ceil((R * 2) / cell);
  const pos: number[] = [];
  const col: number[] = [];
  const grass = hex('#5c9e45'), stone = hex('#b9b1a2');
  const vtx = (x: number, z: number) => {
    pos.push(x, t.heightRaw(x, z), z);
    const c = t.pathWeight(x, z) > 0.5 ? stone : grass;
    const lc = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    col.push(lc.r, lc.g, lc.b);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -R + i * cell, z0 = -R + j * cell, x1 = x0 + cell, z1 = z0 + cell;
      if (!(t.isInside(x0, z0) && t.isInside(x1, z0) && t.isInside(x0, z1) && t.isInside(x1, z1))) continue;
      vtx(x0, z0); vtx(x0, z1); vtx(x1, z0);
      vtx(x1, z0); vtx(x0, z1); vtx(x1, z1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const group = new THREE.Group();
  const top = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  top.receiveShadow = true;
  group.add(top);
  const under = new THREE.Mesh(new THREE.ConeGeometry(t.cfg.radius * 0.88, 15, 24, 1, true), new THREE.MeshLambertMaterial({ color: '#7a6c62', side: THREE.DoubleSide }));
  under.rotation.x = Math.PI;
  under.position.y = -7;
  group.add(under);
  return group;
}
