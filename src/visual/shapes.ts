// 形状の表面に粒をほぼ等間隔に並べるためのサンプリング関数群。

export type Emit = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => void;

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** フィボナッチ球で単位方向を n 個生成 */
export function fibonacciSphere(n: number, cb: (dx: number, dy: number, dz: number, i: number) => void) {
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = GOLDEN * i;
    cb(Math.cos(th) * r, y, Math.sin(th) * r, i);
  }
}

/** 楕円体の表面 */
export function ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, spacing: number, emit: Emit) {
  const p = 1.6;
  const area = 4 * Math.PI * Math.pow((Math.pow(rx * ry, p) + Math.pow(rx * rz, p) + Math.pow(ry * rz, p)) / 3, 1 / p);
  const n = Math.max(6, Math.round(area / (spacing * spacing)));
  fibonacciSphere(n, (dx, dy, dz) => {
    emit(cx + dx * rx, cy + dy * ry, cz + dz * rz, dx / rx, dy / ry, dz / rz);
  });
}

/** カプセル（a から b まで、半径 r）の表面 */
export function capsule(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number, spacing: number, emit: Emit,
) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-6;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // 軸に直交する基底
  let px = -uy, py = ux, pz = 0;
  if (Math.abs(uz) > 0.9 || Math.hypot(px, py) < 1e-3) { px = 0; py = -uz; pz = uy; }
  const pl = Math.hypot(px, py, pz);
  px /= pl; py /= pl; pz /= pl;
  const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
  const ring = Math.max(4, Math.round((2 * Math.PI * r) / spacing));
  const steps = Math.max(1, Math.round(len / spacing));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const off = (s % 2) * 0.5;
    for (let k = 0; k < ring; k++) {
      const a = ((k + off) / ring) * Math.PI * 2;
      const nx = Math.cos(a) * px + Math.sin(a) * qx;
      const ny = Math.cos(a) * py + Math.sin(a) * qy;
      const nz = Math.cos(a) * pz + Math.sin(a) * qz;
      emit(ax + dx * t + nx * r, ay + dy * t + ny * r, az + dz * t + nz * r, nx, ny, nz);
    }
  }
  // 両端の半球
  const capN = Math.max(4, Math.round((2 * Math.PI * r * r) / (spacing * spacing)));
  for (const [cx, cy, cz, sgn] of [[ax, ay, az, -1], [bx, by, bz, 1]] as const) {
    fibonacciSphere(capN * 2, (ex, ey, ez) => {
      if ((ex * ux + ey * uy + ez * uz) * sgn <= 0.05) return;
      emit(cx + ex * r, cy + ey * r, cz + ez * r, ex, ey, ez);
    });
  }
}

/** 円錐の側面（頂点が上）。底面の縁も少し埋める */
export function cone(cx: number, by: number, cz: number, radius: number, height: number, spacing: number, emit: Emit) {
  const slant = Math.hypot(radius, height);
  const steps = Math.max(2, Math.round(slant / spacing));
  const ny0 = radius / slant, nr0 = height / slant;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const rr = radius * (1 - t);
    const ring = Math.max(1, Math.round((2 * Math.PI * rr) / spacing));
    const off = (s % 2) * 0.5;
    for (let k = 0; k < ring; k++) {
      const a = ((k + off) / ring) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      emit(cx + c * rr, by + height * t, cz + sn * rr, c * nr0, ny0, sn * nr0);
    }
  }
  // 底面（外周付近のみ）
  for (let rr = radius - spacing; rr > radius * 0.45; rr -= spacing) {
    const ring = Math.max(1, Math.round((2 * Math.PI * rr) / spacing));
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2;
      emit(cx + Math.cos(a) * rr, by, cz + Math.sin(a) * rr, 0, -1, 0);
    }
  }
}
