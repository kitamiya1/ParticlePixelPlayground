// 第 5 段階：環境との相互作用。ハサミ（GrabSystem）で挟める「生き物」（GrabCreature）として、
// - 水草（PlantGrab）：茎・葉を直接挟む。引くと植物がしなり（AquaPlants の held）、根が張っている植物は抵抗する（ばねの力がカニへ返る）。
//   張力が種類ごとの強さを一定の時間超えると、根元の近くを挟んでいれば根元から抜け、高い所を挟んでいればそこで切れる。
//   抜けた・ちぎれた部分は「かけら」（WeedPieces：円盤の集まり + 軽い物理の物 PropKind 'weed'）になり、そのまま挟んで運べる。
//   離すと水中を漂ってゆっくり沈む。シダ・葉の広い草は根が強く、強く引くとハサミが滑る（抜けにくい）。
// - エビ・小魚（LifeGrab）：近づくと逃げる（AquaLife の従来の動き）。ハサミが届けば挟める。挟まれた生き物は体を動かして抵抗し
//   （エビ = 尾で跳ねる強い一打ち、小魚 = 尾を振る小刻みな力）、その力がハサミを越えるとハサミから逃れる。離すと従来の動きへ戻る
//   （逃げる）。地形・ガラスにはめり込ませない。
// 名前や「挟める」は常には出さない（触れて・挟んでみると、動き・抵抗・音で分かる）。

import * as THREE from 'three';
import { clawSpring, GRIP_FORCE, Prop, type GrabCreature, type GrabSystem, type PropSystem, type V3 } from './AquaGrab';
import type { AquaLife, Fish, Shrimp } from './AquaLife';
import { PLANT_PARAMS, type PlantField } from './AquaPlants';
import type { AquariumWorld } from './AquariumWorld';
import type { SurfelRenderer } from '../render/surfel/SurfelRenderer';

/** 種類ごとの、抜ける張力・ちぎれる張力（null = ちぎれない）・ちぎれる高さ（根元からの距離）の下限・かけらの重さ */
const PLANT_STRENGTH = [
  { name: 'テープ状の葉', uproot: 4.6, cut: 3.6, cutAbove: 0.16, mass: 0.03 },
  { name: '有茎草', uproot: 5.4, cut: 4.6, cutAbove: 0.2, mass: 0.05 },
  { name: 'シダ', uproot: 7.2, cut: null, cutAbove: 1, mass: 0.12 },
  { name: '葉の広い草', uproot: 7.6, cut: null, cutAbove: 1, mass: 0.12 },
  { name: '汀線の草', uproot: 3.4, cut: null, cutAbove: 1, mass: 0.02 },
] as const;
/** 張力が強さを越えている時間がこれを越えたら抜ける・ちぎれる */
const BREAK_T = 0.35;
/** 植物の握る力（物と同じ）。茎は細いので少し小さく */
const PLANT_GRIP = GRIP_FORCE * 0.95;

export interface Detach {
  i: number;
  cutY: number | null;
  at: V3;
}

export class PlantGrab implements GrabCreature {
  name = '水草';
  readonly p: V3 = [0, 0, 0];
  readonly rb = 0.04;
  readonly grip = PLANT_GRIP;
  readonly bonus = 0;
  private cand: { i: number; f: number } | null = null;
  i = -1;
  private fg = 0;
  private strainT = 0;
  private result: Detach | null = null;
  readonly stats = { grabs: 0, uproots: 0, cuts: 0, slips: 0, maxTension: 0 };

  constructor(private readonly field: PlantField, private readonly onDetach: (d: Detach) => void) {}

  grabbable(): boolean {
    return this.field.mode === 'dyn';
  }

  nearest(from: readonly number[]): { p: V3; d: number } | null {
    const n = this.field.nearestStem(from, 0.3);
    if (!n) return null;
    this.cand = { i: n.i, f: n.f };
    if (this.i < 0) this.name = PLANT_PARAMS[this.field.table.kind[n.i]].name;
    return { p: n.p, d: n.d };
  }

  /** いまのつかみ点（茎の、挟んだ高さの点 + 曲がり） */
  gripPoint(): readonly number[] {
    if (this.i < 0) return this.p;
    const T = this.field.table, i = this.i;
    const y = T.root[i * 3 + 1] + this.fg * T.height[i];
    const o = this.field.offsetAt(i, y);
    this.p[0] = T.root[i * 3] + o[0];
    this.p[1] = y + o[1];
    this.p[2] = T.root[i * 3 + 2] + o[2];
    return this.p;
  }

  aim(at: readonly number[]) {
    if (!this.cand) return;
    this.i = this.cand.i;
    this.fg = Math.min(0.98, Math.max(0.04, this.cand.f));
    this.p[0] = at[0];
    this.p[1] = at[1];
    this.p[2] = at[2];
    this.name = PLANT_PARAMS[this.field.table.kind[this.i]].name;
  }

  onGrab() {
    this.strainT = 0;
    this.result = null;
    this.stats.grabs++;
    this.stats.maxTension = 0;
    this.field.held = { i: this.i, dx: 0, dz: 0, fc: this.fg };
  }

  onRelease(kind: 'release' | 'slip' | 'pop') {
    if (this.field.held?.i === this.i) this.field.held = null;
    if (kind === 'slip') this.stats.slips++;
    const r = this.result;
    this.i = -1;
    this.result = null;
    // （かけらを鋏に渡すのは、鋏の状態の更新が終わってから：flush。release の途中で渡すと、その後 idle に戻される）
    if (kind === 'pop' && r) this.pending = r;
  }

  private pending: Detach | null = null;

  /** 抜けた・ちぎれた植物をかけらにして鋏に渡す（GrabSystem.post の後に毎フレーム呼ぶ） */
  flush() {
    const r = this.pending;
    this.pending = null;
    if (r) this.onDetach(r);
  }

  stepHeld(dt: number, a0: readonly number[], a1: readonly number[]) {
    const T = this.field.table, i = this.i;
    const k = PLANT_PARAMS[T.kind[i]], S = PLANT_STRENGTH[T.kind[i]];
    const rx = T.root[i * 3], ry = T.root[i * 3 + 1], rz = T.root[i * 3 + 2];
    const restY = ry + this.fg * T.height[i];
    // 植物を鋏の方へ曲げる（曲がりの上限まで。上限を越えて引いた分が張力になる）
    let dx = a1[0] - rx, dz = a1[2] - rz;
    const dl = Math.hypot(dx, dz);
    if (dl > k.max) {
      dx *= k.max / dl;
      dz *= k.max / dl;
    }
    if (this.field.held) {
      this.field.held.dx = dx;
      this.field.held.dz = dz;
    }
    const p = this.gripPoint();
    const kv = dt > 0 ? 1 / dt : 0;
    const out: V3 = [0, 0, 0];
    // 茎はしなるので、鋏とのばねは柔らかめ（mass を小さく = 減衰を弱く）。縦に引くと根を引き抜く向きの張力
    const ex = a1[0] - p[0], ey = a1[1] - p[1], ez = a1[2] - p[2];
    const raw = clawSpring(ex, ey * 1.2, ez, (a1[0] - a0[0]) * kv, (a1[1] - a0[1]) * kv, (a1[2] - a0[2]) * kv, 0.25, this.grip, out);
    this.stats.maxTension = Math.max(this.stats.maxTension, raw);
    // 抜ける・ちぎれる：高い所を挟んでいて、ちぎれる種類なら、ちぎれる強さ。そうでなければ抜ける強さ
    const cuts = S.cut !== null && this.fg * T.height[i] >= S.cutAbove;
    const need = cuts ? S.cut! : S.uproot;
    this.strainT = raw > need ? this.strainT + dt : Math.max(0, this.strainT - dt * 0.5);
    let done = false;
    if (this.strainT > BREAK_T) {
      done = true;
      this.result = { i, cutY: cuts ? restY - 0.02 : null, at: [p[0], p[1], p[2]] };
      if (cuts) this.stats.cuts++;
      else this.stats.uproots++;
    }
    return { force: out, over: raw / this.grip, tugOver: 0, stretch: Math.hypot(ex, ey, ez), done };
  }
}

/** かけらにする範囲（つかんだ所からの距離） */
const PIECE_R = 1.0;

/** 抜いた・ちぎった水草のかけら（円盤の集まり + 軽い物理の物） */
export class WeedPieces {
  readonly list: { prop: Prop; mesh: THREE.Mesh }[] = [];
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  /** 一度に残すかけらの数（古いものから片づける） */
  max = 8;

  constructor(private readonly field: PlantField, private readonly surfel: SurfelRenderer, private readonly props: PropSystem, private readonly pos: ArrayLike<number>) {}

  /** かけらを作って、鋏 claw に挟ませる */
  spawn(d: Detach, claw: GrabSystem): Prop | null {
    const all = this.field.detach(d.i, d.cutY, this.pos);
    if (!all.length) return null;
    this.surfel.hideWorldPoints(all);
    // かけらにするのは、つかんだ所から PIECE_R までの円盤（長い葉の先は流れて消える）。持って歩いても画面を覆わない
    const idx = all.filter((k) => Math.hypot(this.pos[k * 3] - d.at[0], this.pos[k * 3 + 1] - d.at[1], this.pos[k * 3 + 2] - d.at[2]) <= PIECE_R);
    if (!idx.length) return null;
    const mesh = this.surfel.addPiece(idx, d.at);
    // 当たりの楕円体：かけらの広がり（つかみ点まわり）の半分。細長い葉でも大きくしすぎない
    let ex = 0.03, ey = 0.03, ez = 0.03;
    for (const k of idx) {
      ex = Math.max(ex, Math.abs(this.pos[k * 3] - d.at[0]));
      ey = Math.max(ey, Math.abs(this.pos[k * 3 + 1] - d.at[1]));
      ez = Math.max(ez, Math.abs(this.pos[k * 3 + 2] - d.at[2]));
    }
    const semi: V3 = [Math.min(0.14, ex * 0.5), Math.min(0.14, ey * 0.35), Math.min(0.14, ez * 0.5)];
    const S = PLANT_STRENGTH[this.field.table.kind[d.i]];
    const prop = new Prop(`weed${this.n++}`, 'weed', 1, [...d.at], 0, { semi, mass: S.mass * (d.cutY === null ? 1 : 0.6), name: S.name });
    this.list.push({ prop, mesh });
    while (this.list.length > this.max) {
      const old = this.list.shift()!;
      if (old.prop.held) continue;
      this.surfel.removePiece(old.mesh);
      const j = this.props.props.indexOf(old.prop);
      if (j >= 0) this.props.props.splice(j, 1);
    }
    claw.forceHold(prop, d.at);
    this.update();
    return prop;
  }

  /** かけらの円盤を物の位置・向きへ */
  update() {
    for (const { prop, mesh } of this.list) {
      this.q.set(prop.q[0], prop.q[1], prop.q[2], prop.q[3]);
      this.v.set(prop.p[0], prop.p[1], prop.p[2]);
      mesh.matrix.compose(this.v, this.q, this.s);
      mesh.matrixWorld.copy(mesh.matrix);
    }
  }
}

type Critter = { kind: 'fish'; c: Fish } | { kind: 'shrimp'; c: Shrimp };

/** 生き物ごとの、体の半径・重さ・握られる力（これを越えて暴れるとハサミから逃れる）・暴れる強さ */
const CRITTER = {
  shrimp: { name: 'エビ', r: 0.07, mass: 0.06, grip: GRIP_FORCE * 0.52, kick: 8.5, kickT: 0.07, every: [0.45, 1.0] as const },
  fish: { name: '小魚', r: 0.08, mass: 0.08, grip: GRIP_FORCE * 0.5, kick: 4.2, kickT: 0.28, every: [0.25, 0.6] as const },
};

export class LifeGrab implements GrabCreature {
  name = '生き物';
  readonly p: V3 = [0, 0, 0];
  readonly rb = 0.07;
  grip = CRITTER.shrimp.grip;
  readonly bonus = 0;
  private cand: Critter | null = null;
  held: Critter | null = null;
  /** 挟まれた生き物の速さ・暴れの残り時間と次の暴れまで・暴れる向き */
  private readonly v: V3 = [0, 0, 0];
  private kickT = 0;
  private nextT = 0.3;
  private readonly kd: V3 = [0, 0, 0];
  private t = 0;
  readonly stats = { grabs: 0, escapes: 0, releases: 0, kicks: 0 };

  constructor(private readonly life: AquaLife, private readonly world: AquariumWorld) {}

  grabbable(): boolean {
    return true;
  }

  nearest(from: readonly number[]): { p: V3; d: number } | null {
    let best: { p: V3; d: number; c: Critter } | null = null;
    const L = this.life;
    const test = (c: Critter) => {
      const b = c.c, r = CRITTER[c.kind].r;
      if (L.caught.has(b)) return;
      const y = c.kind === 'shrimp' ? b.y + 0.04 : b.y;
      const d = Math.hypot(b.x - from[0], y - from[1], b.z - from[2]) - r;
      if (d > 0.35 || (best && d >= best.d)) return;
      best = { p: [b.x, y, b.z], d: Math.max(0, d), c };
    };
    for (const f of L.fish) test({ kind: 'fish', c: f });
    for (const s of L.shrimp) test({ kind: 'shrimp', c: s });
    if (!best) return null;
    const B = best as { p: V3; d: number; c: Critter };
    this.cand = B.c;
    if (!this.held) this.name = CRITTER[B.c.kind].name;
    return { p: B.p, d: B.d };
  }

  gripPoint(): readonly number[] {
    const c = this.held ?? this.cand;
    if (c) {
      this.p[0] = c.c.x;
      this.p[1] = c.kind === 'shrimp' ? c.c.y + 0.04 : c.c.y;
      this.p[2] = c.c.z;
    }
    return this.p;
  }

  aim(_at: readonly number[]) {
    // 狙った時点の生き物（閉じる間に逃げても、届けば挟む）
  }

  onGrab() {
    const c = this.cand;
    if (!c) return;
    this.held = c;
    this.life.caught.add(c.c);
    const C = CRITTER[c.kind];
    this.grip = C.grip;
    this.name = C.name;
    this.v[0] = this.v[1] = this.v[2] = 0;
    this.kickT = 0;
    this.nextT = 0.15;
    this.stats.grabs++;
  }

  onRelease(kind: 'release' | 'slip' | 'pop') {
    const c = this.held;
    this.held = null;
    if (!c) return;
    this.life.caught.delete(c.c);
    if (kind === 'slip') this.stats.escapes++;
    else this.stats.releases++;
    // 離れた：勢いのまま逃げる（エビは後ろへ跳ねる・小魚は怖がって速く泳ぐ）
    const b = c.c;
    if (c.kind === 'shrimp') {
      const s = b as Shrimp;
      s.vx = this.v[0] * 0.5 + this.kd[0] * 2.5;
      s.vz = this.v[2] * 0.5 + this.kd[2] * 2.5;
      s.vy = 1.1;
      s.airborne = true;
      s.state = 'dart';
      s.timer = 0.7;
    } else {
      const f = b as Fish;
      f.vx = this.v[0] + this.kd[0] * 3;
      f.vy = this.v[1];
      f.vz = this.v[2] + this.kd[2] * 3;
      f.fear = 1;
    }
  }

  stepHeld(dt: number, a0: readonly number[], a1: readonly number[]) {
    const c = this.held!, C = CRITTER[c.kind], b = c.c;
    this.t += dt;
    // 暴れる：エビは間をおいて尾で強く跳ね（後ろ・上へ）、小魚は尾を左右に振り続けて、ときどき強く身をよじる
    this.nextT -= dt;
    if (this.nextT <= 0) {
      this.nextT = C.every[0] + Math.random() * (C.every[1] - C.every[0]);
      this.kickT = C.kickT;
      const a = Math.random() * Math.PI * 2;
      // 向き：鋏から離れる向き + 横へ（体を振る）
      const ax = b.x - a1[0], az = b.z - a1[2], al = Math.hypot(ax, az) || 1;
      this.kd[0] = (ax / al) * 0.6 + Math.cos(a) * 0.8;
      this.kd[1] = c.kind === 'shrimp' ? 0.6 : (Math.random() - 0.5) * 0.4;
      this.kd[2] = (az / al) * 0.6 + Math.sin(a) * 0.8;
      const l = Math.hypot(...this.kd) || 1;
      for (let j = 0; j < 3; j++) this.kd[j] /= l;
      this.stats.kicks++;
    }
    let kick = 0;
    if (this.kickT > 0) {
      this.kickT -= dt;
      kick = C.kick;
    }
    const wig = c.kind === 'fish' ? Math.sin(this.t * 55) * 1.6 : Math.sin(this.t * 30) * 0.6;
    const gp = this.gripPoint();
    const kv = dt > 0 ? 1 / dt : 0;
    const out: V3 = [0, 0, 0];
    const ex = a1[0] - gp[0], ey = a1[1] - gp[1], ez = a1[2] - gp[2];
    const raw = clawSpring(ex, ey, ez, (a1[0] - a0[0]) * kv - this.v[0], (a1[1] - a0[1]) * kv - this.v[1], (a1[2] - a0[2]) * kv - this.v[2], C.mass, this.grip, out);
    // 生き物の体を進める（ばねで鋏へ、暴れる力で離れる）
    const fx = out[0] + this.kd[0] * kick + this.kd[2] * wig, fy = out[1] + this.kd[1] * kick, fz = out[2] + this.kd[2] * kick - this.kd[0] * wig;
    this.v[0] = (this.v[0] + (fx / C.mass) * dt) * Math.exp(-dt * 6);
    this.v[1] = (this.v[1] + (fy / C.mass) * dt) * Math.exp(-dt * 6);
    this.v[2] = (this.v[2] + (fz / C.mass) * dt) * Math.exp(-dt * 6);
    let nx = b.x + this.v[0] * dt, ny = b.y + this.v[1] * dt, nz = b.z + this.v[2] * dt;
    // 地形・ガラス・管にめり込ませない
    const w = this.world;
    for (let k = 0; k < 3; k++) {
      const d = w.contactSolid(nx, ny + 0.04, nz);
      if (d >= C.r) break;
      const n = w.contactNormal(nx, ny + 0.04, nz);
      nx += n[0] * (C.r - d);
      ny += n[1] * (C.r - d);
      nz += n[2] * (C.r - d);
    }
    b.x = nx;
    b.y = ny;
    b.z = nz;
    // 体の向き：暴れる向きへ少しずつ（小魚は頭を振る）
    if (c.kind === 'fish') {
      const f = b as Fish;
      f.heading += Math.sin(this.t * 22) * 0.25;
      f.phase += dt * 30;
      f.fear = 1;
    } else {
      const s = b as Shrimp;
      s.phase += dt * 24;
      s.heading += kick > 0 ? 0.3 : 0;
    }
    // 暴れて握る力を越えた分：over（GrabSystem が滑らせる）
    const over = raw / this.grip;
    return { force: out, over, tugOver: kick > 0 ? over : 0, stretch: Math.hypot(ex, ey, ez), done: false };
  }
}
