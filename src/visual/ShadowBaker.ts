// 太陽光の遮蔽（影）を生成時に粒ごとに焼き込む。地形の高さと球状の遮蔽物（樹冠・岩）を使う。

import type { Terrain } from '../world/Terrain';
import type { ParticleBuilder } from './ParticleBuilder';

export interface SphereOccluder {
  x: number;
  y: number;
  z: number;
  r: number;
}

export function bakeSunShadows(b: ParticleBuilder, terrain: Terrain, occluders: SphereOccluder[], sun: [number, number, number]) {
  const [lx, ly, lz] = sun;
  const maxTop = terrain.maxTop + 0.5;
  const pos = b.pos, nrm = b.nrm, misc = b.misc;
  const step = 0.3;
  for (let i = 0; i < b.count; i++) {
    const i3 = i * 3;
    const nx = nrm[i3] / 127, ny = nrm[i3 + 1] / 127, nz = nrm[i3 + 2] / 127;
    if (nx * lx + ny * ly + nz * lz <= 0.02) continue; // 裏面はシェーダー側で暗くなるので省略
    const ox = pos[i3] + nx * 0.1, oy = pos[i3 + 1] + ny * 0.1, oz = pos[i3 + 2] + nz * 0.1;
    let vis = 1;

    // 地形によるセルフシャドウ
    for (let s = 1; s < 60; s++) {
      const t = s * step;
      const y = oy + ly * t;
      if (y > maxTop) break;
      const h = terrain.heightRaw(ox + lx * t, oz + lz * t);
      if (h > y + 0.08 && terrain.isInside(ox + lx * t, oz + lz * t, 1.0)) {
        vis = 0;
        break;
      }
    }

    // 樹冠・岩（球）による影。光線と球の最接近距離から柔らかい影を作る
    if (vis > 0) {
      for (let k = 0; k < occluders.length; k++) {
        const o = occluders[k];
        const cx = o.x - ox, cy = o.y - oy, cz = o.z - oz;
        const t = cx * lx + cy * ly + cz * lz;
        if (t < 0) continue;
        const d2 = cx * cx + cy * cy + cz * cz - t * t;
        const r = o.r;
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2);
        const occ = 1 - Math.min(1, Math.max(0, (d - r * 0.7) / (r * 0.3)));
        vis = Math.min(vis, 1 - occ);
        if (vis <= 0) break;
      }
    }
    misc[i3 + 2] = vis;
  }
}
