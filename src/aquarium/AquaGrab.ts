// 挟む（ハサミで物を直接挟んで、引く・運ぶ・離す）の MVP。ゲームロジック側（Three.js に依存しない）。
// 見た目（右の大きな鋏の構えと、挟んだ所へ鋏を伸ばす IK）は CrabRig、物の描画は AquariumRenderer が担当する。
//
// 物理エンジンは入れず、このゲームに合う軽い作りにする：
// - 物（Prop）：小石・貝殻・重い石。体は楕円体で近似し、当たり判定はカニと同じ AquariumWorld.contactSolid
//   （砂・掘った穴・盛った砂・岩・流木・ガラス・管）。楕円体の「面の向きの最も奥の点」（支点）を距離関数で調べて押し戻す
//   ので、平たい貝殻も砂やガラスに埋まらない。重力・浮力（水中では種類ごとの沈む速さ）・水の抵抗・摩擦（静止摩擦の
//   しきい値つき）を、カニと同じく 1/120 秒の小さな刻みで進める（速く動かしてもすり抜けない・振動しない）。
//   止まったら眠らせ（計算しない）、カニが触れた・掘った・盛った・挟んだときに起こす。
// - 挟む：鋏が届く所（構えた鋏の先 = anchor から GRAB_REACH 以内）の物の表面の 1 点（つかみ点。物の座標で持つ）を挟む。
//   つかみ点と鋏の構えの位置（anchor）をばね + 減衰でつなぐ（瞬間移動しない・吸い付かない）。ばねの力は握る力
//   GRIP_FORCE で頭打ちになり、その反作用をカニへ返す（重い物ほど移動が遅くなる・勢いよく動くと物が遅れてついてきて、
//   止まると引き戻される）。軽い物は持ち上がって運べ、重い石は持ち上がらず砂の上を引きずる。陸の上の重い石は動かない。
//   引っ張りすぎ（ばねの伸び・鋏が届かない）が続くと、物が鋏から滑り落ちる。
// - 向き：挟んでいる間は、つかみ点が力の向き（ばねが引く向き）へ来るように回す（ぶら下がる・引きずると傾く）。
//   床に置かれた物は、底を面へ向けて落ち着く。回転の運動方程式（慣性モーメント）は使わない（小さく平たい物で
//   発散しやすいので、目標の角速度へ寄せるだけにする）。
// - 見た目の接触：鋏は物のつかみ点へ伸ばす（CrabRig.grip.target）。物はばねで遅れても、鋏はいつも物の表面を挟んで見える。

import { clamp, lerp, smoothstep } from '../core/math';
import { ROOM } from './AquariumStand';
import { TANK, type AquariumWorld, type SurfaceMaterial } from './AquariumWorld';
import type { CrabController } from './CrabController';

/**
 * weed = ちぎった・抜いた水草（第 5 段階。形は円盤の集まり：AquaCatch.ts。静的なメッシュは持たない）。
 * block / slab / rod / pillar = 積み木・物理パズルの検証エリアの物（ハサミ集中モード。形は箱：剛体の回転と、箱どうしの積み重ね）
 */
export type PropKind = 'pebble' | 'shell' | 'stone' | 'weed' | 'block' | 'slab' | 'rod' | 'pillar' | 'floor';

/** 箱の形の物（積み木の検証エリア）。semi は箱の半分の大きさ（x = 横, y = 厚み, z = 前後） */
export const BOX_KINDS: readonly PropKind[] = ['block', 'slab', 'rod', 'pillar', 'floor'];

export interface PropKindSpec {
  /** 形：省略 = 楕円体（従来の小石・貝殻）、box = 箱（剛体：慣性で回り、角・辺・面で接して積み重なる） */
  shape?: 'box';
  name: string;
  /** 大きさ 1 のときの楕円体の半径（x = 横, y = 厚み, z = 前後） */
  semi: [number, number, number];
  /** 重さ（カニ = 1） */
  mass: number;
  /** 水中で沈む強さ（重力の加速度。水中のカニは 5.2） */
  sinkG: number;
  /** 水の抵抗（速さが 1/e になる割合 / 秒） */
  drag: number;
  /** 摩擦の係数 */
  mu: number;
  /** はね返り */
  bounce: number;
}

export const PROP_KIND: Record<PropKind, PropKindSpec> = {
  // 第 5 段階：全体に軽く（小石・貝殻を軽快に持ち運べる。重さの順は変えない）。以前：貝殻 0.12 / 2.4 / 3.0、小石 0.35 / 4.6 / 1.3 / 0.6、
  // 重い石 1.2 / 7.0 / 1.0 / 0.4（重さ / 沈む強さ / 水の抵抗 / 摩擦）
  shell: { name: '貝殻', semi: [0.092, 0.024, 0.084], mass: 0.08, sinkG: 2.0, drag: 3.2, mu: 0.4, bounce: 0.1 },
  pebble: { name: '小石', semi: [0.078, 0.052, 0.068], mass: 0.22, sinkG: 3.8, drag: 1.5, mu: 0.5, bounce: 0.15 },
  // 重い石：水中ならやっと持ち上がる（重さ × 沈む強さ 0.8 × 6.4 = 5.1 < 握る力 8。ゆっくり）。砂の上なら引きずれる。陸では持ち上がらない
  stone: { name: '重い石', semi: [0.17, 0.115, 0.15], mass: 0.8, sinkG: 6.4, drag: 1.2, mu: 0.35, bounce: 0.05 },
  // ちぎった・抜いた水草：とても軽く、水の抵抗が大きい（離すとゆっくり漂って沈む）
  weed: { name: '水草', semi: [0.08, 0.05, 0.08], mass: 0.04, sinkG: 0.45, drag: 4.5, mu: 0.8, bounce: 0.02 },
  // 積み木の検証エリア（箱）：積み木（10 cm の立方体）・平たい石（板）・細長い棒（42 cm）・石の台（重くて 1 本では持ち上がらない。
  // 水中の重さ 2.2 × 6.4 = 14 > 腕の力 8。両方のハサミなら 8 + 8 = 16 でゆっくり浮く）
  block: { name: '積み木', semi: [0.05, 0.05, 0.05], mass: 0.3, sinkG: 4.5, drag: 1.4, mu: 0.75, bounce: 0.04, shape: 'box' },
  slab: { name: '平たい石', semi: [0.15, 0.024, 0.1], mass: 0.5, sinkG: 4.8, drag: 1.7, mu: 0.8, bounce: 0.02, shape: 'box' },
  rod: { name: '細長い棒', semi: [0.21, 0.017, 0.017], mass: 0.12, sinkG: 3.0, drag: 2.0, mu: 0.65, bounce: 0.03, shape: 'box' },
  pillar: { name: '石の台', semi: [0.075, 0.09, 0.075], mass: 2.2, sinkG: 6.4, drag: 1.2, mu: 0.9, bounce: 0.02, shape: 'box' },
  // 検証エリアの石の床（動かない・挟めない：Prop.fixed。大きさは置くときに決める。平らな床で積み木の安定を確かめる）
  floor: { name: '石の床', semi: [0.8, 0.12, 1.2], mass: 1000, sinkG: 6.4, drag: 1, mu: 0.85, bounce: 0, shape: 'box' },
};

/** 握る力の上限の倍率（強く握る = 1 で従来どおり。弱いほど物が滑る）：握る強さ s（0..1）→ 摩擦で支えられる力 / 腕の力 */
export function gripFriction(s: number): number {
  return 0.12 + 1.1 * Math.pow(clamp(s, 0, 1), 1.4);
}

/** 空気中の重力（カニと同じ） */
const G_AIR = 24;
/** 刻み（秒） */
const SUB = 1 / 120;
/** つかみ点 ↔ 鋏の構えのばね（強さ・減衰の割合）と、握る力の上限（ばねの力の頭打ち） */
export const SPRING_K = 140;
const SPRING_ZETA = 0.55;
export const GRIP_FORCE = 8;
/** 反作用を受けるカニの重さ（小さいほど重い物に引っ張られる） */
const CRAB_MASS = 0.85;
/** 挟める距離（構えた鋏の先から物の表面まで。押した瞬間と、押したまま空で閉じているとき） */
export const GRAB_REACH = 0.26;
/** 右の鋏の大きさ（crabModel の CLAWS.scale.R。指の開きを物の太さに合わせる） */
const CLAW_K_R = 1.22;
/** 鋏の付け根から、伸ばしきった鋏の先までの長さ（CrabRig の腕と掌。少し余裕を引く）。これより遠い所は挟めない */
export const ARM_REACH = 0.33;
/** 鋏を閉じるまでの時間（この間に鋏を物へ伸ばす） */
export const CLOSE_T = 0.13;
/** 生き物（巣穴の触角）は物よりこれだけ遠くから挟める（初心者でも狙いやすく） */
const CREATURE_BONUS = 0.07;
/** 生き物へは腕を伸ばしきるところ（CrabRig の 0.35）まで届かせる */
const CREATURE_ARM_EXTRA = 0.02;
/** 狙いの補助：体の中心からこの距離の物へ鋏を向ける・薄い輪を出す */
export const ASSIST_R = 0.8;
/** 滑り落ちる：ばねの伸び・鋏が届かない量の上限と、それが続く時間 */
const SLIP_STRETCH = 0.3;
const SLIP_REACH = 0.05;
const SLIP_T = 0.3;
/** 当たり判定の皮（これより近づけない） */
const SKIN = 0.002;
/** 地面の近くで調べる支点の向き（真下・横 4 方向・斜め下 4 方向） */
const PROBE_DIRS: readonly (readonly [number, number, number])[] = [
  [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [0.7071, -0.7071, 0], [-0.7071, -0.7071, 0], [0, -0.7071, 0.7071], [0, -0.7071, -0.7071],
];

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

/**
 * 鋏のばね（つかみ点 ↔ 鋏の構え）。物（Prop）と巣穴の生き物（GrabCreature）で共通。
 * e = 構え − つかみ点、rv = 構えの速さ − つかみ点の速さ、mass = つかむ物の重さ、grip = 握る力の上限。
 * out にばねの力（握る力で頭打ち）を書き、頭打ちにする前の力の大きさを返す（握る力を越えて引いている量。生き物の滑りに使う）
 */
export function clawSpring(ex: number, ey: number, ez: number, rvx: number, rvy: number, rvz: number, mass: number, grip: number, out: V3): number {
  const c = 2 * SPRING_ZETA * Math.sqrt(SPRING_K * mass);
  let fx = SPRING_K * ex + c * rvx;
  let fy = SPRING_K * ey + c * rvy;
  let fz = SPRING_K * ez + c * rvz;
  const fl = Math.hypot(fx, fy, fz);
  if (fl > grip) {
    const k = grip / fl;
    fx *= k; fy *= k; fz *= k;
  }
  out[0] = fx; out[1] = fy; out[2] = fz;
  return fl;
}

export class Prop {
  readonly spec: PropKindSpec;
  /** 楕円体の半径（大きさを掛けた後） */
  readonly semi: V3;
  readonly mass: number;
  /** 外接球・平均の半径（物どうし・カニの体との当たり） */
  readonly rb: number;
  readonly rm: number;
  readonly p: V3;
  readonly v: V3 = [0, 0, 0];
  readonly q: Q4;
  readonly w: V3 = [0, 0, 0];
  awake = true;
  restT = 0;
  /** 床・物に触れている（この刻みで押し戻した）面の向き */
  contact = false;
  readonly cn: V3 = [0, 1, 0];
  /** 挟まれている（左右どちらか・両方の鋏。holders = 挟んでいる鋏の数） */
  held = false;
  holders = 0;
  /** 箱（積み木の検証エリア）：剛体として解く。invI = 体の座標の慣性モーメントの逆数、samples = 当たりを調べる表面の点（体の座標） */
  readonly box: boolean;
  readonly invI: V3 = [0, 0, 0];
  readonly samples: Float32Array;
  /** 箱：保存する物（積み木の検証エリアの物） */
  save = false;
  /** 動かない物（検証エリアの石の床）：起きない・挟めない。当たり判定（dist）にだけ入る */
  fixed = false;
  /** 水槽の外・固体の中にいる時間（長く続いたら置いた所へ戻す） */
  lostT = 0;
  /** 置いた所（戻す先） */
  readonly home: V3;
  readonly homeQ: Q4;

  /** 景色の小石・貝殻（AquaDecor）から作った物：景色のメッシュの番号（描画は景色のメッシュの頂点を動かす）。それ以外は −1 */
  decor = -1;
  /**
   * 食べ物（AquaEat）：種類（null = 食べられない物）・大きさ（栄養と時間の倍率）・残り（0..1。見た目が縮む）。
   * eating = 口元で食べている（カニの体から押し出さない：口に入っている）
   */
  food: { kind: 'algae' | 'plant'; size: number } | null = null;
  left = 1;
  eating = false;
  private readonly label: string;

  /**
   * opts：景色の物から作るとき、楕円体の半径（semi）・重さ（mass）・名前・向き（q）を直接決める（種類の値は摩擦・沈む強さ等だけ使う）
   */
  constructor(readonly id: string, readonly kind: PropKind, readonly scale: number, p: V3, yaw: number, opts: { semi?: V3; mass?: number; name?: string; q?: Q4 } = {}) {
    this.spec = PROP_KIND[kind];
    this.semi = opts.semi ? [...opts.semi] : [this.spec.semi[0] * scale, this.spec.semi[1] * scale, this.spec.semi[2] * scale];
    this.mass = opts.mass ?? this.spec.mass * scale * scale * scale;
    this.rb = Math.max(...this.semi);
    this.rm = (this.semi[0] + this.semi[1] + this.semi[2]) / 3;
    this.p = [...p];
    this.q = opts.q ? [...opts.q] : [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    this.home = [...p];
    this.homeQ = [...this.q];
    this.label = opts.name ?? this.spec.name;
    this.box = this.spec.shape === 'box';
    if (this.box) {
      const [a, b, c] = this.semi, m = this.mass;
      // 箱の慣性モーメント（半分の大きさ a, b, c）：I = m / 3 · (b² + c², a² + c², a² + b²)
      this.invI[0] = 3 / (m * (b * b + c * c));
      this.invI[1] = 3 / (m * (a * a + c * c));
      this.invI[2] = 3 / (m * (a * a + b * b));
      // 表面の点：6 つの面ごとに、面の中の格子（約 5 cm ごと）。面の縁からは少し内側（ins：角の丸みより内側）に置く
      // （同じ大きさの箱をぴったり重ねたとき、上の箱の点が下の箱の丸い縁に乗ると、押し戻す向きが斜めになって横へ揺れ、
      // 回り始めて崩れた。面の内側の点なら下の箱の平らな面に乗る）
      const h3 = this.semi;
      const pts: number[] = [];
      for (let ax = 0; ax < 3; ax++) {
        const u = (ax + 1) % 3, w = (ax + 2) % 3;
        const nu = Math.max(1, Math.round((2 * h3[u]) / 0.05)), nw = Math.max(1, Math.round((2 * h3[w]) / 0.05));
        const iu = Math.min(0.008, h3[u] * 0.3), iw = Math.min(0.008, h3[w] * 0.3);
        for (const sgn of [-1, 1]) for (let i = 0; i <= nu; i++) for (let j = 0; j <= nw; j++) {
          const pt = [0, 0, 0];
          pt[ax] = sgn * h3[ax];
          pt[u] = (i / nu * 2 - 1) * (h3[u] - iu);
          pt[w] = (j / nw * 2 - 1) * (h3[w] - iw);
          pts.push(pt[0], pt[1], pt[2]);
        }
      }
      this.samples = new Float32Array(pts);
    } else this.samples = new Float32Array(0);
  }

  get name() {
    return this.label;
  }

  wake() {
    if (this.fixed) return;
    this.awake = true;
    this.restT = 0;
  }
}

// ---------------- 小さな数学（四元数と楕円体） ----------------

/** 四元数で回す（out = q v q⁻¹） */
export function qrot(q: Q4, x: number, y: number, z: number, out: V3 = [0, 0, 0]): V3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** 逆に回す（世界 → 物の座標） */
function qinv(q: Q4, x: number, y: number, z: number, out: V3 = [0, 0, 0]): V3 {
  return qrot([-q[0], -q[1], -q[2], q[3]], x, y, z, out);
}

/** 角速度 w で dt 回す */
function qintegrate(q: Q4, w: V3, dt: number) {
  const [x, y, z, s] = q;
  const hx = w[0] * dt * 0.5, hy = w[1] * dt * 0.5, hz = w[2] * dt * 0.5;
  q[0] = x + hx * s + hy * z - hz * y;
  q[1] = y + hy * s + hz * x - hx * z;
  q[2] = z + hz * s + hx * y - hy * x;
  q[3] = s - hx * x - hy * y - hz * z;
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
}

/** 四元数の積 a ⊗ b */
export function qmul(a: readonly number[], b: readonly number[], out: Q4 = [0, 0, 0, 1]): Q4 {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** 共役（単位四元数の逆） */
export function qconj(q: readonly number[]): Q4 {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** 箱の角の丸み（当たり・見た目。角で引っかかって止まらない） */
const BOX_ROUND = 0.005;

/** 箱（半分の大きさ h、角の丸み BOX_ROUND）の符号付き距離（物の座標の点） */
export function boxSd(h: readonly number[], x: number, y: number, z: number): number {
  const qx = Math.abs(x) - h[0] + BOX_ROUND, qy = Math.abs(y) - h[1] + BOX_ROUND, qz = Math.abs(z) - h[2] + BOX_ROUND;
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return out + Math.min(Math.max(qx, qy, qz), 0) - BOX_ROUND;
}

/** 箱の外向きの法線（物の座標。点がいちばん近い面・辺・角から） */
function boxNormalLocal(h: readonly number[], x: number, y: number, z: number, out: V3): V3 {
  const qx = Math.abs(x) - h[0], qy = Math.abs(y) - h[1], qz = Math.abs(z) - h[2];
  if (qx > 0 || qy > 0 || qz > 0) {
    const nx = Math.max(qx, 0) * Math.sign(x), ny = Math.max(qy, 0) * Math.sign(y), nz = Math.max(qz, 0) * Math.sign(z);
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
  } else {
    out[0] = out[1] = out[2] = 0;
    if (qx >= qy && qx >= qz) out[0] = Math.sign(x) || 1;
    else if (qy >= qz) out[1] = Math.sign(y) || 1;
    else out[2] = Math.sign(z) || 1;
  }
  return out;
}

/** 楕円体の面のうち、世界の向き d（単位）へ最も出ている点の、中心からの位置（世界）。箱は角 */
function support(pr: Prop, dx: number, dy: number, dz: number, out: V3 = [0, 0, 0]): V3 {
  const l = qinv(pr.q, dx, dy, dz);
  const [a, b, c] = pr.semi;
  if (pr.box) return qrot(pr.q, Math.sign(l[0]) * a, Math.sign(l[1]) * b, Math.sign(l[2]) * c, out);
  const sx = a * l[0], sy = b * l[1], sz = c * l[2];
  const k = 1 / (Math.hypot(sx, sy, sz) || 1);
  return qrot(pr.q, a * sx * k, b * sy * k, c * sz * k, out);
}

/** 点 (x, y, z) に近い、楕円体の表面の点（物の座標。中心から見た向きで面へ写す近似）。箱はいちばん近い表面の点 */
function surfaceLocal(pr: Prop, x: number, y: number, z: number): V3 {
  const l = qinv(pr.q, x - pr.p[0], y - pr.p[1], z - pr.p[2]);
  const [a, b, c] = pr.semi;
  if (pr.box) {
    const cx = clamp(l[0], -a, a), cy = clamp(l[1], -b, b), cz = clamp(l[2], -c, c);
    if (cx !== l[0] || cy !== l[1] || cz !== l[2]) return [cx, cy, cz];
    // 内側：いちばん近い面へ
    const ex = a - Math.abs(l[0]), ey = b - Math.abs(l[1]), ez = c - Math.abs(l[2]);
    if (ex <= ey && ex <= ez) return [Math.sign(l[0] || 1) * a, l[1], l[2]];
    if (ey <= ez) return [l[0], Math.sign(l[1] || 1) * b, l[2]];
    return [l[0], l[1], Math.sign(l[2] || 1) * c];
  }
  const ux = l[0] / a, uy = l[1] / b, uz = l[2] / c;
  const k = 1 / (Math.hypot(ux, uy, uz) || 1);
  return [a * ux * k, b * uy * k, c * uz * k];
}

/** 外から見た、点 (x, y, z) から楕円体の表面までのおおよその距離（箱は正確な距離） */
function surfaceDist(pr: Prop, x: number, y: number, z: number): number {
  if (pr.box) {
    const l = qinv(pr.q, x - pr.p[0], y - pr.p[1], z - pr.p[2]);
    return boxSd(pr.semi, l[0], l[1], l[2]);
  }
  const s = surfaceLocal(pr, x, y, z);
  const w = qrot(pr.q, s[0], s[1], s[2]);
  const dx = x - pr.p[0], dy = y - pr.p[1], dz = z - pr.p[2];
  const inside = Math.hypot(dx, dy, dz) < Math.hypot(w[0], w[1], w[2]);
  const d = Math.hypot(dx - w[0], dy - w[1], dz - w[2]);
  return inside ? -d : d;
}

// ---------------- 物（小石・貝殻・重い石） ----------------

/**
 * 挟んでいる物（1 本の鋏）：物・つかみ点（物の座標。滑ると書き換わる）・鋏の構えの前・今のフレームの位置。
 * grip = 握る強さ（0..1。1 = 従来どおり。弱いと摩擦で支えられる力 gripFriction が腕の力より小さくなり、つかみ点が滑る）。
 * qc = 鋏の向き（世界）・rel = 挟んだときの鋏に対する物の向き（1 本で挟んでいる間、強く握るほど鋏と一緒に回る。省略 = 回さない）
 */
export interface HoldReq {
  prop: Prop;
  local: V3;
  a0: V3;
  a1: V3;
  grip?: number;
  qc?: readonly number[] | null;
  rel?: readonly number[] | null;
}

/** 物の時間を進めた結果（1 本の鋏）：ばねの力（世界、刻みで平均）・伸び・滑った距離（このフレーム） */
export interface HoldRes {
  force: V3;
  stretch: number;
  slide: number;
}

/** 鋏の先（開いた鋏で物を押す。挟んでいる物は押さない） */
export interface ClawTip {
  p: readonly number[];
  r: number;
  skip: Prop | null;
}

/** 1 刻みのばねの要求（刻みの間で補間した構え） */
interface HoldStep {
  a: V3;
  av: V3;
  req: HoldReq;
  out: HoldRes;
}

export interface PropStats {
  steps: number;
  awake: number;
  maxSpeed: number;
  /** 固体の中へ入った（押し戻した後も中に残った）回数・戻した回数 */
  deep: number;
  respawn: number;
}

export class PropSystem {
  readonly props: Prop[] = [];
  readonly stats: PropStats = { steps: 0, awake: 0, maxSpeed: 0, deep: 0, respawn: 0 };
  private acc = 0;
  private lastEdits = -1;
  private readonly tmp: V3 = [0, 0, 0];
  private readonly tmp2: V3 = [0, 0, 0];

  /** 箱の物（積み木）：世界の当たり判定（AquariumWorld.dyn）に入れる。いま進めている箱は自分を含めない（exclude） */
  private readonly boxes: Prop[] = [];
  private exclude: Prop | null = null;
  /** 箱の全体の外接箱（遠い点は箱を調べない） */
  private readonly bmin: V3 = [0, 0, 0];
  private readonly bmax: V3 = [0, 0, 0];

  constructor(private readonly world: AquariumWorld) {
    world.dyn = this;
  }

  /** 動かない箱を置く（中心 p・半分の大きさ semi・向き yaw）。起きない・挟めない */
  addFixed(id: string, kind: PropKind, p: readonly number[], semi: readonly number[], yaw = 0): Prop {
    const pr = new Prop(id, kind, 1, [p[0], p[1], p[2]], yaw, { semi: [semi[0], semi[1], semi[2]] });
    pr.fixed = true;
    pr.awake = false;
    this.props.push(pr);
    this.boxes.push(pr);
    this.boxBounds();
    return pr;
  }

  /** 地面の上に置く（x, z、探し始める高さ y、向き、大きさ） */
  add(id: string, kind: PropKind, x: number, z: number, yFrom: number, scale = 1, yaw = 0): Prop {
    const spec = PROP_KIND[kind];
    const ground = this.world.contactSurfaceBelow(x, yFrom, z);
    const pr = new Prop(id, kind, scale, [x, ground + spec.semi[1] * scale + 0.01, z], yaw);
    this.props.push(pr);
    if (pr.box) {
      this.boxes.push(pr);
      this.boxBounds();
    }
    return pr;
  }

  /** 箱の全体の外接箱を作り直す（動いた後） */
  private boxBounds() {
    this.bmin.fill(Infinity);
    this.bmax.fill(-Infinity);
    for (const b of this.boxes) for (let i = 0; i < 3; i++) {
      this.bmin[i] = Math.min(this.bmin[i], b.p[i] - b.rb);
      this.bmax[i] = Math.max(this.bmax[i], b.p[i] + b.rb);
    }
  }

  /** 箱（積み木）までの距離（AquariumWorld.contactSolid が使う：カニ・小石・生き物が箱に乗る・ぶつかる）。exclude の箱は除く */
  /**
   * 動かせる箱だけへの距離（石の床は数えない）。ハサミ集中モードでカニが寄る先に積み木があるか。
   * 上面が minTop より低い箱（平たい石・寝た棒：カニは上に乗る・またぐ。体で横から押さない）は数えない
   */
  movableDist(x: number, y: number, z: number, minTop = -Infinity): number {
    let d = 1e3;
    for (const b of this.boxes) {
      if (b.fixed) continue;
      const [qx, qy, qz, qw] = b.q;
      const ext = Math.abs(2 * (qx * qy + qz * qw)) * b.semi[0] + Math.abs(1 - 2 * (qx * qx + qz * qz)) * b.semi[1] + Math.abs(2 * (qy * qz - qx * qw)) * b.semi[2];
      if (b.p[1] + ext < minTop) continue;
      const dx = x - b.p[0], dy = y - b.p[1], dz = z - b.p[2];
      if (Math.hypot(dx, dy, dz) - b.rb * 1.75 > d) continue;
      const l = qinv(b.q, dx, dy, dz, this.tmpL);
      d = Math.min(d, boxSd(b.semi, l[0], l[1], l[2]));
    }
    return d;
  }

  dist(x: number, y: number, z: number): number {
    if (x < this.bmin[0] - 0.5 || x > this.bmax[0] + 0.5 || y < this.bmin[1] - 0.5 || y > this.bmax[1] + 0.5 || z < this.bmin[2] - 0.5 || z > this.bmax[2] + 0.5) return 1e3;
    let d = 1e3;
    for (const b of this.boxes) {
      if (b === this.exclude) continue;
      const dx = x - b.p[0], dy = y - b.p[1], dz = z - b.p[2];
      const c = Math.hypot(dx, dy, dz) - b.rb * 1.75;
      if (c > d) continue;
      const l = qinv(b.q, dx, dy, dz, this.tmpL);
      d = Math.min(d, boxSd(b.semi, l[0], l[1], l[2]));
    }
    return d;
  }

  /** いちばん近い箱と、その外向きの法線（世界）。exclude の箱は除く */
  private nearestBox(x: number, y: number, z: number, n: V3): Prop | null {
    let best: Prop | null = null, bd = Infinity;
    for (const b of this.boxes) {
      if (b === this.exclude) continue;
      const l = qinv(b.q, x - b.p[0], y - b.p[1], z - b.p[2], this.tmpL);
      const d = boxSd(b.semi, l[0], l[1], l[2]);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (best) {
      const l = qinv(best.q, x - best.p[0], y - best.p[1], z - best.p[2], this.tmpL);
      boxNormalLocal(best.semi, l[0], l[1], l[2], this.tmpN);
      qrot(best.q, this.tmpN[0], this.tmpN[1], this.tmpN[2], n);
    }
    return best;
  }

  private readonly tmpL: V3 = [0, 0, 0];
  private readonly tmpN: V3 = [0, 0, 0];

  /** 動かない物 + 箱（skip の箱を除く）までの距離（集中モードの鋏の目標が地形・箱に入らない） */
  solidSkip(x: number, y: number, z: number, skip: Prop | null): number {
    const ex = this.exclude;
    this.exclude = skip && skip.box ? skip : null;
    const d = Math.min(this.world.staticContactSolid(x, y, z), this.dist(x, y, z));
    this.exclude = ex;
    return d;
  }

  /** 真下へ探った最初の上面（地形・箱。skip の箱は除く：挟んでいる箱の上へ鋏が上っていかない） */
  /** 地形（と動かない箱：石の床）だけの面の高さ。動かせる箱は数えない（ハサミ集中モードの段を越える判定） */
  terrainBelow(x: number, yFrom: number, z: number): number {
    return this.surfaceBelow(x, yFrom, z, this.boxes.filter((b) => !b.fixed));
  }

  surfaceBelow(x: number, yFrom: number, z: number, skip: readonly (Prop | null)[]): number {
    const sk = skip.filter((p): p is Prop => !!p && p.box);
    const f = (py: number) => {
      let d = this.world.staticContactSolid(x, py, z);
      if (py > this.bmin[1] - 0.5 && py < this.bmax[1] + 0.5) {
        for (const b of this.boxes) {
          if (sk.includes(b)) continue;
          const l = qinv(b.q, x - b.p[0], py - b.p[1], z - b.p[2], this.tmpL);
          d = Math.min(d, boxSd(b.semi, l[0], l[1], l[2]));
        }
      }
      return d;
    };
    let py = yFrom;
    for (let i = 0; i < 60; i++) {
      const d = f(py);
      if (d < 0.006) return py;
      py -= Math.max(d * 0.9, 0.01);
      if (py < ROOM.floorY) return ROOM.floorY;
    }
    return py;
  }

  /** 物のいちばん低い所の高さ（世界） */
  lowest(pr: Prop): number {
    const s = support(pr, 0, -1, 0);
    return pr.p[1] + s[1];
  }

  /** 物を取り除く（食べ終えた） */
  remove(pr: Prop) {
    const k = this.props.indexOf(pr);
    if (k >= 0) this.props.splice(k, 1);
    const kb = this.boxes.indexOf(pr);
    if (kb >= 0) this.boxes.splice(kb, 1);
    pr.held = false;
    pr.holders = 0;
    pr.awake = false;
  }

  /** 置いた所へ戻す（自動検証・水槽の外へ出てしまったとき） */
  reset(pr: Prop) {
    pr.p.splice(0, 3, ...pr.home);
    pr.q.splice(0, 4, ...pr.homeQ);
    pr.v.fill(0);
    pr.w.fill(0);
    pr.held = false;
    pr.holders = 0;
    pr.lostT = 0;
    pr.wake();
    if (pr.box) this.boxBounds();
  }

  /** 位置と向きを直接置く（保存から戻す・検証エリアを並べ直す）。眠らせずに起こす */
  place(pr: Prop, p: readonly number[], q: readonly number[]) {
    pr.p.splice(0, 3, p[0], p[1], p[2]);
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    pr.q.splice(0, 4, q[0] / l, q[1] / l, q[2] / l, q[3] / l);
    pr.v.fill(0);
    pr.w.fill(0);
    pr.lostT = 0;
    pr.wake();
    if (pr.box) this.boxBounds();
  }

  /** 近くの物を起こす（カニが触れた・掘った・盛った所） */
  wakeNear(x: number, y: number, z: number, r: number) {
    for (const pr of this.props) if (!pr.awake && Math.hypot(pr.p[0] - x, pr.p[1] - y, pr.p[2] - z) < r + pr.rb) pr.wake();
  }

  /**
   * 時間を進める。holds：挟んでいる物（右・左の鋏。別々の物）と、つかみ点（物の座標）、鋏の構えの位置の前・今のフレームの値（刻みの間は補間）。
   * 返り値：holds と同じ順に、挟んでいる物にばねがかけた力（世界。刻みで平均）と、ばねの伸び（最後の刻み）
   */
  updateMany(
    dt: number,
    crab: { x: number; y: number; z: number; radius: number; speed: number },
    holds: readonly HoldReq[],
    tips: readonly ClawTip[] = [],
  ): HoldRes[] {
    const out: HoldRes[] = holds.map(() => ({ force: [0, 0, 0] as V3, stretch: 0, slide: 0 }));
    // 同じ物を 2 本の鋏で挟むこともある（両方のハサミで持つ）。その物の刻みの中で両方のばねを掛ける
    const byProp = new Map<Prop, number[]>();
    holds.forEach((h, i) => {
      const a = byProp.get(h.prop);
      if (a) a.push(i);
      else byProp.set(h.prop, [i]);
    });
    const w = this.world;
    const edits = w.dig.stats.carves + w.dig.stats.fills;
    if (edits !== this.lastEdits) {
      if (this.lastEdits >= 0) for (const pr of this.props) pr.wake();
      this.lastEdits = edits;
    }
    const cy = crab.y + crab.radius;
    for (const pr of this.props) {
      if (pr.awake) continue;
      const d = Math.hypot(pr.p[0] - crab.x, pr.p[1] - cy, pr.p[2] - crab.z);
      // （箱は面までの距離で：体が押すのは面から 1.2 cm の所から。外接球で測ると、平たい石の横に立っているだけで毎フレーム起きて
      //   重かった（検証エリアの出発点で 2 枚 × 約 1.8 ms））
      if (pr.box ? d < crab.radius + pr.rb + 0.12 && surfaceDist(pr, crab.x, cy, crab.z) < crab.radius + 0.05 : d < crab.radius + pr.rb + 0.12) pr.wake();
      // 開いた鋏の先が触れそう
      else for (const t of tips) if (t.skip !== pr && Math.hypot(pr.p[0] - t.p[0], pr.p[1] - t.p[1], pr.p[2] - t.p[2]) < pr.rb + t.r + 0.03) pr.wake();
    }
    for (const h of holds) h.prop.wake();
    // 動いている箱の上・横の箱も起こす（下の箱を引き抜いたら上の箱が落ちる）
    // （止まりかけている箱は起こさない：眠った箱と起きている箱が互いに起こし合って、いつまでも眠れない）
    for (const a of this.boxes) {
      if (!a.awake || (!a.held && Math.hypot(a.v[0], a.v[1], a.v[2]) < 0.03 && Math.hypot(a.w[0], a.w[1], a.w[2]) < 0.2)) continue;
      for (const b of this.boxes) if (!b.awake && Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < a.rb + b.rb + 0.03) b.wake();
    }
    if (dt <= 0) return out;
    this.acc = Math.min(this.acc + dt, 0.05);
    let n = 0;
    const total = Math.max(1, Math.floor(this.acc / SUB));
    while (this.acc >= SUB) {
      this.acc -= SUB;
      n++;
      const f = n / total;
      for (const pr of this.props) {
        if (!pr.awake) continue;
        const his = byProp.get(pr);
        const hs: HoldStep[] | null = his
          ? his.map((i) => {
            const h = holds[i];
            return {
              a: [lerp(h.a0[0], h.a1[0], f), lerp(h.a0[1], h.a1[1], f), lerp(h.a0[2], h.a1[2], f)] as V3,
              av: [(h.a1[0] - h.a0[0]) / dt, (h.a1[1] - h.a0[1]) / dt, (h.a1[2] - h.a0[2]) / dt] as V3,
              req: h,
              out: out[i],
            };
          })
          : null;
        if (pr.box) this.stepBox(pr, SUB, hs, crab, tips);
        else this.stepProp(pr, SUB, hs, crab, tips);
      }
      this.collideProps();
      if (this.boxes.length) this.boxBounds();
      this.stats.steps++;
    }
    if (n > 0) for (const o of out) for (let i = 0; i < 3; i++) o.force[i] /= n;
    this.afterStep(dt);
    return out;
  }

  /**
   * 時間を進める（挟んでいる物は 1 つ）。hold：挟んでいる物と、つかみ点（物の座標）、鋏の構えの位置の前・今のフレームの値。
   * 返り値：挟んでいる物にばねがかけた力（世界。刻みで平均）と、ばねの伸び（最後の刻み）
   */
  update(
    dt: number,
    crab: { x: number; y: number; z: number; radius: number; speed: number },
    hold: HoldReq | null,
  ): HoldRes {
    const r = this.updateMany(dt, crab, hold ? [hold] : []);
    return r[0] ?? { force: [0, 0, 0], stretch: 0, slide: 0 };
  }

  /**
   * 鋏のばね 1 本（つかみ点にかける力を f に書く）。腕の力（arm：従来の握る力の上限）で頭打ちにし、さらに握る強さで支えられる
   * 摩擦（arm × gripFriction）を越えた分は、つかみ点が鋏の方へ滑る（物の表面に沿って。強く握れば滑らない）。
   * r = つかみ点（中心からの世界の向き）、vp = つかみ点の速さ、mEff = つかみ点で感じる重さ（減衰に使う）
   */
  private spring(pr: Prop, h: HoldStep, r: V3, vp: V3, mEff: number, dt: number, f: V3) {
    const a = h.a, gx = pr.p[0] + r[0], gy = pr.p[1] + r[1], gz = pr.p[2] + r[2];
    const ex = a[0] - gx, ey = a[1] - gy, ez = a[2] - gz;
    // 腕の力：軽い物（小石・貝殻）は小さく持てるので余裕がある（跳んだ瞬間に引っ張られても落とさない）。重い石（0.8 以上）は GRIP_FORCE のまま
    const arm = GRIP_FORCE * (1 + 1.5 * Math.max(0, 1 - pr.mass / 0.8));
    clawSpring(ex, ey, ez, h.av[0] - vp[0], h.av[1] - vp[1], h.av[2] - vp[2], mEff, arm, f);
    const fl = Math.hypot(f[0], f[1], f[2]);
    const cap = arm * gripFriction(h.req.grip ?? 1);
    if (fl > cap && fl > 1e-6) {
      const k = cap / fl;
      f[0] *= k; f[1] *= k; f[2] *= k;
      // 滑る：つかみ点を、構えにいちばん近い表面の点へ寄せる（越えた分が大きいほど速く）
      const L = h.req.local, t = surfaceLocal(pr, a[0], a[1], a[2]);
      const s = Math.min(1, (fl / cap - 1) * 6 * dt + 0.5 * dt);
      const ox = L[0], oy = L[1], oz = L[2];
      L[0] += (t[0] - L[0]) * s;
      L[1] += (t[1] - L[1]) * s;
      L[2] += (t[2] - L[2]) * s;
      // 表面へ戻し、少し内側へ（aimAt と同じ）
      const w = qrot(pr.q, L[0], L[1], L[2]);
      const sl = surfaceLocal(pr, pr.p[0] + w[0], pr.p[1] + w[1], pr.p[2] + w[2]);
      const kk = Math.max(0, 1 - 0.006 / (Math.hypot(sl[0], sl[1], sl[2]) || 1));
      L[0] = sl[0] * kk; L[1] = sl[1] * kk; L[2] = sl[2] * kk;
      h.out.slide += Math.hypot(L[0] - ox, L[1] - oy, L[2] - oz);
    }
    h.out.force[0] += f[0];
    h.out.force[1] += f[1];
    h.out.force[2] += f[2];
    h.out.stretch = Math.hypot(ex, ey, ez);
  }

  /**
   * 1 本で挟んでいる間、鋏と一緒に回す角速度（世界）：挟んだときの向き（rel）を鋏の向き（qc）に保つ。強く握るほど強く、
   * 重い物ほど弱い（握る力で回しきれない）。返り値は混ぜる重み（0 = 回さない：ぶら下がる・引きずる従来の動き）
   */
  private holdSpin(pr: Prop, h: HoldStep, wt: V3): number {
    const qc = h.req.qc, rel = h.req.rel;
    if (!qc || !rel) return 0;
    const g = clamp(h.req.grip ?? 1, 0, 1);
    // （面に触れている間は弱める：置いた物が面に沿って平らに落ち着く）
    const k = smoothstep(0.2, 0.85, g) * clamp(1.45 - pr.mass / 0.55, 0, 1) * (pr.contact ? 0.6 : 1);
    if (k <= 0) return 0;
    const tq = qmul(qc, rel);
    const e = qmul(tq, qconj(pr.q));
    const sg = e[3] < 0 ? -1 : 1;
    // （箱は慣性で回るので強め：片側の面を挟んで持った積み木が、重さで 5° ほどしか傾かない）
    const kr = pr.box ? 30 : 12;
    wt[0] = 2 * sg * e[0] * kr;
    wt[1] = 2 * sg * e[1] * kr;
    wt[2] = 2 * sg * e[2] * kr;
    return k;
  }

  /** 刻みを進めた後：止まった物を眠らせる・水槽の外や固体の中へ迷い込んだ物を置いた所へ戻す */
  private afterStep(dt: number) {
    const w = this.world;
    let awake = 0;
    for (const pr of this.props) {
      if (!pr.awake) continue;
      awake++;
      const sp = Math.hypot(pr.v[0], pr.v[1], pr.v[2]);
      this.stats.maxSpeed = Math.max(this.stats.maxSpeed, sp);
      if (!pr.held && pr.contact && sp < 0.04 && Math.hypot(pr.w[0], pr.w[1], pr.w[2]) < 0.15) pr.restT += dt;
      else pr.restT = 0;
      if (pr.restT > 0.5) {
        pr.awake = false;
        pr.v.fill(0);
        pr.w.fill(0);
      }
      // （箱は自分を当たりに含めない：地形・ガラス・ほかの箱の中に入ったか）
      this.exclude = pr;
      const lost = !Number.isFinite(pr.p[0] + pr.p[1] + pr.p[2] + pr.q[0] + pr.q[1] + pr.q[2] + pr.q[3]) || w.regionAt(pr.p[0], pr.p[1], pr.p[2]) !== 'tank' || w.contactSolid(pr.p[0], pr.p[1], pr.p[2]) < -pr.rm;
      this.exclude = null;
      pr.lostT = lost && !pr.held ? pr.lostT + dt : 0;
      if (pr.lostT > 1.5) {
        this.stats.respawn++;
        this.reset(pr);
      }
    }
    this.stats.awake = awake;
  }

  /** 1 刻み（楕円体の物）。挟んでいれば、ばねの力（物にかけた力）と伸びを hs の out へ足す */
  private stepProp(pr: Prop, dt: number, hs: HoldStep[] | null, crab: { x: number; y: number; z: number; radius: number }, tips: readonly ClawTip[]) {
    const w = this.world, S = pr.spec;
    const p = pr.p, v = pr.v;
    const anchor = hs !== null && hs.length > 0;
    // 水中かどうか（中心と水面の高さで連続的に）
    const level = w.waterLevelAt(p[0], p[1], p[2]);
    const s = smoothstep(level + pr.rm, level - pr.rm, p[1]);
    const g = lerp(G_AIR, S.sinkG, s);
    v[1] -= g * dt;
    // 水の抵抗（空気中は弱い）
    const kd = Math.exp(-dt * lerp(0.15, S.drag, s));
    v[0] *= kd; v[1] *= kd; v[2] *= kd;
    if (hs && hs.length) {
      // 向きの目標の角速度（ぶら下がる・引きずる + 1 本で強く握っている間は鋏と一緒に回る）
      const wt: V3 = [0, 0, 0];
      let any = false;
      for (const h of hs) {
        const local = h.req.local;
        // つかみ点（世界）とその速さ
        const r = qrot(pr.q, local[0], local[1], local[2], this.tmp);
        const wx = pr.w;
        const vp: V3 = [v[0] + wx[1] * r[2] - wx[2] * r[1], v[1] + wx[2] * r[0] - wx[0] * r[2], v[2] + wx[0] * r[1] - wx[1] * r[0]];
        this.spring(pr, h, r, vp, pr.mass, dt, this.tmp2);
        const fx = this.tmp2[0], fy = this.tmp2[1], fz = this.tmp2[2];
        v[0] += (fx / pr.mass) * dt;
        v[1] += (fy / pr.mass) * dt;
        v[2] += (fz / pr.mass) * dt;
        // 向き：つかみ点（中心から r）が力の向きへ来るよう回す（ぶら下がる・引きずると傾く。両方で持つと 2 点が引く向きへ並ぶ）
        const fn = Math.hypot(fx, fy, fz), rn = Math.hypot(r[0], r[1], r[2]);
        if (fn > 1e-4 && rn > 1e-4) {
          const ux = r[0] / rn, uy = r[1] / rn, uz = r[2] / rn, tx = fx / fn, ty = fy / fn, tz = fz / fn;
          // 床の上を引きずっている間は弱める（重い石が大きく傾いて砂へ食い込まない）
          const kk = 9 * clamp(fn / (pr.mass * Math.max(g, 1)), 0.2, 1.5) * (pr.contact ? 0.35 : 1);
          wt[0] += (uy * tz - uz * ty) * kk;
          wt[1] += (uz * tx - ux * tz) * kk;
          wt[2] += (ux * ty - uy * tx) * kk;
          any = true;
        }
      }
      // 1 本で強く握っている：鋏と一緒に回る（ぶら下がる動きと混ぜる）
      if (hs.length === 1) {
        const ws: V3 = [0, 0, 0];
        const k = this.holdSpin(pr, hs[0], ws);
        if (k > 0) {
          for (let i = 0; i < 3; i++) wt[i] = lerp(wt[i], ws[i], k);
          any = true;
        }
      }
      if (any) {
        const kw = 1 - Math.exp(-dt * 10);
        for (let i = 0; i < 3; i++) pr.w[i] += (wt[i] - pr.w[i]) * kw;
      }
    }
    // 回転の減衰（水中は強く）
    const kw = Math.exp(-dt * lerp(1.0, 3.5, s));
    pr.w[0] *= kw; pr.w[1] *= kw; pr.w[2] *= kw;
    // 位置と向きを進める（速さは 1 刻みで物の大きさを越えない = すり抜けない）
    const sp = Math.hypot(v[0], v[1], v[2]), vmax = (pr.rm * 0.8) / dt;
    if (sp > vmax) {
      const k = vmax / sp;
      v[0] *= k; v[1] *= k; v[2] *= k;
    }
    p[0] += v[0] * dt;
    p[1] += v[1] * dt;
    p[2] += v[2] * dt;
    qintegrate(pr.q, pr.w, dt);
    // カニの体（球）から押し出す
    const cy = crab.y + crab.radius;
    const dx = p[0] - crab.x, dy = p[1] - cy, dz = p[2] - crab.z, dl = Math.hypot(dx, dy, dz);
    const minD = crab.radius + pr.rm * 0.9;
    if (dl < minD && dl > 1e-5 && !pr.eating) {
      const nx = dx / dl, ny = dy / dl, nz = dz / dl, push = minD - dl;
      p[0] += nx * push; p[1] += ny * push; p[2] += nz * push;
      const vn = v[0] * nx + v[1] * ny + v[2] * nz;
      if (vn < 0) {
        v[0] -= nx * vn; v[1] -= ny * vn; v[2] -= nz * vn;
      }
    }
    // 開いた鋏の先（球）から押し出す（挟んでいる鋏は除く）
    for (const t of tips) {
      if (t.skip === pr) continue;
      const tx = p[0] - t.p[0], ty = p[1] - t.p[1], tz = p[2] - t.p[2], tl = Math.hypot(tx, ty, tz), md = t.r + pr.rm;
      if (tl >= md || tl < 1e-5) continue;
      const nx = tx / tl, ny = ty / tl, nz = tz / tl, push = Math.min(md - tl, 0.004);
      p[0] += nx * push; p[1] += ny * push; p[2] += nz * push;
      const vn = v[0] * nx + v[1] * ny + v[2] * nz;
      if (vn < 0) {
        v[0] -= nx * vn; v[1] -= ny * vn; v[2] -= nz * vn;
      }
      v[0] += nx * push * 30; v[1] += ny * push * 30; v[2] += nz * push * 30;
    }
    // 地形・ガラスとの当たり：楕円体の支点（面へ向かう向きの最も奥の点）を距離関数で調べて押し戻す
    pr.contact = false;
    for (let it = 0; it < 3; it++) {
      // 面の向きは中心で測る。地面の近くでは、その向き・真下・横 4 方向の支点を調べ、いちばん深い支点の所の面の向きで
      // 支点を取り直して押し戻す（傾いた物・坂・管の脇では、中心の向きの支点がいちばん深い点とは限らない。砂の距離関数は
      // 高さ場からの近似なので、坂の上りの側では横の支点の方が深いことがある）
      let n = w.contactNormal(p[0], p[1], p[2]);
      let o = support(pr, -n[0], -n[1], -n[2], this.tmp2);
      let d = w.contactSolid(p[0] + o[0], p[1] + o[1], p[2] + o[2]);
      if (d < SKIN + pr.rm) {
        for (const dir of PROBE_DIRS) {
          const o2 = support(pr, dir[0], dir[1], dir[2]);
          const d2 = w.contactSolid(p[0] + o2[0], p[1] + o2[1], p[2] + o2[2]);
          if (d2 < d) {
            o = o2;
            d = d2;
          }
        }
        if (d < SKIN) {
          const n2 = w.contactNormal(p[0] + o[0], p[1] + o[1], p[2] + o[2]);
          const o3 = support(pr, -n2[0], -n2[1], -n2[2]);
          const d3 = w.contactSolid(p[0] + o3[0], p[1] + o3[1], p[2] + o3[2]);
          n = n2;
          d = Math.min(d, d3);
        }
      }
      if (d >= SKIN) break;
      const push = SKIN - d;
      p[0] += n[0] * push; p[1] += n[1] * push; p[2] += n[2] * push;
      pr.contact = true;
      pr.cn[0] = n[0]; pr.cn[1] = n[1]; pr.cn[2] = n[2];
      // 面へ向かう速さを消す（速くぶつかったときだけ少しはね返る）。摩擦：消した速さに比例して横滑りを止める（静止摩擦のしきい値）
      const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
      if (vn < 0) {
        const e = -vn > 0.6 ? S.bounce : 0;
        const tx = v[0] - n[0] * vn, ty = v[1] - n[1] * vn, tz = v[2] - n[2] * vn;
        const tl = Math.hypot(tx, ty, tz);
        // 床では、この刻みで足した重力の速さが vn に入っているので、重さの分の押し付けの摩擦（静止摩擦のしきい値 μg）になる
        const fr = S.mu * -vn;
        const kt = tl > fr ? (tl - fr) / tl : 0;
        v[0] = tx * kt - n[0] * vn * e;
        v[1] = ty * kt - n[1] * vn * e;
        v[2] = tz * kt - n[2] * vn * e;
      }
      // 触れている間は回転を弱める（転がり続けない）
      const kr = Math.exp(-dt * 8);
      pr.w[0] *= kr; pr.w[1] *= kr; pr.w[2] *= kr;
    }
    if (w.contactSolid(p[0], p[1], p[2]) < -pr.rm * 0.5) this.stats.deep++;
    // 床に置かれた（挟んでいない）物は、底（物の下 −y）を面へ向けて落ち着く
    if (pr.contact && !anchor && pr.cn[1] > 0.3) {
      const up = qrot(pr.q, 0, 1, 0, this.tmp);
      const n = pr.cn;
      const k = 6;
      const kw2 = 1 - Math.exp(-dt * 10);
      // 物の上（+y）を面の法線へ寄せる角速度（上 × 法線）。裏返っている（ほぼ逆向き）ときは物の横の軸で起こす
      const wt: V3 = [(up[1] * n[2] - up[2] * n[1]) * k, (up[2] * n[0] - up[0] * n[2]) * k, (up[0] * n[1] - up[1] * n[0]) * k];
      if (up[0] * n[0] + up[1] * n[1] + up[2] * n[2] < -0.2 && Math.hypot(wt[0], wt[1], wt[2]) < 0.5 * k) {
        const ax = qrot(pr.q, 1, 0, 0, this.tmp2);
        wt[0] += ax[0] * k; wt[1] += ax[1] * k; wt[2] += ax[2] * k;
      }
      for (let i = 0; i < 3; i++) pr.w[i] += (wt[i] - pr.w[i]) * kw2;
    }
    // 部屋の外へは出ない（水槽の外へ持ち出せないので念のため）
    p[0] = clamp(p[0], ROOM.minX + pr.rb, ROOM.maxX - pr.rb);
    p[1] = clamp(p[1], ROOM.floorY + pr.rb, Math.min(ROOM.ceilY, TANK.topY + 2) - pr.rb);
    p[2] = clamp(p[2], ROOM.minZ + pr.rb, ROOM.maxZ - pr.rb);
  }

  // ---------------- 箱（積み木）：剛体 ----------------

  /**
   * 箱の当たりを速く調べる下ごしらえ（1 つの小刻みに 1 回）：近くの箱（外接球が届く物だけ）と、中心での地形の距離と向き
   * （地形を平面で近似して、明らかに離れている点は正確に調べない）
   */
  private prepFast(pr: Prop) {
    const F = this.fastS, c = pr.p, w = this.world;
    F.cx = c[0]; F.cy = c[1]; F.cz = c[2];
    F.cand.length = 0;
    for (const b of this.boxes) if (b !== pr && Math.hypot(b.p[0] - c[0], b.p[1] - c[1], b.p[2] - c[2]) < b.rb * 1.75 + pr.rb * 1.75 + 0.05) F.cand.push(b);
    const d0 = w.staticContactSolid(c[0], c[1], c[2]);
    F.d0 = d0;
    F.far = d0 > pr.rb * 1.8 + 0.08;
    if (F.far) return;
    const e = 0.03;
    const gx = w.staticContactSolid(c[0] + e, c[1], c[2]) - w.staticContactSolid(c[0] - e, c[1], c[2]);
    const gy = w.staticContactSolid(c[0], c[1] + e, c[2]) - w.staticContactSolid(c[0], c[1] - e, c[2]);
    const gz = w.staticContactSolid(c[0], c[1], c[2] + e) - w.staticContactSolid(c[0], c[1], c[2] - e);
    F.gx = gx / (2 * e); F.gy = gy / (2 * e); F.gz = gz / (2 * e);
  }

  private readonly fastS = { on: false, cx: 0, cy: 0, cz: 0, d0: 0, gx: 0, gy: 0, gz: 0, far: false, cand: [] as Prop[] };

  /** 地形（動かない物）までの距離（箱の小刻みの中では平面の近似で離れた点を飛ばす） */
  private staticAt(x: number, y: number, z: number, need = 0.02): number {
    const F = this.fastS;
    if (F.on) {
      if (F.far) return 1e3;
      const dx = x - F.cx, dy = y - F.cy, dz = z - F.cz;
      const da = F.d0 + F.gx * dx + F.gy * dy + F.gz * dz;
      // 平面の近似が十分離れていれば正確に調べない（曲がった地形・岩の角を見落とさないよう、中心から離れるほど広めに。
      // need = これより近い面だけが要る：箱の面が既にこれより近ければ、地形は調べなくてよい）
      if (da > need + 0.02 + 0.25 * Math.hypot(dx, dy, dz)) return da;
    }
    return this.world.staticContactSolid(x, y, z);
  }

  /** 箱までの距離（小刻みの中では近くの箱だけ） */
  private boxAt(x: number, y: number, z: number): number {
    const F = this.fastS;
    if (!F.on) return this.dist(x, y, z);
    let d = 1e3;
    for (const b of F.cand) {
      const l = qinv(b.q, x - b.p[0], y - b.p[1], z - b.p[2], this.tmpL);
      d = Math.min(d, boxSd(b.semi, l[0], l[1], l[2]));
    }
    return d;
  }

  /**
   * 世界の当たり（箱どうしを含む。exclude = いま進めている箱）と、その外向きの法線（n。only を渡すと、距離が only より
   * 小さいときだけ法線を求める）
   */
  private contact(x: number, y: number, z: number, n: V3 | null, only = Infinity): number {
    const w = this.world;
    const db = this.boxAt(x, y, z);
    const ds = this.staticAt(x, y, z, Math.min(db, only === Infinity ? 0.02 : only));
    this.fromBox = false;
    this.fromAbove = false;
    if (!n || Math.min(ds, db) >= only) return Math.min(ds, db);
    if (db < ds) {
      const b = this.nearestBox(x, y, z, n);
      if (!b) n.splice(0, 3, 0, 1, 0);
      this.fromBox = true;
      // 中心が自分より上の箱（上に載る・上から下ろされてくる）には押されない：上の箱が自分で押し戻る
      // （斜めの縁の向きで、下の箱が横へ押し出されないように）
      this.fromAbove = !!b && !!this.exclude && b.p[1] > this.exclude.p[1] + this.exclude.semi[1] * 0.4;
      return db;
    }
    const e = 0.02;
    const gx = w.staticContactSolid(x + e, y, z) - w.staticContactSolid(x - e, y, z);
    const gy = w.staticContactSolid(x, y + e, z) - w.staticContactSolid(x, y - e, z);
    const gz = w.staticContactSolid(x, y, z + e) - w.staticContactSolid(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    n[0] = gx / l; n[1] = gy / l; n[2] = gz / l;
    return ds;
  }

  /**
   * 箱の接触（jac の m 点：点 r・法線 n・押し戻す量 d）を同時に満たす補正を、正則化した最小二乗で解いて掛ける。
   * 行 a = [n, r × n]、A = Σ a aᵀ + ε·diag(1, 1, 1, Iw / m)、b = Σ a d、A x = b（6 × 6。部分ピボットの消去法）
   */
  private solveContacts(pr: Prop, m: number) {
    // 射影ガウス・ザイデル：点ごとの押し戻しの量（乗数 λ）を積み上げ、負（引っ張る）にはしない。何度か繰り返すと、平らな面の着地は
    // 平行移動に、重心が支えの外なら内側の支えの λ が 0 になって回る（倒れる）。押すことしかできない接触の正しい解に近づく
    const P = this.pgs;
    for (let j = 0; j < m; j++) {
      const J = this.jac[j], r = J.r, n = J.n, E = P[j];
      E.c[0] = r[1] * n[2] - r[2] * n[1];
      E.c[1] = r[2] * n[0] - r[0] * n[2];
      E.c[2] = r[0] * n[1] - r[1] * n[0];
      this.invIw(pr, E.c[0], E.c[1], E.c[2], E.ic);
      E.w = 1 / pr.mass + E.c[0] * E.ic[0] + E.c[1] * E.ic[1] + E.c[2] * E.ic[2];
      E.lam = 0;
    }
    const x = this.x6;
    x.fill(0);
    const im = 1 / pr.mass;
    for (let sweep = 0; sweep < 8; sweep++) {
      for (let j = 0; j < m; j++) {
        const J = this.jac[j], n = J.n, E = P[j];
        const got = n[0] * x[0] + n[1] * x[1] + n[2] * x[2] + E.c[0] * x[3] + E.c[1] * x[4] + E.c[2] * x[5];
        const nl = Math.max(0, E.lam + (J.d - got) / E.w);
        const dl = nl - E.lam;
        if (dl === 0) continue;
        E.lam = nl;
        x[0] += n[0] * dl * im; x[1] += n[1] * dl * im; x[2] += n[2] * dl * im;
        x[3] += E.ic[0] * dl; x[4] += E.ic[1] * dl; x[5] += E.ic[2] * dl;
      }
    }
    for (let j = 0; j < m; j++) this.jac[j].d = P[j].lam / pr.mass;
    if (!x.every(Number.isFinite)) return;
    const q = pr.q;
    pr.p[0] += x[0]; pr.p[1] += x[1]; pr.p[2] += x[2];
    const ax = x[3], ay = x[4], az = x[5];
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    q[0] += 0.5 * (ax * qw + ay * qz - az * qy);
    q[1] += 0.5 * (ay * qw + az * qx - ax * qz);
    q[2] += 0.5 * (az * qw + ax * qy - ay * qx);
    q[3] += 0.5 * (-ax * qx - ay * qy - az * qz);
    const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    q[0] /= ql; q[1] /= ql; q[2] /= ql; q[3] /= ql;
  }

  private readonly x6 = new Float64Array(6);
  private readonly pgs = Array.from({ length: 160 }, () => ({ c: [0, 0, 0] as V3, ic: [0, 0, 0] as V3, w: 1, lam: 0 }));

  /** 世界の向きのベクトル u を、箱の逆慣性で掛ける（世界の向きで返す） */
  private invIw(pr: Prop, ux: number, uy: number, uz: number, out: V3): V3 {
    const l = qinv(pr.q, ux, uy, uz, this.tmpL);
    return qrot(pr.q, l[0] * pr.invI[0], l[1] * pr.invI[1], l[2] * pr.invI[2], out);
  }

  /**
   * 位置の補正（点 r（中心からの世界の向き）を向き n へ dl だけ動かす。重さと慣性で中心の移動と回転に分ける：XPBD の剛体）。
   * 返り値は実際に掛けた補正の大きさ（乗数）
   */
  private correct(pr: Prop, r: V3, nx: number, ny: number, nz: number, dl: number): number {
    const cx = r[1] * nz - r[2] * ny, cy = r[2] * nx - r[0] * nz, cz = r[0] * ny - r[1] * nx;
    const ic = this.invIw(pr, cx, cy, cz, this.tmpC);
    const wgen = 1 / pr.mass + cx * ic[0] + cy * ic[1] + cz * ic[2];
    const lam = dl / wgen;
    pr.p[0] += (nx * lam) / pr.mass;
    pr.p[1] += (ny * lam) / pr.mass;
    pr.p[2] += (nz * lam) / pr.mass;
    // 向き：Δq = ½ [I⁻¹ (r × P), 0] q
    const ax = ic[0] * lam, ay = ic[1] * lam, az = ic[2] * lam;
    const q = pr.q;
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    q[0] += 0.5 * (ax * qw + ay * qz - az * qy);
    q[1] += 0.5 * (ay * qw + az * qx - ax * qz);
    q[2] += 0.5 * (az * qw + ax * qy - ay * qx);
    q[3] += 0.5 * (-ax * qx - ay * qy - az * qz);
    const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    q[0] /= ql; q[1] /= ql; q[2] /= ql; q[3] /= ql;
    return lam;
  }

  private readonly tmpC: V3 = [0, 0, 0];
  /** 最後の contact（法線つき）の面が箱だったか・その箱の中心が上か */
  private fromBox = false;
  private fromAbove = false;
  private readonly boxPrevP: V3 = [0, 0, 0];
  private readonly boxPrevQ: Q4 = [0, 0, 0, 1];
  private readonly boxPrevV: V3 = [0, 0, 0];
  /** 1 回の押し戻しで集める接触（ヤコビ法） */
  private readonly jac: { r: V3; n: V3; d: number; k: number }[] = Array.from({ length: 160 }, () => ({ r: [0, 0, 0] as V3, n: [0, 0, 0] as V3, d: 0, k: 0 }));
  private readonly boxPrevW: V3 = [0, 0, 0];
  /** 箱の接触（1 刻みの中）：点（体の座標）・法線・押し戻した量 */
  private readonly cts: { l: V3; n: V3; lam: number }[] = Array.from({ length: 160 }, () => ({ l: [0, 0, 0] as V3, n: [0, 0, 0] as V3, lam: 0 }));

  /**
   * 1 刻み（箱の物）：2 つの小刻み（1/240 秒）に分け、重力・浮力・水の抵抗・鋏のばね（つかみ点にかかる力 → 中心の加速と回転）・
   * 1 本で強く握っている間は鋏と一緒に回る力のモーメント → 位置と向きを進める → 表面の点が地形・ガラス・ほかの箱に入っていれば
   * 押し戻す（点ごとに重さと慣性で中心の移動と回転に分ける）→ 静止摩擦（接触点が横へずれた分を、押し戻した量 × 摩擦の係数まで
   * 戻す）→ 前の刻みとの差から速さと角速度を決める（位置に基づく剛体：Müller ほか 2020 の XPBD の剛体）。
   * ほかの箱は動かない物として当たる（片側だけ押す）。下の箱を引き抜くと上の箱は支えを失って落ちる・傾く（重心が外れれば倒れる）
   */
  private stepBox(pr: Prop, dt: number, hs: HoldStep[] | null, crab: { x: number; y: number; z: number; radius: number }, tips: readonly ClawTip[]) {
    const S = pr.spec, p = pr.p, v = pr.v, wv = pr.w, q = pr.q;
    const N = 2, h = dt / N;
    const r: V3 = [0, 0, 0], f: V3 = [0, 0, 0], n: V3 = [0, 0, 0], tmp: V3 = [0, 0, 0];
    this.exclude = pr;
    let contactAny = false;
    for (let sub = 0; sub < N; sub++) {
      const level = this.world.waterLevelAt(p[0], p[1], p[2]);
      const s = smoothstep(level + pr.rm, level - pr.rm, p[1]);
      v[1] -= lerp(G_AIR, S.sinkG, s) * h;
      const kd = Math.exp(-h * lerp(0.15, S.drag, s));
      v[0] *= kd; v[1] *= kd; v[2] *= kd;
      const kwd = Math.exp(-h * lerp(0.6, 2.4, s));
      wv[0] *= kwd; wv[1] *= kwd; wv[2] *= kwd;
      // 鋏のばね（つかみ点に力 → 中心の加速 + 力のモーメントで回る）
      if (hs) {
        for (const H of hs) {
          qrot(q, H.req.local[0], H.req.local[1], H.req.local[2], r);
          const vp: V3 = [v[0] + wv[1] * r[2] - wv[2] * r[1], v[1] + wv[2] * r[0] - wv[0] * r[2], v[2] + wv[0] * r[1] - wv[1] * r[0]];
          // つかみ点で感じる重さ（回転を含む。減衰をこの重さで決める：棒の端を持っても振動しない）
          const ex = H.a[0] - p[0] - r[0], ey = H.a[1] - p[1] - r[1], ez = H.a[2] - p[2] - r[2];
          const el = Math.hypot(ex, ey, ez) || 1;
          const nx = ex / el, ny = ey / el, nz = ez / el;
          const cx = r[1] * nz - r[2] * ny, cy = r[2] * nx - r[0] * nz, cz = r[0] * ny - r[1] * nx;
          const ic = this.invIw(pr, cx, cy, cz, tmp);
          const mEff = 1 / (1 / pr.mass + cx * ic[0] + cy * ic[1] + cz * ic[2]);
          // （力は 2 つの小刻みで同じ値を 2 回足すので、平均にするため半分ずつ記録する）
          const before = [H.out.force[0], H.out.force[1], H.out.force[2]];
          this.spring(pr, H, r, vp, mEff, h, f);
          for (let i = 0; i < 3; i++) H.out.force[i] = before[i] + f[i] / N;
          v[0] += (f[0] / pr.mass) * h;
          v[1] += (f[1] / pr.mass) * h;
          v[2] += (f[2] / pr.mass) * h;
          const tx = r[1] * f[2] - r[2] * f[1], ty = r[2] * f[0] - r[0] * f[2], tz = r[0] * f[1] - r[1] * f[0];
          const iw = this.invIw(pr, tx, ty, tz, tmp);
          wv[0] += iw[0] * h; wv[1] += iw[1] * h; wv[2] += iw[2] * h;
        }
        // 両方の鋏で持っている：2 本のばねが互いに引き合って震えないよう、回転と、2 本の間を行き来する動きを強く減衰
        if (hs.length >= 2) {
          const kr = Math.exp(-h * 14);
          wv[0] *= kr; wv[1] *= kr; wv[2] *= kr;
          // 2 本の構えの速さの平均へ寄せる（物は 2 本の鋏と一緒に動く）
          const ax = (hs[0].av[0] + hs[1].av[0]) / 2, ay = (hs[0].av[1] + hs[1].av[1]) / 2, az = (hs[0].av[2] + hs[1].av[2]) / 2;
          const kv = 1 - Math.exp(-h * 6);
          v[0] += (ax - v[0]) * kv; v[1] += (ay - v[1]) * kv; v[2] += (az - v[2]) * kv;
        }
        // 1 本で強く握っている：鋏と一緒に回る（向きのばね。握る力で頭打ち）
        if (hs.length === 1) {
          const wt: V3 = [0, 0, 0];
          const k = this.holdSpin(pr, hs[0], wt);
          if (k > 0) {
            const kw = 1 - Math.exp(-h * 40 * k);
            for (let i = 0; i < 3; i++) wv[i] += (wt[i] - wv[i]) * kw;
          }
        }
      }
      // 速さの上限（1 刻みで大きさを越えない）
      const sp = Math.hypot(v[0], v[1], v[2]), vmax = (Math.min(...pr.semi) * 1.5) / h;
      if (sp > vmax) {
        const k = vmax / sp;
        v[0] *= k; v[1] *= k; v[2] *= k;
      }
      const wl = Math.hypot(wv[0], wv[1], wv[2]);
      if (wl > 25) for (let i = 0; i < 3; i++) wv[i] *= 25 / wl;
      this.boxPrevP.splice(0, 3, p[0], p[1], p[2]);
      this.boxPrevQ.splice(0, 4, q[0], q[1], q[2], q[3]);
      this.boxPrevV.splice(0, 3, v[0], v[1], v[2]);
      this.boxPrevW.splice(0, 3, wv[0], wv[1], wv[2]);
      p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;
      qintegrate(q, wv, h);
      // 当たり：中心が十分離れていれば調べない
      let nc = 0;
      this.prepFast(pr);
      this.fastS.on = true;
      const far = this.contact(p[0], p[1], p[2], null) > pr.rb + 0.02;
      if (!far) {
        const SM = pr.samples;
        for (let it = 0; it < 2; it++) {
          // 押し戻しは同じ姿勢で全部の点の分を求めてから、平均して掛ける（ヤコビ法。1 点ずつ順に直すと、平らな面で着地しただけで
          // 先に直した角の側へ傾いてしまい、積み重ねが崩れた）
          let m = 0;
          // 上を向いている面の点は調べない（触れるのは上に載った箱だけで、それには押されない。挟んで天井へ押し当てるときは調べる）
          const up = qrot(q, 0, 1, 0, tmp), uy = up[1], ux = qrot(q, 1, 0, 0)[1], uz = qrot(q, 0, 0, 1)[1];
          const held = !!hs && hs.length > 0;
          for (let k = 0; k < SM.length; k += 3) {
            if (!held) {
              // 点の面の外向き（体の座標の軸のうち、半分の大きさに一致する成分）
              const fy = Math.abs(Math.abs(SM[k + 1]) - pr.semi[1]) < 1e-6 ? Math.sign(SM[k + 1]) * uy : 0;
              const fx = Math.abs(Math.abs(SM[k]) - pr.semi[0]) < 1e-6 ? Math.sign(SM[k]) * ux : 0;
              const fz = Math.abs(Math.abs(SM[k + 2]) - pr.semi[2]) < 1e-6 ? Math.sign(SM[k + 2]) * uz : 0;
              if (fx > 0.75 || fy > 0.75 || fz > 0.75) continue;
            }
            qrot(q, SM[k], SM[k + 1], SM[k + 2], r);
            const d = this.contact(p[0] + r[0], p[1] + r[1], p[2] + r[2], n, SKIN);
            if (d >= SKIN) continue;
            // 上に載っている箱には押されない（積み重ねは下から順に支える：上の箱は自分で下の箱の上へ押し戻る。
            // 下の箱まで上の箱から逃げると、床との間で挟まれて弾き出される）
            if (this.fromBox && (n[1] < -0.55 || this.fromAbove)) continue;
            if (m >= this.jac.length) break;
            const J = this.jac[m++];
            J.r[0] = r[0]; J.r[1] = r[1]; J.r[2] = r[2];
            J.n[0] = n[0]; J.n[1] = n[1]; J.n[2] = n[2];
            J.d = SKIN - d;
            J.k = k;
          }
          // 近くの（動く）箱の表面の点が、この箱に入っていれば、その点でも押し戻す（支えの縁＝下の箱の角・辺を接点にする：
          // 自分の点だけでは、ずらして積んだときに支えの範囲が点の間隔の分だけ狭く見え、重心が支えの内でも倒れた）
          for (const C of this.fastS.cand) {
            if (C.fixed || C.p[1] > p[1] + pr.semi[1] * 0.4) continue;
            const CS = C.samples;
            for (let k = 0; k < CS.length; k += 3) {
              if (m >= this.jac.length) break;
              const s = qrot(C.q, CS[k], CS[k + 1], CS[k + 2], tmp);
              const sx = C.p[0] + s[0], sy = C.p[1] + s[1], sz = C.p[2] + s[2];
              if (Math.hypot(sx - p[0], sy - p[1], sz - p[2]) > pr.rb * 1.75) continue;
              const l = qinv(q, sx - p[0], sy - p[1], sz - p[2], this.tmpL);
              const d = boxSd(pr.semi, l[0], l[1], l[2]);
              if (d >= SKIN) continue;
              // 押す向き = この箱の表面の外向きの逆（点を箱の外へ出す向きに、箱を動かす）
              const nl = boxNormalLocal(pr.semi, l[0], l[1], l[2], this.tmpN);
              const nw = qrot(q, -nl[0], -nl[1], -nl[2]);
              if (nw[1] < -0.55) continue;
              const J = this.jac[m++];
              J.r[0] = sx - p[0]; J.r[1] = sy - p[1]; J.r[2] = sz - p[2];
              J.n[0] = nw[0]; J.n[1] = nw[1]; J.n[2] = nw[2];
              J.d = SKIN - d;
              J.k = -1;
            }
          }
          if (m === 0) break;
          // 全部の点を同時に直す剛体の補正（中心の移動 Δp と回転 Δθ の 6 つ）を最小二乗で解く：
          // Σ (n·Δp + (r×n)·Δθ − d)² + 正則化（重さ・慣性に比例）を最小にする。平らな面の着地・片側だけ載っている（重心は支えの内）は
          // 平行移動になり、支えの外に重心があるとき（1 点だけで支えている）は回る（倒れる）
          this.solveContacts(pr, m);
          for (let j = 0; j < m; j++) {
            const J = this.jac[j];
            const lam = J.d * pr.mass;
            // 接触の記録（摩擦・速さの段）：最初の回は新しく、2 回目からは同じ点へ足す（ほかの箱の点は記録しない）
            const k = J.k;
            if (k < 0) continue;
            let c = null;
            for (let jj = 0; jj < nc; jj++) {
              const cc = this.cts[jj];
              if (cc.l[0] === SM[k] && cc.l[1] === SM[k + 1] && cc.l[2] === SM[k + 2]) {
                c = cc;
                break;
              }
            }
            if (!c && nc < this.cts.length) {
              c = this.cts[nc++];
              c.l[0] = SM[k]; c.l[1] = SM[k + 1]; c.l[2] = SM[k + 2];
              c.n[0] = J.n[0]; c.n[1] = J.n[1]; c.n[2] = J.n[2];
              c.lam = 0;
            }
            if (c) c.lam += lam;
          }
        }
        // 静止摩擦：接触点が前の刻みから横へずれた分を戻す（押し戻した量 × 摩擦の係数まで。越えたら動摩擦で一部だけ）
        for (let j = 0; j < nc; j++) {
          const c = this.cts[j];
          qrot(q, c.l[0], c.l[1], c.l[2], r);
          const r0 = qrot(this.boxPrevQ, c.l[0], c.l[1], c.l[2], tmp);
          const dx = p[0] + r[0] - this.boxPrevP[0] - r0[0], dy = p[1] + r[1] - this.boxPrevP[1] - r0[1], dz = p[2] + r[2] - this.boxPrevP[2] - r0[2];
          const dn = dx * c.n[0] + dy * c.n[1] + dz * c.n[2];
          const tx = dx - c.n[0] * dn, ty = dy - c.n[1] * dn, tz = dz - c.n[2] * dn;
          const tl = Math.hypot(tx, ty, tz);
          if (tl < 1e-9) continue;
          const lim = S.mu * Math.abs(c.lam) / pr.mass;
          const corr = tl < lim * 1.2 ? tl : tl * Math.min(1, (S.mu * 0.8 * Math.abs(c.lam) / pr.mass) / tl);
          if (corr > 0) this.correct(pr, r, -tx / tl, -ty / tl, -tz / tl, corr);
        }
        if (nc > 0) contactAny = true;
      }
      this.fastS.on = false;
      // カニの体（球）：横から押されたら動く（軽い物だけ。上に乗っているときは押さない）
      const cy = crab.y + crab.radius;
      if (pr.mass < 1 && !pr.eating) {
        const l = qinv(q, crab.x - p[0], cy - p[1], crab.z - p[2], this.tmpL);
        const d = boxSd(pr.semi, l[0], l[1], l[2]);
        if (d < crab.radius + 0.012) {
          boxNormalLocal(pr.semi, l[0], l[1], l[2], tmp);
          qrot(q, tmp[0], tmp[1], tmp[2], n);
          if (Math.abs(n[1]) < 0.7) {
            const push = crab.radius + 0.012 - d;
            p[0] -= n[0] * push; p[2] -= n[2] * push;
          }
        }
      }
      // 開いた鋏の先（球）：押す（点で押すので回る）
      for (const t of tips) {
        if (t.skip === pr) continue;
        const l = qinv(q, t.p[0] - p[0], t.p[1] - p[1], t.p[2] - p[2], this.tmpL);
        const d = boxSd(pr.semi, l[0], l[1], l[2]);
        if (d >= t.r) continue;
        boxNormalLocal(pr.semi, l[0], l[1], l[2], tmp);
        qrot(q, tmp[0], tmp[1], tmp[2], n);
        const sl = surfaceLocal(pr, t.p[0], t.p[1], t.p[2]);
        qrot(q, sl[0], sl[1], sl[2], r);
        // （1 小刻みに 3 mm まで：鋏の先が深く入っていても弾き飛ばさない。押し続ければ少しずつ動く。重い物ほど動かない）
        this.correct(pr, r, -n[0], -n[1], -n[2], Math.min(t.r - d, 0.003) * Math.min(1, 0.4 / pr.mass));
      }
      // 速さと角速度：前の刻みとの差
      v[0] = (p[0] - this.boxPrevP[0]) / h;
      v[1] = (p[1] - this.boxPrevP[1]) / h;
      v[2] = (p[2] - this.boxPrevP[2]) / h;
      const dq = qmul(q, qconj(this.boxPrevQ));
      const sg = dq[3] < 0 ? -1 : 1;
      wv[0] = (2 * sg * dq[0]) / h;
      wv[1] = (2 * sg * dq[1]) / h;
      wv[2] = (2 * sg * dq[2]) / h;
      // 速さの補正（XPBD の剛体の速さの段）：押し戻しで生まれた離れる向きの速さを消す（めり込みを直しただけで跳ねない）。
      // 速くぶつかったときだけ少しはね返る（はね返りの係数 × 押し戻す前の近づく速さ）
      for (let j = 0; j < nc; j++) {
        const c = this.cts[j];
        qrot(q, c.l[0], c.l[1], c.l[2], r);
        const n0 = c.n[0], n1 = c.n[1], n2 = c.n[2];
        const vn = (v[0] + wv[1] * r[2] - wv[2] * r[1]) * n0 + (v[1] + wv[2] * r[0] - wv[0] * r[2]) * n1 + (v[2] + wv[0] * r[1] - wv[1] * r[0]) * n2;
        const pv = this.boxPrevV, pw = this.boxPrevW;
        const vn0 = (pv[0] + pw[1] * r[2] - pw[2] * r[1]) * n0 + (pv[1] + pw[2] * r[0] - pw[0] * r[2]) * n1 + (pv[2] + pw[0] * r[1] - pw[1] * r[0]) * n2;
        // （押し戻す前から離れていく速さ＝倒れ始めた角が浮く・転がる、は残す。押し戻しで生まれた分だけ消す）
        const want = vn0 < -0.6 ? -S.bounce * vn0 : Math.max(vn0, 0);
        const dvn = want - vn;
        if (Math.abs(dvn) < 1e-6) continue;
        const cx = r[1] * n2 - r[2] * n1, cy = r[2] * n0 - r[0] * n2, cz = r[0] * n1 - r[1] * n0;
        const ic = this.invIw(pr, cx, cy, cz, tmp);
        const J = dvn / (1 / pr.mass + cx * ic[0] + cy * ic[1] + cz * ic[2]);
        // （離れる速さを消す・近づく速さを止める。どちらも 1 回の接触点ぶんだけ：同じ面の点が多いので重ねすぎない）
        const k = 1 / Math.max(1, nc * 0.5);
        v[0] += (n0 * J * k) / pr.mass; v[1] += (n1 * J * k) / pr.mass; v[2] += (n2 * J * k) / pr.mass;
        wv[0] += ic[0] * J * k; wv[1] += ic[1] * J * k; wv[2] += ic[2] * J * k;
      }
      // 触れている間は小さな速さ・回転を消す（止まった物が震えない）
      if (nc > 0) {
        const kr = Math.exp(-h * 6);
        wv[0] *= kr; wv[1] *= kr; wv[2] *= kr;
      }
    }
    this.exclude = null;
    pr.contact = contactAny;
    if (contactAny) pr.cn.splice(0, 3, 0, 1, 0);
    if (this.dist(p[0], p[1], p[2]) < -pr.rm) this.stats.deep++;
    p[0] = clamp(p[0], ROOM.minX + pr.rb, ROOM.maxX - pr.rb);
    p[1] = clamp(p[1], ROOM.floorY + pr.rb, Math.min(ROOM.ceilY, TANK.topY + 2) - pr.rb);
    p[2] = clamp(p[2], ROOM.minZ + pr.rb, ROOM.maxZ - pr.rb);
  }

  /** 物どうし（球で近似。重さの比で押し分ける）。箱どうしは世界の当たり（dist）で、箱と楕円体は箱の距離で押し分ける */
  private collideProps() {
    const P = this.props;
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const a = P[i], b = P[j];
        if (!a.awake && !b.awake) continue;
        if ((a.box && b.box) || a.fixed || b.fixed) continue;
        if (a.box || b.box) {
          this.collideBoxBall(a.box ? a : b, a.box ? b : a);
          continue;
        }
        const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], dz = b.p[2] - a.p[2];
        const d = Math.hypot(dx, dy, dz), minD = a.rm + b.rm;
        if (d >= minD || d < 1e-6) continue;
        a.wake();
        b.wake();
        const nx = dx / d, ny = dy / d, nz = dz / d, push = minD - d;
        const ka = b.mass / (a.mass + b.mass), kb = 1 - ka;
        a.p[0] -= nx * push * ka; a.p[1] -= ny * push * ka; a.p[2] -= nz * push * ka;
        b.p[0] += nx * push * kb; b.p[1] += ny * push * kb; b.p[2] += nz * push * kb;
        const rv = (b.v[0] - a.v[0]) * nx + (b.v[1] - a.v[1]) * ny + (b.v[2] - a.v[2]) * nz;
        if (rv < 0) {
          const j2 = -rv * 1.05;
          a.v[0] -= nx * j2 * ka; a.v[1] -= ny * j2 * ka; a.v[2] -= nz * j2 * ka;
          b.v[0] += nx * j2 * kb; b.v[1] += ny * j2 * kb; b.v[2] += nz * j2 * kb;
        }
      }
    }
  }

  /**
   * 箱と楕円体の物（小石・貝殻）：楕円体は世界の当たり（dist）で箱から押し出されるので、ここでは箱の側を重さの比で押し返す
   * （小石を箱へぶつけると箱が少し動く）
   */
  private collideBoxBall(bx: Prop, b: Prop) {
    const l = qinv(bx.q, b.p[0] - bx.p[0], b.p[1] - bx.p[1], b.p[2] - bx.p[2], this.tmpL);
    const d = boxSd(bx.semi, l[0], l[1], l[2]);
    if (d >= b.rm * 0.9) return;
    bx.wake();
    b.wake();
    const n = boxNormalLocal(bx.semi, l[0], l[1], l[2], this.tmpN);
    const nw = qrot(bx.q, n[0], n[1], n[2]);
    const push = (b.rm * 0.9 - d) * (b.mass / (bx.mass + b.mass));
    const sl = surfaceLocal(bx, b.p[0], b.p[1], b.p[2]);
    const r = qrot(bx.q, sl[0], sl[1], sl[2]);
    this.correct(bx, r, -nw[0], -nw[1], -nw[2], push);
  }

  /** 物の表面の点（物の座標）→ 世界 */
  toWorld(pr: Prop, l: readonly number[], out: V3 = [0, 0, 0]): V3 {
    qrot(pr.q, l[0], l[1], l[2], out);
    out[0] += pr.p[0];
    out[1] += pr.p[1];
    out[2] += pr.p[2];
    return out;
  }

  surfaceLocal(pr: Prop, x: number, y: number, z: number): V3 {
    return surfaceLocal(pr, x, y, z);
  }

  surfaceDist(pr: Prop, x: number, y: number, z: number): number {
    return surfaceDist(pr, x, y, z);
  }
}

// ---------------- 挟む（右の大きな鋏） ----------------

/** 鋏の見た目（CrabRig）から受け取る値 */
export interface ClawView {
  /** 構えた鋏の先（挟む所の目標。体に付いて動く） */
  readonly anchor: readonly number[];
  /** いま描いている鋏の先（挟む所） */
  readonly pinch: readonly number[];
  /** 鋏の付け根（届くかの線の始まり） */
  readonly shoulder: readonly number[];
  /** 鋏を目標へ伸ばしきれなかった距離 */
  readonly reachErr: number;
  /** 鋏（掌）の向き（世界の四元数。挟んだ物を鋏と一緒に回す。省略 = 回さない） */
  readonly handQ?: readonly number[];
}

/** ハサミ集中モード：鋏の口（描いている鋏の先）から挟める距離（物の表面まで） */
export const FOCUS_REACH = 0.07;
/**
 * 指の開き（rad）：ふだんの最大・物の太さから決める開き（指の間 = 鋏の大きさ × (0.005 + 0.1 sin 開き)）。
 * 太い物（指より大きい石・積み木）は全体を挟まず縁をつまむので、太さは指の長さ（鋏の大きさ × 0.03）で頭打ち
 */
export const OPEN_MAX = 0.62;
export function openForThick(t: number, k: number): number {
  return Math.asin(clamp((Math.min(t, 0.03 * k) / k - 0.005) / 0.1, 0.05, 0.95));
}

/**
 * 鋏で挟める生き物の体の一部（巣穴から出ているスナモグリの触角・鋏の付け根など。AquaTug の BurrowTug）。
 * 物（Prop）と違い、体の動き（穴からの引き出し・抵抗・伸び）は生き物の側が持つ。鋏の側はばね（clawSpring）でつなぐだけ
 */
export interface GrabCreature {
  readonly name: string;
  /** 案内を出す所（世界。見えている部分の中ほど・挟んでいる間はつかみ点）と、その大きさ */
  readonly p: readonly number[];
  readonly rb: number;
  /** 握る力の上限（この力を越えて引き続けると滑る） */
  readonly grip: number;
  /** 物より遠くから挟める分（省略 = CREATURE_BONUS：巣穴の触角。水草・エビ・小魚は 0） */
  readonly bonus?: number;
  /**
   * 鋏が届かない量がこれを越えたら滑り始める（省略 = SLIP_REACH × 1.6。水草は大きくしなって鋏から離れて見えにくいので広い）
   */
  readonly slipReach?: number;
  /**
   * 張っている間の、速さの上限の落ち方（省略 = TUG_SLOW。速さの上限 × (1 − slow × 張り²)）。水草は大きく（ふつうに歩いて引くと
   * 握る力の手前で釣り合って止まる：ダッシュで引いたときだけ握る力を越えて滑る）
   */
  readonly slow?: number;
  /** 挟む所の太さ（指の開きを合わせる。省略 = 4 cm） */
  thick?(): number;
  /** いま挟めるか（穴から見えている・抜けていない） */
  grabbable(): boolean;
  /** 見えている部分のうち from にいちばん近い点と、そこから表面までの距離（挟めないときは null） */
  nearest(from: readonly number[]): { p: V3; d: number } | null;
  /** 鋏を伸ばす所（世界。挟んでいる間のつかみ点。挟もうとしている間は狙った点） */
  gripPoint(): readonly number[];
  /** 狙う点を決める（鋏を閉じ始めた。at = nearest の点） */
  aim(at: readonly number[]): void;
  onGrab(): void;
  onRelease(kind: 'release' | 'slip' | 'pop'): void;
  /**
   * 挟んでいる間：鋏の構えの前・今のフレームの位置（a0 → a1、刻みの間は補間）で体を進める。
   * 返り値：ばねの力（つかみ点にかけた力。世界、刻みで平均）・頭打ちにする前の力 / 握る力 の最大（over。急に強く引いた）・
   * 生き物が暴れている間の 張力 × 暴れる強さ / 握る力（tugOver。暴れているのに引いている）・ばねの伸び・抜けたか
   */
  stepHeld(dt: number, a0: readonly number[], a1: readonly number[]): { force: V3; over: number; tugOver: number; stretch: number; done: boolean };
}

/** 岩・流木（動かない物）として挟める材質と名前 */
const FIXED_NAME: Partial<Record<SurfaceMaterial, string>> = { rock: '岩', wood: '流木' };
/** 動かない物を挟む距離（構えた鋏の先から面まで）・握る力 */
const FIXED_REACH = 0.2;
const FIXED_GRIP = GRIP_FORCE * 1.25;

/**
 * 岩・流木（固定された物）を挟む：物は動かず、つかんだ点と鋏をばねでつなぐので、離れようとするとカニの方が引き戻される
 * （ぶら下がる・踏ん張る）。強く引き続けると鋏が外れる（生き物と同じ滑りの仕組み）。
 * 押した瞬間に何も届かず、岩・流木の面が届くときだけ挟む（閉じたまま歩いて勝手に岩をつかまない）
 */
export class FixedGrip implements GrabCreature {
  name = '岩';
  readonly p: V3 = [0, 0, 0];
  readonly rb = 0.05;
  readonly grip = FIXED_GRIP;
  private held = false;

  constructor(private readonly world: AquariumWorld) {}

  grabbable(): boolean {
    return true;
  }

  nearest(from: readonly number[]): { p: V3; d: number } | null {
    const w = this.world;
    const d = w.climbSolid(from[0], from[1], from[2]);
    if (d > FIXED_REACH || d < -0.05) return null;
    const n = w.climbNormal(from[0], from[1], from[2]);
    const p: V3 = [from[0] - n[0] * d, from[1] - n[1] * d, from[2] - n[2] * d];
    const name = FIXED_NAME[w.surfaceMaterial(p[0] + n[0] * 0.02, p[1] + n[1] * 0.02, p[2] + n[2] * 0.02)];
    if (!name) return null;
    if (!this.held) this.name = name;
    return { p, d: Math.max(0, d) };
  }

  gripPoint(): readonly number[] {
    return this.p;
  }

  aim(at: readonly number[]) {
    this.p[0] = at[0];
    this.p[1] = at[1];
    this.p[2] = at[2];
  }

  onGrab() {
    this.held = true;
  }

  onRelease() {
    this.held = false;
  }

  stepHeld(dt: number, a0: readonly number[], a1: readonly number[]) {
    // 物は動かない（重さは大きく）：ばねの力がそのままカニへ返る
    const ex = a1[0] - this.p[0], ey = a1[1] - this.p[1], ez = a1[2] - this.p[2];
    const k = dt > 0 ? 1 / dt : 0;
    const out: V3 = [0, 0, 0];
    const raw = clawSpring(ex, ey, ez, (a1[0] - a0[0]) * k, (a1[1] - a0[1]) * k, (a1[2] - a0[2]) * k, 2.0, this.grip, out);
    return { force: out, over: raw / this.grip, tugOver: 0, stretch: Math.hypot(ex, ey, ez), done: false };
  }
}

/** 挟める物か生き物 */
export type Grabbable = Prop | GrabCreature;

/** 届く物・生き物と、構えた鋏の先からの距離・狙う点 */
interface Picked {
  prop: Prop | null;
  creature: GrabCreature | null;
  d: number;
  at: readonly number[];
}

export type GrabState = 'idle' | 'closing' | 'holding' | 'empty';

/** 離した・滑った・抜けた出来事（表示用） */
export type GrabEvent = { kind: 'grab' | 'release' | 'slip' | 'miss' | 'heavy' | 'pop'; prop: Grabbable | null };

/** カニへ返す、挟んだ物の手応え（CrabController の CrabInput.tow） */
export interface Tow {
  /** 加速度（世界） */
  ax: number;
  ay: number;
  az: number;
  /** 速さの上限に掛ける割合（重い物ほど小さい） */
  slow: number;
}

/**
 * 生き物を引っ張るときの反作用を受けるカニの重さ（物より重い = 足を砂に踏ん張っている。小さいと、生き物に穴へ
 * 引きずり込まれる）・速さの上限の落ち方（張力 / 握る力 の 2 乗に掛ける）
 */
const CRAB_MASS_TUG = 1.0;
const TUG_SLOW = 0.75;
/** 生き物が滑り落ちるまで：握る力を越えて引いている時間の上限（越えた量が大きいほど早く溜まる。緩めると減る） */
export const TUG_SLIP_T = 0.8;

export class GrabSystem {
  state: GrabState = 'idle';
  /** 挟んでいる物・挟もうとしている物（生き物のときは null で creature） */
  target: Prop | null = null;
  /** 挟んでいる・挟もうとしている生き物 */
  creature: GrabCreature | null = null;
  /** 挟める生き物（巣穴のスナモグリ。main が入れる） */
  readonly creatures: GrabCreature[] = [];
  /** つかみ点（物の座標） */
  local: [number, number, number] = [0, 0, 0];
  /** 閉じ具合（0 = 開き、1 = 閉じ）と、構えの重み */
  close = 0;
  private closeT = 0;
  private retryT = 0;
  private slipT = 0;
  private heavyT = 0;
  private prevAnchor: [number, number, number] | null = null;
  private prevCrab: [number, number, number] = [0, 0, 0];
  /** 生き物を挟んでいる間の、ならした鋏の構えの位置（離したら null） */
  private fAnchor: [number, number, number] | null = null;
  /** 挟んでいる物の手応え（次のフレームのカニの入力） */
  tow: Tow | null = null;
  /** ばねの伸び・力（表示・自動検証用） */
  stretch = 0;
  /** 重さの手応え（ばねの力 / 握る力 を約 0.4 秒でならした値。表示用：歩き出し・跳んだ瞬間の引っ張りでは跳ねない） */
  strain = 0;
  /** 生き物を引っ張っている：このフレームの 張力 / 握る力（ならさない）・握る力を越えて引いている量（頭打ち前の力 / 握る力） */
  load = 0;
  over = 0;
  readonly force: [number, number, number] = [0, 0, 0];
  readonly events: GrabEvent[] = [];
  readonly stats = { grabs: 0, releases: 0, slips: 0, misses: 0, touchGrabs: 0, maxStretch: 0, creatureGrabs: 0, creatureSlips: 0, pops: 0, maxOver: 0 };
  /** 押していない・挟める物の候補（案内の表示用） */
  hint: Grabbable | null = null;
  /** hint のつかみ点（案内の輪を出す所） */
  hintAt: V3 | null = null;
  /**
   * 近くにあるが、まだ鋏の届かない物（狙いの補助：挟むを押している間はカニがそちらへ鋏を向け、案内の輪を薄く出す）。
   * 体の中心から ASSIST_R 以内・体の前の半分の側だけ
   */
  near: { target: Grabbable; at: V3; d: number } | null = null;
  /** 腕の向きを動かしている（鋏を構えて見せる。CrabRig へ） */
  aiming = false;
  /** 景色の小石・貝殻（AquaDecor の、まだ動いていない物）：挟む候補に入れる。挟んだ瞬間に promote で物理の物にする */
  ghosts: () => Iterable<Prop> = () => [];
  promote: (pr: Prop) => void = () => {};
  /** 岩・流木（動かない物）を挟む */
  readonly fixed: FixedGrip;
  /**
   * 挟んだ物を口元へ運んで食べている（AquaEat。main が毎フレーム書く）：鋏が届かない・ばねが伸びた・強く引いたことによる
   * 滑りを止める（口元へ引き寄せている物を、構えを動かしたせいで落とさない）
   */
  feeding = false;
  /**
   * 握る強さ（main が毎フレーム書く。0..1）：ふだんは 1（ボタン）・ゲームパッドのトリガーの押し込み。ハサミ集中モード（focus）では
   * 開閉そのもの（離すと開き、押し込むほど閉じる。物に触れた後は押し込んだ分だけ握る力が増える）
   */
  squeeze = 1;
  /** ハサミ集中モード：狙いの補助を使わず、鋏の口のすぐ前の物だけを挟む。開閉は squeeze に従う（連続） */
  focus = false;
  /** 集中モードの閉じ具合（squeeze を閉じる速さで追った値）と、挟んだ後の握る強さ（0..1。触れた所から押し込んだ分） */
  private sq = 0;
  gripNow = 1;
  /** 挟む物の太さに合わせた指の開き（rad。触れた所）・近づく前の開き・触れる閉じ具合（0..1） */
  width = 0.3;
  preOpen = OPEN_MAX;
  c0 = 0.5;
  /** 挟んだときの、鋏に対する物の向き（鋏と一緒に回す） */
  private rel: Q4 | null = null;
  /** 最後に離した物（すぐ挟み直すときは優先し、少し遠くても届く）と、その残り時間 */
  private lastRel: { target: Grabbable; t: number } | null = null;
  /** 前のフレームの案内の物（狙いを切り替えにくくする：近い物が並んでいても、案内と違う物を挟まない） */
  private hintPrev: Grabbable | null = null;
  /** 離した・滑った位置（挟み直しの検証用） */
  readonly regrab = { releases: 0, quick: 0 };
  /** つかみ点が滑った距離の合計（握る力が足りない） */
  slid = 0;
  /** モードを切り替えた直後：押し直すまで挟んだまま（setCarry） */
  carry = false;

  /** 離して 0.5 秒以内の物（開いた鋏の先で押さない：離した瞬間に鋏の先が物の中にあり、弾き飛ばしていた） */
  get justReleased(): Prop | null {
    const L = this.lastRel;
    return L && L.t > 0.7 && L.target instanceof Prop ? L.target : null;
  }

  /**
   * モードの切り替え（通常 ↔ ハサミ集中）：挟んでいる物は、新しいモードで一度押し直すまで手放さない。開閉の状態も引き継ぐ
   * （閉じている鋏が切り替えた瞬間に開かない）
   */
  setMode(focus: boolean) {
    if (focus === this.focus) return;
    this.carry = this.state === 'holding';
    if (focus) {
      this.sq = this.state === 'holding' ? Math.min(1, this.c0 + 0.45) : 0;
      if (this.state === 'empty' || this.state === 'closing') {
        this.state = 'idle';
        this.target = null;
        this.creature = null;
      }
    } else if (this.state === 'closing') {
      this.state = 'idle';
      this.target = null;
      this.creature = null;
    }
    this.focus = focus;
    this.hint = null;
    this.near = null;
  }

  constructor(private readonly world: AquariumWorld, readonly props: PropSystem) {
    this.fixed = new FixedGrip(world);
  }

  /** 物を挟んだ（挟んでいる鋏の数を数える：両方のハサミで同じ物を持てる） */
  private holdProp(pr: Prop) {
    pr.holders++;
    pr.held = true;
    pr.wake();
  }

  private unholdProp(pr: Prop) {
    pr.holders = Math.max(0, pr.holders - 1);
    pr.held = pr.holders > 0;
    if (!pr.held) pr.eating = false;
    pr.wake();
  }

  /**
   * 食べ終えた：挟んでいた物・生き物を、出来事（離した音）を出さずに手放して鋏を空にする（物・生き物を世界から消すのは呼んだ側）。
   * 鋏は閉じたまま空（押し続けていても、一度離すまで次の物を挟まない：empty の待ち）
   */
  consume() {
    if (this.state === 'holding' && this.target) {
      this.unholdProp(this.target);
      this.target.eating = false;
    } else if (this.state === 'holding' && this.creature) this.creature.onRelease('release');
    this.state = 'empty';
    this.retryT = 0.8;
    this.target = null;
    this.creature = null;
    this.tow = null;
    this.slipT = 0;
    this.load = this.over = 0;
    this.fAnchor = null;
    this.feeding = false;
  }

  /** 挟んでいる・閉じている（鋏が使われている：穴掘りはできない） */
  get busy(): boolean {
    return this.state !== 'idle';
  }

  get holding(): Prop | null {
    return this.state === 'holding' ? this.target : null;
  }

  /** 挟んでいる生き物 */
  get holdingCreature(): GrabCreature | null {
    return this.state === 'holding' ? this.creature : null;
  }

  /** 挟んでいる物か生き物（表示用） */
  get held(): Grabbable | null {
    return this.holding ?? this.holdingCreature;
  }

  /** 滑りそうな度合い（0..1。生き物を握る力より強く引いている時間 / TUG_SLIP_T） */
  get warn(): number {
    return this.holdingCreature ? clamp(this.slipT / TUG_SLIP_T, 0, 1) : 0;
  }

  /**
   * 鋏の構え（CrabRig.grip へ渡す）。target = 鋏を伸ばす所（世界）。width = 物に触れる指の開き、pre = 近づく間の開き、
   * analog = 開閉が握る強さに従う（集中モード）、grip = 握る強さ
   */
  rigGrip(): { on: boolean; close: number; hold: boolean; target: [number, number, number] | null; shake: number; width: number; pre: number; analog: boolean; grip: number; c0: number } {
    const busy = this.state === 'closing' || this.state === 'holding';
    let t: [number, number, number] | null = null;
    if (busy && this.target) t = this.props.toWorld(this.target, this.local);
    else if (busy && this.creature) {
      const g = this.creature.gripPoint();
      t = [g[0], g[1], g[2]];
    }
    return {
      // （集中モードでは開いていても鋏の先をいつも目標へ：操作した所に鋏がある）
      on: this.state !== 'idle' || this.aiming || this.focus, close: this.close, hold: this.state === 'holding', target: t, shake: this.warn,
      width: this.width, pre: this.preOpen, analog: this.focus, grip: this.state === 'holding' ? this.gripNow : 0, c0: this.c0,
    };
  }

  /** 挟む物・生き物の太さから、指の開き（触れる所・近づく間）と触れる閉じ具合を決める（k = 鋏の大きさ） */
  private fitWidth(pr: Prop | null, cr: GrabCreature | null) {
    const k = this.armReach / ARM_REACH * CLAW_K_R;
    const t = pr ? 2 * Math.min(...pr.semi) : cr?.thick ? cr.thick() : 0.04;
    this.width = openForThick(t, k);
    this.preOpen = Math.max(OPEN_MAX, this.width + 0.12);
    // 集中モードで指が物に触れる押し込み（0.3〜0.7）：細い物ほど深く押し込んでから触れる。そこから先が握る強さ
    this.c0 = clamp(0.3 + 0.4 * (1 - this.width / OPEN_MAX), 0.3, 0.7);
  }

  /**
   * 物 pr をすぐ挟んだ状態にする（第 5 段階：引き抜いた・ちぎった水草を、そのまま挟んでいる物にする）。at = つかみ点（世界）
   */
  forceHold(pr: Prop, at: readonly number[]) {
    if (this.state !== 'idle') this.release();
    if (!this.props.props.includes(pr)) this.props.props.push(pr);
    this.state = 'holding';
    this.target = pr;
    this.creature = null;
    this.close = 1;
    this.local = this.props.surfaceLocal(pr, at[0], at[1], at[2]);
    this.holdProp(pr);
    this.fitWidth(pr, null);
    this.rel = null;
    this.qGrab = [pr.q[0], pr.q[1], pr.q[2], pr.q[3]];
    this.twistAtGrab = this.twist;
    if (this.focus) this.sq = Math.max(this.sq, this.c0 + 0.1);
    this.slipT = this.heavyT = 0;
    this.events.push({ kind: 'grab', prop: pr });
  }

  /** すぐ離す（瞬間移動・管に入った等）。kind = 離した理由（生き物が抜けたときは 'pop'） */
  release(kind: 'release' | 'slip' | 'pop' = 'release') {
    const was = this.state === 'holding' ? (this.target ?? this.creature) : null;
    if (was && kind !== 'pop') {
      this.lastRel = { target: was, t: 1.2 };
      this.regrab.releases++;
    }
    this.rel = null;
    if (this.state === 'holding' && this.target) {
      this.unholdProp(this.target);
      this.events.push({ kind: kind === 'pop' ? 'release' : kind, prop: this.target });
      if (kind === 'slip') this.stats.slips++;
      else this.stats.releases++;
    } else if (this.state === 'holding' && this.creature) {
      this.creature.onRelease(kind);
      this.events.push({ kind, prop: this.creature });
      if (kind === 'slip') {
        this.stats.slips++;
        this.stats.creatureSlips++;
      } else if (kind === 'pop') this.stats.pops++;
      else this.stats.releases++;
    }
    this.state = 'idle';
    this.target = null;
    this.creature = null;
    this.tow = null;
    this.slipT = 0;
    this.load = this.over = 0;
    this.fAnchor = null;
    this.feeding = false;
  }

  /**
   * 構えた鋏の先から届く物（物の表面までの距離が reach 以内。ガラス・岩越しには挟めない）。近い物が並んでいるときは、
   * 距離に、鋏の向き（付け根 → 構え）から外れた量・前のフレームの案内の物（切り替えにくくする）・すぐ挟み直す物（離して 1.2 秒）・
   * 狙いの補助で腕を向けていた物を足し引きした点数でいちばん良い物を選ぶ（案内の輪と挟む物が食い違わない・横の物を誤ってつかまない）
   */
  private pick(claw: ClawView, from: readonly number[], reach: number): Picked | null {
    let best: Picked | null = null;
    let bestS = Infinity;
    const sh = claw.shoulder;
    const fx0 = from[0] - sh[0], fy0 = from[1] - sh[1], fz0 = from[2] - sh[2], fl0 = Math.hypot(fx0, fy0, fz0) || 1;
    const quick = this.lastRel && this.lastRel.t > 0 ? this.lastRel.target : null;
    const nearT = this.near?.target ?? null;
    const score = (d: number, at: readonly number[], t: Grabbable): number => {
      const ax = at[0] - sh[0], ay = at[1] - sh[1], az = at[2] - sh[2], al = Math.hypot(ax, ay, az) || 1;
      const cos = (ax * fx0 + ay * fy0 + az * fz0) / (al * fl0);
      let s = d + (this.focus ? 0 : 0.05 * (1 - cos));
      if (t === this.hintPrev) s -= 0.025;
      if (t === quick) s -= 0.04;
      if (t === nearT) s -= 0.02;
      return s;
    };
    const test = (pr: Prop) => {
      // もう 1 本の鋏が挟んでいる物は、もう 1 か所を挟める（両方のハサミで持つ）。挟もうとしている途中の物・3 本目は挟まない
      const o = this.other;
      if (pr.fixed) return;
      if (pr.held && !(o && o.state === 'holding' && o.target === pr && pr.holders === 1)) return;
      if (o && o.state === 'closing' && o.target === pr) return;
      const rq = reach + (pr === quick ? 0.04 : 0);
      // 遠い物は楕円体の距離を測らない（景色の小石は数百個ある）
      if (Math.hypot(pr.p[0] - from[0], pr.p[1] - from[1], pr.p[2] - from[2]) > rq + pr.rb) return;
      const d = this.props.surfaceDist(pr, from[0], from[1], from[2]);
      if (d > rq) return;
      // 付け根からつかみ点までの間に固体（ガラス・岩・砂）が無い
      const l = this.props.surfaceLocal(pr, from[0], from[1], from[2]);
      const gp = this.props.toWorld(pr, l);
      // 両方で持つとき：もう 1 本のつかみ点のすぐそばは挟まない（鋏どうしが重ならない）
      if (o && o.target === pr && o.state === 'holding') {
        const og = this.props.toWorld(pr, o.local);
        if (Math.hypot(og[0] - gp[0], og[1] - gp[1], og[2] - gp[2]) < 0.06) return;
      }
      const s = score(d, gp, pr);
      if (s >= bestS) return;
      if (this.reachable(claw, gp, (x, y, z) => this.props.surfaceDist(pr, x, y, z) > 0.02)) {
        best = { prop: pr, creature: null, d, at: gp };
        bestS = s;
      }
    };
    for (const pr of this.props.props) test(pr);
    for (const pr of this.ghosts()) test(pr);
    // 巣穴の生き物：見えている部分（挟める所の球）。初心者でも狙えるよう、物より少し遠くから挟める（CREATURE_BONUS）。
    // 比べるときは足した分を引く（同じ距離なら物より生き物を選ぶ）。集中モードは足さない（鋏の口の前の物だけ）
    for (const cr of this.creatures) {
      // もう 1 本の鋏が挟んでいる生き物は挟まない（ゴカイの 2 か所目は、ゴカイの側が別の窓口 grip2 を出す）
      if (!cr.grabbable() || this.other?.creature === cr) continue;
      // 構えた鋏の先にいちばん近い点。腕の付け根から届かなければ、付け根にいちばん近い点も試す（腕を伸ばして挟む）
      for (const o of this.focus ? [from] : [from, claw.shoulder]) {
        const n = cr.nearest(o);
        if (!n) continue;
        const d0 = o === from ? n.d : (cr.nearest(from)?.d ?? n.d);
        const bonus = this.focus ? 0 : (cr.bonus ?? CREATURE_BONUS) + (cr === quick ? 0.04 : 0);
        const d = d0 - bonus;
        if (d0 > reach + bonus) continue;
        const s = score(d, n.p, cr);
        if (s >= bestS) continue;
        if (this.reachable(claw, n.p, (x, y, z) => (cr.nearest([x, y, z])?.d ?? 1) > 0.03, CREATURE_ARM_EXTRA)) {
          best = { prop: null, creature: cr, d, at: n.p };
          bestS = s;
          break;
        }
      }
    }
    return best;
  }

  /**
   * 狙いの補助：体の中心から ASSIST_R 以内で、体の前の半分の側にある、いちばん近い挟める物（届く物は除く。hint が出す）
   */
  private findNear(crab: CrabController): { target: Grabbable; at: V3; d: number } | null {
    const cx = crab.x, cy = crab.y + crab.radius, cz = crab.z;
    const fx = Math.sin(crab.heading), fz = Math.cos(crab.heading);
    let best: { target: Grabbable; at: V3; d: number } | null = null;
    const prev = this.near?.target ?? null;
    const consider = (target: Grabbable, at: readonly number[]) => {
      const dx = at[0] - cx, dy = at[1] - cy, dz = at[2] - cz;
      const d0 = Math.hypot(dx, dy, dz);
      // 前のフレームに腕を向けていた物は切り替えにくく（近い物が並んでいても腕が行ったり来たりしない）
      const d = target === prev ? d0 - 0.08 : d0;
      if (d0 > ASSIST_R || Math.abs(dy) > 0.45 || (best && d >= best.d)) return;
      // 体の前の側（横・後ろの物へ急に向き直らない）
      const hl = Math.hypot(dx, dz);
      if (hl > 0.05 && (dx * fx + dz * fz) / hl < -0.2) return;
      best = { target, at: [at[0], at[1], at[2]], d };
    };
    const scan = (pr: Prop) => {
      if (pr.held || pr.fixed || Math.hypot(pr.p[0] - cx, pr.p[2] - cz) > ASSIST_R + pr.rb) return;
      consider(pr, pr.p);
    };
    for (const pr of this.props.props) scan(pr);
    for (const pr of this.ghosts()) scan(pr);
    for (const cr of this.creatures) {
      if (!cr.grabbable()) continue;
      const n = cr.nearest([cx, cy, cz]);
      if (n) consider(cr, n.p);
    }
    return best;
  }

  /** 腕を伸ばして届く（付け根から ARM_REACH 以内）・付け根からつかみ点までの間に固体が無い（away = その点が挟む物から離れている） */
  private reachable(claw: ClawView, gp: readonly number[], away: (x: number, y: number, z: number) => boolean, extra = 0): boolean {
    // （集中モード：鋏の口の前の物を挟むので、腕を伸ばしきるところ（+2 cm）まで）
    if (Math.hypot(gp[0] - claw.shoulder[0], gp[1] - claw.shoulder[1], gp[2] - claw.shoulder[2]) > this.armReach + extra + (this.focus ? 0.02 : 0)) return false;
    for (let i = 1; i <= 4; i++) {
      const f = i / 5;
      const x = lerp(claw.shoulder[0], gp[0], f), y = lerp(claw.shoulder[1], gp[1], f), z = lerp(claw.shoulder[2], gp[2], f);
      if (this.world.contactSolid(x, y, z) < 0.005 && away(x, y, z)) return false;
    }
    return true;
  }

  /** つかみ点を決める（鋏の先に近い表面の点を、少し内側へ） */
  private aimAt(pr: Prop, from: readonly number[]) {
    const l = this.props.surfaceLocal(pr, from[0], from[1], from[2]);
    const k = Math.max(0, 1 - 0.006 / (Math.hypot(l[0], l[1], l[2]) || 1));
    this.local = [l[0] * k, l[1] * k, l[2] * k];
  }

  /**
   * 挟もうとする物・生き物を決めて、鋏を閉じ始める。景色の物（ghost）なら、ここで物理の物にする。
   * fresh（押した瞬間）で何も届かなければ、岩・流木の面が届くか調べる（閉じたまま歩いている間は岩をつかまない）
   */
  private beginClose(c: Picked | null, anchor: readonly number[], claw: ClawView, fresh: boolean) {
    if (!c && fresh) {
      // 構えた鋏の先にいちばん近い面の点。腕が届かなければ、付け根にいちばん近い面の点（腕を伸ばしてつかむ）
      for (const o of [anchor, claw.shoulder]) {
        const n = this.fixed.nearest(o);
        if (n && this.reachable(claw, n.p, (x, y, z) => this.world.climbSolid(x, y, z) > 0.03, CREATURE_ARM_EXTRA)) {
          c = { prop: null, creature: this.fixed, d: n.d, at: n.p };
          break;
        }
      }
    }
    this.state = 'closing';
    this.closeT = 0;
    this.target = c?.prop ?? null;
    this.creature = c?.creature ?? null;
    if (c?.prop && c.prop.decor >= 0 && !this.props.props.includes(c.prop)) this.promote(c.prop);
    if (c?.prop) this.aimAt(c.prop, anchor);
    if (c?.creature) c.creature.aim(c.at);
    this.fitWidth(this.target, this.creature);
  }

  /** 挟んだ（closing → holding）：物なら挟んでいる鋏の数を数え、鋏に対する向きを覚える */
  private onHold(pr: Prop | null, cr: GrabCreature | null, claw: ClawView) {
    this.state = 'holding';
    this.slipT = this.heavyT = 0;
    this.stats.grabs++;
    if (this.lastRel && this.lastRel.t > 0 && this.lastRel.target === (pr ?? cr)) this.regrab.quick++;
    this.lastRel = null;
    if (pr) {
      this.holdProp(pr);
      this.rel = claw.handQ ? qmul(qconj(claw.handQ), pr.q) : null;
      this.qGrab = [pr.q[0], pr.q[1], pr.q[2], pr.q[3]];
      this.twistAtGrab = this.twist;
    } else if (cr) {
      cr.onGrab();
      this.stats.creatureGrabs++;
    }
    this.events.push({ kind: 'grab', prop: pr ?? cr });
  }

  /**
   * 1 フレーム。held = 挟むボタンを押している。crab = いまのカニ、claw = 鋏の見た目（CrabRig。このフレームの姿勢）。
   * 物の時間もここで進める（挟んでいなくても）
   */
  update(dt: number, held: boolean, crab: CrabController, claw: ClawView) {
    const req = this.pre(dt, held, crab, claw);
    const r = this.props.update(dt, crab, req);
    this.post(dt, crab, claw, r);
  }

  /** このフレームの鋏の構え（pre で決め、post で使う）と、挟めない状態か */
  private anchorNow: [number, number, number] = [0, 0, 0];
  private blockedNow = false;
  /** 腕の届く長さ（付け根から。左の小さな鋏は短い） */
  armReach = ARM_REACH;
  /** もう 1 本の鋏（左右で同じ物・生き物を挟まない） */
  other: GrabSystem | null = null;

  /**
   * 1 フレームの前半：押している・離した・閉じ具合の状態を進め、挟んでいる物のばねの要求を返す（物の時間は進めない。
   * 2 本の鋏で 1 回だけ PropSystem.updateMany を呼ぶため）
   */
  pre(dt: number, held: boolean, crab: CrabController, claw: ClawView): HoldReq | null {
    const anchor: [number, number, number] = [claw.anchor[0], claw.anchor[1], claw.anchor[2]];
    this.anchorNow = anchor;
    // 瞬間移動した（スタート地点へ戻る・自動検証の移動）：離す
    const jump = Math.hypot(crab.x - this.prevCrab[0], crab.y - this.prevCrab[1], crab.z - this.prevCrab[2]);
    this.prevCrab = [crab.x, crab.y, crab.z];
    const teleported = jump > 1.2;
    const blocked = crab.state === 'ride' || crab.region !== 'tank';
    this.blockedNow = blocked;
    if (teleported) this.prevAnchor = null;
    if (this.lastRel && (this.lastRel.t -= dt) <= 0) this.lastRel = null;
    // 挟んでいた物が世界から消えた（もう 1 本の鋏で食べ終えた等）：音を出さずに空にする
    if (this.state !== 'idle' && this.target && !this.props.props.includes(this.target) && this.target.decor < 0) {
      this.target = null;
      this.state = 'idle';
      this.tow = null;
      this.rel = null;
    }
    if (this.focus) return this.preFocus(dt, blocked || teleported, claw, anchor);
    this.gripNow = clamp(this.squeeze, 0, 1);
    // モードを切り替えた直後：押し直すまで挟んだまま（ボタンを一度押して離すと離す）
    if (this.carry) {
      if (held || this.state !== 'holding') this.carry = false;
      else {
        held = true;
        this.gripNow = Math.max(this.gripNow, 0.7);
      }
    }
    this.sq = this.close;
    if (!held || blocked || teleported) {
      if (this.state !== 'idle') this.release();
    } else if (this.state === 'idle') {
      // 押した：届く物を探して、鋏を伸ばしながら閉じる
      this.beginClose(this.pick(claw, anchor, GRAB_REACH), anchor, claw, true);
    } else if (this.state === 'empty' && (this.retryT -= dt) <= 0) {
      // 空のまま閉じている：押したまま歩いて物が届く所へ来たら、鋏を開き直して挟む（押し直さなくてよい）。
      // 挟みそこねた直後（retryT）は待つ（届かない物へ鋏を開閉し続けない）
      const c = this.pick(claw, anchor, GRAB_REACH);
      if (c) {
        this.beginClose(c, anchor, claw, false);
        this.stats.touchGrabs++;
      }
    }
    if (this.state === 'closing') {
      this.closeT += dt;
      this.close = clamp(this.closeT / CLOSE_T, 0, 1);
      if (this.closeT >= CLOSE_T) {
        const pr = this.target, cr = this.creature;
        const gp = pr ? this.props.toWorld(pr, this.local) : cr && cr.grabbable() ? cr.gripPoint() : null;
        // 鋏の先が届いた（伸ばした鋏の先がつかみ点の近く）。同じ物・生き物をもう 1 本の鋏が先に挟んでいたら、挟めない
        const taken = this.taken(pr, cr);
        if (gp && !taken && Math.hypot(claw.pinch[0] - gp[0], claw.pinch[1] - gp[1], claw.pinch[2] - gp[2]) < 0.08) {
          this.onHold(pr, cr, claw);
        } else {
          this.state = 'empty';
          this.retryT = pr || cr ? 0.6 : 0;
          this.target = null;
          this.creature = null;
          this.stats.misses++;
          this.events.push({ kind: 'miss', prop: null });
        }
      }
    } else if (this.state === 'empty') this.close = Math.min(1, this.close + dt / CLOSE_T);
    else if (this.state === 'idle') this.close = Math.max(0, this.close - dt / CLOSE_T);

    return this.holdReq(anchor, claw);
  }

  /** 物・生き物を、もう 1 本の鋏が先に挟んでしまったか（物は 2 本まで。生き物は 1 本だけ。岩・流木は両方でつかめる） */
  private taken(pr: Prop | null, cr: GrabCreature | null): boolean {
    if (pr) return pr.held && !(this.other?.target === pr && this.other.state === 'holding' && pr.holders === 1);
    return !!cr && this.other?.holdingCreature === cr && cr !== this.fixed;
  }

  /** 物の時間を進める要求（挟んでいれば、ばねでつなぐ。握る強さ・鋏の向き・挟んだときの向き） */
  private holdReq(anchor: V3, claw: ClawView): HoldReq | null {
    const pr = this.holding;
    const a0 = this.prevAnchor ?? anchor;
    if (!pr) return null;
    // 集中モード：挟んだ物は挟んだときの世界の向きのまま（積む・並べるときに傾かない）。手首のひねり（twist）で縦の軸まわりに回す
    if (this.focus && this.qGrab) {
      const t = (this.twist - this.twistAtGrab) * 0.5;
      return { prop: pr, local: this.local, a0, a1: anchor, grip: this.gripNow, qc: [0, Math.sin(t), 0, Math.cos(t)], rel: this.qGrab };
    }
    return { prop: pr, local: this.local, a0, a1: anchor, grip: this.gripNow, qc: claw.handQ ?? null, rel: this.rel };
  }

  /** 手首のひねり（集中モード。AquaClawFocus が書く。rad）と、挟んだときの値・物の世界の向き */
  twist = 0;
  private twistAtGrab = 0;
  private qGrab: Q4 | null = null;

  /**
   * ハサミ集中モードの 1 フレームの前半：開閉は握る強さ（squeeze）に従う（閉じる速さの上限 CLOSE_T で追う。ボタンでも同じ動き）。
   * 開いていく途中で鋏の口のすぐ前（FOCUS_REACH）に物があれば、その物へ向けて閉じる。指が物に触れる閉じ具合（物の太さから c0）まで
   * 押し込んだら挟む。そこから押し込んだ分が握る強さ（gripNow）。触れる所より開いたら離す（物を貫いて閉じない）
   */
  private preFocus(dt: number, blocked: boolean, claw: ClawView, anchor: V3): HoldReq | null {
    let raw = blocked ? 0 : clamp(this.squeeze, 0, 1);
    // モードを切り替えた直後：押し直すまで挟んだまま（切り替えた瞬間の「押していない」で落とさない）
    if (this.carry) {
      if (this.state !== 'holding' || raw > this.c0 + 0.1) this.carry = false;
      else raw = Math.max(raw, Math.min(1, this.c0 + 0.45));
    }
    const rate = dt / CLOSE_T;
    this.sq += clamp(raw - this.sq, -rate * 1.5, rate);
    const s = this.sq;
    if (blocked && this.state !== 'idle') this.release();
    if (this.state === 'empty') this.state = 'idle';
    if (this.state === 'idle') {
      this.close = s;
      this.gripNow = 0;
      if (s > 0.06 && this.retryT <= 0) {
        const c = this.pick(claw, claw.pinch, FOCUS_REACH);
        if (c) {
          // 指がまだ物より広く開いているときだけ（閉じきった指で物をすくい取らない）
          this.fitWidth(c.prop, c.creature);
          if (s < Math.max(this.c0 + 0.03, 0.16)) this.beginClose(c, claw.pinch, claw, false);
        } else if (s > 0.3) {
          // 何も無い所で閉じた：岩・流木の面がすぐ前にあればつかむ
          const n = this.fixed.nearest(claw.pinch);
          if (n && n.d < FOCUS_REACH * 0.7 && s < 0.5) this.beginClose({ prop: null, creature: this.fixed, d: n.d, at: n.p }, claw.pinch, claw, false);
        }
      }
      this.retryT = Math.max(0, this.retryT - dt);
    } else if (this.state === 'closing') {
      this.close = s;
      const pr = this.target, cr = this.creature;
      if (s < 0.04) {
        this.state = 'idle';
        this.target = null;
        this.creature = null;
      } else if (s >= this.c0) {
        const gp = pr ? this.props.toWorld(pr, this.local) : cr && cr.grabbable() ? cr.gripPoint() : null;
        if (gp && !this.taken(pr, cr) && Math.hypot(claw.pinch[0] - gp[0], claw.pinch[1] - gp[1], claw.pinch[2] - gp[2]) < 0.06) this.onHold(pr, cr, claw);
        else {
          this.state = 'idle';
          this.retryT = 0.25;
          this.target = null;
          this.creature = null;
          this.stats.misses++;
          this.events.push({ kind: 'miss', prop: null });
        }
      }
    }
    if (this.state === 'holding') {
      // 触れた所から押し込んだ分が握る強さ。触れる所より開いたら離す
      this.close = this.c0;
      this.gripNow = clamp((s - this.c0) / Math.max(0.08, 1 - this.c0), 0, 1);
      if (s < this.c0 - 0.05) this.release();
    }
    return this.holdReq(anchor, claw);
  }

  /** 1 フレームの後半：物の時間を進めた結果（r = この鋏の挟んでいる物のばね）から、手応え・滑り・生き物・案内を決める */
  post(dt: number, crab: CrabController, claw: ClawView, r: { force: V3; stretch: number; slide?: number }) {
    const anchor = this.anchorNow, blocked = this.blockedNow;
    const pr = this.holding, cr = this.holdingCreature;
    const a0 = this.prevAnchor ?? anchor;
    this.prevAnchor = anchor;
    if (pr) {
      this.stretch = r.stretch;
      // 握る力が足りずにつかみ点が滑った距離（物の座標。検証・表示用の合計）
      this.slid += r.slide ?? 0;
      this.force.splice(0, 3, ...r.force);
      this.stats.maxStretch = Math.max(this.stats.maxStretch, r.stretch);
      // 反作用：物が引く力をカニへ（接地中のカニを持ち上げはしない：縦は CrabController が空中・水中だけ使う）
      const F = r.force;
      const fl = Math.hypot(F[0], F[1], F[2]);
      // 重さ：握る力に対して物がどれだけ重いか（引きずっている・持ち上げている）
      const strain = clamp(fl / GRIP_FORCE, 0, 1);
      this.strain += (strain - this.strain) * (1 - Math.exp(-dt / 0.4));
      // （第 5 段階：重さによる歩きの遅れを弱めた。以前は 1 − 0.45 × strain²）
      this.tow = { ax: -F[0] / CRAB_MASS, ay: -F[1] / CRAB_MASS, az: -F[2] / CRAB_MASS, slow: 1 - 0.28 * strain * strain };
      // 滑り落ちる：伸びすぎ・鋏が届かない状態が続いた
      // （鋏が大きく届かない = 鋏と物が離れて見える、ときは早めに滑らせる）
      // （口元へ運んで食べている間は滑らない：feeding）
      const over = !this.feeding && (r.stretch > SLIP_STRETCH || claw.reachErr > SLIP_REACH);
      this.slipT = over ? this.slipT + dt * (claw.reachErr > SLIP_REACH * 2.5 ? 2 : 1) : Math.max(0, this.slipT - dt * 2);
      if (this.slipT > SLIP_T) this.release('slip');
      // 重くて動かない（ほとんど動かないのに強く引いている）：一度だけ知らせる
      const ps = Math.hypot(pr.v[0], pr.v[1], pr.v[2]);
      this.heavyT = strain > 0.97 && ps < 0.15 ? this.heavyT + dt : 0;
      if (this.heavyT > 0.6) {
        this.heavyT = -1e9;
        this.events.push({ kind: 'heavy', prop: pr });
      }
    } else if (cr && dt > 0) {
      // 巣穴の生き物：体（引き出し・抵抗・伸び）は生き物の側で進め、ばねの力と反作用は物と同じ。
      // 鋏の構えは少しならして渡す（踏ん張りの見た目の小刻みな揺れ（CrabRig の tugShake）が、ばねの減衰を通って
      // 張力を毎フレーム揺らさない。描く鋏は IK でいつもつかみ点を挟む）
      const fa = this.fAnchor ?? [...a0] as [number, number, number];
      const fa0: [number, number, number] = [fa[0], fa[1], fa[2]];
      const kf = 1 - Math.exp(-dt * 30);
      for (let i = 0; i < 3; i++) fa[i] += (anchor[i] - fa[i]) * kf;
      this.fAnchor = fa;
      const t = cr.stepHeld(dt, fa0, fa);
      this.stretch = t.stretch;
      this.force.splice(0, 3, ...t.force);
      this.stats.maxStretch = Math.max(this.stats.maxStretch, t.stretch);
      const F = t.force;
      const fl = Math.hypot(F[0], F[1], F[2]);
      // 握る強さ：弱く握るほど、同じ引きでも握る力を越えやすい（滑りやすい）。強く握る（1）と従来どおり
      const gm = this.gripNow >= 0.999 ? 1 : Math.min(1, gripFriction(this.gripNow));
      t.over /= gm;
      t.tugOver /= gm;
      const strain = clamp(fl / (cr.grip * gm), 0, 1);
      this.load = strain;
      this.over = Math.max(t.over, t.tugOver);
      this.stats.maxOver = Math.max(this.stats.maxOver, this.over);
      this.strain += (strain - this.strain) * (1 - Math.exp(-dt / 0.25));
      // 反作用：生き物が引く力でカニが穴の方へ引き戻され、強く張っているほど下がる速さが落ちる
      this.tow = { ax: -F[0] / CRAB_MASS_TUG, ay: -F[1] / CRAB_MASS_TUG, az: -F[2] / CRAB_MASS_TUG, slow: 1 - (cr.slow ?? TUG_SLOW) * strain * strain };
      if (t.done) this.release('pop');
      else {
        // 滑る：握る力を越えて引いている時間が続いた・鋏が届かない。越え方は 2 通り：急に強く引いた（over：越えた量が
        // 大きいほど早い。走って引き続けると約 0.7 秒）、暴れている間に強く張っている（tugOver：暴れる 1 回を歩いて耐えると
        // 滑る直前まで、走って耐えると滑る）。緩めれば減る（理不尽に滑らない：滑りそうな間は鋏が震えて知らせる = warn）
        const reachOver = claw.reachErr > (cr.slipReach ?? SLIP_REACH * 1.6);
        const rJerk = t.over > 1 ? Math.min(1.2, 0.3 + (t.over - 1) * 1.5) : 0;
        const rTug = t.tugOver > 1 ? Math.min(2, 0.5 + (t.tugOver - 1) * 3.5) : 0;
        const rate = this.feeding ? 0 : Math.max(rJerk, rTug, reachOver ? 1.5 : 0);
        if (rate > 0) this.slipT += dt * rate;
        else this.slipT = Math.max(0, this.slipT - dt * 1.5);
        if (this.slipT > TUG_SLIP_T) this.release('slip');
      }
    } else if (!cr) {
      this.tow = null;
      this.stretch = 0;
      this.strain = 0;
      this.load = this.over = 0;
      this.force.fill(0);
    }
    // 案内：押していない・閉じたまま空のとき、届く物（つかみ点に輪を出す）。届かないが近い物（狙いの補助）。
    // 集中モードは鋏の口のすぐ前の物（いま閉じると挟む物）だけ
    const free = (this.state === 'idle' || this.state === 'empty') && !blocked;
    const h = free ? (this.focus ? this.pick(claw, claw.pinch, FOCUS_REACH) : this.pick(claw, anchor, GRAB_REACH)) : null;
    this.hint = h ? h.prop ?? h.creature : null;
    this.hintAt = h ? [h.at[0], h.at[1], h.at[2]] : null;
    this.near = free && !h && !this.focus ? this.findNear(crab) : null;
    this.hintPrev = this.hint ?? (this.state === 'closing' || this.state === 'holding' ? this.target ?? this.creature : null);
  }

  /** いま挟んでいる・挟もうとしている所（世界。案内の印を出す所） */
  gripAt(): V3 | null {
    if (this.state !== 'closing' && this.state !== 'holding') return null;
    if (this.target) return this.props.toWorld(this.target, this.local);
    if (this.creature) {
      const g = this.creature.gripPoint();
      return [g[0], g[1], g[2]];
    }
    return null;
  }

  drainEvents(): GrabEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
