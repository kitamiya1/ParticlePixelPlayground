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
import { TANK, type AquariumWorld } from './AquariumWorld';
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
const ARM_REACH = 0.33;
/** 鋏を閉じるまでの時間（この間に鋏を物へ伸ばす） */
export const CLOSE_T = 0.13;
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

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

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

  constructor(readonly id: string, readonly kind: PropKind, readonly scale: number, p: V3, yaw: number) {
    this.spec = PROP_KIND[kind];
    this.semi = [this.spec.semi[0] * scale, this.spec.semi[1] * scale, this.spec.semi[2] * scale];
    this.mass = this.spec.mass * scale * scale * scale;
    this.rb = Math.max(...this.semi);
    this.rm = (this.semi[0] + this.semi[1] + this.semi[2]) / 3;
    this.p = [...p];
    this.q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    this.home = [...p];
    this.homeQ = [...this.q];
  }

  get name() {
    return this.spec.name;
  }

  wake() {
    this.awake = true;
    this.restT = 0;
  }
}

// ---------------- 小さな数学（四元数と楕円体） ----------------

/** 四元数で回す（out = q v q⁻¹） */
function qrot(q: Q4, x: number, y: number, z: number, out: V3 = [0, 0, 0]): V3 {
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
   * 時間を進める。hold：挟んでいる物と、つかみ点（物の座標）、鋏の構えの位置の前・今のフレームの値（刻みの間は補間）。
   * 返り値：挟んでいる物にばねがかけた力（世界。刻みで平均）と、ばねの伸び（最後の刻み）
   */
  update(
    dt: number,
    crab: { x: number; y: number; z: number; radius: number; speed: number },
    hold: { prop: Prop; local: V3; a0: V3; a1: V3 } | null,
  ): { force: V3; stretch: number } {
    const w = this.world;
    // 掘った・盛った：全部起こす（足もとの砂が無くなった物は落ち、盛った砂に埋まった物は押し出される）
    const edits = w.dig.stats.carves + w.dig.stats.fills;
    if (edits !== this.lastEdits) {
      if (this.lastEdits >= 0) for (const pr of this.props) pr.wake();
      this.lastEdits = edits;
    }
    // カニの体が触れそうな物を起こす
    const cy = crab.y + crab.radius;
    for (const pr of this.props) {
      if (pr.awake) continue;
      const d = Math.hypot(pr.p[0] - crab.x, pr.p[1] - cy, pr.p[2] - crab.z);
      if (d < crab.radius + pr.rb + 0.12) pr.wake();
    }
    if (hold) hold.prop.wake();
    const force: V3 = [0, 0, 0];
    let stretch = 0;
    if (dt <= 0) return { force, stretch };
    // 刻みの数（大きな時間差は 0.05 秒まで。止まったタブから戻ったときに暴れない）
    this.acc = Math.min(this.acc + dt, 0.05);
    let n = 0;
    const total = Math.max(1, Math.floor(this.acc / SUB));
    while (this.acc >= SUB) {
      this.acc -= SUB;
      n++;
      const f = n / total;
      for (const pr of this.props) {
        if (!pr.awake) continue;
        let a: V3 | null = null, local: V3 | null = null;
        if (hold && hold.prop === pr) {
          local = hold.local;
          a = [lerp(hold.a0[0], hold.a1[0], f), lerp(hold.a0[1], hold.a1[1], f), lerp(hold.a0[2], hold.a1[2], f)];
        }
        const r = this.stepProp(pr, SUB, a, local, hold ? [(hold.a1[0] - hold.a0[0]) / dt, (hold.a1[1] - hold.a0[1]) / dt, (hold.a1[2] - hold.a0[2]) / dt] : null, crab);
        if (r) {
          force[0] += r.f[0];
          force[1] += r.f[1];
          force[2] += r.f[2];
          stretch = r.stretch;
        }
      }
      this.collideProps();
      this.stats.steps++;
    }
    if (n > 0) {
      force[0] /= n;
      force[1] /= n;
      force[2] /= n;
    }
    // 眠らせる・迷子を戻す
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
    return { force, stretch };
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
      const c = 2 * SPRING_ZETA * Math.sqrt(SPRING_K * pr.mass);
      let fx = SPRING_K * ex + c * ((av?.[0] ?? 0) - v[0] - rvx);
      let fy = SPRING_K * ey + c * ((av?.[1] ?? 0) - v[1] - rvy);
      let fz = SPRING_K * ez + c * ((av?.[2] ?? 0) - v[2] - rvz);
      // 握る力の上限：軽い物（小石・貝殻）は小さく持てるので余裕がある（跳んだ瞬間に引っ張られても落とさない）。
      // 重い石（重さ 0.8 以上）は GRIP_FORCE のまま
      const grip = GRIP_FORCE * (1 + 1.5 * Math.max(0, 1 - pr.mass / 0.8));
      const fl = Math.hypot(fx, fy, fz);
      if (fl > grip) {
        const k = grip / fl;
        fx *= k; fy *= k; fz *= k;
      }
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

export type GrabState = 'idle' | 'closing' | 'holding' | 'empty';

/** 離した・滑った出来事（表示用） */
export type GrabEvent = { kind: 'grab' | 'release' | 'slip' | 'miss' | 'heavy'; prop: Prop | null };

/** カニへ返す、挟んだ物の手応え（CrabController の CrabInput.tow） */
export interface Tow {
  /** 加速度（世界） */
  ax: number;
  ay: number;
  az: number;
  /** 速さの上限に掛ける割合（重い物ほど小さい） */
  slow: number;
}

export class GrabSystem {
  state: GrabState = 'idle';
  /** 挟んでいる物・挟もうとしている物 */
  target: Prop | null = null;
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
  /** 挟んでいる物の手応え（次のフレームのカニの入力） */
  tow: Tow | null = null;
  /** ばねの伸び・力（表示・自動検証用） */
  stretch = 0;
  /** 重さの手応え（ばねの力 / 握る力 を約 0.4 秒でならした値。表示用：歩き出し・跳んだ瞬間の引っ張りでは跳ねない） */
  strain = 0;
  readonly force: [number, number, number] = [0, 0, 0];
  readonly events: GrabEvent[] = [];
  readonly stats = { grabs: 0, releases: 0, slips: 0, misses: 0, touchGrabs: 0, maxStretch: 0 };
  /** 押していない・挟める物の候補（案内の表示用） */
  hint: Prop | null = null;

  constructor(private readonly world: AquariumWorld, readonly props: PropSystem) {}

  /** 挟んでいる・閉じている（鋏が使われている：穴掘り・引っこ抜きはできない） */
  get busy(): boolean {
    return this.state !== 'idle';
  }

  get holding(): Prop | null {
    return this.state === 'holding' ? this.target : null;
  }

  /** 鋏の構え（CrabRig.grip へ渡す）。target = 鋏を伸ばす所（世界） */
  rigGrip(): { on: boolean; close: number; hold: boolean; target: [number, number, number] | null } {
    const t = this.target && (this.state === 'closing' || this.state === 'holding') ? this.props.toWorld(this.target, this.local) : null;
    return { on: this.state !== 'idle', close: this.close, hold: this.state === 'holding', target: t };
  }

  /** すぐ離す（瞬間移動・管に入った等） */
  release(kind: 'release' | 'slip' = 'release') {
    if (this.state === 'holding' && this.target) {
      this.target.held = false;
      this.target.wake();
      this.events.push({ kind, prop: this.target });
      if (kind === 'slip') this.stats.slips++;
      else this.stats.releases++;
    }
    this.state = 'idle';
    this.target = null;
    this.tow = null;
    this.slipT = 0;
  }

  /** 構えた鋏の先から届く物（いちばん近い物の表面までの距離が reach 以内。ガラス・岩越しには挟めない） */
  private pick(claw: ClawView, from: readonly number[], reach: number): { prop: Prop; d: number } | null {
    let best: { prop: Prop; d: number } | null = null;
    for (const pr of this.props.props) {
      const d = this.props.surfaceDist(pr, from[0], from[1], from[2]);
      if (d > reach || (best && d >= best.d)) continue;
      // 付け根からつかみ点までの間に固体（ガラス・岩・砂）が無い
      const l = this.props.surfaceLocal(pr, from[0], from[1], from[2]);
      const gp = this.props.toWorld(pr, l);
      // 腕を伸ばして届く（付け根から ARM_REACH 以内）
      if (Math.hypot(gp[0] - claw.shoulder[0], gp[1] - claw.shoulder[1], gp[2] - claw.shoulder[2]) > ARM_REACH) continue;
      let clear = true;
      for (let i = 1; i <= 4; i++) {
        const f = i / 5;
        const x = lerp(claw.shoulder[0], gp[0], f), y = lerp(claw.shoulder[1], gp[1], f), z = lerp(claw.shoulder[2], gp[2], f);
        if (this.world.contactSolid(x, y, z) < 0.005 && this.props.surfaceDist(pr, x, y, z) > 0.02) clear = false;
      }
      if (clear) best = { prop: pr, d };
    }
    return best;
  }

  /** つかみ点を決める（鋏の先に近い表面の点を、少し内側へ） */
  private aimAt(pr: Prop, from: readonly number[]) {
    const l = this.props.surfaceLocal(pr, from[0], from[1], from[2]);
    const k = Math.max(0, 1 - 0.006 / (Math.hypot(l[0], l[1], l[2]) || 1));
    this.local = [l[0] * k, l[1] * k, l[2] * k];
  }

  /**
   * 1 フレーム。held = 挟むボタンを押している。crab = いまのカニ、claw = 鋏の見た目（CrabRig。このフレームの姿勢）。
   * 物の時間もここで進める（挟んでいなくても）
   */
  update(dt: number, held: boolean, crab: CrabController, claw: ClawView) {
    const anchor: [number, number, number] = [claw.anchor[0], claw.anchor[1], claw.anchor[2]];
    // 瞬間移動した（スタート地点へ戻る・自動検証の移動）：離す
    const jump = Math.hypot(crab.x - this.prevCrab[0], crab.y - this.prevCrab[1], crab.z - this.prevCrab[2]);
    this.prevCrab = [crab.x, crab.y, crab.z];
    const teleported = jump > 1.2;
    const blocked = crab.state === 'ride' || crab.pulling || crab.region !== 'tank';
    if (teleported) this.prevAnchor = null;
    if (!held || blocked || teleported) {
      if (this.state !== 'idle') this.release();
    } else if (this.state === 'idle') {
      // 押した：届く物を探して、鋏を伸ばしながら閉じる
      const c = this.pick(claw, anchor, GRAB_REACH);
      this.state = 'closing';
      this.closeT = 0;
      this.target = c?.prop ?? null;
      if (c) this.aimAt(c.prop, anchor);
    } else if (this.state === 'empty' && (this.retryT -= dt) <= 0) {
      // 空のまま閉じている：押したまま歩いて物が届く所へ来たら、鋏を開き直して挟む（押し直さなくてよい）。
      // 挟みそこねた直後（retryT）は待つ（届かない物へ鋏を開閉し続けない）
      const c = this.pick(claw, anchor, GRAB_REACH);
      if (c) {
        this.state = 'closing';
        this.closeT = 0;
        this.target = c.prop;
        this.aimAt(c.prop, anchor);
        this.stats.touchGrabs++;
      }
    }
    if (this.state === 'closing') {
      this.closeT += dt;
      this.close = clamp(this.closeT / CLOSE_T, 0, 1);
      if (this.closeT >= CLOSE_T) {
        const pr = this.target;
        const gp = pr ? this.props.toWorld(pr, this.local) : null;
        // 鋏の先が届いた（伸ばした鋏の先がつかみ点の近く）
        if (pr && gp && Math.hypot(claw.pinch[0] - gp[0], claw.pinch[1] - gp[1], claw.pinch[2] - gp[2]) < 0.08) {
          this.state = 'holding';
          pr.held = true;
          pr.wake();
          this.slipT = this.heavyT = 0;
          this.stats.grabs++;
          this.events.push({ kind: 'grab', prop: pr });
        } else {
          this.state = 'empty';
          this.retryT = pr ? 0.6 : 0;
          this.target = null;
          this.stats.misses++;
          this.events.push({ kind: 'miss', prop: null });
        }
      }
    } else if (this.state === 'empty') this.close = Math.min(1, this.close + dt / CLOSE_T);
    else if (this.state === 'idle') this.close = Math.max(0, this.close - dt / CLOSE_T);

    // 物の時間を進める（挟んでいれば、ばねでつなぐ）
    const pr = this.holding;
    const a0 = this.prevAnchor ?? anchor;
    const r = this.props.update(dt, crab, pr ? { prop: pr, local: this.local, a0, a1: anchor } : null);
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
    } else {
      this.tow = null;
      this.stretch = 0;
      this.strain = 0;
      this.force.fill(0);
    }
    // 案内：押していないとき、届く物
    this.hint = this.state === 'idle' && !blocked ? this.pick(claw, anchor, GRAB_REACH)?.prop ?? null : null;
  }

  drainEvents(): GrabEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
