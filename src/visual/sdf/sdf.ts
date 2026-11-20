// 符号付き距離関数（SDF）の基本形状と、SDF の表面に点を並べるサンプラー。
// 描画方式 B（Gaussian Splats）で「ポリゴンや既存の粒からの変換に頼らない形状生成」を検証するために使う。

import type { Rng } from '../../core/math';

/** 点 (x, y, z) から表面までの符号付き距離（内側が負） */
export type Sdf = (x: number, y: number, z: number) => number;

export function sdSphere(x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number): number {
  return Math.hypot(x - cx, y - cy, z - cz) - r;
}

/** 楕円体（近似距離。勾配を使う用途には十分） */
export function sdEllipsoid(x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.hypot(px, py, pz);
  const k1 = Math.hypot(px / rx, py / ry, pz / rz);
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}

/** 線分 a–b を軸とするカプセル（半径は a 側 ra から b 側 rb へ線形に変化） */
export function sdCapsule(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  ra: number, rb = ra,
): number {
  const pax = x - ax, pay = y - ay, paz = z - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz || 1e-9)));
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - (ra + (rb - ra) * h);
}

/** 底面中心 (cx, by, cz)・半径 r・高さ h の円錐（頂点が上）。底面も閉じる */
export function sdCone(x: number, y: number, z: number, cx: number, by: number, cz: number, r: number, h: number): number {
  const q = Math.hypot(x - cx, z - cz);
  const py = y - by;
  // 2D (q, py) 平面での三角形 (0,0)-(r,0)-(0,h) への距離
  const ex = -r, ey = h; // 底面の縁 (r,0) から頂点 (0,h) への辺
  const wx = q - r, wy = py;
  const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
  const dSide = Math.hypot(wx - ex * t, wy - ey * t);
  const dBase = py < 0 ? Math.hypot(Math.max(q - r, 0), py) : Infinity;
  const inside = py >= 0 && py <= h && q <= r * (1 - py / h);
  const d = Math.min(dSide, dBase, inside ? Math.min(py, dSide) : Infinity);
  return inside ? -d : d;
}

/** なめらかな和集合（k が大きいほど継ぎ目が丸くなる） */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

export type SurfaceEmit = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => void;

/**
 * SDF の表面（d = 0）付近に、おおむね step 間隔で点を並べる。
 * 粗いグリッドで表面から遠いブロックを読み飛ばし、細かいグリッドの各セルから
 * 勾配方向へ射影して表面上の点と法線を得る（「グリッドを歩いて表面へ寄せる」方式）。
 */
export function sampleSdfSurface(sdf: Sdf, box: Box3Like, step: number, rng: Rng, emit: SurfaceEmit): number {
  const B = 4; // 粗いブロック = B×B×B セル
  const block = step * B;
  const nx = Math.max(1, Math.ceil((box.max[0] - box.min[0]) / block));
  const ny = Math.max(1, Math.ceil((box.max[1] - box.min[1]) / block));
  const nz = Math.max(1, Math.ceil((box.max[2] - box.min[2]) / block));
  const eps = step * 0.15;
  const skip = block * 0.87 * 1.6; // ブロックの半対角 × 余裕（ノイズで距離が不正確な分）
  let count = 0;
  for (let bk = 0; bk < nz; bk++) {
    for (let bj = 0; bj < ny; bj++) {
      for (let bi = 0; bi < nx; bi++) {
        const bx0 = box.min[0] + bi * block, by0 = box.min[1] + bj * block, bz0 = box.min[2] + bk * block;
        if (Math.abs(sdf(bx0 + block / 2, by0 + block / 2, bz0 + block / 2)) > skip) continue;
        for (let k = 0; k < B; k++) {
          for (let j = 0; j < B; j++) {
            for (let i = 0; i < B; i++) {
              let x = bx0 + (i + 0.5 + (rng() - 0.5) * 0.6) * step;
              let y = by0 + (j + 0.5 + (rng() - 0.5) * 0.6) * step;
              let z = bz0 + (k + 0.5 + (rng() - 0.5) * 0.6) * step;
              let d = sdf(x, y, z);
              // 表面をまたぐセルだけを採用（1 セルにつき最大 1 点 ≒ step² あたり 1 点）
              if (Math.abs(d) > step * 0.5) continue;
              let gx = 0, gy = 0, gz = 0;
              for (let it = 0; it < 3; it++) {
                gx = sdf(x + eps, y, z) - sdf(x - eps, y, z);
                gy = sdf(x, y + eps, z) - sdf(x, y - eps, z);
                gz = sdf(x, y, z + eps) - sdf(x, y, z - eps);
                const gl = Math.hypot(gx, gy, gz) || 1;
                gx /= gl; gy /= gl; gz /= gl;
                x -= gx * d; y -= gy * d; z -= gz * d;
                d = sdf(x, y, z);
                if (Math.abs(d) < step * 0.02) break;
              }
              if (Math.abs(d) > step * 0.3) continue;
              emit(x, y, z, gx, gy, gz);
              count++;
            }
          }
        }
      }
    }
  }
  return count;
}
