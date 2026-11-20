// 樹木。Placement から「形の計画 (TreePlan)」を作り、それを粒・簡易メッシュ・影の遮蔽物の 3 用途で共有する。

import { hex, mixRGB, mulberry32, noise3, pick, scaleRGB, type RGB, type Rng } from '../../core/math';
import type { Placement } from '../../world/IslandLayout';
import type { ParticleBuilder } from '../ParticleBuilder';
import type { SphereOccluder } from '../ShadowBaker';
import { capsule, cone, fibonacciSphere } from '../shapes';

export interface TreeBlob { x: number; y: number; z: number; r: number }
export interface TreeCone { y: number; r: number; h: number }

export interface TreePlan {
  x: number; y: number; z: number;
  variant: string;
  trunkH: number;
  trunkR: number;
  bend: [number, number];
  blobs: TreeBlob[];
  cones: TreeCone[];
  leaf: RGB[];
  bark: RGB[];
  seed: number;
}

const PALETTES: Record<string, { leaf: string[]; bark: string[] }> = {
  broadleaf: { leaf: ['#7cc657', '#5fae4b', '#4b9443', '#3c7c3b', '#92d063'], bark: ['#6e4a32', '#5d3d2a', '#7c5639'] },
  blossom: { leaf: ['#f7b6cf', '#ee97b9', '#ffd3e2', '#e07ea6', '#fbe4ec'], bark: ['#5a3a30', '#4b2f28', '#6b463a'] },
  conifer: { leaf: ['#3f8a52', '#2f6b45', '#4f9c5c', '#26573b'], bark: ['#5e4030', '#4f3527'] },
};

export function planTree(p: Placement): TreePlan {
  const rng = mulberry32(p.seed);
  const s = p.scale;
  const pal = PALETTES[p.variant] ?? PALETTES.broadleaf;
  const plan: TreePlan = {
    x: p.x, y: p.y, z: p.z,
    variant: p.variant,
    trunkH: (p.variant === 'conifer' ? 1.1 : 2.2 + rng() * 0.8) * s,
    trunkR: (p.variant === 'conifer' ? 0.26 : 0.3) * s,
    bend: [(rng() - 0.5) * 0.5 * s, (rng() - 0.5) * 0.5 * s],
    blobs: [],
    cones: [],
    leaf: pal.leaf.map(hex),
    bark: pal.bark.map(hex),
    seed: p.seed,
  };
  if (p.variant === 'conifer') {
    const layers = 4;
    for (let k = 0; k < layers; k++) {
      const f = k / layers;
      plan.cones.push({ y: plan.trunkH * 0.6 + k * 0.95 * s, r: (1.9 - f * 1.5) * s, h: (1.7 - f * 0.3) * s });
    }
  } else {
    const topX = p.x + plan.bend[0], topZ = p.z + plan.bend[1];
    const cy = p.y + plan.trunkH + 0.7 * s;
    const mainR = (1.5 + rng() * 0.3) * s;
    plan.blobs.push({ x: topX, y: cy, z: topZ, r: mainR });
    const n = 4 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.6 + p.rotY;
      const d = mainR * (0.75 + rng() * 0.25);
      plan.blobs.push({
        x: topX + Math.cos(a) * d,
        y: cy + (rng() - 0.6) * mainR * 0.8,
        z: topZ + Math.sin(a) * d,
        r: mainR * (0.55 + rng() * 0.25),
      });
    }
    plan.blobs.push({ x: topX + (rng() - 0.5) * 0.4, y: cy + mainR * 0.75, z: topZ + (rng() - 0.5) * 0.4, r: mainR * 0.7 });
  }
  return plan;
}

function trunkPoint(plan: TreePlan, f: number): [number, number, number] {
  const k = f * f;
  return [plan.x + plan.bend[0] * k, plan.y + plan.trunkH * f, plan.z + plan.bend[1] * k];
}

export function emitTree(b: ParticleBuilder, plan: TreePlan, rng: Rng) {
  b.setCategory('樹木');
  const sp = 0.075;
  // 幹（根元を広げる）
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const f0 = i / segs, f1 = (i + 1) / segs;
    const a = trunkPoint(plan, f0), c = trunkPoint(plan, f1);
    const flare = 1 + 0.7 * Math.exp(-f0 * plan.trunkH * 3);
    const r = plan.trunkR * flare * (1 - f0 * 0.35);
    capsule(a[0], a[1], a[2], c[0], c[1], c[2], r, sp, (x, y, z, nx, ny, nz) => {
      if (y < plan.y - 0.1) return;
      const streak = noise3(x * 2, y * 9, z * 2, plan.seed) * 0.5 + 0.5;
      b.push(x, y, z, scaleRGB(pick(plan.bark, streak), 0.9 + rng() * 0.15), nx, ny, nz, { size: 0.12 });
    });
  }

  // 枝：幹の上部から各樹冠へ
  const top = trunkPoint(plan, 0.85);
  for (const bl of plan.blobs.slice(1, 4)) {
    capsule(top[0], top[1], top[2], (top[0] + bl.x) / 2, (top[1] + bl.y) / 2, (top[2] + bl.z) / 2, plan.trunkR * 0.35, sp, (x, y, z, nx, ny, nz) => {
      b.push(x, y, z, pick(plan.bark, rng()), nx, ny, nz, { size: 0.1 });
    });
  }

  const leafSize = 0.21;
  const ls = 0.13;
  // 樹冠（ふくらみのある球の殻）
  for (let bi = 0; bi < plan.blobs.length; bi++) {
    const bl = plan.blobs[bi];
    for (const layer of [1, 0.82]) {
      const rr = bl.r * layer;
      const n = Math.round((4 * Math.PI * rr * rr) / (ls * ls) * (layer < 1 ? 0.45 : 1));
      fibonacciSphere(n, (dx, dy, dz) => {
        const lump = noise3(dx * 2.2 + bl.x, dy * 2.2 + bi, dz * 2.2 + bl.z, plan.seed) * 0.22 * bl.r;
        const r = rr + lump + (rng() - 0.5) * 0.06;
        const x = bl.x + dx * r, y = bl.y + dy * r * 0.88, z = bl.z + dz * r;
        // 他の樹冠に埋もれる粒は省く
        for (let k = 0; k < plan.blobs.length; k++) {
          if (k === bi) continue;
          const o = plan.blobs[k];
          if (Math.hypot(x - o.x, (y - o.y) / 0.88, z - o.z) < o.r * 0.86) return;
        }
        const tone = dy * 0.45 + (dx * 0.2 - dz * 0.1) + noise3(x * 1.5, y * 1.5, z * 1.5, plan.seed + 1) * 0.6;
        const idx = tone > 0.45 ? 4 : tone > 0.15 ? 0 : tone > -0.2 ? 1 : tone > -0.5 ? 2 : 3;
        let c = plan.leaf[Math.min(idx, plan.leaf.length - 1)];
        if (layer < 1) c = scaleRGB(c, 0.7);
        if (plan.variant === 'blossom' && rng() < 0.06) c = hex('#ffffff');
        // 法線は樹冠の中心と粒の向きの中間（柔らかい陰影）
        const hNorm = ((y - plan.y) / (plan.trunkH + bl.r * 2));
        b.push(x, y, z, c, dx, dy * 1.1 + 0.15, dz, { size: leafSize, wind: 0.25 + 0.25 * Math.min(1, hNorm) });
      });
    }
  }

  // 針葉樹の円錐
  for (let ci = 0; ci < plan.cones.length; ci++) {
    const cn = plan.cones[ci];
    const by = plan.y + cn.y;
    cone(plan.x, by, plan.z, cn.r, cn.h, ls, (x, y, z, nx, ny, nz) => {
      const jag = noise3(x * 3, y * 3, z * 3, plan.seed) * 0.12;
      const fx = x + nx * jag, fz = z + nz * jag;
      const tone = ny * 0.5 + nx * 0.25 - nz * 0.1 + (rng() - 0.5) * 0.5 + ((y - by) / cn.h) * 0.3;
      const c = tone > 0.5 ? plan.leaf[2] : tone > 0.2 ? plan.leaf[0] : tone > -0.1 ? plan.leaf[1] : plan.leaf[3];
      b.push(fx, y, fz, ny < 0 ? scaleRGB(c, 0.6) : c, nx, ny + 0.2, nz, { size: leafSize * 0.95, wind: 0.2 + 0.15 * ci / plan.cones.length });
    });
  }
}

export function treeOccluders(plan: TreePlan): SphereOccluder[] {
  const out: SphereOccluder[] = plan.blobs.map((b) => ({ x: b.x, y: b.y, z: b.z, r: b.r * 0.92 }));
  for (const c of plan.cones) out.push({ x: plan.x, y: plan.y + c.y + c.h * 0.32, z: plan.z, r: c.r * 0.7 });
  return out;
}

export const leafMix = (a: RGB, b: RGB, t: number) => mixRGB(a, b, t);
