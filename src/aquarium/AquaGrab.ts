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

export type PropKind = 'pebble' | 'shell' | 'stone';

export interface PropKindSpec {
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
  shell: { name: '貝殻', semi: [0.092, 0.024, 0.084], mass: 0.12, sinkG: 2.4, drag: 3.0, mu: 0.45, bounce: 0.1 },
  pebble: { name: '小石', semi: [0.078, 0.052, 0.068], mass: 0.35, sinkG: 4.6, drag: 1.3, mu: 0.6, bounce: 0.15 },
  // 重い石：水中でも持ち上がらない（重さ × 沈む強さ 8.4 > 握る力 8）が、砂の上なら引きずれる（摩擦 0.4 × 7 × 1.2 = 3.4）。陸では動かない
  stone: { name: '重い石', semi: [0.17, 0.115, 0.15], mass: 1.2, sinkG: 7.0, drag: 1.0, mu: 0.4, bounce: 0.05 },
};

/** 空気中の重力（カニと同じ） */
const G_AIR = 24;
/** 刻み（秒） */
const SUB = 1 / 120;
/** つかみ点 ↔ 鋏の構えのばね（強さ・減衰の割合）と、握る力の上限（ばねの力の頭打ち） */
const SPRING_K = 140;
const SPRING_ZETA = 0.55;
export const GRIP_FORCE = 8;
/** 反作用を受けるカニの重さ（小さいほど重い物に引っ張られる） */
const CRAB_MASS = 0.6;
/** 挟める距離（構えた鋏の先から物の表面まで。押した瞬間と、押したまま空で閉じているとき） */
export const GRAB_REACH = 0.26;
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
  held = false;
  /** 水槽の外・固体の中にいる時間（長く続いたら置いた所へ戻す） */
  lostT = 0;
  /** 置いた所（戻す先） */
  readonly home: V3;
  readonly homeQ: Q4;

  /** 景色の小石・貝殻（AquaDecor）から作った物：景色のメッシュの番号（描画は景色のメッシュの頂点を動かす）。それ以外は −1 */
  decor = -1;
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
  }

  get name() {
    return this.label;
  }

  wake() {
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

/** 楕円体の面のうち、世界の向き d（単位）へ最も出ている点の、中心からの位置（世界） */
function support(pr: Prop, dx: number, dy: number, dz: number, out: V3 = [0, 0, 0]): V3 {
  const l = qinv(pr.q, dx, dy, dz);
  const [a, b, c] = pr.semi;
  const sx = a * l[0], sy = b * l[1], sz = c * l[2];
  const k = 1 / (Math.hypot(sx, sy, sz) || 1);
  return qrot(pr.q, a * sx * k, b * sy * k, c * sz * k, out);
}

/** 点 (x, y, z) に近い、楕円体の表面の点（物の座標。中心から見た向きで面へ写す近似） */
function surfaceLocal(pr: Prop, x: number, y: number, z: number): V3 {
  const l = qinv(pr.q, x - pr.p[0], y - pr.p[1], z - pr.p[2]);
  const [a, b, c] = pr.semi;
  const ux = l[0] / a, uy = l[1] / b, uz = l[2] / c;
  const k = 1 / (Math.hypot(ux, uy, uz) || 1);
  return [a * ux * k, b * uy * k, c * uz * k];
}

/** 外から見た、点 (x, y, z) から楕円体の表面までのおおよその距離 */
function surfaceDist(pr: Prop, x: number, y: number, z: number): number {
  const s = surfaceLocal(pr, x, y, z);
  const w = qrot(pr.q, s[0], s[1], s[2]);
  const dx = x - pr.p[0], dy = y - pr.p[1], dz = z - pr.p[2];
  const inside = Math.hypot(dx, dy, dz) < Math.hypot(w[0], w[1], w[2]);
  const d = Math.hypot(dx - w[0], dy - w[1], dz - w[2]);
  return inside ? -d : d;
}

// ---------------- 物（小石・貝殻・重い石） ----------------

/** 挟んでいる物（1 本の鋏）：物・つかみ点（物の座標）・鋏の構えの前・今のフレームの位置 */
export interface HoldReq {
  prop: Prop;
  local: V3;
  a0: V3;
  a1: V3;
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

  constructor(private readonly world: AquariumWorld) {}

  /** 地面の上に置く（x, z、探し始める高さ y、向き、大きさ） */
  add(id: string, kind: PropKind, x: number, z: number, yFrom: number, scale = 1, yaw = 0): Prop {
    const spec = PROP_KIND[kind];
    const ground = this.world.contactSurfaceBelow(x, yFrom, z);
    const pr = new Prop(id, kind, scale, [x, ground + spec.semi[1] * scale + 0.01, z], yaw);
    this.props.push(pr);
    return pr;
  }

  /** 置いた所へ戻す（自動検証・水槽の外へ出てしまったとき） */
  reset(pr: Prop) {
    pr.p.splice(0, 3, ...pr.home);
    pr.q.splice(0, 4, ...pr.homeQ);
    pr.v.fill(0);
    pr.w.fill(0);
    pr.held = false;
    pr.lostT = 0;
    pr.wake();
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
  ): { force: V3; stretch: number }[] {
    const out = holds.map(() => ({ force: [0, 0, 0] as V3, stretch: 0 }));
    // 同じ物を 2 本の鋏で挟むことはない（GrabSystem が除く）。1 本ずつ、その物の刻みの中でばねを掛ける
    const byProp = new Map<Prop, number>();
    holds.forEach((h, i) => byProp.set(h.prop, i));
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
      if (d < crab.radius + pr.rb + 0.12) pr.wake();
    }
    for (const h of holds) h.prop.wake();
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
        const hi = byProp.get(pr);
        const hold = hi === undefined ? null : holds[hi];
        let a: V3 | null = null, local: V3 | null = null;
        if (hold) {
          local = hold.local;
          a = [lerp(hold.a0[0], hold.a1[0], f), lerp(hold.a0[1], hold.a1[1], f), lerp(hold.a0[2], hold.a1[2], f)];
        }
        const r = this.stepProp(pr, SUB, a, local, hold ? [(hold.a1[0] - hold.a0[0]) / dt, (hold.a1[1] - hold.a0[1]) / dt, (hold.a1[2] - hold.a0[2]) / dt] : null, crab);
        if (r && hi !== undefined) {
          const o = out[hi];
          o.force[0] += r.f[0];
          o.force[1] += r.f[1];
          o.force[2] += r.f[2];
          o.stretch = r.stretch;
        }
      }
      this.collideProps();
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
  ): { force: V3; stretch: number } {
    const r = this.updateMany(dt, crab, hold ? [hold] : []);
    return r[0] ?? { force: [0, 0, 0], stretch: 0 };
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
      const lost = !Number.isFinite(pr.p[0] + pr.p[1] + pr.p[2]) || w.regionAt(pr.p[0], pr.p[1], pr.p[2]) !== 'tank' || w.contactSolid(pr.p[0], pr.p[1], pr.p[2]) < -pr.rm;
      pr.lostT = lost && !pr.held ? pr.lostT + dt : 0;
      if (pr.lostT > 1.5) {
        this.stats.respawn++;
        this.reset(pr);
      }
    }
    this.stats.awake = awake;
  }

  /** 1 刻み。挟んでいれば、ばねの力（物にかけた力）と伸びを返す */
  private stepProp(pr: Prop, dt: number, anchor: V3 | null, local: V3 | null, av: V3 | null, crab: { x: number; y: number; z: number; radius: number }): { f: V3; stretch: number } | null {
    const w = this.world, S = pr.spec;
    const p = pr.p, v = pr.v;
    // 水中かどうか（中心と水面の高さで連続的に）
    const level = w.waterLevelAt(p[0], p[1], p[2]);
    const s = smoothstep(level + pr.rm, level - pr.rm, p[1]);
    const g = lerp(G_AIR, S.sinkG, s);
    v[1] -= g * dt;
    // 水の抵抗（空気中は弱い）
    const kd = Math.exp(-dt * lerp(0.15, S.drag, s));
    v[0] *= kd; v[1] *= kd; v[2] *= kd;
    let out: { f: V3; stretch: number } | null = null;
    if (anchor && local) {
      // つかみ点（世界）とその速さ
      const r = qrot(pr.q, local[0], local[1], local[2], this.tmp);
      const gx = p[0] + r[0], gy = p[1] + r[1], gz = p[2] + r[2];
      const wx = pr.w, rvx = wx[1] * r[2] - wx[2] * r[1], rvy = wx[2] * r[0] - wx[0] * r[2], rvz = wx[0] * r[1] - wx[1] * r[0];
      const ex = anchor[0] - gx, ey = anchor[1] - gy, ez = anchor[2] - gz;
      // 握る力の上限：軽い物（小石・貝殻）は小さく持てるので余裕がある（跳んだ瞬間に引っ張られても落とさない）。
      // 重い石（重さ 0.8 以上）は GRIP_FORCE のまま
      const grip = GRIP_FORCE * (1 + 1.5 * Math.max(0, 1 - pr.mass / 0.8));
      clawSpring(ex, ey, ez, (av?.[0] ?? 0) - v[0] - rvx, (av?.[1] ?? 0) - v[1] - rvy, (av?.[2] ?? 0) - v[2] - rvz, pr.mass, grip, this.tmp2);
      const fx = this.tmp2[0], fy = this.tmp2[1], fz = this.tmp2[2];
      v[0] += (fx / pr.mass) * dt;
      v[1] += (fy / pr.mass) * dt;
      v[2] += (fz / pr.mass) * dt;
      // 向き：つかみ点（中心から r）が力の向きへ来るよう回す（ぶら下がる・引きずると傾く）
      const fn = Math.hypot(fx, fy, fz), rn = Math.hypot(r[0], r[1], r[2]);
      if (fn > 1e-4 && rn > 1e-4) {
        const ux = r[0] / rn, uy = r[1] / rn, uz = r[2] / rn, tx = fx / fn, ty = fy / fn, tz = fz / fn;
        // 床の上を引きずっている間は弱める（重い石が大きく傾いて砂へ食い込まない）
        const kk = 9 * clamp(fn / (pr.mass * Math.max(g, 1)), 0.2, 1.5) * (pr.contact ? 0.35 : 1);
        const wt: V3 = [(uy * tz - uz * ty) * kk, (uz * tx - ux * tz) * kk, (ux * ty - uy * tx) * kk];
        const kw = 1 - Math.exp(-dt * 10);
        for (let i = 0; i < 3; i++) pr.w[i] += (wt[i] - pr.w[i]) * kw;
      }
      out = { f: [fx, fy, fz], stretch: Math.hypot(ex, ey, ez) };
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
    if (dl < minD && dl > 1e-5) {
      const nx = dx / dl, ny = dy / dl, nz = dz / dl, push = minD - dl;
      p[0] += nx * push; p[1] += ny * push; p[2] += nz * push;
      const vn = v[0] * nx + v[1] * ny + v[2] * nz;
      if (vn < 0) {
        v[0] -= nx * vn; v[1] -= ny * vn; v[2] -= nz * vn;
      }
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
    return out;
  }

  /** 物どうし（球で近似。重さの比で押し分ける） */
  private collideProps() {
    const P = this.props;
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const a = P[i], b = P[j];
        if (!a.awake && !b.awake) continue;
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

  constructor(private readonly world: AquariumWorld, readonly props: PropSystem) {
    this.fixed = new FixedGrip(world);
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

  /** 鋏の構え（CrabRig.grip へ渡す）。target = 鋏を伸ばす所（世界） */
  rigGrip(): { on: boolean; close: number; hold: boolean; target: [number, number, number] | null; shake: number } {
    const busy = this.state === 'closing' || this.state === 'holding';
    let t: [number, number, number] | null = null;
    if (busy && this.target) t = this.props.toWorld(this.target, this.local);
    else if (busy && this.creature) {
      const g = this.creature.gripPoint();
      t = [g[0], g[1], g[2]];
    }
    return { on: this.state !== 'idle' || this.aiming, close: this.close, hold: this.state === 'holding', target: t, shake: this.warn };
  }

  /** すぐ離す（瞬間移動・管に入った等）。kind = 離した理由（生き物が抜けたときは 'pop'） */
  release(kind: 'release' | 'slip' | 'pop' = 'release') {
    if (this.state === 'holding' && this.target) {
      this.target.held = false;
      this.target.wake();
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
  }

  /** 構えた鋏の先から届く物（いちばん近い物の表面までの距離が reach 以内。ガラス・岩越しには挟めない） */
  private pick(claw: ClawView, from: readonly number[], reach: number): Picked | null {
    let best: Picked | null = null;
    const test = (pr: Prop) => {
      // もう 1 本の鋏が挟んでいる・挟もうとしている物は挟まない
      if (pr.held || this.other?.target === pr) return;
      // 遠い物は楕円体の距離を測らない（景色の小石は数百個ある）
      if (Math.hypot(pr.p[0] - from[0], pr.p[1] - from[1], pr.p[2] - from[2]) > reach + pr.rb) return;
      const d = this.props.surfaceDist(pr, from[0], from[1], from[2]);
      if (d > reach || (best && d >= best.d)) return;
      // 付け根からつかみ点までの間に固体（ガラス・岩・砂）が無い
      const l = this.props.surfaceLocal(pr, from[0], from[1], from[2]);
      const gp = this.props.toWorld(pr, l);
      if (this.reachable(claw, gp, (x, y, z) => this.props.surfaceDist(pr, x, y, z) > 0.02)) best = { prop: pr, creature: null, d, at: gp };
    };
    for (const pr of this.props.props) test(pr);
    for (const pr of this.ghosts()) test(pr);
    // 巣穴の生き物：見えている部分（挟める所の球）。初心者でも狙えるよう、物より少し遠くから挟める（CREATURE_BONUS）。
    // 比べるときは足した分を引く（同じ距離なら物より生き物を選ぶ）
    for (const cr of this.creatures) {
      // もう 1 本の鋏が挟んでいる生き物は挟まない
      if (!cr.grabbable() || this.other?.creature === cr) continue;
      // 構えた鋏の先にいちばん近い点。腕の付け根から届かなければ、付け根にいちばん近い点も試す（腕を伸ばして挟む）
      for (const o of [from, claw.shoulder]) {
        const n = cr.nearest(o);
        if (!n) continue;
        const d0 = o === from ? n.d : (cr.nearest(from)?.d ?? n.d);
        const d = d0 - CREATURE_BONUS;
        if (d0 > reach + CREATURE_BONUS || (best && d >= best.d)) continue;
        if (this.reachable(claw, n.p, (x, y, z) => (cr.nearest([x, y, z])?.d ?? 1) > 0.03, CREATURE_ARM_EXTRA)) {
          best = { prop: null, creature: cr, d, at: n.p };
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
    const consider = (target: Grabbable, at: readonly number[]) => {
      const dx = at[0] - cx, dy = at[1] - cy, dz = at[2] - cz;
      const d = Math.hypot(dx, dy, dz);
      if (d > ASSIST_R || Math.abs(dy) > 0.45 || (best && d >= best.d)) return;
      // 体の前の側（横・後ろの物へ急に向き直らない）
      const hl = Math.hypot(dx, dz);
      if (hl > 0.05 && (dx * fx + dz * fz) / hl < -0.2) return;
      best = { target, at: [at[0], at[1], at[2]], d };
    };
    const scan = (pr: Prop) => {
      if (pr.held || Math.hypot(pr.p[0] - cx, pr.p[2] - cz) > ASSIST_R + pr.rb) return;
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
    if (Math.hypot(gp[0] - claw.shoulder[0], gp[1] - claw.shoulder[1], gp[2] - claw.shoulder[2]) > this.armReach + extra) return false;
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
        const taken = (!!pr && pr.held) || (!!cr && this.other?.holdingCreature === cr && cr !== this.fixed);
        if (gp && !taken && Math.hypot(claw.pinch[0] - gp[0], claw.pinch[1] - gp[1], claw.pinch[2] - gp[2]) < 0.08) {
          this.state = 'holding';
          this.slipT = this.heavyT = 0;
          this.stats.grabs++;
          if (pr) {
            pr.held = true;
            pr.wake();
          } else if (cr) {
            cr.onGrab();
            this.stats.creatureGrabs++;
          }
          this.events.push({ kind: 'grab', prop: pr ?? cr });
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

    // 物の時間を進める要求（挟んでいれば、ばねでつなぐ）
    const pr = this.holding;
    const a0 = this.prevAnchor ?? anchor;
    return pr ? { prop: pr, local: this.local, a0, a1: anchor } : null;
  }

  /** 1 フレームの後半：物の時間を進めた結果（r = この鋏の挟んでいる物のばね）から、手応え・滑り・生き物・案内を決める */
  post(dt: number, crab: CrabController, claw: ClawView, r: { force: V3; stretch: number }) {
    const anchor = this.anchorNow, blocked = this.blockedNow;
    const pr = this.holding, cr = this.holdingCreature;
    const a0 = this.prevAnchor ?? anchor;
    this.prevAnchor = anchor;
    if (pr) {
      this.stretch = r.stretch;
      this.force.splice(0, 3, ...r.force);
      this.stats.maxStretch = Math.max(this.stats.maxStretch, r.stretch);
      // 反作用：物が引く力をカニへ（接地中のカニを持ち上げはしない：縦は CrabController が空中・水中だけ使う）
      const F = r.force;
      const fl = Math.hypot(F[0], F[1], F[2]);
      // 重さ：握る力に対して物がどれだけ重いか（引きずっている・持ち上げている）
      const strain = clamp(fl / GRIP_FORCE, 0, 1);
      this.strain += (strain - this.strain) * (1 - Math.exp(-dt / 0.4));
      this.tow = { ax: -F[0] / CRAB_MASS, ay: -F[1] / CRAB_MASS, az: -F[2] / CRAB_MASS, slow: 1 - 0.45 * strain * strain };
      // 滑り落ちる：伸びすぎ・鋏が届かない状態が続いた
      // （鋏が大きく届かない = 鋏と物が離れて見える、ときは早めに滑らせる）
      const over = r.stretch > SLIP_STRETCH || claw.reachErr > SLIP_REACH;
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
      const strain = clamp(fl / cr.grip, 0, 1);
      this.load = strain;
      this.over = Math.max(t.over, t.tugOver);
      this.stats.maxOver = Math.max(this.stats.maxOver, this.over);
      this.strain += (strain - this.strain) * (1 - Math.exp(-dt / 0.25));
      // 反作用：生き物が引く力でカニが穴の方へ引き戻され、強く張っているほど下がる速さが落ちる
      this.tow = { ax: -F[0] / CRAB_MASS_TUG, ay: -F[1] / CRAB_MASS_TUG, az: -F[2] / CRAB_MASS_TUG, slow: 1 - TUG_SLOW * strain * strain };
      if (t.done) this.release('pop');
      else {
        // 滑る：握る力を越えて引いている時間が続いた・鋏が届かない。越え方は 2 通り：急に強く引いた（over：越えた量が
        // 大きいほど早い。走って引き続けると約 0.7 秒）、暴れている間に強く張っている（tugOver：暴れる 1 回を歩いて耐えると
        // 滑る直前まで、走って耐えると滑る）。緩めれば減る（理不尽に滑らない：滑りそうな間は鋏が震えて知らせる = warn）
        const reachOver = claw.reachErr > SLIP_REACH * 1.6;
        const rJerk = t.over > 1 ? Math.min(1.2, 0.3 + (t.over - 1) * 1.5) : 0;
        const rTug = t.tugOver > 1 ? Math.min(2, 0.5 + (t.tugOver - 1) * 3.5) : 0;
        const rate = Math.max(rJerk, rTug, reachOver ? 1.5 : 0);
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
    // 案内：押していない・閉じたまま空のとき、届く物（つかみ点に輪を出す）。届かないが近い物（狙いの補助）
    const free = (this.state === 'idle' || this.state === 'empty') && !blocked;
    const h = free ? this.pick(claw, anchor, GRAB_REACH) : null;
    this.hint = h ? h.prop ?? h.creature : null;
    this.hintAt = h ? [h.at[0], h.at[1], h.at[2]] : null;
    this.near = free && !h ? this.findNear(crab) : null;
  }

  drainEvents(): GrabEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
