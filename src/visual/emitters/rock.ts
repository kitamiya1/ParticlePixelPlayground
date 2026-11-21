// 岩と雲。

import { fbm3, hex, mixRGB, mulberry32, pick, scaleRGB, type RGB, type Rng } from '../../core/math';
import type { Placement } from '../../world/IslandLayout';
import type { Terrain } from '../../world/Terrain';
import type { ParticleBuilder } from '../ParticleBuilder';
import type { SphereOccluder } from '../ShadowBaker';
import { fibonacciSphere } from '../shapes';
import type { MeshHints } from '../meshHints';

export interface RockPlan { x: number; y: number; z: number; rx: number; ry: number; rz: number; rot: number; seed: number }

const ROCK: RGB[] = ['#9a958f', '#86817c', '#aaa59d', '#7a7570'].map(hex);
const MOSS = hex('#6f9a4a');

export function planRock(p: Placement): RockPlan {
  const rng = mulberry32(p.seed);
  const s = p.scale;
  return { x: p.x, y: p.y - 0.15 * s, z: p.z, rx: s * (0.9 + rng() * 0.3), ry: s * (0.55 + rng() * 0.3), rz: s * (0.75 + rng() * 0.3), rot: p.rotY, seed: p.seed };
}

/** 岩の表面上の点（ノイズで歪めた楕円体） */
function rockSurface(r: RockPlan, dx: number, dy: number, dz: number): [number, number, number, number] {
  const d = 1 + 0.28 * fbm3(dx * 1.6, dy * 1.6, dz * 1.6, 3, r.seed);
  const facet = Math.max(Math.abs(dx), Math.abs(dy) * 1.2, Math.abs(dz));
  const k = d * (0.82 + 0.18 / Math.max(0.6, facet)); // 少し角ばらせる
  const c = Math.cos(r.rot), s = Math.sin(r.rot);
  const lx = dx * r.rx * k, lz = dz * r.rz * k;
  return [r.x + lx * c - lz * s, r.y + dy * r.ry * k, r.z + lx * s + lz * c, k];
}

export function emitRock(b: ParticleBuilder, plan: RockPlan, terrain: Terrain, rng: Rng) {
  b.setCategory('岩');
  const sp = 0.1;
  const area = 4 * Math.PI * Math.pow((plan.rx * plan.ry + plan.rx * plan.rz + plan.ry * plan.rz) / 3, 1);
  const n = Math.round((area * 1.3) / (sp * sp));
  const e = 0.05;
  fibonacciSphere(n, (dx, dy, dz) => {
    const [x, y, z] = rockSurface(plan, dx, dy, dz);
    if (y < terrain.heightRaw(x, z) - 0.05) return;
    // 数値微分で法線
    const a = rockSurface(plan, dx + e, dy, dz), bb = rockSurface(plan, dx, dy + e, dz);
    const ux = a[0] - x, uy = a[1] - y, uz = a[2] - z;
    const vx = bb[0] - x, vy = bb[1] - y, vz = bb[2] - z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * (x - plan.x) + ny * (y - plan.y) + nz * (z - plan.z) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const nl = Math.hypot(nx, ny, nz) || 1;
    ny /= nl;
    let c = pick(ROCK, fbm3(x * 2, y * 2, z * 2, 2, plan.seed) * 0.5 + 0.5 + (rng() - 0.5) * 0.2);
    if (ny > 0.55 && fbm3(x * 1.2, 0, z * 1.2, 2, plan.seed + 3) > -0.05) c = mixRGB(c, MOSS, 0.75);
    c = scaleRGB(c, 0.95 + rng() * 0.1);
    b.push(x, y, z, c, nx / nl, ny, nz / nl, { size: 0.16 });
  });
}

export function rockOccluders(plan: RockPlan): SphereOccluder[] {
  return [{ x: plan.x, y: plan.y, z: plan.z, r: Math.max(plan.rx, plan.rz) * 0.8 }];
}

/** 島の周囲・下方に漂う雲（hints があればかたまりの中心と半径を記録する。乱数は消費しない） */
export function emitClouds(b: ParticleBuilder, rng: Rng, hints?: MeshHints) {
  b.setCategory('雲');
  const cols: RGB[] = ['#f6f8ff', '#e8eefb', '#dde6f6'].map(hex);
  const under = hex('#b7c4e0');
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + rng() * 0.3;
    const d = 34 + rng() * 16;
    const cx = Math.cos(a) * d, cz = Math.sin(a) * d, cy = -4 - rng() * 12;
    const lumps = 3 + Math.floor(rng() * 4);
    for (let l = 0; l < lumps; l++) {
      const lx = cx + (rng() - 0.5) * 9, lz = cz + (rng() - 0.5) * 6, ly = cy + (rng() - 0.5) * 1.5;
      const r = 1.8 + rng() * 2.2;
      const n = Math.round((4 * Math.PI * r * r) / 0.16);
      hints?.cloudLumps.push({ x: lx, y: ly, z: lz, r });
      fibonacciSphere(n, (dx, dy, dz) => {
        if (dy < -0.45) return;
        const ry = dy * 0.6;
        const c = dy < 0 ? mixRGB(pick(cols, rng()), under, -dy * 1.6) : pick(cols, rng());
        b.push(lx + dx * r, ly + ry * r, lz + dz * r, c, dx, dy, dz, { size: 0.55, wind: 0 });
      });
    }
  }
}
