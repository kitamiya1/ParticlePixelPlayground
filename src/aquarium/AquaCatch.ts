// 第 5 段階：環境との相互作用。ハサミ（GrabSystem）で挟める「生き物」（GrabCreature）として、
// - 水草（PlantGrab）：茎・葉を直接挟む。引くと植物が大きくしなり（AquaPlants の held。種類ごとの上限 cap まで）、引くほど抵抗が
//   増えて（張力が距離の 3 乗で硬くなる）カニが引き戻される（ばねの力がカニへ返る：GrabSystem の tow）。離すと曲がっていた分だけ
//   ビヨーンと跳ね返って何度か揺れ戻る（AquaPlants.fling）。上へ引くほど・強く引くほど葉が震える。
//   第 6 段階（iPhone の確認から）：引くだけでは抜けない・ちぎれない。強く引きすぎる（握る力を越える）と先にハサミが滑る。
//   抜く・ちぎるは、挟んだまま「掘る」ボタン（F・X / □）で意図して行う（twist）：高い所を挟んでいて、ちぎれる種類なら切る。
//   そうでなければ種類ごとの強さ以上に引いている間だけ、根をゆすって抜ける（足りなければ草が震えるだけ）。
//   抜けた・ちぎれた部分は「かけら」（WeedPieces：円盤の集まり + 軽い物理の物 PropKind 'weed'）になり、つかんだ所の近くは
//   そのまま挟んで運べ、その先（長い葉の先）は離れたかけらとして漂う（消さない）。離すと水中を漂ってゆっくり沈む。
//   長い葉は柔らかく大きくしなり、有茎草は中くらい、シダ・葉の広い草は硬く・根が強い（抜くには強く引く）。
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

/**
 * 種類ごとの引っ張りの手応え（PLANT_KIND の順）。
 * cap = 挟んでいる間の曲がりの上限（ふだんの押された上限より大きくしなる）、k = 引く強さ（張力 / 引いた距離）、
 * soft = これを越えて引くと急に硬くなる距離（引くほど抵抗が増える）、boing = 離したときの跳ね返り、quiver = 張ったときの震え、
 * uproot = 抜くのに要る張りの割合（握る力に対して。「抜く」を押したときにこれだけ引いていれば根元から抜ける）、
 * cut = ちぎれる種類か・cutAbove = ちぎれる高さ（根元からの距離）の下限、mass = かけらの重さ
 * （第 6 段階：引くだけでは抜けない・ちぎれない。強く引きすぎるとハサミが先に滑る。抜く・ちぎるは「掘る」ボタンで意図して行う）
 */
const PLANT_PULL = [
  { name: 'テープ状の葉', cap: 1.05, k: 2.6, soft: 0.85, boing: 2.2, quiver: 0.9, uproot: 0.3, cut: true, cutAbove: 0.16, mass: 0.03 },
  { name: '有茎草', cap: 0.8, k: 4.0, soft: 0.62, boing: 1.8, quiver: 0.7, uproot: 0.38, cut: true, cutAbove: 0.2, mass: 0.05 },
  { name: 'シダ', cap: 0.45, k: 6.0, soft: 0.45, boing: 1.2, quiver: 0.5, uproot: 0.62, cut: false, cutAbove: 1, mass: 0.12 },
  { name: '葉の広い草', cap: 0.4, k: 6.8, soft: 0.4, boing: 1.0, quiver: 0.45, uproot: 0.68, cut: false, cutAbove: 1, mass: 0.12 },
  { name: '汀線の草', cap: 0.45, k: 3.2, soft: 0.5, boing: 2.0, quiver: 0.8, uproot: 0.22, cut: false, cutAbove: 1, mass: 0.02 },
] as const;
/** 植物の握る力（物と同じ）。茎は細いので少し小さく */
const PLANT_GRIP = GRIP_FORCE * 0.95;
/** ちぎる（ハサミで切る）・抜く（引きながら根をゆする）の長さ */
const CUT_T = 0.14;
const UPROOT_T = 0.3;
/** 両方のハサミで引き裂く：挟んだときより鋏の間をこれだけ広げるとちぎれる・2 本目のばねの強さ */
const TEAR_D = 0.06;
const SECOND_K = 60;

export interface Detach {
  i: number;
  cutY: number | null;
  at: V3;
}

/** 「掘る」ボタンを押したときの結果：ちぎり始めた・抜き始めた・引きが足りない（抜けない）・水草を挟んでいない */
export type TwistResult = 'cut' | 'uproot' | 'weak' | null;

export class PlantGrab implements GrabCreature {
  name = '水草';
  readonly p: V3 = [0, 0, 0];
  readonly rb = 0.04;
  readonly grip = PLANT_GRIP;
  readonly bonus = 0;
  /** 大きくしなるので、鋏が届かない量は広めに許す（引いても鋏がすぐ外れない） */
  readonly slipReach = 0.15;
  /** 引くほど歩みが重くなる（ふつうに歩いて引くと握る力の手前で止まる） */
  readonly slow = 0.92;
  private cand: { i: number; f: number } | null = null;
  i = -1;
  /** 挟んだ高さ（根元からの高さの割合） */
  fg = 0;
  private prevL = -1;
  /** 張り（張力 / 握る力。約 0.15 秒でならす）・曲がり（表示・検証用） */
  tension = 0;
  bend = 0;
  /** ちぎる・抜くの途中（残り時間） */
  private act: { kind: 'cut' | 'uproot'; t: number } | null = null;
  private result: Detach | null = null;
  readonly stats = { grabs: 0, uproots: 0, cuts: 0, slips: 0, releases: 0, weak: 0, maxTension: 0, maxBend: 0, tears: 0 };
  /**
   * 両方のハサミで同じ株を挟む（2026-11-28）：もう 1 本の鋏の窓口（main が組にする）。後から挟んだ方は secondary（株のしなりは
   * 先に挟んだ方が決める）。2 本の鋏の間を、挟んだときより TEAR_D 以上広げると、ちぎれる種類の株は 2 つのつかみ点の間で
   * ちぎれる（上のかけらは上を挟んでいた鋏へ、根の付いた方は下の鋏に残る）
   */
  partner: PlantGrab | null = null;
  secondary = false;
  /** 挟んだときの、もう 1 本の鋏との間（世界）・このフレームの鋏の構え */
  private sep0 = 0;
  readonly lastA: V3 = [0, 0, 0];
  /** もう 1 本の鋏から頼まれた、ちぎれ（上のかけらを受け取る：次の stepHeld で done） */
  private tearReq: Detach | null = null;

  constructor(private readonly field: PlantField, private readonly onDetach: (d: Detach) => void) {}

  grabbable(): boolean {
    return this.field.mode === 'dyn';
  }

  nearest(from: readonly number[]): { p: V3; d: number } | null {
    // （0.6 まで探す：挟めるかは GrabSystem が距離で決める。体の中心から探す狙いの補助（near）にも見つかるように）
    // もう 1 本の鋏が株を挟んでいる：同じ株の別の所だけ挟める（ほかの株を挟むと、その鋏の株のしなりを奪ってしまう）
    const P = this.partner;
    const n = this.field.nearestStem(from, 0.6, this.i < 0 && P && P.holding ? P.i : -1);
    if (!n) return null;
    this.cand = { i: n.i, f: n.f };
    this.from[0] = from[0];
    this.from[1] = from[1];
    this.from[2] = from[2];
    if (this.i < 0) this.name = PLANT_PARAMS[this.field.table.kind[n.i]].name;
    return { p: n.p, d: n.d };
  }

  /** いまのつかみ点（茎の、挟んだ高さの点 + 曲がり） */
  gripPoint(): readonly number[] {
    if (this.i < 0) return this.p;
    const T = this.field.table, i = this.i;
    const y = T.root[i * 3 + 1] + this.fg * T.height[i];
    const o = this.field.offsetAt(i, y);
    this.p[0] = T.root[i * 3] + o[0] + this.side[0];
    this.p[1] = y + o[1];
    this.p[2] = T.root[i * 3 + 2] + o[2] + this.side[1];
    return this.p;
  }

  /**
   * 茎の中心から、挟んだ側の面へのずれ（水平）。太い株（シダ・葉の広い草）は中心ではなく手前の葉の所を挟む
   * （中心までは鋏が届かない）。細い茎では小さい
   */
  private readonly side: [number, number] = [0, 0];

  aim(at: readonly number[]) {
    if (!this.cand) return;
    this.i = this.cand.i;
    this.fg = Math.min(0.98, Math.max(0.04, this.cand.f));
    this.p[0] = at[0];
    this.p[1] = at[1];
    this.p[2] = at[2];
    const T = this.field.table, kp = PLANT_PARAMS[T.kind[this.i]];
    this.name = kp.name;
    // 鋏の付け根の側（この時点の狙う点 = 茎の中心の点。鋏の構えの側は GrabSystem が知っている：from に近い向き）
    const fx = this.from[0] - at[0], fz = this.from[2] - at[2], fl = Math.hypot(fx, fz);
    const s = fl > 1e-4 ? Math.min(kp.thick * 0.42, fl * 0.5) / fl : 0;
    this.side[0] = fx * s;
    this.side[1] = fz * s;
  }

  /** nearest を最後に呼んだ所（鋏の構えの先・付け根。aim で挟む側を決める） */
  private readonly from: V3 = [0, 0, 0];

  onGrab() {
    this.result = null;
    this.act = null;
    this.tearReq = null;
    this.prevL = -1;
    this.tension = this.bend = 0;
    this.stats.grabs++;
    this.stats.maxTension = 0;
    this.stats.maxBend = 0;
    const P = this.partner;
    // （鋏の構えの最初の値：もう 1 本の鋏が引き裂きの間を測る基準。stepHeld で毎フレーム書き直す）
    const g0 = this.gripPoint();
    this.lastA[0] = g0[0];
    this.lastA[1] = g0[1];
    this.lastA[2] = g0[2];
    // もう 1 本の鋏が同じ株を挟んでいる：2 本目（株のしなりは 1 本目のまま）
    this.secondary = !!P && P.holding && P.i === this.i;
    if (this.secondary && P) {
      // （2 本の鋏の構えの間は、最初の stepHeld で測る：構えはつかみ点から少し離れているので）
      this.sep0 = -1;
      return;
    }
    this.field.held = { i: this.i, dx: 0, dz: 0, fc: this.fg, cap: PLANT_PULL[this.field.table.kind[this.i]].cap, fl: 0 };
  }

  /**
   * 2 本目の鋏（同じ株の別の所）：つかみ点（株のしなりは 1 本目が決める）と鋏の構えをばねでつなぐ。鋏の間を広げると
   * ちぎれる種類の株は 2 つのつかみ点の間（真ん中の高さ）でちぎれ、上を挟んでいた鋏が上のかけらを受け取る
   */
  private stepSecondary(a1: readonly number[]) {
    const gp = this.gripPoint();
    const ex = a1[0] - gp[0], ey = a1[1] - gp[1], ez = a1[2] - gp[2], L = Math.hypot(ex, ey, ez);
    const raw = SECOND_K * L, F = Math.min(raw, this.grip);
    const out: V3 = L > 1e-6 ? [(ex / L) * F, (ey / L) * F, (ez / L) * F] : [0, 0, 0];
    const P = this.partner;
    const T = this.field.table, i = this.i, S = PLANT_PULL[T.kind[i]];
    if (P && P.holding && P.i === i && S.cut) {
      const pa = P.lastA, sep = Math.hypot(a1[0] - pa[0], a1[1] - pa[1], a1[2] - pa[2]);
      if (this.sep0 < 0) this.sep0 = sep;
      if (sep - this.sep0 > TEAR_D) {
        const lo = Math.min(this.fg, P.fg), hi = Math.max(this.fg, P.fg);
        const ry = T.root[i * 3 + 1], cutY = ry + ((lo + hi) / 2) * T.height[i];
        if (cutY - ry >= S.cutAbove * 0.5 && cutY < ry + this.field.cutH[i] - 0.03) {
          const upperIsMe = this.fg >= P.fg;
          const g = (upperIsMe ? this : P).gripPoint();
          const d: Detach = { i, cutY, at: [g[0], g[1], g[2]] };
          this.stats.tears++;
          if (upperIsMe) {
            this.result = d;
            return { force: out, over: 0, tugOver: 0, stretch: L, done: true };
          }
          P.tearReq = d;
        }
      }
    }
    return { force: out, over: raw / this.grip, tugOver: 0, stretch: L, done: false };
  }

  /** 1 本目の鋏が離した：2 本目がこの株のしなりを受け持つ */
  private promote() {
    this.secondary = false;
    this.prevL = -1;
    this.field.held = { i: this.i, dx: 0, dz: 0, fc: this.fg, cap: PLANT_PULL[this.field.table.kind[this.i]].cap, fl: 0 };
  }

  onRelease(kind: 'release' | 'slip' | 'pop') {
    const i = this.i;
    const P = this.partner;
    if (this.secondary) {
      // 2 本目を離した：株はそのまま（1 本目が引いている）。ちぎれた上のかけらは受け取る（pop）
      this.secondary = false;
      const r = kind === 'pop' ? this.result ?? this.tearReq : null;
      this.i = -1;
      this.result = this.tearReq = null;
      this.act = null;
      if (r) this.pending = r;
      return;
    }
    // 1 本目を離した：もう 1 本が同じ株を挟んでいれば、そちらが株のしなりを受け持つ
    if (P && P.secondary && P.i === i && kind !== 'pop') {
      this.field.held = null;
      P.promote();
      this.i = -1;
      this.result = null;
      this.act = null;
      this.tension = this.bend = 0;
      return;
    }
    if (P && P.secondary && P.i === i && kind === 'pop') {
      // （1 本目が上のかけらを受け取って離れる：2 本目が根の付いた方を受け持つ）
      this.field.held = null;
      P.promote();
      const r = this.result ?? this.tearReq;
      this.i = -1;
      this.result = this.tearReq = null;
      this.act = null;
      this.tension = this.bend = 0;
      if (r) this.pending = r;
      return;
    }
    if (this.field.held?.i === i) this.field.held = null;
    if (kind === 'slip') this.stats.slips++;
    else if (kind === 'release') this.stats.releases++;
    // 離した・滑った：しなっていた分だけビヨーンと跳ね返る（滑ったときは強く）
    if (i >= 0 && kind !== 'pop') {
      const S = PLANT_PULL[this.field.table.kind[i]];
      this.field.fling(i, S.boing * (kind === 'slip' ? 1.5 : 1), S.quiver * (kind === 'slip' ? 1 : 0.6));
    }
    const r = this.result;
    this.i = -1;
    this.result = null;
    this.act = null;
    this.tension = this.bend = 0;
    // （かけらを鋏に渡すのは、鋏の状態の更新が終わってから：flush。release の途中で渡すと、その後 idle に戻される）
    if (kind === 'pop' && r) this.pending = r;
  }

  /** 最後に nearest で見つけた植物（狙っている植物。無ければ −1） */
  get candIndex(): number {
    return this.cand?.i ?? -1;
  }

  /** 挟んでいるか */
  get holding(): boolean {
    return this.i >= 0 && this.field.held?.i === this.i;
  }

  /**
   * 「掘る」ボタン（挟んでいる間）：意図して抜く・ちぎる。高い所を挟んでいて、ちぎれる種類ならハサミで切る（CUT_T 後）。
   * そうでなければ、種類ごとの強さ（uproot）以上に引いていれば根をゆすって抜く（UPROOT_T の間引き続ける）。
   * 引きが足りなければ抜けない（草が震えるだけ：'weak'）
   */
  twist(): TwistResult {
    if (!this.holding || this.act) return null;
    if (this.cutsHere) {
      this.act = { kind: 'cut', t: CUT_T };
      return 'cut';
    }
    const S = PLANT_PULL[this.field.table.kind[this.i]];
    if (this.tension >= S.uproot) {
      this.act = { kind: 'uproot', t: UPROOT_T };
      return 'uproot';
    }
    this.stats.weak++;
    if (this.field.held) this.field.held.fl = 1;
    return 'weak';
  }

  /** 抜くのに要る張りの割合（いま挟んでいる植物。案内・検証用） */
  get uprootNeed(): number {
    return this.i >= 0 ? PLANT_PULL[this.field.table.kind[this.i]].uproot : 1;
  }

  /** いま挟んでいる所で「掘る」を押すと ちぎる か（そうでなければ抜く） */
  get cutsHere(): boolean {
    if (this.i < 0) return false;
    const T = this.field.table, S = PLANT_PULL[T.kind[this.i]], h = this.fg * T.height[this.i];
    // （もうちぎった株の残りで、挟んだ所より上に葉が無ければ、ちぎらずに抜く）
    return S.cut && h >= S.cutAbove && h < this.field.cutH[this.i] - 0.04;
  }

  private pending: Detach | null = null;

  /** 抜けた・ちぎれた植物をかけらにして鋏に渡す（GrabSystem.post の後に毎フレーム呼ぶ） */
  flush() {
    const r = this.pending;
    this.pending = null;
    if (r) this.onDetach(r);
  }

  stepHeld(dt: number, _a0: readonly number[], a1: readonly number[]) {
    this.lastA[0] = a1[0];
    this.lastA[1] = a1[1];
    this.lastA[2] = a1[2];
    // もう 1 本の鋏が引き裂いた：上のかけらを受け取る（pop で離して、かけらを挟み直す）
    if (this.tearReq) {
      this.result = this.tearReq;
      this.tearReq = null;
      return { force: [0, 0, 0] as V3, over: 0, tugOver: 0, stretch: 0, done: true };
    }
    if (this.secondary) return this.stepSecondary(a1);
    const T = this.field.table, i = this.i;
    const S = PLANT_PULL[T.kind[i]];
    const rx = T.root[i * 3], ry = T.root[i * 3 + 1], rz = T.root[i * 3 + 2];
    const restY = ry + this.fg * T.height[i];
    // 引いている量：挟んだ所（曲がっていない位置）から鋏の構えまで。横はしなり、上は根を引く（硬い）、下へ押しても張らない
    const px = a1[0] - rx, pz = a1[2] - rz, py = a1[1] - restY;
    const ph = Math.hypot(px, pz);
    // しなり：上限（cap）の 8 割までは鋏について曲がり、そこから上限へなめらかに近づく。上限を越えて引いた分は鋏が茎から離れる
    const knee = S.cap * 0.8;
    const bl = ph <= knee ? ph : knee + (S.cap - knee) * Math.tanh((ph - knee) / (S.cap - knee));
    // 曲がりの形（AquaPlants.offsetAt）：根元のすぐ近く（高さの 12% 未満）を挟んだときは、挟んだ所のずれが曲がりより小さい。
    // その分だけ曲がりを大きくして、挟んだ所が鋏について行くようにする
    const fcc = Math.min(1, Math.max(0.12, this.fg)), u = Math.min(1, this.fg / fcc), sG = Math.max(0.3, u * u * (3 - 2 * u));
    const bx = ph > 1e-5 ? (px / ph) * bl / sG : 0, bz = ph > 1e-5 ? (pz / ph) * bl / sG : 0;
    const lv = Math.max(0, py - 0.04) * 1.4;
    const L = Math.hypot(ph, lv);
    // 張力：引いた距離に比例 + soft を越えると急に硬く（引くほど抵抗が増える）+ 上限を越えて引いた分はとても硬く（それ以上は
    // 離れられない：引き続けると握る力を越えて鋏が滑る）+ 急に引いた分（勢いで引くと強く張る）。根元の近くを挟むほど硬い（てこ）
    const kE = S.k * (1.35 - 0.6 * this.fg);
    const dL = this.prevL >= 0 && dt > 0 ? (L - this.prevL) / dt : 0;
    this.prevL = L;
    let F = kE * L * (1 + (L / S.soft) ** 2) + Math.max(0, ph - S.cap) * 28 + Math.max(0, dL) * kE * 0.35;
    // ちぎる・抜くの途中：ハサミで茎をゆする（小刻みな力）
    let done = false;
    if (this.act) {
      this.act.t -= dt;
      F += this.grip * 0.18 * Math.abs(Math.sin(this.act.t * 70));
      if (this.act.kind === 'uproot' && this.tension < S.uproot * 0.5) {
        // 途中で緩めた：抜けない（草が震えて戻る）
        this.act = null;
        this.stats.weak++;
      } else if (this.act.t <= 0) {
        const cuts = this.act.kind === 'cut';
        const p = this.gripPoint();
        this.result = { i, cutY: cuts ? restY - 0.02 : null, at: [p[0], p[1], p[2]] };
        if (cuts) this.stats.cuts++;
        else this.stats.uproots++;
        this.act = null;
        done = true;
      }
    }
    this.tension += (F / this.grip - this.tension) * (1 - Math.exp(-dt / 0.15));
    this.bend = bl;
    this.stats.maxTension = Math.max(this.stats.maxTension, F);
    this.stats.maxBend = Math.max(this.stats.maxBend, bl);
    if (this.field.held) {
      const H = this.field.held;
      H.dx = bx;
      H.dz = bz;
      H.cap = S.cap / sG;
      // 張っている震え：強く引くほど、上へ引くほど（根が張って葉先が細かく震える）。ゆすっている間は強く
      H.fl = this.act ? 1 : S.quiver * Math.min(1, this.tension) * (0.45 + 0.55 * (L > 1e-4 ? lv / L : 0));
    }
    // 鋏にかける力：つかみ点から鋏の構えへ（引いた向き）。握る力で頭打ち（越えた分 over で GrabSystem が鋏を滑らせる）
    const out: V3 = [0, 0, 0];
    if (L > 1e-5) {
      const f = Math.min(F, this.grip) / L;
      out[0] = px * f;
      out[1] = lv * f;
      out[2] = pz * f;
    }
    const gp = this.gripPoint();
    const stretch = Math.hypot(a1[0] - gp[0], a1[1] - gp[1], a1[2] - gp[2]);
    return { force: out, over: F / this.grip, tugOver: 0, stretch, done };
  }
}

/** 挟んだまま運ぶかけらにする範囲（つかんだ所からの距離）。これより先は離れたかけらとして漂う（消さない） */
const PIECE_R = 1.0;
/** 片づけるかけらが小さくなって消えるまでの時間 */
const FADE_T = 0.8;

/** 抜いた・ちぎった水草のかけら（円盤の集まり + 軽い物理の物） */
export class WeedPieces {
  readonly list: { prop: Prop; mesh: THREE.Mesh; die: number }[] = [];
  private n = 0;
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  /** 一度に残すかけらの数（越えたら古いもの（挟んでいない）から、小さくしてから片づける） */
  max = 12;
  readonly stats = { spawned: 0, drifting: 0, faded: 0, eaten: 0 };

  constructor(private readonly field: PlantField, private readonly surfel: SurfelRenderer, private readonly props: PropSystem, private readonly pos: ArrayLike<number>) {}

  /**
   * 円盤 idx のかけら（pivot = かけらの原点、at = 置く所。円盤は pos − pivot + at に見える）。food = 食べ物の種類と大きさ
   * （AquaEat。水草のかけら・むしった藻）
   */
  make(idx: number[], pivot: readonly number[], at: readonly number[], mass: number, name: string, food: Prop['food'] = null): Prop {
    const mesh = this.surfel.addPiece(idx, pivot);
    // 当たりの楕円体：かけらの広がり（原点まわり）の半分。細長い葉でも大きくしすぎない
    let ex = 0.03, ey = 0.03, ez = 0.03;
    for (const k of idx) {
      ex = Math.max(ex, Math.abs(this.pos[k * 3] - pivot[0]));
      ey = Math.max(ey, Math.abs(this.pos[k * 3 + 1] - pivot[1]));
      ez = Math.max(ez, Math.abs(this.pos[k * 3 + 2] - pivot[2]));
    }
    const semi: V3 = [Math.min(0.14, ex * 0.5), Math.min(0.14, ey * 0.35), Math.min(0.14, ez * 0.5)];
    const prop = new Prop(`weed${this.n++}`, 'weed', 1, [at[0], at[1], at[2]], 0, { semi, mass, name });
    // 食べ物：水草のかけらは重さで大きさを決める（有茎草の 1 本分 0.05 = 1）
    prop.food = food ?? { kind: 'plant', size: Math.min(2.5, Math.max(0.4, mass / 0.05)) };
    this.list.push({ prop, mesh, die: -1 });
    this.stats.spawned++;
    return prop;
  }

  /**
   * かけらを作って、鋏 claw に挟ませる。つかんだ所から PIECE_R までを挟むかけらに、その先（長い葉の先など）は
   * 離れたかけらにして、その場から漂わせる（突然消えたように見せない）。どちらも曲がっていた位置から始める
   */
  spawn(d: Detach, claw: GrabSystem): Prop | null {
    const T = this.field.table, S = PLANT_PULL[T.kind[d.i]];
    // 曲がり（切り離す前に読む：detach で消える）
    const offG = this.field.offsetAt(d.i, d.at[1]);
    const all = this.field.detach(d.i, d.cutY, this.pos);
    if (!all.length) return null;
    const near: number[] = [], far: number[] = [];
    for (const k of all) (Math.hypot(this.pos[k * 3] - d.at[0] + offG[0], this.pos[k * 3 + 1] - d.at[1], this.pos[k * 3 + 2] - d.at[2] + offG[2]) <= PIECE_R ? near : far).push(k);
    // 離れたかけら：原点は円盤の重心、置く所はその高さの曲がりを足した所
    let farOff: V3 | null = null, farC: V3 = [0, 0, 0];
    if (far.length) {
      for (const k of far) for (let j = 0; j < 3; j++) farC[j] += this.pos[k * 3 + j] / far.length;
      farOff = this.field.offsetAt(d.i, farC[1]);
    }
    this.surfel.hideWorldPoints(all);
    const mass = S.mass * (d.cutY === null ? 1 : 0.6);
    let held: Prop | null = null;
    if (near.length) {
      // 鋏が挟んでいるかけら：原点 = つかみ点から曲がりを引いた所（円盤は曲がっていた位置に見える）
      held = this.make(near, [d.at[0] - offG[0], d.at[1] - offG[1], d.at[2] - offG[2]], d.at, mass * Math.min(1, near.length / all.length + 0.3), S.name);
      claw.forceHold(held, d.at);
    }
    if (far.length && farOff) {
      const at: V3 = [farC[0] + farOff[0], farC[1] + farOff[1], farC[2] + farOff[2]];
      const pr = this.make(far, farC, at, mass * 0.5, S.name);
      this.props.props.push(pr);
      // 切り離された勢いで少し浮く（ゆっくり沈んでいく）
      pr.v[1] = 0.12;
      pr.wake();
      this.stats.drifting++;
    }
    this.trim();
    this.update(0);
    return held;
  }

  /** 食べ終えたかけらを取り除く（物・円盤） */
  remove(prop: Prop) {
    const j = this.list.findIndex((w) => w.prop === prop);
    if (j < 0) return;
    this.surfel.removePiece(this.list[j].mesh);
    this.list.splice(j, 1);
    this.props.remove(prop);
    this.stats.eaten++;
  }

  /** 多すぎるかけらを、古いもの（挟んでいない）から小さくして片づけ始める（食べかけは片づけない） */
  private trim() {
    let alive = this.list.filter((w) => w.die < 0).length;
    for (const w of this.list) {
      if (alive <= this.max) break;
      if (w.die >= 0 || w.prop.held || w.prop.left < 0.999) continue;
      w.die = 0;
      alive--;
    }
  }

  /** かけらの円盤を物の位置・向きへ（片づけ中のかけらは小さくして、消えたら外す） */
  update(dt = 1 / 60) {
    for (let j = this.list.length - 1; j >= 0; j--) {
      const w = this.list[j], { prop, mesh } = w;
      let sc = 1;
      if (w.die >= 0) {
        // 挟んだ（拾い直した）ら片づけない
        if (prop.held) w.die = -1;
        else {
          w.die += dt;
          if (w.die >= FADE_T) {
            this.surfel.removePiece(mesh);
            const k = this.props.props.indexOf(prop);
            if (k >= 0) this.props.props.splice(k, 1);
            this.list.splice(j, 1);
            this.stats.faded++;
            continue;
          }
          sc = Math.max(0.02, 1 - w.die / FADE_T);
        }
      }
      // 食べかけ：残りの体積に合わせて小さく
      if (prop.left < 1) sc *= Math.max(0.15, Math.cbrt(prop.left));
      this.q.set(prop.q[0], prop.q[1], prop.q[2], prop.q[3]);
      this.v.set(prop.p[0], prop.p[1], prop.p[2]);
      this.s.set(sc, sc, sc);
      mesh.matrix.compose(this.v, this.q, this.s);
      mesh.matrixWorld.copy(mesh.matrix);
    }
  }
}

/** 藻をむしる範囲（つかんだ所から）・1 回にむしる円盤の上限・むしれる最小の数・生え戻るまでの時間と、生え戻るのにかかる時間 */
const ALGAE_R = 0.14;
const ALGAE_MAX = 36;
const ALGAE_MIN = 4;
const ALGAE_REGROW: [number, number] = [90, 150];
const ALGAE_GROW_T = 20;
/** 探す格子の一辺 */
const ALGAE_CELL = 0.25;

/**
 * 食べられる藻（水中の岩・流木の苔の円盤。AquariumBuild の SURFEL_TAG.algae）。岩・流木をハサミでつかんだまま「食べる」と、
 * つかんだ所のまわりの藻をむしり取り、そのまま挟んだ「藻のかけら」（WeedPieces の物）にする。むしった跡は隠し、しばらくすると
 * 少しずつ生え戻る（保存はしない：水草と同じく、読み込み直すと元どおり）
 */
export class AlgaeBeds {
  private readonly cells = new Map<string, number[]>();
  private readonly regrow: { idx: number[]; size: Float32Array; wait: number; grow: number }[] = [];
  private stepT = 0;
  readonly count: number;
  readonly stats = { scrapes: 0, empty: 0, taken: 0, regrown: 0 };

  constructor(private readonly surfel: SurfelRenderer, private readonly pos: ArrayLike<number>, tag: ArrayLike<number>, private readonly weeds: WeedPieces, private readonly rng: () => number = Math.random) {
    let n = 0;
    for (let i = 0; i < tag.length; i++) {
      if (tag[i] !== 1) continue;
      const k = this.key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
      n++;
    }
    this.count = n;
  }

  private key(x: number, y: number, z: number): string {
    return `${Math.floor(x / ALGAE_CELL)},${Math.floor(y / ALGAE_CELL)},${Math.floor(z / ALGAE_CELL)}`;
  }

  /** p のまわり r の、いま見えている藻の円盤（近い順） */
  near(p: readonly number[], r = ALGAE_R): number[] {
    const out: { i: number; d: number }[] = [];
    const cx = Math.floor(p[0] / ALGAE_CELL), cy = Math.floor(p[1] / ALGAE_CELL), cz = Math.floor(p[2] / ALGAE_CELL);
    const idx: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const c = this.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (c) for (const i of c) idx.push(i);
    }
    if (!idx.length) return [];
    const size = this.surfel.worldSizes(idx);
    idx.forEach((i, o) => {
      if (size[o] <= 0) return;
      const d = Math.hypot(this.pos[i * 3] - p[0], this.pos[i * 3 + 1] - p[1], this.pos[i * 3 + 2] - p[2]);
      if (d <= r) out.push({ i, d });
    });
    out.sort((a, b) => a.d - b.d);
    return out.map((o) => o.i);
  }

  /** つかんだ所 at のまわりの藻をむしって、鋏 claw に挟ませる（無ければ null） */
  scrape(at: readonly number[], claw: GrabSystem): Prop | null {
    this.stats.scrapes++;
    const idx = this.near(at).slice(0, ALGAE_MAX);
    if (idx.length < ALGAE_MIN) {
      this.stats.empty++;
      return null;
    }
    const c: V3 = [0, 0, 0];
    for (const i of idx) for (let k = 0; k < 3; k++) c[k] += this.pos[i * 3 + k] / idx.length;
    // 隠す前の大きさ（生え戻す）
    const size = this.surfel.worldSizes(idx);
    this.surfel.hideWorldPoints(idx);
    this.regrow.push({ idx, size, wait: ALGAE_REGROW[0] + this.rng() * (ALGAE_REGROW[1] - ALGAE_REGROW[0]), grow: 0 });
    this.stats.taken += idx.length;
    // かけら：原点 = 藻の重心。鋏は藻の重心を挟む（岩の面から少し離れた所）
    const n = idx.length;
    const pr = this.weeds.make(idx, c, c, 0.015 + n * 0.0006, '藻', { kind: 'algae', size: Math.min(2, Math.max(0.5, n / 18)) });
    claw.forceHold(pr, c);
    return pr;
  }

  /** むしった跡を、しばらくしてから少しずつ生え戻す（1 秒ごとにまとめて書く） */
  update(dt: number) {
    this.stepT += dt;
    if (this.stepT < 1 || !this.regrow.length) return;
    const h = this.stepT;
    this.stepT = 0;
    for (let j = this.regrow.length - 1; j >= 0; j--) {
      const g = this.regrow[j];
      if (g.wait > 0) {
        g.wait -= h;
        continue;
      }
      g.grow = Math.min(1, g.grow + h / ALGAE_GROW_T);
      this.surfel.setWorldSizes(g.idx, g.size, g.grow);
      if (g.grow >= 1) {
        this.regrow.splice(j, 1);
        this.stats.regrown++;
      }
    }
  }

  /** 生え戻りを待っている所の数（検証用） */
  get pending(): number {
    return this.regrow.length;
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
  /**
   * 口元へ運ばれている（AquaEat。main が毎フレーム書く）：暴れない（1 口目の前にやめれば、離すと生きたまま逃げる）
   */
  subdued = false;

  constructor(private readonly life: AquaLife, private readonly world: AquariumWorld) {}

  grabbable(): boolean {
    return true;
  }

  nearest(from: readonly number[]): { p: V3; d: number } | null {
    let best: { p: V3; d: number; c: Critter } | null = null;
    const L = this.life;
    const test = (c: Critter) => {
      const b = c.c, r = CRITTER[c.kind].r * (b.eat ? Math.cbrt(Math.max(0.05, b.eat.left)) : 1);
      if (L.caught.has(b) || b.eat?.gone) return;
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
    // 食べかけ（動かない）はしっかり持てる
    this.grip = c.c.eat ? GRIP_FORCE * 1.5 : C.grip;
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
    const b = c.c;
    // 食べかけ：逃げない（その場から底へ沈む。食べ終えて消えた個体は何もしない）
    if (b.eat) {
      b.eat.vy = this.v[1] * 0.3;
      return;
    }
    // 離れた：勢いのまま逃げる（エビは後ろへ跳ねる・小魚は怖がって速く泳ぐ）
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
    // （食べられ始めた個体・口元へ運ばれている間は動かない）
    const dead = !!b.eat || this.subdued;
    this.nextT -= dt;
    if (dead) {
      this.nextT = 1;
      this.kickT = 0;
    }
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
    const wig = dead ? 0 : c.kind === 'fish' ? Math.sin(this.t * 55) * 1.6 : Math.sin(this.t * 30) * 0.6;
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
    if (dead) {
      // 動かない
    } else if (c.kind === 'fish') {
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
