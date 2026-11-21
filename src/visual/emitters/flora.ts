// 草・草花・崖から垂れるツタ。どれも風で揺れる（wind 属性）。

import { fbm2, hash2, hex, mixRGB, pick, scaleRGB, type RGB, type Rng } from '../../core/math';
import type { IslandLayout, Placement } from '../../world/IslandLayout';
import type { ParticleBuilder } from '../ParticleBuilder';
import type { MeshHints } from '../meshHints';

const BLADE_BASE: RGB[] = ['#3f7d3a', '#4a8a3e', '#457f36'].map(hex);
const BLADE_TIP: RGB[] = ['#8cc95c', '#a5d36a', '#79bb52', '#b9d877'].map(hex);

export const FLOWER_COLORS: Record<string, RGB[]> = {
  white: ['#f6f4ea', '#e9e6dc'].map(hex),
  yellow: ['#f6d548', '#f0c03a'].map(hex),
  pink: ['#f4a3c0', '#e889b0'].map(hex),
  violet: ['#a985d8', '#8d6bc6'].map(hex),
  red: ['#e2513f', '#c93f3a'].map(hex),
  blue: ['#6aa4e8', '#5288d6'].map(hex),
};

/** 草むら：島全体に房を散らす（hints があれば葉 1 枚ごとの形を記録する。乱数は消費しない） */
export function emitGrass(b: ParticleBuilder, layout: IslandLayout, rng: Rng, hints?: MeshHints) {
  b.setCategory('草花');
  const t = layout.terrain;
  const R = t.cfg.radius * 1.1;
  const step = 0.42;
  for (let z = -R; z < R; z += step) {
    for (let x = -R; x < R; x += step) {
      const px = x + (rng() - 0.5) * step, pz = z + (rng() - 0.5) * step;
      if (t.mask(px, pz) > 0.97) continue;
      if (t.pathSignedDistance(px, pz) < 0.25) continue;
      const meadow = fbm2(px * 0.09, pz * 0.09, 3, 51) * 0.5 + 0.5;
      if (rng() > 0.35 + meadow * 0.6) continue;
      if (layout.colliders.some((c) => Math.hypot(c.x - px, c.z - pz) < c.r * 0.9)) continue;
      const base = t.heightRaw(px, pz);
      const blades = 2 + Math.floor(rng() * 4);
      const tall = 0.7 + meadow * 0.6;
      for (let k = 0; k < blades; k++) {
        const bx = px + (rng() - 0.5) * 0.22, bz = pz + (rng() - 0.5) * 0.22;
        const len = (0.14 + rng() * 0.28) * tall;
        const lean = (rng() - 0.5) * 0.25, leanZ = (rng() - 0.5) * 0.25;
        const segs = Math.max(2, Math.round(len / 0.065));
        const baseC = pick(BLADE_BASE, rng());
        const tipC = pick(BLADE_TIP, rng());
        hints?.blades.push({ x: bx, y: base, z: bz, len, leanX: lean, leanZ, base: baseC, tip: tipC });
        // 葉ごとの順位（方式 F の間引き用）。乱数列を消費しないよう、根元の位置のハッシュで決める
        const grassRank = hash2(Math.round(bx * 997), Math.round(bz * 991), 4243);
        for (let sgi = 1; sgi <= segs; sgi++) {
          const f = sgi / segs;
          const c = mixRGB(baseC, tipC, f);
          b.push(bx + lean * f * f * len * 2, base + len * f, bz + leanZ * f * f * len * 2, c, lean, 1, leanZ, {
            size: 0.1 - f * 0.02,
            wind: Math.pow(f, 1.4),
            grassRank,
          });
        }
      }
    }
  }
}

/** 草花の群生（hints があれば花 1 輪ごとの形を記録する。乱数は消費しない） */
export function emitFlowerPatch(b: ParticleBuilder, layout: IslandLayout, p: Placement, rng: Rng, hints?: MeshHints) {
  b.setCategory('草花');
  const t = layout.terrain;
  const cols = FLOWER_COLORS[p.variant] ?? FLOWER_COLORS.white;
  const count = Math.round(p.scale * p.scale * 9);
  const center = hex('#f7d64a');
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * p.scale;
    const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
    if (t.mask(x, z) > 0.96 || t.pathSignedDistance(x, z) < 0.3) continue;
    const base = t.heightRaw(x, z);
    const stem = 0.18 + rng() * 0.22;
    const stemC = hex('#4b8a3c');
    const segs = Math.round(stem / 0.06);
    for (let s = 1; s <= segs; s++) {
      const f = s / segs;
      b.push(x, base + stem * f, z, stemC, 0, 1, 0, { size: 0.07, wind: Math.pow(f, 1.3) * 0.9 });
    }
    const hy = base + stem + 0.04;
    const pc = pick(cols, rng());
    const petal = 0.065;
    const rot = rng() * Math.PI;
    for (let k = 0; k < 5; k++) {
      const pa = rot + (k / 5) * Math.PI * 2;
      b.push(x + Math.cos(pa) * petal, hy, z + Math.sin(pa) * petal, pc, 0, 1, 0, { size: 0.085, wind: 1 });
    }
    const cc = p.variant === 'yellow' ? hex('#e07b2e') : center;
    b.push(x, hy + 0.015, z, cc, 0, 1, 0, { size: 0.08, wind: 1 });
    hints?.flowers.push({ x, y: base, z, stem, petal: pc, center: cc, rot });
  }
}

/** 島の縁から垂れ下がるツタ */
export function emitVines(b: ParticleBuilder, layout: IslandLayout, rng: Rng) {
  b.setCategory('草花');
  const t = layout.terrain;
  const leaf: RGB[] = ['#4f8f3f', '#3d7536', '#69a84a'].map(hex);
  for (let k = 0; k < 70; k++) {
    const th = rng() * Math.PI * 2;
    const er = t.edgeRadius(th);
    const ix = Math.cos(th) * er * 0.985, iz = Math.sin(th) * er * 0.985;
    const top = t.heightRaw(ix, iz);
    const len = 0.8 + rng() * rng() * 4;
    const ox = Math.cos(th) * (er + 0.12), oz = Math.sin(th) * (er + 0.12);
    const segs = Math.round(len / 0.07);
    const ph = rng() * 6;
    for (let s = 0; s < segs; s++) {
      const f = s / segs;
      const y = top - s * 0.07;
      const wob = Math.sin(f * 7 + ph) * 0.08;
      const c = scaleRGB(pick(leaf, rng()), 1 - f * 0.25);
      const x = ox + Math.cos(th) * f * 0.25 - Math.sin(th) * wob;
      const z = oz + Math.sin(th) * f * 0.25 + Math.cos(th) * wob;
      b.push(x, y, z, c, Math.cos(th), 0.3, Math.sin(th), { size: 0.11, wind: 0.25 + f * 0.75 });
      if (rng() < 0.3) {
        b.push(x - Math.sin(th) * 0.07, y, z + Math.cos(th) * 0.07, pick(leaf, rng()), Math.cos(th), 0.3, Math.sin(th), { size: 0.1, wind: 0.3 + f * 0.7 });
      }
    }
  }
}
