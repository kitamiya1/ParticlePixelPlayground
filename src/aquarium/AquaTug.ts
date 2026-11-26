// 巣穴の生き物を鋏で挟んで引っ張って抜く（引っこ抜き 2.0）。ゲームロジック側（Three.js に依存しない）。
// 見た目（体の位置・向き・節の伸び・穴の縁での曲がり）は AquaBuddy が、この状態から決める。
//
// 物理エンジンは入れず、穴から出ている体を 1 本の軸の上の点で表す：
// - 体の向き dir：穴の口（地表）から体が出ている向き（単位）。鋏が引く向きへ曲がる（真上から leanMax まで。
//   横（方位）へは bendRate でしか回らない = 穴の縁に体がこすれる）。体の線はいつも穴の口を通る。
// - つかみ点（挟まれている触角・鋏の付け根）= 穴の口 + dir × u。u は、軸に沿って質点（mass）として動く：
//   鋏のばね（AquaGrab.clawSpring：挟む物と同じばね・減衰・握る力の上限）の軸の向きの成分（張力 T）と、
//   体の伸びのばね（bodyK × 伸び s、s = u − L0）・内部の減衰で動く。
// - 引き出した量 ext（0 = 触角が見えている、1 = 抜ける）。体の自然な長さ L0 = peekLen + extLen × ext。
//   生き物は穴の壁で踏ん張る（hold）：体の張力 bodyK × s が踏ん張りより大きいと、越えた分に比例して体が滑り出る
//   （ext が増える = 伸びが縮む）。小さいと、生き物は体を穴へ引き戻す（drive × (1 − 張力 / 踏ん張り)）。
//   横に引いた分（張力の、体の向きに垂直な成分）は穴の縁の摩擦（rimMu）として踏ん張りに足す（横に引くと抜けにくい）。
// - 抵抗の段階（ext で決まる）：最初 = 小刻みに震える・小さく引き戻す。中盤 = 大きく引き戻す（tug）→ 力が抜ける
//   （rest：踏ん張りが弱い。釣りの「寄せどき」）。終盤 = 激しく震え、強く短く何度も引き戻す。give より先で
//   踏ん張りが急に抜け、一気に滑り出て抜ける（done）。
// - 長く強く張っていると疲れる（stamina：踏ん張りが下がる）。放っておくと戻る。粘れば必ず抜ける。
// - 挟んでいないとき：体は縮んで、穴へ戻る（releaseRetract）。触角の出具合（peek）はカニとの距離で AquaBuddy が決める。
// 鋏の側（滑り・反作用・遅くなる）は AquaGrab.GrabSystem が受け持つ（握る力を越えて引き続けると滑る）。

import { clamp, lerp, smoothstep, type Rng } from '../core/math';
import { clawSpring, type GrabCreature } from './AquaGrab';

type V3 = [number, number, number];

/** 抵抗の段階ごとの値 */
export interface TugStageSpec {
  /** この段階の終わりの引き出し量 */
  until: number;
  /** 震え（踏ん張りの揺れの割合・周波数） */
  tremorA: number;
  tremorF: number;
  /** 引き戻し（tug）：踏ん張りの倍率・続く時間・次までの間（秒の範囲）・引き戻す速さの倍率 */
  tugP: number;
  tugDur: number;
  tugGap: [number, number];
  tugDrive: number;
  /** 引き戻しの後の力が抜ける間（踏ん張りの倍率・時間） */
  restK: number;
  restT: number;
}

export interface TugSpec {
  name: string;
  /** 握る力の上限（GrabSystem の生き物の滑り） */
  grip: number;
  /** つかみ点の重さ */
  mass: number;
  /** 穴の口からつかみ点までの長さ：隠れているとき（負 = 砂の中）・触角が見えているとき・抜けるまでに引き出す長さ */
  hideLen: number;
  peekLen: number;
  extLen: number;
  /** 挟んでいる間、生き物が体を穴の奥へ引き込める量（ext の下限。負） */
  extMin: number;
  /** 体の伸び：ばねの強さ・伸びの上限・減衰の割合 */
  bodyK: number;
  bodyMax: number;
  bodyZeta: number;
  /** 踏ん張り：引き出し量 0・mid・late・give の始まりでの強さ（間は線形） */
  hold: [number, number, number, number];
  /** 滑り出す速さ（踏ん張りを越えた張力 / holdRef あたり、ext / 秒）・引き戻す速さ（ext / 秒） */
  slide: number;
  holdRef: number;
  drive: number;
  /** 穴の縁の摩擦（横の力に掛けて踏ん張りに足す） */
  rimMu: number;
  /** 体が真上から傾ける角の上限（引き出し始め・十分出た後）と、方位へ曲がる速さ（rad / 秒） */
  leanMin: number;
  leanMax: number;
  bendRate: number;
  stages: TugStageSpec[];
  /** ここから踏ん張りが急に抜ける（give → give + giveW で 1 → giveK 倍） */
  give: number;
  giveW: number;
  giveK: number;
  /** 疲れ：下がる速さ・下限・戻る速さ */
  tire: number;
  tireMin: number;
  recover: number;
  /** 離したとき穴へ戻る速さ（ext / 秒） */
  releaseRetract: number;
}

/** スナモグリ（最初の仲間） */
export const SUNAMOGURI_TUG: TugSpec = {
  // 挟んでいる間の表示の名前（抜けて仲間になるまで正体は分からない）
  name: '何かの触角',
  grip: 10,
  mass: 0.3,
  hideLen: -0.18,
  peekLen: 0.14,
  extLen: 0.42,
  extMin: -0.14,
  bodyK: 150,
  bodyMax: 0.08,
  bodyZeta: 0.8,
  hold: [4.6, 5.4, 6.3, 6.9],
  slide: 0.6,
  holdRef: 5,
  drive: 0.09,
  rimMu: 0.35,
  leanMin: 0.55,
  leanMax: 1.15,
  bendRate: 2.0,
  stages: [
    { until: 0.3, tremorA: 0.12, tremorF: 7, tugP: 1.3, tugDur: 0.22, tugGap: [0.9, 1.5], tugDrive: 3, restK: 1, restT: 0 },
    { until: 0.72, tremorA: 0.05, tremorF: 4, tugP: 1.55, tugDur: 0.45, tugGap: [1.3, 2.0], tugDrive: 2.5, restK: 0.65, restT: 0.8 },
    { until: 1, tremorA: 0.2, tremorF: 9, tugP: 1.65, tugDur: 0.5, tugGap: [0.8, 1.3], tugDrive: 3, restK: 0.7, restT: 0.55 },
  ],
  give: 0.9,
  giveW: 0.06,
  giveK: 0.2,
  tire: 0.05,
  tireMin: 0.65,
  recover: 0.04,
  releaseRetract: 0.32,
};

export type TugStage = 'early' | 'mid' | 'late' | 'give';

export type TugEvent =
  | { kind: 'grab' }
  | { kind: 'tug'; stage: TugStage }
  | { kind: 'rest' }
  | { kind: 'stage'; stage: TugStage }
  | { kind: 'release'; why: 'release' | 'slip' | 'pop'; ext: number; tension: number };

/** 刻み（秒） */
const SUB = 1 / 120;
/** 見えている部分：穴の口からこの長さより上・基準の点から触角の先まで（体の軸に沿って）と、体の太さ */
const VISIBLE_FROM = 0.03;
const TIP = 0.1;
const PART_R = 0.05;

export class BurrowTug implements GrabCreature {
  readonly name: string;
  readonly grip: number;
  /** 挟める所の半径 */
  readonly rb = 0.07;
  /** 挟める所の中心（= つかみ点。世界） */
  readonly p: V3 = [0, 0, 0];
  /** 穴の口（地表） */
  readonly mouth: V3;
  /** 体の向き（穴の口から体が出ている向き） */
  readonly dir: V3 = [0, 1, 0];
  /** 引き出した量（挟んでいる間は extMin..1） */
  ext = 0;
  /** 穴の口から体の基準の点（鋏の付け根・触角の根元）までの長さと、その速さ */
  u: number;
  uV = 0;
  /** 鋏で挟んだ所の、基準の点からの体の軸に沿った差（負 = 頭の側、正 = 触角の先の側） */
  off = 0;
  /** 触角の出具合（0..1。AquaBuddy が決める。挟んでいる間は 1） */
  peek = 0;
  held = false;
  /** 抜けた（もう挟めない） */
  popped = false;
  stamina = 1;
  /** 体の張力（伸びのばね）・踏ん張り（このフレームの最後の刻み）・張力 / 踏ん張り・横の力 */
  tension = 0;
  hold = 0;
  load = 0;
  rub = 0;
  /** 引き出しの速さ（ext / 秒。ならした値）と、引き戻しの強さ（0..1）・力が抜けている残り時間 */
  extV = 0;
  env = 0;
  restT = 0;
  stage: TugStage = 'early';
  /** 最後に離したときの理由と張力（抜けたときの勢い） */
  lastRelease: { why: 'release' | 'slip' | 'pop'; tension: number } | null = null;
  readonly events: TugEvent[] = [];
  readonly stats = { grabs: 0, tugs: 0, rests: 0, heldT: 0, maxExt: 0, maxStretch: 0, maxTension: 0, minExt: 0 };
  private clock = 0;
  private tugT = 0;
  private nextTug = 0.8;

  constructor(mouth: readonly number[], readonly spec: TugSpec, private readonly rng: Rng) {
    this.name = spec.name;
    this.grip = spec.grip;
    this.mouth = [mouth[0], mouth[1], mouth[2]];
    this.u = spec.hideLen;
    this.syncP();
  }

  /** 体の自然な長さ（穴の口からつかみ点まで） */
  restLen(): number {
    const S = this.spec;
    return lerp(S.hideLen, S.peekLen, this.peek) + S.extLen * this.ext;
  }

  /** 体の伸び（見た目に使う。0 以上） */
  get stretch(): number {
    return Math.max(0, this.u - this.restLen());
  }

  grabbable(): boolean {
    return !this.popped && !this.held && this.peek > 0.75 && this.u > 0.05;
  }

  /**
   * 見えている部分（穴の口の少し上 → 触角の先 = つかみ点の TIP 先）の軸の上で from にいちばん近い点と、体の表面までの距離。
   * 触角でも頭でも、鋏が届いた所を挟める（挟める判定と鋏の届く所を合わせる）
   */
  nearest(from: readonly number[]): { p: V3; d: number } | null {
    if (!this.grabbable()) return null;
    const m = this.mouth, d = this.dir;
    const t = clamp((from[0] - m[0]) * d[0] + (from[1] - m[1]) * d[1] + (from[2] - m[2]) * d[2], VISIBLE_FROM, this.u + TIP);
    const p: V3 = [m[0] + d[0] * t, m[1] + d[1] * t, m[2] + d[2] * t];
    return { p, d: Math.hypot(from[0] - p[0], from[1] - p[1], from[2] - p[2]) - PART_R };
  }

  /** 鋏を閉じ始めた：狙う点（軸の上の位置をつかみ点からの差 off で持つ） */
  aim(at: readonly number[]) {
    const m = this.mouth, d = this.dir;
    const t = (at[0] - m[0]) * d[0] + (at[1] - m[1]) * d[1] + (at[2] - m[2]) * d[2];
    this.off = clamp(t - this.u, VISIBLE_FROM - this.u, TIP);
  }

  gripPoint(): V3 {
    const k = this.u + this.off;
    return [this.mouth[0] + this.dir[0] * k, this.mouth[1] + this.dir[1] * k, this.mouth[2] + this.dir[2] * k];
  }

  /** 案内の位置：挟んでいる・狙っている間はつかみ点、それ以外は見えている部分の中ほど */
  private syncP() {
    const k = this.held ? this.u + this.off : Math.max(VISIBLE_FROM, this.u + TIP * 0.3);
    this.p[0] = this.mouth[0] + this.dir[0] * k;
    this.p[1] = this.mouth[1] + this.dir[1] * k;
    this.p[2] = this.mouth[2] + this.dir[2] * k;
  }

  onGrab() {
    this.held = true;
    this.peek = 1;
    this.stats.grabs++;
    // 挟まれた瞬間、驚いて一度引き戻す（挟めた手応え）
    this.nextTug = 0.25 + this.rng() * 0.2;
    this.lastRelease = null;
    this.events.push({ kind: 'grab' });
  }

  onRelease(why: 'release' | 'slip' | 'pop') {
    this.held = false;
    this.lastRelease = { why, tension: this.tension };
    if (why === 'pop') this.popped = true;
    this.tugT = 0;
    this.events.push({ kind: 'release', why, ext: this.ext, tension: this.tension });
  }

  drainEvents(): TugEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** いまの段階の値 */
  private stageSpec(): TugStageSpec {
    const st = this.spec.stages;
    for (const s of st) if (this.ext < s.until) return s;
    return st[st.length - 1];
  }

  /** 踏ん張りの強さ（段階・疲れ・震え・引き戻し・力が抜けた間・最後に抜ける） */
  private holdNow(): number {
    const S = this.spec, h = S.hold, st = this.stageSpec();
    const e = this.ext;
    const m0 = S.stages[0].until, m1 = S.stages[1].until;
    let base = e < m0 ? lerp(h[0], h[1], clamp(e / m0, 0, 1)) : e < m1 ? lerp(h[1], h[2], (e - m0) / (m1 - m0)) : lerp(h[2], h[3], clamp((e - m1) / (S.give - m1), 0, 1));
    base *= lerp(1, S.giveK, smoothstep(S.give, S.give + S.giveW, e));
    const c = this.clock;
    const tremor = 1 + st.tremorA * Math.sin(c * Math.PI * 2 * st.tremorF) * (0.6 + 0.4 * Math.sin(c * 2.3 + 1.1));
    const tug = 1 + (st.tugP - 1) * this.env;
    const rest = this.restT > 0 ? st.restK : 1;
    return base * this.stamina * tremor * tug * rest;
  }

  /** 体の向きを、つかまれている所を引く向き（穴の口 → to）へ曲げる（傾きの上限 lean） */
  private bend(dt: number, to: readonly number[], lean: number) {
    const S = this.spec, d = this.dir, m = this.mouth;
    const px = to[0] - m[0], py = to[1] - m[1], pz = to[2] - m[2];
    const hp = Math.hypot(px, pz);
    const thT = clamp(Math.atan2(hp, py), 0, lean);
    let th = Math.acos(clamp(d[1], -1, 1));
    let az = Math.atan2(d[0], d[2]);
    th += clamp(thT - th, -4 * dt, 4 * dt);
    if (hp > 0.02) {
      const da = Math.atan2(Math.sin(Math.atan2(px, pz) - az), Math.cos(Math.atan2(px, pz) - az));
      // 真上を向いている間は方位を自由に変えられる（穴の縁にこすれない）
      const rate = th < 0.15 ? 20 : S.bendRate;
      az += clamp(da, -rate * dt, rate * dt);
    }
    const s = Math.sin(th);
    d[0] = s * Math.sin(az);
    d[1] = Math.cos(th);
    d[2] = s * Math.cos(az);
  }

  /** 傾きの上限（引き出し始めは浅く：まだ体の大部分が穴の中） */
  private leanNow(): number {
    const S = this.spec;
    return lerp(S.leanMin, S.leanMax, smoothstep(-0.1, 0.45, this.ext));
  }

  /** 段階・引き戻し・疲れを 1 フレーム進める */
  private struggle(dt: number) {
    const S = this.spec, st = this.stageSpec();
    this.clock += dt;
    const stage: TugStage = this.ext >= S.give ? 'give' : this.ext >= S.stages[1].until ? 'late' : this.ext >= S.stages[0].until ? 'mid' : 'early';
    if (stage !== this.stage) {
      this.stage = stage;
      this.events.push({ kind: 'stage', stage });
    }
    if (this.held && stage !== 'give') {
      if (this.tugT > 0) {
        this.tugT -= dt;
        if (this.tugT <= 0) {
          this.restT = st.restT;
          if (st.restT > 0) {
            this.stats.rests++;
            this.events.push({ kind: 'rest' });
          }
          this.nextTug = lerp(st.tugGap[0], st.tugGap[1], this.rng());
        }
      } else if ((this.nextTug -= dt) <= 0) {
        this.tugT = st.tugDur * (0.8 + 0.4 * this.rng());
        this.stats.tugs++;
        this.events.push({ kind: 'tug', stage });
      }
    } else this.tugT = 0;
    this.env += ((this.tugT > 0 ? 1 : 0) - this.env) * (1 - Math.exp(-dt * (this.tugT > 0 ? 14 : 7)));
    this.restT = Math.max(0, this.restT - dt);
    if (this.held && this.load > 0.6) this.stamina = Math.max(S.tireMin, this.stamina - S.tire * dt);
    else if (!this.held) this.stamina = Math.min(1, this.stamina + S.recover * dt);
  }

  /**
   * 挟んでいる間（GrabSystem が毎フレーム呼ぶ）。a0 → a1 = 鋏の構えの位置（前・今のフレーム）
   */
  stepHeld(dt: number, a0: readonly number[], a1: readonly number[]): { force: V3; over: number; tugOver: number; stretch: number; done: boolean } {
    const S = this.spec;
    const force: V3 = [0, 0, 0];
    let over = 0, tugOver = 0, stretch = 0;
    if (dt <= 0) return { force, over, tugOver, stretch, done: false };
    this.peek = 1;
    this.struggle(dt);
    const n = Math.max(1, Math.round(dt / SUB)), h = dt / n;
    const avx = (a1[0] - a0[0]) / dt, avy = (a1[1] - a0[1]) / dt, avz = (a1[2] - a0[2]) / dt;
    const f: V3 = [0, 0, 0];
    const cB = 2 * S.bodyZeta * Math.sqrt(S.bodyK * S.mass);
    const st = this.stageSpec();
    let extVsum = 0;
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const ax = lerp(a0[0], a1[0], k), ay = lerp(a0[1], a1[1], k), az = lerp(a0[2], a1[2], k);
      this.bend(h, [ax, ay, az], this.leanNow());
      const d = this.dir, m = this.mouth;
      // 挟んだ所は穴の口より下へは入らない（引き込まれても、鋏は見えている所を挟んだまま）
      this.off = Math.max(this.off, VISIBLE_FROM - this.u);
      const ug = this.u + this.off;
      const gx = m[0] + d[0] * ug, gy = m[1] + d[1] * ug, gz = m[2] + d[2] * ug;
      const raw = clawSpring(ax - gx, ay - gy, az - gz, avx - d[0] * this.uV, avy - d[1] * this.uV, avz - d[2] * this.uV, S.mass, S.grip, f);
      over = Math.max(over, raw / S.grip);
      const T = f[0] * d[0] + f[1] * d[1] + f[2] * d[2];
      const lat = Math.hypot(f[0] - d[0] * T, f[1] - d[1] * T, f[2] - d[2] * T);
      // 体：伸びのばね（縮む向きは硬い = 体が穴の口で突っかえる）と内部の減衰
      const L0 = this.restLen();
      const s = this.u - L0;
      const Fb = s > 0 ? S.bodyK * s : S.bodyK * 4 * s;
      this.uV += ((T - Fb - cB * this.uV) / S.mass) * h;
      this.u += this.uV * h;
      if (this.u - L0 > S.bodyMax) {
        this.u = L0 + S.bodyMax;
        this.uV = Math.min(this.uV, Math.max(0, this.extV) * S.extLen);
      }
      // 踏ん張り：張力が越えたら滑り出る。下回れば引き戻す（引き戻している間 = tug は速い）
      const Tb = S.bodyK * Math.max(0, this.u - L0);
      const H = this.holdNow() + S.rimMu * lat;
      let ev: number;
      // （力が抜けている間 = rest は滑りやすい：寄せどき）
      if (Tb > H) ev = (S.slide * (this.restT > 0 ? 2 : 1) * (Tb - H)) / S.holdRef;
      else ev = -S.drive * (1 + (st.tugDrive - 1) * this.env) * (1 - Tb / H);
      this.ext = clamp(this.ext + ev * h, S.extMin, 1);
      extVsum += ev;
      this.tension = Tb;
      this.hold = H;
      this.rub = lat;
      this.load = Tb / Math.max(H, 1e-3);
      // 暴れている（引き戻している）間に強く張っている：生き物が引く力が鋏の張力に重なり、握る力を越える
      // （緩めればすぐ下がる。釣りの「走られたら糸を出す」）
      tugOver = Math.max(tugOver, (this.env * st.tugP * Math.hypot(f[0], f[1], f[2])) / S.grip);
      force[0] += f[0];
      force[1] += f[1];
      force[2] += f[2];
      stretch = Math.hypot(ax - gx, ay - gy, az - gz);
    }
    force[0] /= n;
    force[1] /= n;
    force[2] /= n;
    this.extV += (extVsum / n - this.extV) * (1 - Math.exp(-dt * 10));
    this.syncP();
    this.stats.heldT += dt;
    this.stats.maxExt = Math.max(this.stats.maxExt, this.ext);
    this.stats.minExt = Math.min(this.stats.minExt, this.ext);
    this.stats.maxStretch = Math.max(this.stats.maxStretch, this.stretch);
    this.stats.maxTension = Math.max(this.stats.maxTension, this.tension);
    return { force, over, tugOver, stretch, done: this.ext >= 1 };
  }

  /**
   * 挟んでいないとき（AquaBuddy が毎フレーム呼ぶ）：体が縮んで穴へ戻る。toward = 体を少し傾ける先（カニの鋏）、
   * peek = 触角の出具合の目標
   */
  stepFree(dt: number, toward: readonly number[] | null, peekT: number) {
    const S = this.spec;
    if (dt <= 0 || this.held) return;
    this.struggle(dt);
    this.peek += (peekT - this.peek) * (1 - Math.exp(-dt * 3));
    // 引き出しかけた体は穴へ戻る（離してすぐなら、まだ出ているうちに挟み直せる）。引き込んだ分は元の深さへ
    if (this.ext > 0) this.ext = Math.max(0, this.ext - S.releaseRetract * dt);
    else this.ext = Math.min(0, this.ext + 0.3 * dt);
    // 伸びは縮む
    const L0 = this.restLen();
    this.u += (L0 - this.u) * (1 - Math.exp(-dt * 12));
    this.uV = 0;
    this.tension = this.load = this.rub = 0;
    this.extV *= Math.exp(-dt * 8);
    // 体は、近くにいるカニの方へ少し傾く（触角で探る。鋏が届きやすい）
    this.bend(dt, toward ?? [this.mouth[0], this.mouth[1] + 1, this.mouth[2]], 0.55 * clamp(this.peek, 0, 1) + 0.4 * clamp(this.ext, 0, 1));
    this.syncP();
  }
}
