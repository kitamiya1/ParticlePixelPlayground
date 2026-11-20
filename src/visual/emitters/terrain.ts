// 浮き島の地形（草地・石畳・崖・岩盤の底）を粒で構築する。
// 上面は高さ場の上に、側面と底は「露出しているボクセル殻」だけに粒を置く。

import { fbm2, hash2, hex, mixRGB, noise2, pick, scaleRGB, voronoi2, type RGB, type Rng } from '../../core/math';
import type { Terrain } from '../../world/Terrain';
import type { ParticleBuilder } from '../ParticleBuilder';

export const TERRAIN_SPACING = 0.15;

const GRASS: RGB[] = ['#5c9e45', '#6aaa4a', '#4f9142', '#79b650'].map(hex);
const GRASS_DRY = hex('#a3be5c');
const GRASS_DARK = hex('#3f7a3a');
const DIRT = hex('#8a6440');
const STONES: RGB[] = ['#b9b1a2', '#a59d90', '#c8c0ae', '#9a948c', '#d2c7b0'].map(hex);
const MORTAR = hex('#6b6156');
const SOIL: RGB[] = ['#7a5234', '#6b4630', '#845a3a'].map(hex);
const ROCK: RGB[] = ['#8a7f72', '#776c61', '#9a8f7f', '#6a6158', '#857a70'].map(hex);
const UNDER: RGB[] = ['#5b5260', '#4c4552', '#665c66'].map(hex);

export function emitTerrain(b: ParticleBuilder, terrain: Terrain, rng: Rng) {
  b.setCategory('地形');
  const s = TERRAIN_SPACING;
  const seed = terrain.cfg.seed;
  const ext = terrain.cfg.radius * 1.12;
  const n = Math.ceil((ext * 2) / s) + 1;
  const inside = new Uint8Array(n * n);
  const top = new Float32Array(n * n);
  const bot = new Float32Array(n * n);
  const size = s * 1.75;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -ext + i * s, z = -ext + j * s;
      const idx = j * n + i;
      if (!terrain.isInside(x, z)) continue;
      inside[idx] = 1;
      top[idx] = terrain.heightRaw(x, z);
      bot[idx] = terrain.bottomAt(x, z);
    }
  }

  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const idx = j * n + i;
      if (!inside[idx]) continue;
      const gx = -ext + i * s, gz = -ext + j * s;

      // ---- 上面 ----
      const jx = gx + (rng() - 0.5) * s * 0.6;
      const jz = gz + (rng() - 0.5) * s * 0.6;
      let h = terrain.heightRaw(jx, jz);
      const [nx, ny, nz] = terrain.normalAt(jx, jz);
      const pw = terrain.pathWeight(jx, jz);
      const sd = terrain.pathSignedDistance(jx, jz);
      let c: RGB;
      if (pw > 0.5) {
        const v = voronoi2(jx * 2.2, jz * 2.2, seed + 77);
        if (v.edge < 0.09) {
          c = scaleRGB(MORTAR, 0.9 + rng() * 0.15);
          h -= 0.02;
        } else {
          c = pick(STONES, v.id);
          const shade = 0.92 + 0.12 * Math.min(1, v.edge * 2.5) + (rng() - 0.5) * 0.04;
          c = scaleRGB(c, shade);
          h += 0.03 + v.id * 0.02;
          // 石の隙間に苔
          if (hash2(Math.floor(v.cx * 9), Math.floor(v.cy * 9), seed) < 0.05) c = mixRGB(c, GRASS[0], 0.5);
        }
      } else {
        const patch = fbm2(jx * 0.12, jz * 0.12, 3, seed + 3);
        const fine = noise2(jx * 1.3, jz * 1.3, seed + 4);
        c = pick(GRASS, rng());
        if (patch > 0.25) c = mixRGB(c, GRASS_DRY, Math.min(1, (patch - 0.25) * 2.2));
        if (patch < -0.3) c = mixRGB(c, GRASS_DARK, Math.min(1, (-0.3 - patch) * 2));
        c = scaleRGB(c, 0.95 + fine * 0.07);
        // 道のふちは土
        if (sd < 0.45) c = mixRGB(c, DIRT, 0.55 * (1 - Math.max(0, sd) / 0.45));
      }
      b.push(jx, h, jz, c, nx, ny, nz, { size });

      // ---- 側面・底面（露出しているボクセルだけ） ----
      const t0 = top[idx], b0 = bot[idx];
      const nbs = [idx - 1, idx + 1, idx - n, idx + n];
      const ndir = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (let y = t0 - s; y > b0 + s * 0.5; y -= s) {
        let ex = 0, ez = 0, exposed = false;
        for (let k = 0; k < 4; k++) {
          const q = nbs[k];
          if (!inside[q] || top[q] < y - s * 0.2 || bot[q] > y) {
            exposed = true;
            ex += ndir[k][0];
            ez += ndir[k][1];
          }
        }
        if (!exposed) continue;
        const depth = t0 - y;
        let cc: RGB;
        if (depth < 0.3) cc = scaleRGB(pick(GRASS, rng()), 0.75);
        else if (depth < 1.1 + noise2(gx * 0.8, gz * 0.8, seed) * 0.3) cc = pick(SOIL, rng());
        else {
          const band = noise2(y * 1.6 + noise2(gx * 0.3, gz * 0.3, seed + 8) * 1.5, 0.5, seed + 9);
          cc = pick(ROCK, band * 0.5 + 0.5 + (rng() - 0.5) * 0.15);
          const dark = Math.min(0.42, (t0 - y) / 26);
          cc = mixRGB(scaleRGB(cc, 1 - dark), UNDER[0], dark * 0.6);
        }
        const nyy = y - b0 < s * 1.5 ? -0.6 : 0;
        b.push(gx + (rng() - 0.5) * s * 0.3, y, gz + (rng() - 0.5) * s * 0.3, cc, ex, nyy, ez, { size });
      }
      // 底面
      const uc = scaleRGB(pick(UNDER, rng()), 0.9 + rng() * 0.15);
      b.push(gx, b0, gz, uc, 0, -1, 0, { size: size * 1.1 });
    }
  }
}
