// ゴカイ（多毛類）：岩・流木が砂に接する根元の石の隙間にすむ、細長い生き物（2026-11-28 改：以前は砂に巣穴を掘っていた）。ゲームロジック側（Three.js に依存しない）。
// 見た目は AquaWormView（AquariumRenderer が毎フレーム頂点を書き換える）。
//
// 体（柔らかい体の物理）
// - 頭から尾まで N 個の質点（節）を距離の制約でつなぐ（XPBD。1/240 秒の小さな刻みで、刻みごとに 2 回だけ解く：
//   刻みを細かくする方が反復を増やすより安定で軽い）。節ごとに伸びのやわらかさ（compliance）があり、伸びの上限（maxStrain）を
//   越えると硬い制約になる。縮みの下限（minStrain）もある。制約の乗数から節ごとの張力が分かる（tension）。
// - 曲げ：3 つの節の中ほどへ寄せる弱い制約（まっすぐに戻る）と、折れ曲がりの限界（i−1 と i+1 の距離の下限）。
// - 筋肉（加速度の組：真ん中の節に +a、両隣に −a/2 なので全体の勢いは変わらない）：這うときの横のうねり（頭へ向かう波）、
//   暴れる・身をよじるときの回る向きのうねり、節ごとの伸び縮み（蠕動：自然な長さを波で変える）。
// - 水の中：ゆっくり沈み、水の抵抗で減速する。地面に触れている節は、横には滑りにくく前後には滑りやすい（這うとうねりが前へ進む力になる）。
// - 当たり：外に出ている節は AquariumWorld.contactSolid（砂・岩・流木・ガラス・管）から押し出す（巣穴の口の近くだけは穴なので除く）。
//
// 巣穴（石の隙間。2026-11-28 改）
// - 巣穴は、岩・流木が砂に接する根元から、その面に沿って下・奥へ続く隙間の折れ線（tunnel。口 = 根元の砂の上の点。面から体の半径 +
//   HUG の幅の中を通る：tunOk・extendTunnel）。隙間の中にある節は「動かせない節」（逆質量 0）として、巣穴に沿った
//   位置に置く：いちばん口に近い節が口から feed の深さ、その奥は自然な長さの間隔（隙間の壁に疣足で踏ん張っているので伸びない）。
//   feed が負になった節は外へ出る（自由な質点になる）。feed が節 1 つ分より深くなり、外の節が口まで来ていれば砂の中へ入る。
// - 巣穴に入っている端は尾の側（bEnd = 1：頭を出す）か頭の側（bEnd = 0：頭から潜っている途中）。潜り終えたら砂の中で
//   向きを入れ替え（見えない）、頭を口の側にする。
// - 挟まれて引かれている間の feed の速さは、スナモグリ（AquaTug.BurrowTug）と同じ考え方：口の所の節の張力が踏ん張り（hold）を
//   越えた分だけ滑り出て、下回れば引き戻す。抵抗の段階（最初・中盤・終盤）・引き戻し（tug）・力が抜ける間（rest）・疲れ・横に引いた
//   分の隙間の縁の摩擦（石なので砂より大きい：隙間に沿って引くと抜けやすく、斜めだと引っかかる）、最後の give から先は
//   踏ん張りが急に抜ける。最後の節が口を出た瞬間に抵抗が消える（抜ける）。
// - 掘ってまわりの砂が無くなっても巣は壊れない（体は岩の面に沿う隙間に収まったまま）。砂を盛って口が埋まった：巣穴を上へ延ばす。
//
// 暮らし（life）
// - hidden（隙間の中）→ peek（頭と触角を出して周りを探る）→ カニが近づくと alert（出す長さを減らして頭をカニへ向け、震える）→
//   速く近づく・跳んで着地する・すぐそばで掘る・口のすぐそばへ来ると hide（すばやく引っ込む）→ しばらくして hidden → peek。
// - まれに forage（カニが遠いとき、自分で這い出る）。抜けた・自分で出た後は free（這う）→ seek（近くの石の隙間を探す：creviceAt）→
//   dig（頭から潜る）→ hidden。挟まれて離されたら writhe（くねる）→ seek。
// 挟む（AquaGrab.GrabSystem の GrabCreature）：外に出ている体のどこでも挟める（頭・胴体の途中）。挟んだ点は節の間の点で、
// 鋏とつなぐ制約（強さは AquaGrab の SPRING_K、力の上限は握る力 grip）が体へ力を伝える。抜けた後も挟んだまま運べる。

import { clamp, lerp, mulberry32, smoothstep, type Rng } from '../core/math';
import { SPRING_K, type GrabCreature, type V3 } from './AquaGrab';
import type { BuddySave } from './AquaSave';
import type { TugStage, TugStageSpec } from './AquaTug';
import { TANK, type AquariumWorld } from './AquariumWorld';

export const WORM_SPECIES = 'gokai';
export const WORM_NAME = 'ゴカイ';
export const WORM_DESC = '岩や流木の根元の、石の隙間にすむ多毛類。たくさんの節と疣足で這い、隙間に潜り込む';
/** 一度も抜く前の名前（挟んでいる間の表示） */
export const WORM_UNKNOWN = '細長い何か';

/** 引っこ抜きの手応え（設定で選ぶ。比べるため） */
export type WormFeel = 'soft' | 'std' | 'hard';
export const WORM_FEELS: WormFeel[] = ['soft', 'std', 'hard'];
export const WORM_FEEL_LABEL: Record<WormFeel, string> = { soft: '柔らかめ', std: '標準', hard: '硬め' };

/** 調整できる値（体・動き・引っ張り）。WORM_SPEC_BASE を種の標準とし、手応えの設定（WormFeel）が一部を上書きする */
export interface WormSpec {
  // ---- 体 ----
  /** 節の長さの目安（体長からの節の数を決める）・太さ（半径の基準。個体差 thick を掛ける）・長さあたりの重さ */
  segLen: number;
  radius: number;
  massPerLen: number;
  /** 節 1 つの伸びのやわらかさ（1 / ばねの強さ）・伸びの上限・縮みの下限（自然な長さの倍率） */
  compliance: number;
  maxStrain: number;
  minStrain: number;
  /** 曲がりにくさ（まっすぐに戻る強さ 0..1）・曲がりの限界（i−1 と i+1 の距離の下限 / 節 2 つ分） */
  bendK: number;
  bendMin: number;
  /** 水の抵抗（1/秒）・水の中で沈む加速度 */
  drag: number;
  sink: number;
  /** 地面の摩擦（1/秒）：横・前後 */
  fricLat: number;
  fricTan: number;
  // ---- 動き ----
  /** 這う速さの目安（m/秒）・横のうねりの強さ（加速度）・周波数（Hz）・波の長さ（節の数） */
  crawlSpeed: number;
  waveAcc: number;
  waveFreq: number;
  waveLen: number;
  /** 潜る速さ・顔を出す速さ・引っ込む速さ（m/秒。巣穴に沿って） */
  burrowSpeed: number;
  emergeSpeed: number;
  retractSpeed: number;
  /** 蠕動（節ごとの伸び縮みの割合）・暴れる（身をよじる）強さ（加速度） */
  peristalsis: number;
  writheAcc: number;
  // ---- 引っ張り（AquaTug.TugSpec と同じ意味の値は同じ名前） ----
  grip: number;
  /** 踏ん張り：引き出し量 0・mid・late・give の始まりでの強さ */
  hold: [number, number, number, number];
  /** 滑り出す速さ（踏ん張りを越えた張力 / holdRef あたり、m/秒）・引き戻す速さ（m/秒）・穴の縁の摩擦 */
  slide: number;
  holdRef: number;
  drive: number;
  rimMu: number;
  stages: TugStageSpec[];
  /** 最後のこの節の数だけ残ったところから踏ん張りが抜け始める（give）・抜け切る幅・抜けた後の倍率 */
  giveSegs: number;
  giveW: number;
  giveK: number;
  tire: number;
  tireMin: number;
  recover: number;
  /** 暴れている間、外の体の節を縮める割合（縮んで引き戻そうとする）・抜けた瞬間に最後の節が飛び出す速さ（m/秒） */
  contract: number;
  popKick: number;
}

export const WORM_SPEC_BASE: WormSpec = {
  segLen: 0.055,
  radius: 0.037,
  massPerLen: 0.36,
  compliance: 1 / 300,
  maxStrain: 1.7,
  minStrain: 0.55,
  bendK: 0.015,
  bendMin: 0.42,
  drag: 1.3,
  sink: 2.4,
  fricLat: 16,
  fricTan: 2.2,
  crawlSpeed: 0.24,
  waveAcc: 2.2,
  waveFreq: 1.5,
  waveLen: 7,
  burrowSpeed: 0.17,
  emergeSpeed: 0.11,
  retractSpeed: 0.85,
  peristalsis: 0.1,
  writheAcc: 12,
  grip: 9,
  hold: [3.0, 3.5, 4.2, 4.7],
  slide: 0.5,
  holdRef: 4,
  drive: 0.06,
  rimMu: 0.55,
  stages: [
    { until: 0.3, tremorA: 0.12, tremorF: 7, tugP: 1.3, tugDur: 0.25, tugGap: [0.9, 1.5], tugDrive: 3, restK: 1, restT: 0 },
    { until: 0.7, tremorA: 0.06, tremorF: 4, tugP: 1.55, tugDur: 0.45, tugGap: [1.2, 1.9], tugDrive: 2.6, restK: 0.65, restT: 0.8 },
    { until: 1, tremorA: 0.2, tremorF: 9, tugP: 1.65, tugDur: 0.4, tugGap: [0.8, 1.3], tugDrive: 3, restK: 0.7, restT: 0.55 },
  ],
  giveSegs: 2.2,
  giveW: 0.05,
  giveK: 0.18,
  tire: 0.05,
  tireMin: 0.65,
  recover: 0.04,
  contract: 0.14,
  popKick: 1.5,
};

/** 手応えの設定ごとの上書き（柔らかめ = よく伸びて粘る・抜けは穏やか、硬め = 伸びが少なく抵抗が強い・抜けが鋭い） */
const FEEL_OVERRIDE: Record<WormFeel, Partial<WormSpec>> = {
  soft: {
    compliance: 1 / 190,
    maxStrain: 2.0,
    hold: [2.6, 3.0, 3.6, 4.0],
    slide: 0.6,
    rimMu: 0.45,
    grip: 9.5,
    stages: [
      { until: 0.3, tremorA: 0.08, tremorF: 6, tugP: 1.2, tugDur: 0.3, tugGap: [1.0, 1.7], tugDrive: 2.6, restK: 1, restT: 0 },
      { until: 0.7, tremorA: 0.05, tremorF: 3.5, tugP: 1.4, tugDur: 0.55, tugGap: [1.3, 2.1], tugDrive: 2.3, restK: 0.7, restT: 0.9 },
      { until: 1, tremorA: 0.14, tremorF: 7, tugP: 1.5, tugDur: 0.5, tugGap: [0.9, 1.4], tugDrive: 2.6, restK: 0.75, restT: 0.6 },
    ],
    giveK: 0.3,
    popKick: 1.1,
    contract: 0.1,
  },
  std: {},
  hard: {
    compliance: 1 / 520,
    maxStrain: 1.45,
    hold: [3.5, 4.1, 5.0, 5.6],
    slide: 0.42,
    rimMu: 0.65,
    grip: 8.6,
    stages: [
      { until: 0.3, tremorA: 0.16, tremorF: 8, tugP: 1.4, tugDur: 0.2, tugGap: [0.8, 1.3], tugDrive: 3.3, restK: 1, restT: 0 },
      { until: 0.7, tremorA: 0.08, tremorF: 5, tugP: 1.7, tugDur: 0.35, tugGap: [1.0, 1.6], tugDrive: 2.9, restK: 0.6, restT: 0.65 },
      { until: 1, tremorA: 0.25, tremorF: 10, tugP: 1.8, tugDur: 0.32, tugGap: [0.7, 1.1], tugDrive: 3.3, restK: 0.65, restT: 0.45 },
    ],
    giveK: 0.1,
    popKick: 2.1,
    contract: 0.18,
  },
};

export function wormSpec(feel: WormFeel, base: WormSpec = WORM_SPEC_BASE): WormSpec {
  return { ...base, ...FEEL_OVERRIDE[feel] };
}

/** 個体差（保存する） */
export interface WormTraits {
  /** 体長（m）・太さの倍率・体色（0 = 赤褐色 … 1 = 淡いピンク）・模様の乱数 */
  len: number;
  thick: number;
  tone: number;
  seed: number;
}

export type WormLife = 'hidden' | 'peek' | 'alert' | 'hide' | 'forage' | 'free' | 'writhe' | 'seek' | 'dig';

export type WormEvent =
  | { kind: 'grab' }
  | { kind: 'release'; why: 'release' | 'slip' | 'pop' }
  | { kind: 'tug'; stage: TugStage }
  | { kind: 'rest' }
  | { kind: 'stage'; stage: TugStage }
  /** 抜けた（x, y, z = 巣穴の口・power = 抜ける直前の張り 0..1・dir = 口からカニへの水平の向き） */
  | { kind: 'pop'; x: number; y: number; z: number; power: number; dir: [number, number]; first: boolean }
  | { kind: 'hide'; x: number; y: number; z: number }
  | { kind: 'peek'; x: number; y: number; z: number }
  /** 隙間に潜り始めた・潜り終えた */
  | { kind: 'dig'; x: number; y: number; z: number }
  | { kind: 'buried'; x: number; y: number; z: number };

/** カニの様子（暮らしの判断に使う） */
export interface WormSense {
  x: number;
  y: number;
  z: number;
  speed: number;
  grounded: boolean;
  vy: number;
  /** カニが近くで掘った・盛った（このフレーム） */
  dug: boolean;
  /** カニが水槽の中にいる */
  inTank: boolean;
}

/** 刻み（秒）・制約を解く回数 */
const SUB = 1 / 240;
/** 挟まれていない間の刻み（軽くする。這う・顔を出すだけなら十分） */
const SUB_FREE = 1 / 120;
const ITER = 2;
/** 当たりの距離を測り直すまでに節が動いてよい距離（同じフレームの中） */
const CACHE_R = 0.015;
/** 隠れているときの頭の深さ（口から。巣穴に沿って） */
const HIDE_DEPTH = 0.05;
/** 口のまわりの当たりを除く半径（穴なので） */
const MOUTH_R = 0.09;
/** 警戒する距離・すぐ引っ込む距離（口からカニの体の中心まで、水平） */
const ALERT_R = 1.6;
const TOUCH_R = 0.3;
const FAST = 0.9;
/** 巣穴を作る刻み */
const TUN_STEP = 0.035;
/** 石の隙間：巣穴が岩・流木の面に沿ってよい幅（面から体の半径 + これまで）・口にする縁（砂の上で岩・流木の面からこの範囲） */
const HUG = 0.17;
const CREVICE_EDGE: [number, number] = [0.03, 0.11];
/** 暴れている間に強く張ったときの滑り（GrabSystem の tugOver）のうち、体が吸わずに鋏へ伝わる割合 */
const TUG_ABSORB = 0.8;
/** 速さの上限（発散を防ぐ） */
const V_MAX = 6;

const tmpA: V3 = [0, 0, 0];
const tmpB: V3 = [0, 0, 0];

export class Worm implements GrabCreature {
  // ---- GrabCreature ----
  name = WORM_UNKNOWN;
  readonly p: V3 = [0, 0, 0];
  readonly rb: number;
  get grip(): number {
    return this.spec.grip;
  }
  /** 巣穴から出ている頭は少し遠くからでも挟める（スナモグリの触角と同じ）。外を這っている体はふつうの物と同じ */
  get bonus(): number {
    return this.nb > 0 ? 0.05 : 0.02;
  }
  /** 張っている間の歩みの重さ：巣穴に踏ん張っている間はスナモグリと同じ・抜けた後は軽い */
  get slow(): number {
    return this.nb > 0 ? 0.75 : 0.25;
  }
  readonly slipReach = 0.09;

  // ---- 体 ----
  readonly N: number;
  /** 節の自然な長さ（基準）・体長 */
  readonly Lb: number;
  readonly length: number;
  readonly x: Float64Array;
  private readonly xp: Float64Array;
  readonly v: Float64Array;
  /** 逆質量（砂の中の節は 0） */
  readonly w: Float64Array;
  private readonly invM: number;
  /** 節の太さ（先細りを含む基準の半径） */
  readonly rad: Float64Array;
  /** 節の間 i（i と i+1）：いまの自然な長さ・張力・伸び（いまの長さ / 基準の長さ） */
  readonly Lr: Float64Array;
  readonly tension: Float64Array;
  readonly strain: Float64Array;
  private readonly lam: Float64Array;
  /** 地面に触れている節と、その面の法線 */
  readonly touch: Uint8Array;
  private readonly cn: Float64Array;
  /** 当たりの覚え（0 = 無し、1 = 離れていた、2 = 触れていた）・測った所・その距離 */
  private readonly cv: Uint8Array;
  private readonly cx: Float64Array;
  private readonly cd: Float64Array;
  /** 見た目：節ごとの体のねじれ（暴れているときの回り） */
  readonly roll: Float64Array;
  // ---- 巣穴 ----
  /** 巣穴に入っている端（1 = 尾、0 = 頭）・入っている節の数・いちばん口に近い節の深さ（口から巣穴に沿って）・その速さ */
  bEnd: 0 | 1 = 1;
  nb = 0;
  feed = 0;
  feedV = 0;
  /** 口から外に出している体の長さの目標（負 = 頭が口より下。暮らしが決める。outLen と比べる） */
  private outTarget = -HIDE_DEPTH;
  /** 巣穴の折れ線（xyz を並べた点）と、口からの長さ */
  private tun: number[] = [];
  private tunC: number[] = [];
  /** 巣穴を延ばす向き・深さの目標（潜っている間） */
  private tunDir: V3 = [0, -1, 0];
  private tunDepth = 0.22;
  /** 隙間の開いている水平の向き（口で岩・流木から離れる向き。巣穴を作るときに決める。縁にこすれる力に使う） */
  private openDir: [number, number] = [0, 1];
  /** 口の所の節の張力・横の力 */
  mouthT = 0;
  // ---- 暮らし ----
  life: WormLife = 'hidden';
  private lifeT = 2;
  /** 見つけた（一度でも抜いた・自分で出た所を挟んだ） */
  found = false;
  /** 住みか（最初の巣穴の口。保存する。戻れないときの戻り先） */
  readonly home: V3;
  private goal: [number, number] | null = null;
  private stuckT = 0;
  private lookA = 0;
  private alertK = 0;
  private sleep = false;
  // ---- 筋肉 ----
  private phase = 0;
  private twist = 0;
  /** 暴れる強さ（0..1） */
  wr = 0;
  // ---- 挟まれている ----
  held = false;
  /** 挟んだ節の間（i と i+1）と、その間の割合 */
  gS = 0;
  gF = 0;
  private readonly gForce: V3 = [0, 0, 0];
  private gOver = 0;
  private gStretch = 0;
  // ---- 引っ張りの状態（AquaTug.BurrowTug と同じ名前） ----
  ext = 0;
  stage: TugStage = 'early';
  env = 0;
  restT = 0;
  stamina = 1;
  /** 張力 / 踏ん張り・横の力・引き出しの速さ（体長 / 秒。ならした値）・踏ん張り */
  load = 0;
  rub = 0;
  /** 引く向きが隙間の開いている向きから外れている割合（0..1） */
  side = 0;
  extV = 0;
  hold = 0;
  private clock = 0;
  private tugT = 0;
  private nextTug = 0.8;
  private checkT = 0;
  /** 離された直後の残り時間（この間はゆっくり引き込む） */
  private afterT = 0;
  readonly events: WormEvent[] = [];
  readonly stats = { grabs: 0, pops: 0, tugs: 0, rests: 0, heldT: 0, maxExt: 0, maxStrain: 0, maxTension: 0, digs: 0, diverge: 0, maxV: 0, pushMax: 0, stepMs: 0, steps: 0, hides: 0 };

  constructor(
    readonly id: string,
    private readonly world: AquariumWorld,
    readonly traits: WormTraits,
    public spec: WormSpec,
    home: readonly number[],
    private readonly rng: Rng,
  ) {
    this.N = clamp(Math.round(traits.len / spec.segLen) + 1, 12, 20);
    this.Lb = traits.len / (this.N - 1);
    this.length = traits.len;
    const N = this.N;
    this.x = new Float64Array(N * 3);
    this.xp = new Float64Array(N * 3);
    this.v = new Float64Array(N * 3);
    this.w = new Float64Array(N);
    this.rad = new Float64Array(N);
    this.Lr = new Float64Array(N - 1).fill(this.Lb);
    this.tension = new Float64Array(N - 1);
    this.strain = new Float64Array(N - 1).fill(1);
    this.lam = new Float64Array(N - 1);
    this.touch = new Uint8Array(N);
    this.cn = new Float64Array(N * 3);
    this.cv = new Uint8Array(N);
    this.cx = new Float64Array(N * 3);
    this.cd = new Float64Array(N);
    this.roll = new Float64Array(N);
    this.invM = (N / (spec.massPerLen * traits.len));
    const R = spec.radius * traits.thick;
    for (let i = 0; i < N; i++) {
      const s = i / (N - 1);
      // 頭は少し細く、前の 1/4 がいちばん太く、尾へ細くなる
      this.rad[i] = R * (s < 0.22 ? lerp(0.72, 1, smoothstep(0, 0.22, s)) : lerp(1, 0.32, smoothstep(0.22, 1, s)));
    }
    this.rb = R * 1.4;
    this.home = [home[0], home[1], home[2]];
  }

  // ---------------- 添字 ----------------

  /** いちばん口に近い、砂の中の節 */
  private sb(): number {
    return this.bEnd ? this.N - this.nb : this.nb - 1;
  }

  /** 砂の中の節のすぐ外の節（外に出ている端） */
  private ea(): number {
    return this.bEnd ? this.N - this.nb - 1 : this.nb;
  }

  /** 砂の中の m 番目（0 = 口に近い）の節 */
  private bIdx(m: number): number {
    return this.bEnd ? this.N - this.nb + m : this.nb - 1 - m;
  }

  /** 外に出ている節の数 */
  get exposedCount(): number {
    return this.N - this.nb;
  }

  isBuried(i: number): boolean {
    return this.bEnd ? i >= this.N - this.nb : i < this.nb;
  }

  /** 巣穴の口（地表） */
  get mouth(): V3 {
    return [this.tun[0] ?? this.x[0], this.tun[1] ?? this.x[1], this.tun[2] ?? this.x[2]];
  }

  /**
   * 口から外に出ている体の長さ（自然な長さで数える。節が出入りしても変わらない：出る = nb が 1 減り feed が節 1 つ分増える）。
   * 負 = 頭が口より下
   */
  outLen(): number {
    return (this.N - this.nb) * this.Lb - this.feed;
  }

  /** 巣穴に踏ん張っている（体の一部が砂の中） */
  get anchored(): boolean {
    return this.nb > 0;
  }

  /** 頭の位置 */
  head(out: V3 = [0, 0, 0]): V3 {
    out[0] = this.x[0];
    out[1] = this.x[1];
    out[2] = this.x[2];
    return out;
  }

  // ---------------- 巣穴の折れ線 ----------------

  private tunLen(): number {
    return this.tunC.length ? this.tunC[this.tunC.length - 1] : 0;
  }

  /** 巣穴の口から長さ t の点（端より先は最後の向きへ延ばす） */
  private tunAt(t: number, out: V3): V3 {
    const P = this.tun, C = this.tunC, n = C.length;
    if (n < 2) {
      out[0] = P[0];
      out[1] = P[1] - t;
      out[2] = P[2];
      return out;
    }
    let i = 0;
    if (t <= 0) i = 0;
    else if (t >= C[n - 1]) i = n - 2;
    else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (C[m] <= t) lo = m;
        else hi = m;
      }
      i = lo;
    }
    const L = C[i + 1] - C[i] || 1e-6;
    const f = (t - C[i]) / L;
    out[0] = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * f;
    out[1] = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * f;
    out[2] = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * f;
    return out;
  }

  /** 巣穴の長さ t での向き（口から奥へ） */
  private tunDirAt(t: number, out: V3): V3 {
    const P = this.tun, C = this.tunC, n = C.length;
    let i = 0;
    while (i < n - 2 && C[i + 1] < t) i++;
    if (n < 2) {
      out[0] = 0;
      out[1] = -1;
      out[2] = 0;
      return out;
    }
    const dx = P[i * 3 + 3] - P[i * 3], dy = P[i * 3 + 4] - P[i * 3 + 1], dz = P[i * 3 + 5] - P[i * 3 + 2];
    const l = Math.hypot(dx, dy, dz) || 1;
    out[0] = dx / l;
    out[1] = dy / l;
    out[2] = dz / l;
    return out;
  }

  /** 口から外へ出る向き（巣穴の最初の向きの逆） */
  outward(out: V3 = [0, 0, 0]): V3 {
    this.tunDirAt(0, out);
    out[0] = -out[0];
    out[1] = -out[1];
    out[2] = -out[2];
    return out;
  }

  /**
   * 巣穴の点にしてよいか（2026-11-28 改：石の隙間）。岩・流木の面に沿う所（面から mg より離れ、HUG + mg より近い）で、
   * 作るときは砂に覆われている（隠れている）こと。ガラス・管・底からは離れる。よければ岩・流木までの距離、だめなら −1
   */
  private tunOk(x: number, y: number, z: number, mg: number): number {
    const W = this.world;
    if (!W.insideTank(x, z, 0.4) || y < TANK.floorY + 0.06 + mg || y > TANK.waterY - 0.2) return -1;
    if (W.pipeClear(x, z) < 0.16) return -1;
    if (W.sandSolid(x, y, z) > -mg * 0.6) return -1;
    const h = W.hardSolid(x, y, z);
    return h < mg + 0.008 || h > HUG + mg ? -1 : h;
  }

  /**
   * 巣穴を 1 刻み延ばす：岩・流木の面に沿って（面からの距離を mg + 0.05 に保つ）下へ、深さの目標に近づいたら面に沿って横へ。
   * 延ばせなければ false
   */
  private extendTunnel(): boolean {
    const P = this.tun, n = P.length / 3;
    const px = P[n * 3 - 3], py = P[n * 3 - 2], pz = P[n * 3 - 1];
    const d = this.tunDir;
    const len = this.tunLen();
    const mg = Math.min(this.rad[0] + 0.015, 0.012 + len * 0.6);
    const depth = -this.world.sandSolid(px, py, pz);
    const wantDy = depth < this.tunDepth ? -0.75 : depth > this.tunDepth + 0.08 ? 0.35 : Math.sin(len * 7 + this.traits.seed) * 0.15;
    const yaw0 = Math.atan2(d[0], d[2]);
    let best: { s: number; q: V3; c: V3 } | null = null;
    for (const k of [0, 0.3, -0.3, 0.65, -0.65, 1.05, -1.05, 1.6, -1.6, 2.3, -2.3]) {
      const yaw = yaw0 + k + (this.rng() - 0.5) * 0.2;
      for (const dyK of [1, 0.4]) {
        const dy = lerp(d[1], wantDy, 0.35) * dyK;
        const hh = Math.sqrt(Math.max(0.05, 1 - dy * dy));
        let cx = Math.sin(yaw) * hh, cy = dy, cz = Math.cos(yaw) * hh;
        const cl = Math.hypot(cx, cy, cz);
        cx /= cl;
        cy /= cl;
        cz /= cl;
        const q: V3 = [px + cx * TUN_STEP, py + cy * TUN_STEP, pz + cz * TUN_STEP];
        const h = this.tunOk(q[0], q[1], q[2], mg);
        if (h < 0) continue;
        // 面に沿う（隙間の中ほど）ほど・まっすぐなほど良い
        const s = Math.abs(h - (mg + 0.05)) * 4 + Math.abs(k) * 0.06 + (1 - dyK) * 0.05;
        if (!best || s < best.s) best = { s, q, c: [cx, cy, cz] };
      }
    }
    if (!best) return false;
    P.push(best.q[0], best.q[1], best.q[2]);
    this.tunC.push(len + TUN_STEP);
    d[0] = best.c[0];
    d[1] = best.c[1];
    d[2] = best.c[2];
    return true;
  }

  /** 口 m から dir（水平の向き yaw = 岩の方、下へ pitch）へ長さ len の巣穴を作る。作れなければ false（巣穴は元のまま） */
  private makeTunnel(m: readonly number[], yaw: number, len: number): boolean {
    const old = { tun: this.tun, tunC: this.tunC, dir: this.tunDir };
    this.tun = [m[0], m[1], m[2]];
    this.tunC = [0];
    this.setOpen(m);
    const pitch = 0.9;
    this.tunDir = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const g = this.world.groundAt(m[0], m[2]);
    this.tunDepth = clamp(0.2, 0.1, Math.max(0.1, g - TANK.floorY - 0.12));
    while (this.tunLen() < len) {
      if (!this.extendTunnel()) {
        this.tun = old.tun;
        this.tunC = old.tunC;
        this.tunDir = old.dir;
        return false;
      }
    }
    return true;
  }

  /** 巣穴を作れるか確かめるだけ（巣穴は元のまま） */
  private canTunnel(m: readonly number[], yaw: number): boolean {
    const old = { tun: this.tun, tunC: this.tunC, dir: this.tunDir, depth: this.tunDepth, open: this.openDir };
    const ok = this.makeTunnel(m, yaw, this.length + HIDE_DEPTH + 0.12);
    this.tun = old.tun;
    this.tunC = old.tunC;
    this.tunDir = old.dir;
    this.tunDepth = old.depth;
    this.openDir = old.open;
    return ok;
  }

  /** 砂の表面の点（x, z の真上から探る） */
  private surfaceAt(x: number, y: number, z: number): number {
    return this.world.surfaceBelow(x, y + 0.4, z);
  }

  /** 砂だけの表面（岩・流木の上に乗っていても、その下・横の砂の面。石の隙間の口を決める） */
  private sandSurface(x: number, y: number, z: number): number {
    const W = this.world;
    let py = y + 0.4;
    for (let i = 0; i < 60; i++) {
      const d = W.sandSolid(x, py, z);
      if (d < 0.01) return py;
      py -= Math.max(d * 0.9, 0.015);
      if (py < TANK.floorY) break;
    }
    return W.groundAt(x, z);
  }

  /**
   * 石の隙間の口の候補：(x, z) の近くの、岩・流木が砂に接している縁の砂の上の点と、岩・流木の方への水平の向き。
   * 縁から離れていれば、岩・流木の面の方へ寄せる。無ければ null
   */
  creviceAt(x: number, z: number, y?: number): { m: V3; yaw: number } | null {
    const W = this.world;
    for (let it = 0; it < 3; it++) {
      if (!W.insideTank(x, z, 0.6) || W.pipeClear(x, z) < 0.35) return null;
      const sy = this.sandSurface(x, y ?? W.groundAt(x, z) + 0.3, z);
      if (sy > TANK.waterY - 0.4) return null;
      const h = W.hardSolid(x, sy + 0.03, z);
      if (h > 0.8) return null;
      const e = 0.03;
      const gx = W.hardSolid(x + e, sy + 0.03, z) - W.hardSolid(x - e, sy + 0.03, z);
      const gz = W.hardSolid(x, sy + 0.03, z + e) - W.hardSolid(x, sy + 0.03, z - e);
      const gl = Math.hypot(gx, gz);
      if (gl < 1e-4) return null;
      const yaw = Math.atan2(-gx, -gz);
      if (h >= CREVICE_EDGE[0] && h <= CREVICE_EDGE[1]) {
        if (W.surfaceMaterial(x, sy + 0.02, z) !== 'sand' || W.sandSolid(x, sy - 0.25, z) > -0.03) return null;
        return { m: [x, sy, z], yaw };
      }
      // 縁へ寄せる（岩の面までの距離が 0.06 になる所へ。勾配 = 岩から離れる向き）
      const step = h - 0.06;
      x -= (gx / gl) * step;
      z -= (gz / gl) * step;
      y = undefined;
    }
    return null;
  }

  /** 岩・流木の方への水平の向き（口 m のそば） */
  private rockYaw(m: readonly number[]): number {
    const W = this.world, e = 0.03, y = m[1] + 0.03;
    const gx = W.hardSolid(m[0] + e, y, m[2]) - W.hardSolid(m[0] - e, y, m[2]);
    const gz = W.hardSolid(m[0], y, m[2] + e) - W.hardSolid(m[0], y, m[2] - e);
    return Math.atan2(-gx, -gz);
  }

  /** 隙間の開いている向き（岩・流木から離れる水平の向き）を口 m で決める */
  private setOpen(m: readonly number[]) {
    const ry = this.rockYaw(m);
    this.openDir = [-Math.sin(ry), -Math.cos(ry)];
  }

  // ---------------- 置く ----------------

  /** 石の隙間に置く（口 m。体はすべて隙間の中）。yaw = 隙間の奥への水平の向き（省略 = 岩の方）。作れなければ false */
  placeBuried(m: readonly number[], yaw?: number): boolean {
    const len = this.length + HIDE_DEPTH + 0.12;
    const y0 = yaw ?? this.rockYaw(m);
    let ok = false;
    for (const k of [0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3]) if (!ok) ok = this.makeTunnel(m, y0 + k, len);
    if (!ok) return false;
    this.bEnd = 1;
    this.nb = this.N;
    this.feed = HIDE_DEPTH;
    this.feedV = 0;
    this.outTarget = -HIDE_DEPTH;
    this.life = 'hidden';
    this.lifeT = 1.5 + this.rng() * 3;
    this.held = false;
    this.v.fill(0);
    this.placeKinematic(0);
    this.xp.set(this.x);
    this.resetTug();
    return true;
  }

  /** 外に置く（頭を (x, y, z) に、yaw の向きへ体を伸ばして地面に） */
  layFree(x: number, y: number, z: number, yaw: number) {
    const W = this.world, N = this.N;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (let i = 0; i < N; i++) {
      let px = x + fx * this.Lb * i, pz = z + fz * this.Lb * i;
      if (!W.insideTank(px, pz, 0.35)) {
        px = this.x[(i - 1) * 3] ?? x;
        pz = this.x[(i - 1) * 3 + 2] ?? z;
      }
      const py = W.surfaceBelow(px, Math.max(y, W.groundAt(px, pz)) + 0.3, pz) + this.rad[i];
      this.x[i * 3] = px;
      this.x[i * 3 + 1] = py;
      this.x[i * 3 + 2] = pz;
      this.w[i] = this.invM;
    }
    this.xp.set(this.x);
    this.v.fill(0);
    this.nb = 0;
    this.feed = 0;
    this.feedV = 0;
    this.tun = [];
    this.tunC = [];
    this.life = 'free';
    this.lifeT = 4 + this.rng() * 4;
    this.goal = null;
    this.resetTug();
  }

  private resetTug() {
    this.ext = this.nb > 0 ? 0 : 1;
    this.stage = 'early';
    this.env = this.restT = this.tugT = 0;
    this.stamina = 1;
    this.load = this.rub = this.extV = this.hold = this.mouthT = 0;
  }

  /** 砂の中の節を巣穴に沿って置く（速さは巣穴の向き × feedV） */
  private placeKinematic(h: number) {
    for (let m = 0; m < this.nb; m++) {
      const i = this.bIdx(m);
      const t = this.feed + m * this.Lb;
      this.tunAt(t, tmpA);
      this.x[i * 3] = tmpA[0];
      this.x[i * 3 + 1] = tmpA[1];
      this.x[i * 3 + 2] = tmpA[2];
      this.w[i] = 0;
      if (h > 0) {
        // 巣穴の奥への向き × feedV（正 = 奥へ）
        this.tunDirAt(t, tmpB);
        this.v[i * 3] = tmpB[0] * this.feedV;
        this.v[i * 3 + 1] = tmpB[1] * this.feedV;
        this.v[i * 3 + 2] = tmpB[2] * this.feedV;
      }
    }
  }

  // ---------------- 引っ張りの抵抗（AquaTug.BurrowTug と同じ考え方） ----------------

  private stageSpec(): TugStageSpec {
    const st = this.spec.stages;
    for (const s of st) if (this.ext < s.until) return s;
    return st[st.length - 1];
  }

  private give(): number {
    return 1 - this.spec.giveSegs / (this.N - 1);
  }

  private holdNow(): number {
    const S = this.spec, h = S.hold, st = this.stageSpec();
    const e = clamp(this.ext, 0, 1);
    const m0 = S.stages[0].until, m1 = S.stages[1].until, g = this.give();
    let base = e < m0 ? lerp(h[0], h[1], e / m0) : e < m1 ? lerp(h[1], h[2], (e - m0) / (m1 - m0)) : lerp(h[2], h[3], clamp((e - m1) / Math.max(0.01, g - m1), 0, 1));
    base *= lerp(1, S.giveK, smoothstep(g, g + S.giveW, e));
    const c = this.clock;
    const tremor = 1 + st.tremorA * Math.sin(c * Math.PI * 2 * st.tremorF) * (0.6 + 0.4 * Math.sin(c * 2.3 + 1.1));
    const tug = 1 + (st.tugP - 1) * this.env;
    const rest = this.restT > 0 ? st.restK : 1;
    // 頭を挟まれると強く暴れる（頭は敏感）・胴体の途中は少し弱い
    const where = this.gripNearHead() ? 1.06 : 0.96;
    return base * this.stamina * tremor * tug * rest * where;
  }

  private gripNearHead(): boolean {
    return this.gS + this.gF < 2.2;
  }

  /** 段階・引き戻し・疲れを 1 フレーム進める（挟まれて巣穴に踏ん張っている間） */
  private struggle(dt: number) {
    const S = this.spec, st = this.stageSpec();
    this.clock += dt;
    const g = this.give();
    const stage: TugStage = this.ext >= g ? 'give' : this.ext >= S.stages[1].until ? 'late' : this.ext >= S.stages[0].until ? 'mid' : 'early';
    if (stage !== this.stage) {
      this.stage = stage;
      if (this.held) this.events.push({ kind: 'stage', stage });
    }
    const active = this.held && this.nb > 0;
    if (active && stage !== 'give') {
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
    } else if (this.held && this.nb === 0) {
      // 抜けた後に挟まれている：ときどき強く身をよじる（抵抗。暴れる間は鋏から抜けやすい）
      if (this.tugT > 0) this.tugT -= dt;
      else if ((this.nextTug -= dt) <= 0) {
        this.tugT = 0.35 + 0.3 * this.rng();
        this.nextTug = 1.2 + this.rng() * 1.8;
      }
    } else this.tugT = 0;
    this.env += ((this.tugT > 0 ? 1 : 0) - this.env) * (1 - Math.exp(-dt * (this.tugT > 0 ? 14 : 7)));
    this.restT = Math.max(0, this.restT - dt);
    if (active && this.load > 0.6) this.stamina = Math.max(S.tireMin, this.stamina - S.tire * dt);
    else if (!this.held) this.stamina = Math.min(1, this.stamina + S.recover * dt);
  }

  /** 外に出ている体の長さの割合（0 = 頭だけ … 1 = 全身） */
  private calcExt(): number {
    if (this.nb === 0) return 1;
    const ne = this.N - this.nb;
    if (ne === 0) return 0;
    return clamp(((ne - 1) * this.Lb + Math.max(0, this.Lb - this.feed)) / ((this.N - 1) * this.Lb), 0, 1);
  }

  // ---------------- 1 フレーム ----------------

  /**
   * 体を dt 進める。claw = 鋏の構えの前・今のフレームの位置（挟まれている間）。
   * 返り値は挟まれている間の手応え（GrabCreature.stepHeld と同じ）
   */
  simulate(dt: number, a0: readonly number[] | null, a1: readonly number[] | null): { force: V3; over: number; tugOver: number; stretch: number; done: boolean } {
    const out = { force: [0, 0, 0] as V3, over: 0, tugOver: 0, stretch: 0, done: false };
    if (dt <= 0) return out;
    const t0 = performance.now();
    this.struggle(dt);
    if (this.nb > 0) this.checkSand(dt);
    // 寝ている（砂の中で止まっている・遠くで止まっている）：物理を進めない
    const still = this.nb === this.N && Math.abs(this.outLen() - this.outTarget) < 1e-3 && this.life !== 'dig' && !this.held;
    if (still || (this.sleep && !this.held)) {
      this.feedV = 0;
      this.syncP();
      return out;
    }
    const n = Math.max(1, Math.ceil(dt / (this.held ? SUB : SUB_FREE) - 1e-6)), h = dt / n;
    // 当たりの距離はフレームごとに測り直す（掘った・盛った砂もすぐ効く）
    this.cv.fill(0);
    this.gForce.fill(0);
    this.gOver = 0;
    let tugOver = 0;
    const avx = a0 && a1 ? (a1[0] - a0[0]) / dt : 0, avy = a0 && a1 ? (a1[1] - a0[1]) / dt : 0, avz = a0 && a1 ? (a1[2] - a0[2]) / dt : 0;
    for (let k = 1; k <= n; k++) {
      let A: V3 | null = null;
      if (a0 && a1) {
        const f = k / n;
        A = [lerp(a0[0], a1[0], f), lerp(a0[1], a1[1], f), lerp(a0[2], a1[2], f)];
      }
      this.substep(h, A, avx, avy, avz);
      if (A && this.held) {
        const fl = Math.hypot(this.gForce[0], this.gForce[1], this.gForce[2]) / k;
        // （伸び縮みする体が暴れる力の一部を吸うので、スナモグリ（固い体）より小さく）
        tugOver = Math.max(tugOver, ((this.nb > 0 ? this.env * this.stageSpec().tugP * TUG_ABSORB : this.env * 0.7) * fl) / this.spec.grip);
      }
    }
    out.force[0] = this.gForce[0] / n;
    out.force[1] = this.gForce[1] / n;
    out.force[2] = this.gForce[2] / n;
    out.over = this.gOver;
    out.tugOver = tugOver;
    out.stretch = this.gStretch;
    this.ext = this.calcExt();
    this.load = this.mouthT / Math.max(this.hold, 1e-3);
    this.extV += ((this.nb > 0 ? Math.max(0, -this.feedV) / this.length : 0) - this.extV) * (1 - Math.exp(-dt * 10));
    if (this.held) {
      this.stats.heldT += dt;
      this.stats.maxExt = Math.max(this.stats.maxExt, this.ext);
      this.stats.maxTension = Math.max(this.stats.maxTension, this.mouthT);
    }
    this.syncP();
    this.stats.steps++;
    this.stats.stepMs += performance.now() - t0;
    return out;
  }

  private substep(h: number, A: V3 | null, avx: number, avy: number, avz: number) {
    const N = this.N, X = this.x, V = this.v, W = this.w, S = this.spec;
    this.phase += h * Math.PI * 2 * S.waveFreq * (this.life === 'dig' ? 1.6 : 1);
    this.twist += h * (2.3 + 3 * this.wr);
    // ---- 巣穴に沿った動き（feed）と、出る・入る ----
    if (this.nb > 0) this.stepFeed(h);
    // ---- 外の節：力 → 速さ → 位置 ----
    const wet = (y: number) => y < TANK.waterY - 0.03;
    const crawl = this.nb === 0 && !this.held && (this.life === 'free' || this.life === 'seek') ? 1 : this.life === 'forage' && !this.held ? 1 : 0;
    const peek = this.nb > 0 && !this.held && (this.life === 'peek' || this.life === 'alert');
    // 暴れる強さ：挟まれている・離された直後
    const wrT = this.held ? (this.nb > 0 ? 0.25 + 0.75 * this.env : 0.35 + 0.65 * this.env) : this.life === 'writhe' ? 0.5 + 0.5 * clamp(this.lifeT, 0, 1) : this.life === 'hide' && this.nb < N ? 0.35 : 0;
    this.wr += (wrT - this.wr) * (1 - Math.exp(-h * 6));
    // 節ごとの伸び縮み（蠕動）と、暴れている間は縮む
    for (let i = 0; i < N - 1; i++) {
      const per = S.peristalsis * (crawl ? 1 : this.held ? 0.6 : 0.35);
      const c = this.held && this.nb > 0 ? 1 - S.contract * this.env : 1;
      this.Lr[i] = this.Lb * c * (1 + per * Math.sin(this.phase * 1.3 - i * 0.9));
    }
    for (let i = 0; i < N; i++) {
      if (W[i] === 0) continue;
      const o = i * 3;
      const g = wet(X[o + 1]) ? S.sink * (peek ? 0.12 : 1) : 9.8;
      V[o + 1] -= g * h;
      const dg = Math.exp(-(wet(X[o + 1]) ? S.drag : 0.3) * h);
      V[o] *= dg;
      V[o + 1] *= dg;
      V[o + 2] *= dg;
    }
    this.muscles(h, crawl, peek);
    for (let i = 0; i < N; i++) {
      if (W[i] === 0) continue;
      const o = i * 3;
      const sp = Math.hypot(V[o], V[o + 1], V[o + 2]);
      if (sp > V_MAX) {
        const k = V_MAX / sp;
        V[o] *= k;
        V[o + 1] *= k;
        V[o + 2] *= k;
      }
      this.xp[o] = X[o];
      this.xp[o + 1] = X[o + 1];
      this.xp[o + 2] = X[o + 2];
      X[o] += V[o] * h;
      X[o + 1] += V[o + 1] * h;
      X[o + 2] += V[o + 2] * h;
    }
    if (this.nb > 0) this.placeKinematic(h);
    // ---- 制約 ----
    this.lam.fill(0);
    let gl = 0;
    for (let it = 0; it < ITER; it++) {
      this.solveDistances(h, it & 1);
      if (A && this.held) gl = this.solveClaw(h, A, gl);
    }
    this.solveBend();
    this.collide();
    // 張力（伸びの制約の乗数 → 力）と伸び
    for (let i = 0; i < N - 1; i++) {
      const o = i * 3;
      const l = Math.hypot(X[o + 3] - X[o], X[o + 4] - X[o + 1], X[o + 5] - X[o + 2]);
      this.tension[i] = Math.max(0, -this.lam[i] / (h * h));
      this.strain[i] = l / this.Lb;
      if (!this.isBuried(i) || !this.isBuried(i + 1)) this.stats.maxStrain = Math.max(this.stats.maxStrain, this.strain[i]);
    }
    if (this.nb > 0 && this.nb < N) {
      const s = this.bEnd ? this.ea() : this.sb();
      this.mouthT = this.tension[s];
      // 隙間の縁にこすれる力（石の隙間）：口の所の体の水平の向きが、隙間の開いている向き（岩から離れる水平の向き）から
      // ずれている分。真上・開いている向きへ引くと小さく、岩の面に沿って横へ・岩の方へ引くと大きい（隙間の傾きには左右されない）
      const e = this.ea(), m = this.mouth;
      const dx = X[e * 3] - m[0], dy = X[e * 3 + 1] - m[1], dz = X[e * 3 + 2] - m[2];
      const dl = Math.hypot(dx, dy, dz) || 1, dh = Math.hypot(dx, dz);
      const od = this.openDir;
      let side = 0;
      if (dh > 1e-4) {
        const c = (dx * od[0] + dz * od[1]) / dh;
        side = (c >= 0 ? Math.sqrt(Math.max(0, 1 - c * c)) : 1) * (dh / dl);
      }
      this.side = side;
      this.rub = this.mouthT * side;
    } else {
      this.mouthT = 0;
      this.rub = 0;
      this.side = 0;
    }
    // ---- 速さ ----
    const kd = 1 - Math.exp(-h * 40);
    for (let i = 0; i < N; i++) {
      if (W[i] === 0) continue;
      const o = i * 3;
      V[o] = (X[o] - this.xp[o]) / h;
      V[o + 1] = (X[o + 1] - this.xp[o + 1]) / h;
      V[o + 2] = (X[o + 2] - this.xp[o + 2]) / h;
    }
    // 体の中の減衰（節の間の伸び縮みの速さを弱める：震えを抑える）
    for (let i = 0; i < N - 1; i++) {
      const a = i * 3, b = a + 3;
      const dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      const nx = dx / l, ny = dy / l, nz = dz / l;
      const rv = (V[b] - V[a]) * nx + (V[b + 1] - V[a + 1]) * ny + (V[b + 2] - V[a + 2]) * nz;
      const ws = W[i] + W[i + 1];
      if (ws === 0) continue;
      const imp = rv * kd;
      const ka = W[i] / ws, kb = W[i + 1] / ws;
      V[a] += nx * imp * ka;
      V[a + 1] += ny * imp * ka;
      V[a + 2] += nz * imp * ka;
      V[b] -= nx * imp * kb;
      V[b + 1] -= ny * imp * kb;
      V[b + 2] -= nz * imp * kb;
    }
    this.friction(h);
    // 鋏につかまれている所は鋏と一緒に動く（相対の速さを弱める）
    if (A && this.held) {
      const a = this.gS, b = a + 1, f = this.gF;
      const vx = lerp(V[a * 3], V[b * 3], f), vy = lerp(V[a * 3 + 1], V[b * 3 + 1], f), vz = lerp(V[a * 3 + 2], V[b * 3 + 2], f);
      const k = 1 - Math.exp(-h * 14);
      for (const [j, wf] of [[a, 1 - f], [b, f]] as const) {
        if (W[j] === 0) continue;
        V[j * 3] += (avx - vx) * k * wf;
        V[j * 3 + 1] += (avy - vy) * k * wf;
        V[j * 3 + 2] += (avz - vz) * k * wf;
      }
    }
    this.guard();
  }

  /** 巣穴に沿った速さ（挟まれている = 踏ん張りと張力、それ以外 = 暮らしの目標）と、節が出る・入る */
  private stepFeed(h: number) {
    const S = this.spec;
    let v: number;
    if (this.held) {
      // 張力が踏ん張りを越えた分だけ滑り出る。下回れば引き戻す（引き戻している間は速い）
      const st = this.stageSpec();
      // 隙間の縁に引っかかる：開いている向きから外れて引くほど踏ん張りが増える（張力に比例させると、斜めでは引くほど強く
      // 引っかかって決して抜けなくなるので、踏ん張りの倍率にする）
      const H = this.holdNow() * (1 + S.rimMu * this.side);
      this.hold = H;
      const T = this.mouthT;
      if (T > H) v = -(S.slide * (this.restT > 0 ? 2 : 1) * (T - H)) / S.holdRef;
      else v = S.drive * (1 + (st.tugDrive - 1) * this.env) * (1 - T / H);
      v = Math.max(v, -3);
    } else if (this.life === 'dig') v = S.burrowSpeed;
    else {
      // 出している長さを目標へ（正 = 奥へ引き込む）。離された直後は、伸びた体を縮めながらゆっくり戻る（まだ挟み直せる）
      this.afterT = Math.max(0, this.afterT - h);
      const rMax = this.afterT > 0 ? S.retractSpeed * (this.afterT > 1 ? 0.12 : 0.25) : S.retractSpeed;
      v = clamp((this.outLen() - this.outTarget) * 6, -S.emergeSpeed * (this.life === 'forage' ? 1.4 : 1), rMax);
      // 外の体が何かに引っかかっている（強く張っている）間は引き込めない
      if (v > 0 && this.mouthT > S.hold[0] * 0.8) v = 0;
      this.feedV += (v - this.feedV) * (1 - Math.exp(-h * 20));
      v = this.feedV;
    }
    this.feedV = v;
    this.feed += v * h;
    // 頭から潜っている間：巣穴を奥へ延ばす（延ばせなければ潜るのをやめて出てくる）
    if (this.life === 'dig' && this.bEnd === 0) {
      const need = this.feed + (this.nb - 1) * this.Lb + 0.04;
      while (this.tunLen() < need) {
        if (!this.extendTunnel()) {
          this.feed = Math.min(this.feed, this.tunLen() - (this.nb - 1) * this.Lb - 0.04);
          this.feedV = 0;
          if (!this.held) {
            this.life = 'forage';
            this.outTarget = 99;
          }
          break;
        }
      }
    } else {
      // 巣穴の奥より深くへは入らない
      const deep = this.tunLen() - (this.nb - 1) * this.Lb - 0.01;
      if (this.feed > deep) {
        this.feed = deep;
        this.feedV = Math.min(0, this.feedV);
      }
    }
    this.transitions(h);
  }

  /** 節が口から出る・入る */
  private transitions(h: number) {
    const N = this.N, X = this.x, V = this.v;
    // 出る：いちばん口に近い節が口より外へ
    while (this.nb > 0 && this.feed < 0) {
      const i = this.sb();
      const m = this.mouth;
      this.outward(tmpA);
      const k = -this.feed;
      X[i * 3] = m[0] + tmpA[0] * k;
      X[i * 3 + 1] = m[1] + tmpA[1] * k;
      X[i * 3 + 2] = m[2] + tmpA[2] * k;
      const sp = Math.max(0, -this.feedV);
      V[i * 3] = tmpA[0] * sp;
      V[i * 3 + 1] = tmpA[1] * sp;
      V[i * 3 + 2] = tmpA[2] * sp;
      this.xp[i * 3] = X[i * 3] - V[i * 3] * h;
      this.xp[i * 3 + 1] = X[i * 3 + 1] - V[i * 3 + 1] * h;
      this.xp[i * 3 + 2] = X[i * 3 + 2] - V[i * 3 + 2] * h;
      this.w[i] = this.invM;
      this.nb--;
      this.feed += this.Lb;
      if (this.nb === 0) {
        this.fullyOut(h);
        return;
      }
    }
    // 入る：口に近い外の節が口まで来ていれば
    while (this.nb > 0 && this.nb < N && this.feed > this.Lb) {
      const e = this.ea();
      if (this.held && (e === this.gS || e === this.gS + 1)) {
        this.feed = Math.min(this.feed, this.Lb * 1.4);
        break;
      }
      const t = this.feed - this.Lb;
      this.tunAt(t, tmpA);
      const d = Math.hypot(X[e * 3] - tmpA[0], X[e * 3 + 1] - tmpA[1], X[e * 3 + 2] - tmpA[2]);
      if (d < this.Lb * 0.75) {
        this.w[e] = 0;
        this.nb++;
        this.feed = t;
      } else {
        this.feed = Math.min(this.feed, this.Lb * 1.45);
        break;
      }
    }
    // 頭から潜り終えた：砂の中で向きを入れ替え（頭を口の側に）、隠れる
    if (this.nb === N && this.bEnd === 0) {
      this.bEnd = 1;
      this.life = 'hidden';
      this.lifeT = 3 + this.rng() * 4;
      this.outTarget = -HIDE_DEPTH;
      this.feedV = 0;
      this.stats.digs++;
      const m = this.mouth;
      this.events.push({ kind: 'buried', x: m[0], y: m[1], z: m[2] });
    }
  }

  /** 最後の節が口を出た：挟まれていれば「抜けた」 */
  private fullyOut(h: number) {
    const m = this.mouth;
    this.feedV = 0;
    if (this.held) {
      // 最後の節（尾・潜りかけなら頭）は、抜けた勢いで飛び出す
      const S = this.spec;
      const tail = this.bEnd ? this.N - 1 : 0;
      this.outward(tmpA);
      const kick = S.popKick * (0.6 + 0.4 * clamp(this.mouthT / this.spec.grip, 0, 1));
      for (let j = 0; j < 3; j++) {
        const i = this.bEnd ? tail - j : tail + j;
        const f = 1 - j * 0.3;
        this.v[i * 3] += tmpA[0] * kick * f;
        this.v[i * 3 + 1] += tmpA[1] * kick * f;
        this.v[i * 3 + 2] += tmpA[2] * kick * f;
        this.xp[i * 3] = this.x[i * 3] - this.v[i * 3] * h;
        this.xp[i * 3 + 1] = this.x[i * 3 + 1] - this.v[i * 3 + 1] * h;
        this.xp[i * 3 + 2] = this.x[i * 3 + 2] - this.v[i * 3 + 2] * h;
      }
      const first = !this.found;
      this.found = true;
      this.name = WORM_NAME;
      this.stats.pops++;
      // 口からカニの側（挟んでいる点の側）への水平の向き
      const g = this.gripPoint();
      const dx = g[0] - m[0], dz = g[2] - m[2], dl = Math.hypot(dx, dz) || 1;
      const power = clamp(Math.max(this.mouthT, this.tension.reduce((a, b) => Math.max(a, b), 0) * 0.6) / this.spec.grip, 0.3, 1);
      this.events.push({ kind: 'pop', x: m[0], y: m[1], z: m[2], power, dir: [dx / dl, dz / dl], first });
      // 抜けた瞬間：激しくくねる
      this.env = 1;
      this.tugT = 0.6;
      this.nextTug = 1.4;
      this.life = 'writhe';
      this.lifeT = 1.8;
    } else if (this.life === 'forage') {
      this.life = 'free';
      this.lifeT = 6 + this.rng() * 8;
      this.goal = null;
    } else {
      this.life = 'writhe';
      this.lifeT = 1.2;
    }
    this.mouthT = 0;
    this.ext = 1;
    this.stage = 'early';
    this.restT = 0;
  }

  /** 筋肉：横のうねり（這う）・回るうねり（暴れる）・推進・頭の向き・顔を出している間の姿勢 */
  private muscles(h: number, crawl: number, peek: boolean) {
    const N = this.N, X = this.x, V = this.v, W = this.w, S = this.spec;
    const crawlAcc = S.crawlSpeed * S.fricTan * 2.6;
    for (let i = 1; i < N - 1; i++) {
      const a = (i - 1) * 3, o = i * 3, b = (i + 1) * 3;
      if (W[i] === 0 && W[i - 1] === 0 && W[i + 1] === 0) continue;
      let tx = X[a] - X[b], ty = X[a + 1] - X[b + 1], tz = X[a + 2] - X[b + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      // 横の向き（地面に触れていればその面の中、そうでなければ水平の面の中）
      const ux = this.touch[i] ? this.cn[o] : 0, uy = this.touch[i] ? this.cn[o + 1] : 1, uz = this.touch[i] ? this.cn[o + 2] : 0;
      let lx = uy * tz - uz * ty, ly = uz * tx - ux * tz, lz = ux * ty - uy * tx;
      const ll = Math.hypot(lx, ly, lz);
      if (ll < 1e-4) {
        lx = 1;
        ly = 0;
        lz = 0;
      } else {
        lx /= ll;
        ly /= ll;
        lz /= ll;
      }
      let acc = 0;
      let ax = 0, ay = 0, az = 0;
      if (crawl) {
        acc = S.waveAcc * Math.sin(this.phase - (i * Math.PI * 2) / S.waveLen);
        ax += lx * acc;
        ay += ly * acc;
        az += lz * acc;
      }
      if (this.wr > 0.01) {
        // 回るうねり：横の向きを体の軸のまわりに回す（身をよじる）
        const ps = this.twist + i * 0.55;
        const bx = ty * lz - tz * ly, by = tz * lx - tx * lz, bz = tx * ly - ty * lx;
        const c = Math.cos(ps), s = Math.sin(ps);
        const k = S.writheAcc * this.wr * Math.sin(this.phase * 1.7 - i * 0.8);
        ax += (lx * c + bx * s) * k;
        ay += (ly * c + by * s) * k;
        az += (lz * c + bz * s) * k;
        this.roll[i] = Math.sin(ps) * 0.6 * this.wr;
      } else this.roll[i] *= 0.95;
      if (peek && W[i] !== 0) {
        // 顔を出している間：小さく探るように揺れる
        const k = 0.35 * Math.sin(this.phase * 0.6 + i);
        ax += lx * k;
        ay += ly * k;
        az += lz * k;
      }
      // 組で加える（両隣に半分ずつ逆向き：体全体の勢いは変わらない）
      if (W[i] !== 0) {
        V[o] += ax * h;
        V[o + 1] += ay * h;
        V[o + 2] += az * h;
      }
      if (W[i - 1] !== 0) {
        V[a] -= ax * h * 0.5;
        V[a + 1] -= ay * h * 0.5;
        V[a + 2] -= az * h * 0.5;
      }
      if (W[i + 1] !== 0) {
        V[b] -= ax * h * 0.5;
        V[b + 1] -= ay * h * 0.5;
        V[b + 2] -= az * h * 0.5;
      }
      // 推進：地面に触れている節は頭の側へ押す（疣足）
      if (crawl && this.touch[i] && W[i] !== 0) {
        V[o] += tx * crawlAcc * h * 0.5;
        V[o + 1] += ty * crawlAcc * h * 0.5;
        V[o + 2] += tz * crawlAcc * h * 0.5;
      }
    }
    // 頭：行き先へ向かう（地面に触れているとき）
    if (crawl && W[0] !== 0 && this.goal) {
      const gx = this.goal[0] - X[0], gz = this.goal[1] - X[2], gl = Math.hypot(gx, gz) || 1;
      const k = crawlAcc * (this.touch[0] || this.touch[1] ? 1.3 : 0.4);
      V[0] += (gx / gl) * k * h;
      V[2] += (gz / gl) * k * h;
    }
    // 顔を出している：頭を口の上の探る点へ（ばね）
    if (this.nb > 0 && !this.held && W[0] !== 0 && this.bEnd === 1) {
      const m = this.mouth;
      this.outward(tmpA);
      const ne = this.N - this.nb;
      const le = Math.max(0.03, (ne - 0.3) * this.Lb - Math.max(0, this.feed));
      this.lookA += h * (0.7 + 0.5 * Math.sin(this.clock * 0.37 + this.traits.seed));
      const side = Math.sin(this.lookA) * (1 - this.alertK * 0.6);
      // 横の向き（水平）
      const sx = -tmpA[2], sz = tmpA[0], sl = Math.hypot(sx, sz) || 1;
      // 口からほぼ上へ伸び（巣穴の向きへは少しだけ傾く）、横へ首を振って探る
      let tx = m[0] + tmpA[0] * le * 0.3 + (sx / sl) * le * 0.45 * side;
      const ty = m[1] + le * (0.85 - 0.2 * this.alertK) + Math.sin(this.lookA * 1.7) * le * 0.08;
      let tz = m[2] + tmpA[2] * le * 0.3 + (sz / sl) * le * 0.45 * side;
      if (this.alertK > 0.05 && this.senseAt) {
        // 警戒：頭をカニの方へ向けて（様子をうかがう）、震える
        const cx = this.senseAt[0] - m[0], cz = this.senseAt[1] - m[2], cl = Math.hypot(cx, cz) || 1;
        tx = lerp(tx, m[0] + (cx / cl) * le * 0.8, this.alertK * 0.9);
        tz = lerp(tz, m[2] + (cz / cl) * le * 0.8, this.alertK * 0.9);
      }
      const kp = 90, kv = 11;
      const tr = this.alertK * Math.sin(this.clock * 60) * 0.6;
      V[0] += ((tx - X[0]) * kp - V[0] * kv + tr) * h;
      V[1] += ((ty - X[1]) * kp - V[1] * kv) * h;
      V[2] += ((tz - X[2]) * kp - V[2] * kv - tr) * h;
    }
  }

  /** 制約：節の間の距離（やわらかい伸び + 伸びの上限・縮みの下限）。dir = 解く順（0 = 頭から、1 = 尾から） */
  private solveDistances(h: number, dir: number) {
    const N = this.N, X = this.x, W = this.w, S = this.spec;
    const at = S.compliance / (h * h);
    for (let k = 0; k < N - 1; k++) {
      const i = dir ? N - 2 - k : k;
      const wa = W[i], wb = W[i + 1], ws = wa + wb;
      if (ws === 0) continue;
      const a = i * 3, b = a + 3;
      const dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-7) continue;
      const nx = dx / l, ny = dy / l, nz = dz / l;
      const L = this.Lr[i];
      // やわらかい伸び
      let C = l - L;
      let dl = (-C - at * this.lam[i]) / (ws + at);
      this.lam[i] += dl;
      // 伸びの上限・縮みの下限（硬い）
      const l2 = l + dl * ws;
      if (l2 > L * S.maxStrain) {
        C = l2 - L * S.maxStrain;
        const d2 = -C / ws;
        dl += d2;
        this.lam[i] += d2;
      } else if (l2 < L * S.minStrain) {
        C = l2 - L * S.minStrain;
        dl += -C / ws;
      }
      X[a] -= nx * dl * wa;
      X[a + 1] -= ny * dl * wa;
      X[a + 2] -= nz * dl * wa;
      X[b] += nx * dl * wb;
      X[b + 1] += ny * dl * wb;
      X[b + 2] += nz * dl * wb;
    }
  }

  /** 制約：鋏の構え A と挟んだ点（ばね SPRING_K、力の上限 = 握る力）。gl = これまでの乗数 */
  private solveClaw(h: number, A: V3, gl: number): number {
    const X = this.x, W = this.w, S = this.spec;
    const a = this.gS, b = a + 1, f = this.gF;
    const px = lerp(X[a * 3], X[b * 3], f), py = lerp(X[a * 3 + 1], X[b * 3 + 1], f), pz = lerp(X[a * 3 + 2], X[b * 3 + 2], f);
    const ex = A[0] - px, ey = A[1] - py, ez = A[2] - pz;
    const C = Math.hypot(ex, ey, ez);
    this.gStretch = C;
    this.gOver = Math.max(this.gOver, (SPRING_K * C) / S.grip);
    if (C < 1e-7) return gl;
    const nx = ex / C, ny = ey / C, nz = ez / C;
    const wa = W[a] * (1 - f) * (1 - f), wb = W[b] * f * f, ws = wa + wb;
    if (ws === 0) return gl;
    const at = 1 / (SPRING_K * h * h);
    let dl = (C - at * gl) / (ws + at);
    // 握る力より強くは引けない（力 = 乗数 / 刻み²）
    const cap = S.grip * h * h;
    if (gl + dl > cap) dl = cap - gl;
    if (dl <= 0) return gl;
    const ka = W[a] * (1 - f) * dl, kb = W[b] * f * dl;
    X[a * 3] += nx * ka;
    X[a * 3 + 1] += ny * ka;
    X[a * 3 + 2] += nz * ka;
    X[b * 3] += nx * kb;
    X[b * 3 + 1] += ny * kb;
    X[b * 3 + 2] += nz * kb;
    const F = dl / (h * h);
    this.gForce[0] += nx * F;
    this.gForce[1] += ny * F;
    this.gForce[2] += nz * F;
    return gl + dl;
  }

  /** 制約：曲げ（まっすぐに戻る弱い力と、折れ曲がりの限界） */
  private solveBend() {
    const N = this.N, X = this.x, W = this.w, S = this.spec;
    for (let i = 1; i < N - 1; i++) {
      const wa = W[i - 1], wi = W[i], wb = W[i + 1];
      const ws = wi + (wa + wb) * 0.25;
      if (ws === 0) continue;
      const a = (i - 1) * 3, o = i * 3, b = (i + 1) * 3;
      for (let c = 0; c < 3; c++) {
        const C = X[o + c] - (X[a + c] + X[b + c]) * 0.5;
        const dl = (-C * S.bendK) / ws;
        X[o + c] += wi * dl;
        X[a + c] -= wa * dl * 0.5;
        X[b + c] -= wb * dl * 0.5;
      }
      // 折れ曲がりの限界：両隣の距離の下限
      const dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2];
      const l = Math.hypot(dx, dy, dz);
      const lmin = 2 * this.Lb * S.bendMin;
      const w2 = wa + wb;
      if (l < lmin && l > 1e-7 && w2 > 0) {
        const d = (lmin - l) / (l * w2);
        X[a] -= dx * d * wa;
        X[a + 1] -= dy * d * wa;
        X[a + 2] -= dz * d * wa;
        X[b] += dx * d * wb;
        X[b + 1] += dy * d * wb;
        X[b + 2] += dz * d * wb;
      }
    }
  }

  /**
   * 当たり：外の節を地形・ガラス・管から押し出す（巣穴の口の近くは穴なので除く）。
   * 距離と法線は節ごとにフレームで最初に 1 回だけ正確に測り、同じフレームの刻みの間は、測った所から CACHE_R より動くまで
   * 面を平らと見なして近似する（離れている節は「距離 − 動いた量」が余裕のある間は調べない）。地形の関数は重いので（スマホで効く）
   */
  private collide() {
    const N = this.N, X = this.x, W = this.w, Wd = this.world;
    const m = this.nb > 0 ? this.mouth : null;
    for (let i = 0; i < N; i++) {
      this.touch[i] = 0;
      if (W[i] === 0) continue;
      const o = i * 3;
      const x = X[o], y = X[o + 1], z = X[o + 2];
      if (m && Math.hypot(x - m[0], y - m[1], z - m[2]) < MOUTH_R + this.rad[i]) continue;
      const r = this.rad[i] * 0.85;
      let d: number;
      let nx: number, ny: number, nz: number;
      const mv = this.cv[i] ? Math.hypot(x - this.cx[o], y - this.cx[o + 1], z - this.cx[o + 2]) : Infinity;
      if (mv < CACHE_R) {
        if (this.cv[i] === 1) {
          // 前に離れていた：動いた分だけ近づいたとしても余裕があれば調べない
          if (this.cd[i] - mv >= r + 0.004) continue;
        } else {
          // 前に触れていた：面を平らと見なす
          nx = this.cn[o];
          ny = this.cn[o + 1];
          nz = this.cn[o + 2];
          d = this.cd[i] + nx * (x - this.cx[o]) + ny * (y - this.cx[o + 1]) + nz * (z - this.cx[o + 2]);
          if (d >= r + 0.004) continue;
          this.touch[i] = 1;
          if (d < r) {
            const push = Math.min(r - d, 0.06);
            X[o] += nx * push;
            X[o + 1] += ny * push;
            X[o + 2] += nz * push;
          }
          continue;
        }
      }
      d = Wd.contactSolid(x, y, z);
      this.cx[o] = x;
      this.cx[o + 1] = y;
      this.cx[o + 2] = z;
      this.cd[i] = d;
      if (d >= r + 0.004) {
        this.cv[i] = 1;
        continue;
      }
      // 法線（4 点の勾配）
      const e = 0.012;
      const f1 = Wd.contactSolid(x + e, y - e, z - e), f2 = Wd.contactSolid(x - e, y - e, z + e), f3 = Wd.contactSolid(x - e, y + e, z - e), f4 = Wd.contactSolid(x + e, y + e, z + e);
      nx = f1 - f2 - f3 + f4;
      ny = -f1 - f2 + f3 + f4;
      nz = -f1 + f2 - f3 + f4;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-9) {
        nx = 0;
        ny = 1;
        nz = 0;
      } else {
        nx /= nl;
        ny /= nl;
        nz /= nl;
      }
      this.cv[i] = 2;
      this.touch[i] = 1;
      this.cn[o] = nx;
      this.cn[o + 1] = ny;
      this.cn[o + 2] = nz;
      if (d < r) {
        const push = Math.min(r - d, 0.06);
        this.stats.pushMax = Math.max(this.stats.pushMax, r - d);
        X[o] += nx * push;
        X[o + 1] += ny * push;
        X[o + 2] += nz * push;
      }
    }
  }

  /** 地面の摩擦（横に滑りにくく、前後に滑りやすい）と、面へめり込む速さを消す */
  private friction(h: number) {
    const N = this.N, X = this.x, V = this.v, W = this.w, S = this.spec;
    const kl = Math.exp(-S.fricLat * h), kt = Math.exp(-S.fricTan * h);
    for (let i = 0; i < N; i++) {
      if (!this.touch[i] || W[i] === 0) continue;
      const o = i * 3;
      const nx = this.cn[o], ny = this.cn[o + 1], nz = this.cn[o + 2];
      let vn = V[o] * nx + V[o + 1] * ny + V[o + 2] * nz;
      if (vn < 0) {
        V[o] -= nx * vn;
        V[o + 1] -= ny * vn;
        V[o + 2] -= nz * vn;
        vn = 0;
      }
      // 体の向き（面の中）
      const a = Math.max(0, i - 1) * 3, b = Math.min(N - 1, i + 1) * 3;
      let tx = X[a] - X[b], ty = X[a + 1] - X[b + 1], tz = X[a + 2] - X[b + 2];
      const td = tx * nx + ty * ny + tz * nz;
      tx -= nx * td;
      ty -= ny * td;
      tz -= nz * td;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const vt = V[o] * tx + V[o + 1] * ty + V[o + 2] * tz;
      const lx = V[o] - nx * vn - tx * vt, ly = V[o + 1] - ny * vn - ty * vt, lz = V[o + 2] - nz * vn - tz * vt;
      V[o] = nx * vn + tx * vt * kt + lx * kl;
      V[o + 1] = ny * vn + ty * vt * kt + ly * kl;
      V[o + 2] = nz * vn + tz * vt * kt + lz * kl;
    }
  }

  /** 発散・水槽の外への抜けを見張る（見つけたら住みかの砂の中へ戻す） */
  private guard() {
    const X = this.x, N = this.N;
    let bad = false;
    for (let i = 0; i < N && !bad; i++) {
      const o = i * 3;
      if (!Number.isFinite(X[o] + X[o + 1] + X[o + 2])) bad = true;
      else if (X[o + 1] < TANK.floorY - 0.3 || !this.world.insideTank(X[o], X[o + 2], -0.2)) bad = true;
      const sp = Math.hypot(this.v[o], this.v[o + 1], this.v[o + 2]);
      this.stats.maxV = Math.max(this.stats.maxV, sp);
    }
    if (!bad) {
      for (let i = 0; i < N - 1; i++) if (this.strain[i] > this.spec.maxStrain * 2.5) bad = true;
    }
    if (bad) {
      this.stats.diverge++;
      this.recover();
    }
  }

  /** 戻す：住みかの砂の中へ（できなければ住みかの上に置く） */
  recover() {
    this.held = false;
    if (!this.placeBuried(this.home)) this.layFree(this.home[0], this.home[1] + 0.1, this.home[2], 0);
  }

  // ---------------- 砂の変化 ----------------

  /**
   * 盛られた（0.25 秒ごと）：口が砂で埋まったら巣穴を上へ延ばす（口を新しい表面へ）。
   * 掘られても巣は壊れない（2026-11-28 改：巣穴は岩・流木の面に沿う石の隙間なので、まわりの砂が無くなっても体は隙間に収まったまま）
   */
  private checkSand(dt: number) {
    if ((this.checkT -= dt) > 0) return;
    this.checkT = 0.25;
    const W = this.world;
    const m = this.mouth;
    // 口の上に砂が盛られた：巣穴を上へ延ばす（口を新しい表面へ）
    const sy = W.surfaceBelow(m[0], m[1] + 0.6, m[2]);
    if (sy > m[1] + 0.04 && W.sandSolid(m[0], m[1] + 0.02, m[2]) < -0.02) {
      const add = sy - m[1];
      this.tun.unshift(m[0], sy, m[2]);
      for (let i = 0; i < this.tunC.length; i++) this.tunC[i] += add;
      this.tunC.unshift(0);
      this.feed += add;
    }
  }

  // ---------------- 暮らし ----------------

  /** カニの位置（警戒の向き） */
  private senseAt: [number, number] | null = null;
  private prevGrounded = true;
  private prevVy = 0;

  /** 挟まれていない間の 1 フレーム（暮らしを決めてから体を進める） */
  update(dt: number, s: WormSense) {
    if (dt <= 0 || this.held) return;
    this.life_(dt, s);
    this.simulate(dt, null, null);
  }

  private life_(dt: number, s: WormSense) {
    this.lifeT -= dt;
    const m = this.nb > 0 ? this.mouth : this.head();
    const dx = s.x - m[0], dz = s.z - m[2];
    const dist = Math.hypot(dx, dz);
    const near = s.inTank && Math.abs(s.y - m[1]) < 1.6;
    this.senseAt = near ? [s.x, s.z] : null;
    // 起きる・寝る（遠くで止まっている外の体は進めない）
    this.sleep = this.nb === 0 && !near && dist > 14 && this.life !== 'writhe' && Math.hypot(this.v[0], this.v[1], this.v[2]) < 0.05;
    const landed = s.grounded && !this.prevGrounded && this.prevVy < -1.6;
    this.prevGrounded = s.grounded;
    this.prevVy = s.vy;
    const danger = near && ((dist < ALERT_R && s.speed > FAST) || dist < TOUCH_R || (landed && dist < 2.2) || (s.dug && dist < 1.3));
    const close = near && dist < ALERT_R;
    this.alertK += ((close && (this.life === 'peek' || this.life === 'alert') ? 1 : 0) - this.alertK) * (1 - Math.exp(-dt * 4));
    const peekLen = (k: number) => this.Lb * k + 0.02;
    switch (this.life) {
      case 'hidden':
        this.outTarget = -HIDE_DEPTH;
        if (this.lifeT <= 0 && !danger) {
          // カニが遠ければ、まれに自分で這い出る
          if (!near || dist > 7) {
            if (this.rng() < 0.12) {
              this.life = 'forage';
              this.outTarget = 99;
              break;
            }
          }
          this.life = close ? 'alert' : 'peek';
          this.lifeT = 6 + this.rng() * 10;
          const mm = this.mouth;
          this.events.push({ kind: 'peek', x: mm[0], y: mm[1], z: mm[2] });
        } else if (this.lifeT <= 0) this.lifeT = 0.8;
        break;
      case 'peek':
      case 'alert':
        if (danger) {
          this.hide(2.5 + this.rng() * 2.5);
          break;
        }
        this.life = close ? 'alert' : 'peek';
        this.outTarget = peekLen(close ? 3.2 : 3.8 + Math.sin(this.clock * 0.3 + this.traits.seed) * 0.8);
        // ときどき引っ込む（カニがいなくても）
        if (this.lifeT <= 0) this.hide(1.5 + this.rng() * 3);
        break;
      case 'hide':
        this.outTarget = -HIDE_DEPTH;
        if (this.nb === this.N && this.lifeT <= 0) {
          this.life = 'hidden';
          this.lifeT = danger ? 1.5 : 0.3 + this.rng() * 1.2;
        }
        break;
      case 'forage':
        this.outTarget = 99;
        if (danger && this.nb > this.N * 0.4) this.hide(3);
        if (!this.goal) this.goal = this.pickWander(1.2, 2.5);
        break;
      case 'writhe':
        if (this.lifeT <= 0) {
          this.life = this.nb === 0 ? 'seek' : 'hide';
          this.goal = null;
          this.lifeT = 12;
        }
        break;
      case 'free':
        if (!this.goal || this.reached(0.25)) this.goal = this.pickWander(0.8, 2.2);
        if (this.lifeT <= 0) {
          this.life = 'seek';
          this.goal = null;
          this.lifeT = 14;
        }
        this.watchStuck(dt);
        break;
      case 'seek': {
        // 近くの石の隙間（岩・流木が砂に接する縁）を探して、その口へ頭を向けて這う
        if (!this.goal) this.goal = this.pickCrevice();
        this.watchStuck(dt);
        // 頭が岩・流木に触れたら、そこの隙間に入れるか確かめる（行き先の隙間が岩の向こう側でも、ぶつかった所の隙間に潜り込む）
        if ((this.bumpT -= dt) <= 0 && (this.touch[0] || this.touch[1])) {
          this.bumpT = 0.5;
          const hx = this.x[0], hy = this.x[1], hz = this.x[2];
          if (this.world.hardSolid(hx, hy, hz) < this.rad[0] + 0.1) {
            const c = this.creviceAt(hx, hz, hy + 0.2);
            if (c && Math.hypot(c.m[0] - hx, c.m[2] - hz) < 0.6 && this.canTunnel(c.m, c.yaw)) {
              this.crevice = c;
              this.goal = [c.m[0], c.m[2]];
            }
          }
        }
        if (this.goal && this.crevice && this.reached(0.1) && (this.touch[0] || this.touch[1])) this.startDig();
        else if (this.lifeT <= 0) {
          this.goal = null;
          this.lifeT = 12;
        }
        break;
      }
      case 'dig':
        break;
    }
  }

  private hide(t: number) {
    this.life = 'hide';
    this.lifeT = t;
    this.outTarget = -HIDE_DEPTH;
    this.stats.hides++;
    const m = this.mouth;
    this.events.push({ kind: 'hide', x: m[0], y: m[1], z: m[2] });
  }

  private reached(r: number): boolean {
    return !!this.goal && Math.hypot(this.goal[0] - this.x[0], this.goal[1] - this.x[2]) < r;
  }

  private watchStuck(dt: number) {
    const sp = Math.hypot(this.v[0], this.v[2]);
    this.stuckT = sp < 0.03 ? this.stuckT + dt : Math.max(0, this.stuckT - dt);
    if (this.stuckT > 3.5) {
      this.stuckT = 0;
      this.goal = this.life === 'seek' ? this.pickCrevice(true) : this.pickWander(0.6, 1.6);
    }
  }

  /** 近くの歩ける所（水の中の底） */
  private pickWander(r0: number, r1: number): [number, number] {
    const W = this.world;
    for (let k = 0; k < 10; k++) {
      const a = this.rng() * Math.PI * 2, r = lerp(r0, r1, this.rng());
      const x = this.x[0] + Math.sin(a) * r, z = this.x[2] + Math.cos(a) * r;
      if (!W.insideTank(x, z, 0.6) || W.pipeClear(x, z) < 0.3) continue;
      if (W.surfaceBelow(x, this.x[1] + 0.5, z) > TANK.waterY - 0.4) continue;
      return [x, z];
    }
    return [this.home[0], this.home[2]];
  }

  /** 潜り込む石の隙間（口と奥への向き。seek の行き先） */
  private crevice: { m: V3; yaw: number } | null = null;
  /** 頭が岩に触れたときに、そこの隙間を調べる間隔 */
  private bumpT = 0;

  /** 近くの石の隙間（近い順。体が収まる隙間を作れる所。見つからなければ住みか）。行き先（x, z）を返す */
  private pickCrevice(far = false): [number, number] {
    for (const R of far ? [1.5, 3, 5, 8, 12] : [0.4, 1, 2, 3.5, 6, 9, 12]) {
      for (let k = 0; k < 10 + R * 3; k++) {
        const a = this.rng() * Math.PI * 2, r = R * (0.6 + 0.4 * this.rng());
        const c = this.creviceAt(this.x[0] + Math.sin(a) * r, this.x[2] + Math.cos(a) * r, this.x[1] + 0.3);
        if (c && this.canTunnel(c.m, c.yaw)) {
          this.crevice = c;
          return [c.m[0], c.m[2]];
        }
      }
    }
    this.crevice = { m: [this.home[0], this.home[1], this.home[2]], yaw: this.rockYaw(this.home) };
    return [this.home[0], this.home[2]];
  }

  /** 石の隙間の口から頭を差し込んで潜り始める（隙間を作れなければ別の所を探す） */
  private startDig(): boolean {
    const W = this.world;
    const c = this.crevice!;
    const m: V3 = [c.m[0], this.sandSurface(c.m[0], c.m[1], c.m[2]), c.m[2]];
    const yaw0 = c.yaw;
    const old = this.tun, oldC = this.tunC;
    let ok = false;
    for (const k of [0, 0.4, -0.4, 0.8, -0.8]) {
      this.tun = [m[0], m[1], m[2]];
      this.tunC = [0];
      const pitch = 0.9;
      this.tunDir = [Math.sin(yaw0 + k) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw0 + k) * Math.cos(pitch)];
      this.tunDepth = clamp(0.16 + this.rng() * 0.1, 0.1, Math.max(0.1, W.groundAt(m[0], m[2]) - TANK.floorY - 0.12));
      // 最初の数刻みが作れるか
      let good = true;
      for (let s = 0; s < 4 && good; s++) good = this.extendTunnel();
      if (good) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      this.tun = old;
      this.tunC = oldC;
      this.goal = this.pickCrevice(true);
      return false;
    }
    this.setOpen(m);
    this.bEnd = 0;
    this.nb = 1;
    this.feed = 0;
    this.feedV = 0;
    this.w[0] = 0;
    this.life = 'dig';
    this.stats.digs++;
    this.events.push({ kind: 'dig', x: m[0], y: m[1], z: m[2] });
    return true;
  }

  // ---------------- 挟む（GrabCreature） ----------------

  grabbable(): boolean {
    if (this.held) return false;
    if (this.nb === 0) return true;
    // 口より上に体が見えている
    if (this.nb >= this.N) return false;
    const e = this.ea(), m = this.mouth;
    return Math.hypot(this.x[e * 3] - m[0], this.x[e * 3 + 1] - m[1], this.x[e * 3 + 2] - m[2]) > 0.035 || this.N - this.nb >= 2;
  }

  /** 外に出ている体のうち from にいちばん近い節の間（i と i+1）と割合・点 */
  private closest(from: readonly number[]): { i: number; f: number; p: V3; d: number } | null {
    const X = this.x, N = this.N;
    let best: { i: number; f: number; p: V3; d: number } | null = null;
    for (let i = 0; i < N - 1; i++) {
      const ba = this.isBuried(i), bb = this.isBuried(i + 1);
      if (ba && bb) continue;
      const a = i * 3, b = a + 3;
      let f0 = 0, f1 = 1;
      // 口をまたぐ節の間は、外の節の所だけ
      if (ba) f0 = f1 = 1;
      else if (bb) f0 = f1 = 0;
      const dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2];
      const ll = dx * dx + dy * dy + dz * dz || 1e-9;
      let f = ((from[0] - X[a]) * dx + (from[1] - X[a + 1]) * dy + (from[2] - X[a + 2]) * dz) / ll;
      f = clamp(f, f0, f1);
      const px = X[a] + dx * f, py = X[a + 1] + dy * f, pz = X[a + 2] + dz * f;
      const r = lerp(this.rad[i], this.rad[i + 1], f);
      const d = Math.hypot(from[0] - px, from[1] - py, from[2] - pz) - r;
      if (!best || d < best.d) best = { i, f, p: [px, py, pz], d };
    }
    return best;
  }

  nearest(from: readonly number[]): { p: V3; d: number } | null {
    if (!this.grabbable()) return null;
    // 遠い体は調べない（狙いの補助は体の中心から 0.8 まで）
    if (Math.hypot(from[0] - this.x[0], from[2] - this.x[2]) > this.length + 1.2) return null;
    const c = this.closest(from);
    return c ? { p: c.p, d: Math.max(0, c.d) } : null;
  }

  aim(at: readonly number[]) {
    const c = this.closest(at);
    if (!c) return;
    // 頭の先（i = 0, f = 0）は鋏の付け根が届きにくいので、ほんの少し後ろ
    this.gS = c.i;
    this.gF = c.i === 0 ? Math.max(0.15, c.f) : c.f;
    if (this.isBuried(this.gS + 1) && this.gF > 0) this.gF = 0;
    if (this.isBuried(this.gS) && this.gF < 1) this.gF = 1;
    this.syncP();
  }

  gripPoint(): readonly number[] {
    const a = this.gS * 3, b = a + 3, f = this.gF, X = this.x;
    return [lerp(X[a], X[b], f), lerp(X[a + 1], X[b + 1], f), lerp(X[a + 2], X[b + 2], f)];
  }

  onGrab() {
    this.held = true;
    this.sleep = false;
    this.stats.grabs++;
    this.nextTug = 0.25 + this.rng() * 0.25;
    this.tugT = 0;
    this.goal = null;
    this.events.push({ kind: 'grab' });
  }

  onRelease(kind: 'release' | 'slip' | 'pop') {
    this.held = false;
    this.tugT = 0;
    this.gForce.fill(0);
    if (this.nb > 0) {
      this.hide(3 + this.rng() * 2.5);
      this.afterT = 2.0;
    }
    else {
      this.life = 'writhe';
      this.lifeT = kind === 'slip' ? 1.6 : 1.1;
    }
    this.events.push({ kind: 'release', why: kind });
  }

  stepHeld(dt: number, a0: readonly number[], a1: readonly number[]) {
    return this.simulate(dt, a0, a1);
  }

  /** 案内の位置：挟んでいる間はつかみ点、それ以外は外に出ている体の中ほど（頭の側） */
  private syncP() {
    if (this.held) {
      const g = this.gripPoint();
      this.p[0] = g[0];
      this.p[1] = g[1];
      this.p[2] = g[2];
      return;
    }
    const ne = this.N - this.nb;
    const i = this.bEnd ? Math.min(this.N - 1, Math.floor(Math.max(0, ne - 1) * 0.4)) : Math.min(this.N - 1, this.nb + Math.floor(ne * 0.5));
    this.p[0] = this.x[i * 3];
    this.p[1] = this.x[i * 3 + 1];
    this.p[2] = this.x[i * 3 + 2];
  }

  drainEvents(): WormEvent[] {
    return this.events.splice(0, this.events.length);
  }

  // ---------------- 保存 ----------------

  toSave(): BuddySave {
    const m = this.nb > 0 ? this.mouth : null;
    const yaw = Math.atan2(this.x[0] - this.x[3], this.x[2] - this.x[5]);
    // 位置 = 頭。砂の中なら口（読み込んだら同じ口の巣穴に戻す）
    const px = m ? m[0] : this.x[0], py = m ? m[1] : this.x[1], pz = m ? m[2] : this.x[2];
    return {
      id: this.id,
      species: WORM_SPECIES,
      found: this.found,
      mode: 'free',
      tank: 'home',
      x: px,
      y: py,
      z: pz,
      home: [this.home[0], this.home[2]],
      traits: { len: this.traits.len, thick: this.traits.thick, tone: this.traits.tone, seed: this.traits.seed, state: m ? 'buried' : 'free', yaw },
    };
  }

  /** 保存データから戻す（地形を戻した後に呼ぶ）。巣穴が作れない・置けない所なら住みかへ */
  restore(s: BuddySave) {
    this.found = s.found;
    this.name = s.found ? WORM_NAME : WORM_UNKNOWN;
    const yaw = typeof s.traits.yaw === 'number' ? s.traits.yaw : 0;
    const W = this.world;
    if (s.traits.state === 'buried') {
      const sy = this.sandSurface(s.x, s.y + 0.2, s.z);
      // 同じ口から石の隙間を作り直す（岩・流木の方へ）
      if (this.placeBuried([s.x, sy, s.z])) return;
    } else if (W.insideTank(s.x, s.z, 0.4) && s.y < TANK.waterY - 0.2 && W.contactSolid(s.x, s.y + 0.05, s.z) > -0.02) {
      this.layFree(s.x, s.y, s.z, yaw);
      return;
    }
    this.recover();
  }
}

/** 巣穴の場所の候補を避ける所（スナモグリの巣穴・発見物・スタート地点） */
export interface WormAvoid {
  x: number;
  z: number;
  r: number;
}

/** ゴカイの個体の id */
export const wormId = (i: number) => `gokai-${i}`;

/**
 * 水槽のゴカイたち：砂の広い所に巣穴を探して置き、毎フレーム進める（挟まれている個体は GrabSystem が進める）
 */
export class WormSystem {
  readonly worms: Worm[] = [];
  feel: WormFeel;
  /** 前のフレームの、掘った・盛った回数（近くで掘ったら警戒する） */
  private lastEdits = -1;

  constructor(private readonly world: AquariumWorld, opts: { count: number; avoid: WormAvoid[]; near: { x: number; z: number }; feel: WormFeel; seed?: number }) {
    this.feel = opts.feel;
    const rng = mulberry32(opts.seed ?? 9177);
    const cand = this.findSites(opts.avoid, opts.near);
    const placed: V3[] = [];
    for (let i = 0; i < opts.count; i++) {
      const tr: WormTraits = { len: 0.72 + rng() * 0.3, thick: 0.85 + rng() * 0.3, tone: rng(), seed: Math.floor(rng() * 1e6) };
      const w = new Worm(wormId(i), world, tr, wormSpec(this.feel), [opts.near.x, world.groundAt(opts.near.x, opts.near.z), opts.near.z], mulberry32(tr.seed + 17));
      // 最初の 1 匹はスタート地点の近く（2.2 以上離す）、残りは互いに 3.5 以上離して近い順。縁へ寄せた口から体が収まる隙間を作れる所
      let tries = 0;
      for (const c of cand) {
        if (tries > 40) break;
        if (placed.some((o) => Math.hypot(o[0] - c[0], o[2] - c[2]) < 3.5)) continue;
        const cr = w.creviceAt(c[0], c[2]);
        if (!cr || opts.avoid.some((a) => Math.hypot(a.x - cr.m[0], a.z - cr.m[2]) < a.r)) continue;
        tries++;
        if (!w.placeBuried(cr.m, cr.yaw)) continue;
        w.home.splice(0, 3, cr.m[0], cr.m[1], cr.m[2]);
        placed.push(cr.m);
        break;
      }
      if (w.home[0] === opts.near.x && w.home[2] === opts.near.z) w.layFree(opts.near.x + 2.5, w.home[1] + 0.2, opts.near.z, rng() * 6.28);
      this.worms.push(w);
    }
  }

  /**
   * 石の隙間の候補（2026-11-28 改）：水の中の砂で、岩・流木の面の近く（0.5 以内）にある格子の点を、スタート地点から近い順に
   * （2.2 より近い所は除く）。口の位置は各個体が縁へ寄せて決める（Worm.creviceAt）
   */
  private findSites(avoid: WormAvoid[], near: { x: number; z: number }): V3[] {
    const W = this.world;
    const cand: { p: V3; d: number }[] = [];
    for (let x = TANK.minX + 1; x < TANK.maxX - 1; x += 0.3) {
      for (let z = TANK.minZ + 1; z < TANK.maxZ - 1; z += 0.3) {
        const g = W.groundAt(x, z);
        if (g > TANK.waterY - 0.8 || g - TANK.floorY < 0.4) continue;
        const d = Math.hypot(x - near.x, z - near.z);
        if (d < 2.2 || W.pipeClear(x, z) < 0.6) continue;
        if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
        const h = W.hardSolid(x, g + 0.03, z);
        if (h < 0.03 || h > 0.5) continue;
        cand.push({ p: [x, g, z], d });
      }
    }
    cand.sort((a, b) => a.d - b.d);
    return cand.map((c) => c.p);
  }

  setFeel(f: WormFeel) {
    this.feel = f;
    for (const w of this.worms) w.spec = wormSpec(f);
  }

  /** 挟まれていない個体を進める */
  update(dt: number, s: Omit<WormSense, 'dug'>, edits: number) {
    const dug = this.lastEdits >= 0 && edits !== this.lastEdits;
    this.lastEdits = edits;
    const sense: WormSense = { ...s, dug };
    for (const w of this.worms) w.update(dt, sense);
  }

  drainEvents(): { worm: Worm; e: WormEvent }[] {
    const out: { worm: Worm; e: WormEvent }[] = [];
    for (const w of this.worms) for (const e of w.drainEvents()) out.push({ worm: w, e });
    return out;
  }

  get ids(): string[] {
    return this.worms.map((w) => w.id);
  }

  toSave(): BuddySave[] {
    return this.worms.map((w) => w.toSave());
  }

  /**
   * 保存データから戻す（地形を戻した後）。個体差（体長・太さ・体色・模様）は保存した値にする（作り直した個体は
   * 前の個体と別の物になるので、戻した個体の一覧を返す：GrabSystem.creatures を入れ替える）
   */
  restore(list: readonly BuddySave[]): { from: Worm; to: Worm }[] {
    const swapped: { from: Worm; to: Worm }[] = [];
    this.worms.forEach((w, k) => {
      const s = list.find((b) => b.id === w.id && b.species === WORM_SPECIES);
      if (!s) return;
      const t = s.traits;
      const num = (v: unknown, a: number, b: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : d);
      const tr: WormTraits = { len: num(t.len, 0.55, 1.2, w.traits.len), thick: num(t.thick, 0.7, 1.3, w.traits.thick), tone: num(t.tone, 0, 1, w.traits.tone), seed: Math.round(num(t.seed, 0, 1e7, w.traits.seed)) };
      let cur = w;
      if (tr.len !== w.traits.len || tr.thick !== w.traits.thick || tr.tone !== w.traits.tone || tr.seed !== w.traits.seed) {
        const hx = s.home[0], hz = s.home[1];
        const home: V3 = this.world.insideTank(hx, hz, 0.6) ? [hx, this.world.groundAt(hx, hz), hz] : w.home;
        cur = new Worm(w.id, this.world, tr, wormSpec(this.feel), home, mulberry32(tr.seed + 17));
        this.worms[k] = cur;
        swapped.push({ from: w, to: cur });
      }
      cur.restore(s);
    });
    return swapped;
  }
}
