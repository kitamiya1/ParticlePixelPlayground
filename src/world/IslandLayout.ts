// 浮き島のレイアウト（配置と当たり判定）。ゲームロジック側のデータで、見た目の生成は visual/ が担当する。

import { mulberry32, pick } from '../core/math';
import { Terrain } from './Terrain';

/** 世界に置かれるオブジェクトの共通データ。kind ごとに visual/registry の生成器が対応する。 */
export interface Placement {
  kind: string;
  variant: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  seed: number;
  /** 当たり判定の半径（0 なら判定なし） */
  colliderRadius: number;
}

export interface CircleCollider {
  x: number;
  z: number;
  r: number;
}

export class IslandLayout {
  readonly terrain: Terrain;
  readonly placements: Placement[] = [];
  readonly colliders: CircleCollider[] = [];
  readonly spawn: { x: number; z: number };

  constructor(seed = 7) {
    this.terrain = new Terrain({
      seed,
      radius: 26,
      cell: 0.25,
      pathPoints: [
        [-21, 5],
        [-14, 3.5],
        [-7, 5],
        [-1, 1],
        [4, -2.5],
        [10, -1],
        [15, 3],
        [20, 4],
      ],
      pathHalfWidth: 0.95,
      plaza: { x: -1, z: 1, r: 3.2 },
    });
    this.spawn = { x: -1, z: 1.5 };
    this.generate(seed);
  }

  private add(p: Omit<Placement, 'y'>) {
    const y = this.terrain.heightAt(p.x, p.z);
    const placed = { ...p, y };
    this.placements.push(placed);
    if (p.colliderRadius > 0) this.colliders.push({ x: p.x, z: p.z, r: p.colliderRadius });
    return placed;
  }

  private tooClose(x: number, z: number, kinds: string[], dist: number): boolean {
    return this.placements.some((p) => kinds.includes(p.kind) && Math.hypot(p.x - x, p.z - z) < dist);
  }

  private generate(seed: number) {
    const rng = mulberry32(seed * 101 + 5);
    const t = this.terrain;
    const R = t.cfg.radius;

    // 樹木
    let tries = 0;
    let trees = 0;
    while (trees < 12 && tries++ < 2000) {
      const x = (rng() * 2 - 1) * R, z = (rng() * 2 - 1) * R;
      if (t.mask(x, z) > 0.78) continue;
      if (t.pathSignedDistance(x, z) < 2.3) continue;
      if (Math.hypot(x - this.spawn.x, z - this.spawn.z) < 5) continue;
      if (this.tooClose(x, z, ['tree'], 4.6)) continue;
      const r = rng();
      const variant = r < 0.55 ? 'broadleaf' : r < 0.82 ? 'conifer' : 'blossom';
      const scale = 0.85 + rng() * 0.45;
      this.add({ kind: 'tree', variant, x, z, rotY: rng() * Math.PI * 2, scale, seed: Math.floor(rng() * 1e9), colliderRadius: 0.38 * scale + 0.15 });
      trees++;
    }

    // 岩
    tries = 0;
    let rocks = 0;
    while (rocks < 16 && tries++ < 2000) {
      const x = (rng() * 2 - 1) * R, z = (rng() * 2 - 1) * R;
      if (t.mask(x, z) > 0.9) continue;
      if (t.pathSignedDistance(x, z) < 0.6) continue;
      if (Math.hypot(x - this.spawn.x, z - this.spawn.z) < 4) continue;
      if (this.tooClose(x, z, ['tree'], 2.2) || this.tooClose(x, z, ['rock'], 2.5)) continue;
      const scale = 0.35 + Math.pow(rng(), 2) * 1.1;
      this.add({ kind: 'rock', variant: 'boulder', x, z, rotY: rng() * Math.PI * 2, scale, seed: Math.floor(rng() * 1e9), colliderRadius: scale * 0.85 });
      rocks++;
    }

    // 草花の群生（当たり判定なし）
    tries = 0;
    let patches = 0;
    const colors = ['white', 'yellow', 'pink', 'violet', 'red', 'blue'];
    while (patches < 30 && tries++ < 2000) {
      const x = (rng() * 2 - 1) * R, z = (rng() * 2 - 1) * R;
      if (t.mask(x, z) > 0.88) continue;
      if (t.pathSignedDistance(x, z) < 0.8) continue;
      if (this.tooClose(x, z, ['flowerPatch'], 3)) continue;
      this.add({ kind: 'flowerPatch', variant: pick(colors, rng()), x, z, rotY: 0, scale: 1 + rng() * 1.6, seed: Math.floor(rng() * 1e9), colliderRadius: 0 });
      patches++;
    }
  }

  /** 当たり判定：円コライダーと島の縁から押し戻した位置を返す */
  resolve(x: number, z: number, radius: number): { x: number; z: number } {
    for (let iter = 0; iter < 2; iter++) {
      for (const c of this.colliders) {
        const dx = x - c.x, dz = z - c.z;
        const d = Math.hypot(dx, dz);
        const min = c.r + radius;
        if (d < min && d > 1e-5) {
          x = c.x + (dx / d) * min;
          z = c.z + (dz / d) * min;
        }
      }
      const limit = 0.94;
      const m = this.terrain.mask(x, z);
      if (m > limit) {
        const s = limit / m;
        x *= s;
        z *= s;
      }
    }
    return { x, z };
  }
}
