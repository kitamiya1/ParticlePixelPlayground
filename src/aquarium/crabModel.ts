// カニの形（サワガニに近い体型）。部位ごとの SDF を「そのボーンのローカル座標」で定義し、
// 方式 E と同じ Surface Nets（MeshBuild.surfaceNets）で三角形にして、ボーン行列で剛体として動かす。
// - 甲羅：横に広い（幅 0.58 / 長さ 0.43）。前縁がやや広く、上面はなだらかな丸み、下面は平ら。
//   H 字形の溝・前側縁の細かな歯・まだら模様は色で、細かな粒状の凹凸は SDF のノイズで付ける。
// - 眼：前縁の眼柄の先。口器・胸板（腹側）・脚の付け根も胴のボーンに含める。
// - 鋏脚（左右）：腕節（arm）→ 掌部と不動指（hand）→ 可動指（finger）の 3 ボーン。右（雄の利き手）を大きく。
// - 歩脚（左右 4 対）：長節（upper）と、腕節〜前節〜指節（lower）の 2 ボーン。指節は下へ曲げる。
// ローカル座標：+X = カニの左, +Y = 上, +Z = 前（眼の向き）。

import { hex, mixRGB, noise3, type RGB } from '../core/math';
import { sdCapsule, sdEllipsoid, sdSphere, smin, type Box3Like, type Sdf } from '../visual/sdf/sdf';

export const CRAB_BONE = { body: 0, armL: 1, handL: 2, fingerL: 3, armR: 4, handR: 5, fingerR: 6 } as const;
/** 歩脚のボーン番号（side: +1 = 左, -1 = 右、i: 0 = 最前 … 3 = 最後） */
export function legBone(side: 1 | -1, i: number, lower: boolean): number {
  return 7 + (side === 1 ? 0 : 8) + i * 2 + (lower ? 1 : 0);
}
export const CRAB_BONE_COUNT = 23;

/** 甲羅の中心の高さ（足元からの静止時の高さ） */
export const BODY_HEIGHT = 0.17;

/** 歩脚の付け根と長さ */
export interface LegSpec {
  hip: [number, number, number];
  /** 長節の長さ */
  l1: number;
  /** 下の節（腕節＋前節）の長さと指節の長さ */
  a: number;
  b: number;
  /** 指節の下向きの曲がり（rad） */
  bend: number;
  /** 静止時の足先（体の座標、y = 地面からの高さ） */
  rest: { out: number; fwd: number };
}

export const LEGS: LegSpec[] = [
  { hip: [0.235, -0.03, 0.11], l1: 0.19, a: 0.15, b: 0.1, bend: 0.45, rest: { out: 0.39, fwd: 0.27 } },
  { hip: [0.245, -0.03, 0.035], l1: 0.22, a: 0.17, b: 0.11, bend: 0.45, rest: { out: 0.45, fwd: 0.11 } },
  { hip: [0.24, -0.03, -0.045], l1: 0.22, a: 0.17, b: 0.11, bend: 0.45, rest: { out: 0.45, fwd: -0.07 } },
  { hip: [0.215, -0.025, -0.12], l1: 0.19, a: 0.15, b: 0.1, bend: 0.5, rest: { out: 0.39, fwd: -0.24 } },
];

/** 指節の先端（下の節のローカル座標、外向き = +u, 上 = +v） */
export function legTip(L: LegSpec): { u: number; v: number } {
  return { u: L.a + L.b * Math.cos(L.bend), v: -L.b * Math.sin(L.bend) };
}

/** 鋏脚の付け根（体の座標）と大きさ */
export const CLAWS = {
  shoulder: [0.2, -0.035, 0.15] as [number, number, number],
  armLen: 0.12,
  /** 左右の大きさ（右 = 雄の大きい鋏） */
  scale: { L: 1, R: 1.22 },
};

export interface CrabPart {
  bone: number;
  sdf: Sdf;
  box: Box3Like;
  /** Surface Nets の格子の一辺 */
  cell: number;
  color: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => RGB;
  /** 画素ごとの細かな明暗の強さ（0..1） */
  grain: number;
}

const COL = {
  shellDark: hex('#4e2219'),
  shell: hex('#7d3524'),
  shellLight: hex('#a8492c'),
  shellRim: hex('#c2603a'),
  groove: hex('#341712'),
  under: hex('#dcc39c'),
  underShade: hex('#bf9f78'),
  leg: hex('#b34d2d'),
  legLight: hex('#d2703f'),
  legDark: hex('#6e2c1d'),
  tip: hex('#3a2119'),
  claw: hex('#a7432a'),
  clawLight: hex('#d9895a'),
  fingerTip: hex('#efe1c8'),
  eye: hex('#141012'),
  eyeGlint: hex('#e8eef2'),
  stalk: hex('#c0643c'),
};

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box3Like => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

/** 甲羅の平面形（前ほど広い）と高さ */
function carapace(x: number, y: number, z: number): number {
  const taper = 1 + 0.11 * Math.max(-1, Math.min(1, z / 0.21));
  const ry = y > 0 ? 0.085 - 0.02 * (z / 0.21) * (z / 0.21) : 0.05;
  let d = sdEllipsoid(x / taper, y, z, 0, 0, 0, 0.285, ry, 0.215) * Math.min(1, taper);
  // 前縁（額）をやや平らに切る
  d = Math.max(d, z - 0.195 - 0.012 * Math.cos(x * 22));
  // 細かな粒状の凹凸
  d -= noise3(x * 45, y * 45, z * 45, 3) * 0.0035;
  return d;
}

/** 甲羅の H 字形の溝（色で表す。0..1） */
function grooveAmt(x: number, z: number): number {
  const cervical = Math.exp(-(((z - (0.025 - 1.4 * x * x)) / 0.011) ** 2)) * (Math.abs(x) < 0.19 ? 1 : 0);
  const gastric = Math.exp(-(((Math.abs(x) - 0.055) / 0.008) ** 2)) * (z > 0.03 && z < 0.12 ? 1 : 0);
  const branch = Math.exp(-(((z + 0.06 - 0.9 * Math.abs(x)) / 0.01) ** 2)) * (Math.abs(x) > 0.08 && Math.abs(x) < 0.2 ? 1 : 0);
  return Math.min(1, cervical + gastric * 0.8 + branch * 0.6);
}

function bodyParts(): CrabPart[] {
  const sdf: Sdf = (x, y, z) => {
    let d = carapace(x, y, z);
    // 胸板（腹側）・口器
    d = smin(d, sdEllipsoid(x, y, z, 0, -0.045, -0.02, 0.165, 0.035, 0.16), 0.02);
    d = smin(d, sdEllipsoid(x, y, z, 0, -0.03, 0.155, 0.075, 0.03, 0.04), 0.015);
    // 脚の付け根（関節の隙間を隠す）
    for (const L of LEGS) for (const sx of [1, -1]) d = smin(d, sdEllipsoid(x, y, z, sx * (L.hip[0] - 0.01), L.hip[1], L.hip[2], 0.05, 0.034, 0.034), 0.015);
    for (const sx of [1, -1]) d = smin(d, sdEllipsoid(x, y, z, sx * CLAWS.shoulder[0], CLAWS.shoulder[1], CLAWS.shoulder[2], 0.045, 0.038, 0.04), 0.015);
    // 眼柄と眼
    for (const sx of [1, -1]) {
      d = smin(d, sdCapsule(x, y, z, sx * 0.058, 0.035, 0.172, sx * 0.074, 0.083, 0.212, 0.016, 0.014), 0.01);
      d = Math.min(d, sdSphere(x, y, z, sx * 0.077, 0.092, 0.219, 0.025));
    }
    return d;
  };
  const color = (x: number, y: number, z: number, _nx: number, ny: number): RGB => {
    // 眼
    for (const sx of [1, -1]) {
      const de = Math.hypot(x - sx * 0.077, y - 0.092, z - 0.219);
      if (de < 0.03) return y > 0.106 && z > 0.222 && x * sx > 0.07 ? COL.eyeGlint : COL.eye;
    }
    if (z > 0.165 && y > 0.02 && Math.abs(x) > 0.045 && Math.abs(x) < 0.1) return COL.stalk;
    // 腹側（クリーム色）
    if (y < -0.012 || ny < -0.35) return y < -0.06 ? COL.underShade : COL.under;
    const m = noise3(x * 14, y * 14, z * 14, 9) * 0.5 + 0.5;
    let c = mixRGB(COL.shellDark, COL.shell, Math.min(1, m * 1.4));
    // 前方の上面と前側縁は明るい赤橙
    const rim = Math.max(0, Math.hypot(x / 0.29, z / 0.22) - 0.78) * 4;
    c = mixRGB(c, COL.shellRim, Math.min(1, rim) * 0.7);
    if (y > 0.05) c = mixRGB(c, COL.shellLight, Math.min(1, (y - 0.05) * 18) * (0.35 + 0.3 * m));
    // 前側縁の歯（細かな明暗）
    if (Math.abs(x) > 0.2 && z > -0.02 && Math.sin(z * 120) > 0.6) c = mixRGB(c, COL.shellDark, 0.5);
    c = mixRGB(c, COL.groove, grooveAmt(x, z) * Math.min(1, Math.max(0, y) * 20));
    return c;
  };
  return [{ bone: CRAB_BONE.body, sdf, box: box(-0.37, -0.12, -0.28, 0.37, 0.15, 0.29), cell: 0.014, color, grain: 0.55 }];
}

function legParts(): CrabPart[] {
  const parts: CrabPart[] = [];
  for (const sx of [1, -1] as const) {
    LEGS.forEach((L, i) => {
      // 長節：外向き（sx·X）に伸びる、上下にやや平たい棒
      const upper: Sdf = (x, y, z) => sdCapsule(x, y * 1.18, z, 0, 0, 0, sx * L.l1, 0, 0, 0.03, 0.026);
      const upperColor = (x: number, y: number, _z: number, _nx: number, ny: number): RGB => {
        const f = (x * sx) / L.l1;
        if (ny < -0.3) return COL.under;
        let c = mixRGB(COL.leg, COL.legLight, Math.max(0, ny) * 0.6);
        if (f > 0.86) c = mixRGB(c, COL.legDark, 0.6);
        if (y > 0.018 && Math.sin(f * 30) > 0.7) c = mixRGB(c, COL.legDark, 0.35); // 縁の小さな棘
        return c;
      };
      parts.push({ bone: legBone(sx, i, false), sdf: upper, box: box(Math.min(0, sx * L.l1) - 0.05, -0.05, -0.05, Math.max(0, sx * L.l1) + 0.05, 0.05, 0.05), cell: 0.011, color: upperColor, grain: 0.3 });
      // 下の節：腕節〜前節（まっすぐ）＋ 指節（下へ曲がり、先が尖る）
      const tip = legTip(L);
      const lower: Sdf = (x, y, z) => {
        const d1 = sdCapsule(x, y, z, 0, 0, 0, sx * L.a, 0, 0, 0.025, 0.02);
        const d2 = sdCapsule(x, y, z, sx * L.a, 0, 0, sx * tip.u, tip.v, 0, 0.018, 0.004);
        return smin(d1, d2, 0.008);
      };
      const lowerColor = (x: number, _y: number, _z: number, _nx: number, ny: number): RGB => {
        const u = x * sx;
        if (u > L.a + L.b * 0.55) return COL.tip;
        if (u < 0.03) return COL.legDark;
        if (ny < -0.4) return mixRGB(COL.legLight, COL.under, 0.5);
        return mixRGB(COL.legLight, COL.leg, u > L.a ? 0.6 : 0.2);
      };
      parts.push({
        bone: legBone(sx, i, true),
        sdf: lower,
        box: box(Math.min(0, sx * (tip.u + 0.03)) - 0.04, tip.v - 0.04, -0.04, Math.max(0, sx * (tip.u + 0.03)) + 0.04, 0.04, 0.04),
        cell: 0.01,
        color: lowerColor,
        grain: 0.25,
      });
    });
  }
  return parts;
}

function clawParts(): CrabPart[] {
  const parts: CrabPart[] = [];
  for (const [sx, k, arm, hand, finger] of [
    [1, CLAWS.scale.L, CRAB_BONE.armL, CRAB_BONE.handL, CRAB_BONE.fingerL],
    [-1, CLAWS.scale.R, CRAB_BONE.armR, CRAB_BONE.handR, CRAB_BONE.fingerR],
  ] as const) {
    // 腕節：前（+Z）へ伸びる。先に丸い節
    const al = CLAWS.armLen;
    const armSdf: Sdf = (x, y, z) => smin(sdCapsule(x, y, z, 0, 0, 0, 0, 0, al, 0.03 * k, 0.034 * k), sdEllipsoid(x, y, z, 0, 0.004, al, 0.042 * k, 0.038 * k, 0.04 * k), 0.015);
    const armColor = (_x: number, _y: number, _z: number, _nx: number, ny: number): RGB => (ny < -0.4 ? COL.under : mixRGB(COL.claw, COL.legLight, Math.max(0, ny) * 0.4));
    parts.push({ bone: arm, sdf: armSdf, box: box(-0.06 * k, -0.06 * k, -0.04, 0.06 * k, 0.06 * k, al + 0.06 * k), cell: 0.011, color: armColor, grain: 0.3 });
    // 掌部（左右に平たい）と不動指
    const handSdf: Sdf = (x, y, z) => {
      const palm = sdEllipsoid(x, y, z, 0, 0, 0.06 * k, 0.034 * k, 0.05 * k, 0.078 * k);
      const fixed = sdCapsule(x, y, z, 0, -0.022 * k, 0.12 * k, 0.004 * k, -0.018 * k, 0.2 * k, 0.02 * k, 0.006 * k);
      return smin(palm, fixed, 0.02 * k) - noise3(x * 50, y * 50, z * 50, 5) * 0.002;
    };
    const handColor = (_x: number, y: number, z: number, _nx: number, ny: number): RGB => {
      if (z > 0.16 * k) return COL.fingerTip;
      if (ny < -0.3 || y < -0.025 * k) return mixRGB(COL.clawLight, COL.under, 0.4);
      return mixRGB(COL.claw, COL.shellLight, Math.max(0, ny) * 0.5);
    };
    parts.push({ bone: hand, sdf: handSdf, box: box(-0.05 * k, -0.07 * k, -0.04 * k, 0.05 * k, 0.07 * k, 0.23 * k), cell: 0.011, color: handColor, grain: 0.35 });
    // 可動指（付け根 = ボーンの原点。下向きに少し曲がる）
    const fingerSdf: Sdf = (x, y, z) => smin(sdCapsule(x, y, z, 0, 0, 0, 0, 0.004 * k, 0.045 * k, 0.017 * k, 0.012 * k), sdCapsule(x, y, z, 0, 0.004 * k, 0.045 * k, 0, -0.01 * k, 0.085 * k, 0.012 * k, 0.005 * k), 0.006);
    const fingerColor = (_x: number, _y: number, z: number): RGB => (z > 0.045 * k ? COL.fingerTip : COL.claw);
    parts.push({ bone: finger, sdf: fingerSdf, box: box(-0.03 * k, -0.035 * k, -0.03 * k, 0.03 * k, 0.035 * k, 0.11 * k), cell: 0.009, color: fingerColor, grain: 0.2 });
  }
  return parts;
}

export function crabParts(): CrabPart[] {
  return [...bodyParts(), ...clawParts(), ...legParts()];
}
