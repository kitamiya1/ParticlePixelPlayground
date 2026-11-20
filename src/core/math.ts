// 汎用の数学ユーティリティ（乱数・ノイズ・補間）。描画にもゲームロジックにも依存しない。

export type Rng = () => number;

/** 再現可能な乱数生成器 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hash3(x: number, y: number, z: number, seed = 0): number {
  return hash2(x + Math.imul(z | 0, 2246822519), y, seed);
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 値ノイズ（-1..1） */
export function noise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}

export function noise3(x: number, y: number, z: number, seed = 0): number {
  const zi = Math.floor(z), zf = z - zi;
  const w = zf * zf * (3 - 2 * zf);
  const a = noise2(x + zi * 17.13, y - zi * 9.71, seed);
  const b = noise2(x + (zi + 1) * 17.13, y - (zi + 1) * 9.71, seed);
  return lerp(a, b, w);
}

export function fbm2(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 31);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

export function fbm3(x: number, y: number, z: number, octaves = 3, seed = 0): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq, seed + i * 31);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** ボロノイ（石畳用）。最近傍セルのハッシュと境界までの近さを返す */
export function voronoi2(x: number, y: number, seed = 0): { id: number; edge: number; cx: number; cy: number } {
  const xi = Math.floor(x), yi = Math.floor(y);
  let d1 = 1e9, d2 = 1e9, id = 0, cx = 0, cy = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = xi + i, gy = yi + j;
      const px = gx + 0.15 + 0.7 * hash2(gx, gy, seed);
      const py = gy + 0.15 + 0.7 * hash2(gx, gy, seed + 7);
      const d = Math.hypot(px - x, py - y);
      if (d < d1) {
        d2 = d1; d1 = d; id = hash2(gx, gy, seed + 13); cx = px; cy = py;
      } else if (d < d2) d2 = d;
    }
  }
  return { id, edge: d2 - d1, cx, cy };
}

export type RGB = [number, number, number];

export function hex(h: string): RGB {
  const v = parseInt(h.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function scaleRGB(a: RGB, s: number): RGB {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
}
