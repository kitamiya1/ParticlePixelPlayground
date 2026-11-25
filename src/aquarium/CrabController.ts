// カニの移動・状態管理（ゲームロジック）。見た目（ボーン・メッシュ）は CrabRig / AquariumRenderer が担当する。
// 既存の CharacterController と同じ考え方（カメラ基準の入力 → 指数平滑の加速、向きの平滑化、移動距離に比例する歩行位相、
// 状態ラベル）を、カニの 3D の移動（重力・浮力・ジャンプ・遊泳・地形との球の当たり判定）に広げたもの。
//
// - 体は半径 RADIUS の球で近似し、AquariumWorld.solid（底床・岩・流木の距離関数）から押し戻す。
//   押し戻しの向きが上向き（法線の y > 0.55）なら接地。下りの坂・段差では地面へ吸着する。
// - 水中かどうかは球の中心と水面の高さで連続的に決め（submerged 0..1）、重力・抵抗・速さを補間する
//   （水面を横切るときに急に切り替わらない）。
// - 横歩き：移動方向に対して体の横（±90°）が向くよう、近い方へ回る。入力方向へはそのまま進むので操作は直感的。
// - 水槽の外（排水管・濾過槽・水槽台・部屋）：当たり判定は AquariumWorld.contactSolid、水面の高さは waterLevelAt
//   （濾過槽は部屋ごとに水位が違う）。水の流れ（flowAt）は速度を目標の流速へ寄せる。管の中（ride）は重力・ジャンプ・
//   遊泳を止め、水といっしょに運ばれる（排水管は真下へ、給水管はポンプの流れで水槽へ）。
// - 穴掘り（dig）：掘るボタンを押している間、体の正面（鋏の側）を掘る向きへ回し、一定の間隔で前方の砂をかき出す
//   （AquariumWorld.digProbe で当たった物を調べ、砂・土なら DigField.stroke で空洞を足す）。
//   掘る向き = 基準の向き + 照準（CrabInput.digAim。押したまま指・マウスをずらした量）。カメラではなくカニが基準：
//   - 基準の向き：押したときの体の向き。押している間は変えない（移動・カメラの向きでは回らない）。
//   - 左右：照準の x で基準から最大 ±90°（押したときにカメラがカニの正面側にいたら、画面の左右と合うよう反転。
//     押している間は反転を変えない＝カメラが動いても掘る向きは変わらない）。
//   - 上下：照準の y が 0 なら自動（地表では斜め下、十分深くなったら水平。ジャンプで上・走るで下も従来どおり）。
//     y を上げる・下げるほど、DIG_PITCH_UP / DIG_PITCH_DOWN へ連続的に向く（ずらしている間は自動の切り替えを止める）。
//   移動と掘る向きは別々に決まる：左のスティック（移動入力）はふだんと同じカメラ基準の向きへ、掘っている間はゆっくり
//   （DIG_MOVE_SPEED）進める。掘る向きへは引き寄せない（上を掘りながら前へ・右を掘りながら左へ・止まったまま
//   掘る向きだけ変える、ができる）。体は横歩きせず、正面（鋏の側）を掘る向きへ回す。
//   掘る向きへ進めば掘れた分だけ前へ入っていける。照準を左右へずらしていくと、曲がったトンネルになる。
//   上へ掘っている間は、スティックの水平の向きが掘る方位に近ければ、掘っている穴に沿って掘る向きの傾きで上へも進む
//   （照準をいっぱいに上げた 60° でも掘り線に遅れず、地表まで掘り抜いて出られる。元の地表より上では弱める）。
//   掘った穴の中は、急な床（継ぎ目の段・地表へ抜けた出口の縁）でもよじ登れる（DUG_FLOOR_NY・よじ登り）。
//   照準の先に何も無い（届かない）ときはかき出さずに空振りする（digWhiff。見た目は CrabRig が鋏を宙で振る）。
// - 壁登り（climbing）：砂・土・岩・流木の急な面（床とみなせない面）へ移動入力を CLIMB_GRAB_T 押し続けると張り付く。
//   登れるかどうかは、登れる物だけの距離関数 AquariumWorld.climbSolid で決める（contactSolid は全部の物の min なので
//   材質が分からない。ガラス・アクリル・管・設備は climbSolid に入っていないので、押し付けても張り付かない）。
//   張り付いている間は重力・浮力・水流を止め、入力を面に沿う向きへ写す（壁へ向かう = 上、離れる = 下、沿う = 横。
//   climbMove）。スティックを離すとその場で止まる。動いたら面から体の半径の所へ吸着し、ほかの物は contactSolid で押し戻す。
//   緩い面（CLIMB_EXIT_NY）へ来たら歩きへ戻り、面を失ったら落ち、ジャンプで面から跳んで離れる。掘るボタンで離す。
//   張り出しすぎた所へは進まず、押し続けたら縁を回り込む道（findMantle）をたどる（掘った穴の継ぎ目の棚・出口の縁）。
//   歩いていて急な面の下のくぼみで進めないときも同じ道を探す。体の傾きは climbN（groundN へ写す）。

import { clamp, lerp, smoothstep } from '../core/math';
import { TANK, type AquariumWorld } from './AquariumWorld';
import { ROOM, type Flow, type Region } from './AquariumStand';
import { DIG, diggable, type DigMaterial } from './AquariumDig';

export type CrabState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'swim' | 'sink' | 'ride' | 'dig' | 'climb' | 'pull';

export const CRAB_STATE_LABEL: Record<CrabState, string> = {
  idle: '待機', walk: '歩行', run: '走行', jump: 'ジャンプ', fall: '落下', swim: '遊泳', sink: '沈降', ride: '水流に乗る', dig: '穴掘り', climb: '壁登り', pull: '引っこ抜き',
};

/** 見た目側（泡・水しぶき・波紋）に知らせる出来事 */
export type CrabEvent = {
  kind: 'jump' | 'land' | 'enterWater' | 'exitWater' | 'swimStart' | 'stroke' | 'dig' | 'digBlocked';
  x: number; y: number; z: number; power: number;
  /** 穴掘り：かき出した向き（体から掘った所へ）と、当たった物 */
  dir?: [number, number, number];
  material?: DigMaterial;
};

/** 掘る向きの照準（見た目の照準・表示用。掘るボタンを押していないときは active = false） */
export interface DigAim {
  active: boolean;
  /** 当たった所（届かなければ届く距離の先） */
  p: [number, number, number];
  dir: [number, number, number];
  material: DigMaterial;
  /** 届く距離の中で当たった（かき出せる） */
  hit: boolean;
  /** 届く距離の少し先までに何かある（掘り進めた穴の突き当たり。無ければ空振り） */
  face: boolean;
}

export interface CrabInput {
  move: { x: number; y: number };
  run: boolean;
  jumpHeld: boolean;
  cameraYaw: number;
  /** 掘るボタン（F キー / 画面の「掘る」）を押しているか */
  dig?: boolean;
  /** 掘る向きの照準（x = 右, y = 上、長さ 0〜1。0 = 正面。Input.digAim） */
  digAim?: { x: number; y: number };
  /**
   * 穴の生き物を引っ張っている（AquaBuddy が決める。x, z = 穴、t = 進み具合 0..1）。この間は移動・ジャンプ・穴掘りの入力を
   * 使わず、穴へ向いて、穴から PULL_STAND（+ 進み具合で少し後ろへ）の所に踏ん張る
   */
  pull?: { x: number; z: number; t: number } | null;
}

/** 引っ張るときに立つ距離（穴の中心から体の中心まで。AquaBuddy.PULL_STAND と同じ） */
const PULL_STAND = 0.6;

const RADIUS = 0.24;
/** 照準を上・下いっぱいにしたときの掘る向きの仰角（上は登れる坂の限界 57° より少し急、下は −57°）と、左右の最大 */
export const DIG_PITCH_UP = 1.05;
export const DIG_PITCH_DOWN = -1.0;
export const DIG_YAW_MAX = Math.PI / 2;
/** 照準を探る距離の、届く距離より先の分（掘り進めた穴の突き当たりを見つける） */
const FACE_AHEAD = 0.8;
/** 掘った穴の中で床とみなす面の法線の y の下限（約 66°。穴の外は 0.55 = 約 57°） */
const DUG_FLOOR_NY = 0.4;
/** 掘っている間の移動の速さの上限 */
const DIG_MOVE_SPEED = 1.1;
/**
 * 壁登り：張り付いたまま床へ戻る面の法線の y（約 42° より緩い面）・それより張り出した面は登れない法線の y（約 143°。
 * 岩の根元は楕円体の下側がふくらんで、くびれのように 130° ほど張り出しているので、回り込んで登れるようにする）・
 * 壁へ向かって押し続けてから張り付くまでの時間・押す向き（壁の向きとの内積）の下限・登る速さ（歩く / 走る）。
 * 張り付き始めるのは、床とみなせない面（法線の y が floorNY 以下）だけ
 */
const CLIMB_EXIT_NY = 0.74;
const CLIMB_MIN_NY = -0.8;
/**
 * 張り付き始めてよい面の張り出しの限度（法線の y。約 127°。動いている間は CLIMB_MIN_NY まで回り込める）。
 * 掘った穴の中は、ほぼ垂直（約 99°）まで：トンネルの天井・掘り口の内側の丸い突き当たりは、張り付いても上が
 * 天井（さらに張り出す）なので登れない。継ぎ目の段・坂の床は、張り付かずに歩く・よじ登る
 */
const GRAB_MIN_NY = -0.6;
const GRAB_MIN_NY_DUG = -0.15;
/** 張り出しで進めないまま押し続けたら離れる時間と、離れたあと張り付かない時間 */
const CLIMB_STUCK_T = 0.3;
const GRAB_COOLDOWN = 0.6;
const CLIMB_GRAB_T = 0.1;
const CLIMB_INTO = 0.35;
const CLIMB_SPEED = 1.6;
const CLIMB_RUN = 2.5;

export class CrabController {
  /** 足元の位置（球の中心は y + RADIUS） */
  x: number;
  y: number;
  z: number;
  vx = 0;
  vy = 0;
  vz = 0;
  heading = 0;
  /** 水平の速さ */
  speed = 0;
  state: CrabState = 'idle';
  grounded = true;
  /** 接地面の法線（体の傾きに使う） */
  readonly groundN: [number, number, number] = [0, 1, 0];
  /** 0 = 空中, 1 = 完全に水中（球の中心と水面の高さで連続的に変わる） */
  submerged = 0;
  /** 歩行サイクルの位相（移動距離に比例） */
  stridePhase = 0;
  /** 遊泳サイクルの位相 */
  swimPhase = 0;
  /** 体の向き基準の速度（+x = 左, +z = 前。脚の動きに使う） */
  localVX = 0;
  localVZ = 0;
  /** 遊泳の残り（0..1。地上で回復） */
  swimStamina = 1;
  /** 直前の着地の強さ（0..1。見た目の沈み込み用、時間で減衰） */
  landImpact = 0;
  /** 空中・水中にいる時間 */
  airTime = 0;
  readonly radius = RADIUS;
  readonly walkSpeed = 2.3;
  readonly runSpeed = 4.4;
  readonly swimDuration = 2.6;
  readonly events: CrabEvent[] = [];
  /** 穴掘り：照準・かき出しの位相（1 回で π 進む。左右の鋏が交互にかく）・掘る向きの仰角・かき出した回数 */
  readonly digAim: DigAim = { active: false, p: [0, 0, 0], dir: [0, 0, 1], material: 'none', hit: false, face: false };
  digPhase = 0;
  digPitch = 0;
  digStrokes = 0;
  /** 掘る向きの方位（照準を足したもの）・基準の方位・左右の反転（押したときに決める） */
  digYaw = 0;
  private digBaseYaw = 0;
  private digSign = 1;
  /** 空振りの度合い（0..1。照準の先に何も無いとき 1 へ。見た目の鋏の振り方に使う） */
  digWhiff = 0;
  /** 空振りした回数・掘った穴の急な面をよじ登った回数（自動検証用） */
  digWhiffs = 0;
  climbs = 0;
  /** 壁登り：壁に張り付いているか・張り付いている面の法線（平滑化。体の傾き・登る向きの基準） */
  climbing = false;
  readonly climbN: [number, number, number] = [0, 1, 0];
  /** 壁へ向かって押し続けている時間（CLIMB_GRAB_T で張り付く）・張り付かない残り時間・張り出しで進めない時間 */
  private grabT = 0;
  private grabWait = 0;
  private stuckT = 0;
  /** 張り出しの下から跳んで離れた直後の、移動入力で水平の速さを変えない残り時間（縁の下へ引き戻されない） */
  private hopT = 0;
  /** 歩いていて、押している向きへ進めない時間（縁の下のくぼみから回り込む） */
  private pushT = 0;
  /** 張り出しの縁を回り込んでいる途中（折れ線の道・進んだ距離・全長・回り込んだ先の面の法線） */
  private mantle: { pts: [number, number, number][]; s: number; len: number; n: [number, number, number] } | null = null;
  /** 壁登りの回数（張り付いた・床へ戻った・跳んで離れた・面を失って落ちた・掘る等で離した・張り出しで止まった・縁を回り込んだ。自動検証用） */
  readonly climbStats = { grabs: 0, exits: 0, jumps: 0, lost: 0, drops: 0, blocked: 0, mantles: 0 };
  /** 経過時間（かき出しの続きの判定に使う） */
  private clock = 0;
  private digT = 0;
  /** 十分深くまで掘った（水平に掘る）。地表近くへ戻ったら解除 */
  private digDeep = false;
  readonly digInterval = 0.17;

  private jumpPrev = false;
  /** ジャンプ（または遊泳の開始）からボタンを押し続けている時間 */
  private holdT = -1;
  private coyote = 0;
  private swimming = false;
  private sinking = false;
  private wasUnder = false;
  private strokeT = 0;
  private readonly flow: Flow = { vx: 0, vy: 0, vz: 0, k: 0, ride: false };
  /** いまいる区画（水槽・排水管・給水管・濾過槽・水槽台・部屋） */
  region: Region = 'tank';
  /** いまいる水の水面の高さ（水の外は −1000） */
  waterLevel: number = TANK.waterY;

  constructor(private readonly world: AquariumWorld) {
    this.x = world.spawn.x;
    this.z = world.spawn.z;
    this.y = world.groundAt(this.x, this.z);
    this.heading = Math.PI / 2;
    this.wasUnder = this.y + RADIUS < TANK.waterY;
    this.submerged = this.wasUnder ? 1 : 0;
  }

  /** 位置を直接置く（デバッグ・自動検証用） */
  teleport(x: number, z: number, y?: number) {
    this.x = x;
    this.z = z;
    this.y = y ?? this.world.contactSurfaceBelow(x, TANK.topY, z) + 0.02;
    this.vx = this.vy = this.vz = 0;
    this.swimming = this.sinking = false;
    this.grounded = false;
    this.climbing = false;
    this.grabT = this.grabWait = this.stuckT = this.hopT = this.pushT = 0;
    this.mantle = null;
  }

  /** 穴の生き物を引っ張っているか・引っ張りの進み具合（見た目 CrabRig の踏ん張り・鋏に使う） */
  pulling = false;
  pullT = 0;
  private pullAt: [number, number] = [0, 0];

  update(dt: number, inp: CrabInput) {
    // 引っ張っている間：移動・ジャンプ・穴掘りの入力は使わない（体の位置と向きは step で穴に合わせる）
    this.pulling = !!inp.pull;
    if (inp.pull) {
      this.pullT = inp.pull.t;
      this.pullAt = [inp.pull.x, inp.pull.z];
      inp = { ...inp, move: { x: 0, y: 0 }, run: false, jumpHeld: false, dig: false };
    } else this.pullT = 0;
    // 大きな時間差は分割して当たり判定のすり抜けを防ぐ
    const steps = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / steps;
    this.clock += dt;
    for (let i = 0; i < steps; i++) this.step(h, inp, i === 0);
    // 穴掘り（1 フレームに 1 回。照準を探ってから、間隔ごとにかき出す）
    if (this.digging) this.updateDig(dt, inp);
    else {
      this.digAim.active = false;
      this.digT = 0;
      if (this.digPitch !== 0) this.digPitch *= Math.exp(-dt * 6);
      this.digWhiff *= Math.exp(-dt * 8);
    }
  }

  /** 掘るボタンを押していて、掘れる状態か（step が決める） */
  private digging = false;

  private updateDig(dt: number, inp: CrabInput) {
    const w = this.world;
    // 上下の向き：地表では斜め下、足元が十分深くなったら（または水槽の底の近く）水平。ジャンプで上へ、走るで急に下へ。
    // 照準を上下へずらしている間は、ずらした量で連続的に上・下へ向ける（自動の切り替えは止める：
    // 地表へ近づいて「斜め下」に戻り、上へ掘っている向きが急に変わることがないように）
    const aimY = inp.digAim?.y ?? 0;
    const swiping = Math.abs(aimY) > 0.02;
    const depth = w.groundAt(this.x, this.z) - this.y;
    const nearBottom = this.y < DIG.floorClip + 0.12;
    if (!swiping) {
      if (depth > DIG.tunnelDepth - 0.05 || nearBottom) this.digDeep = true;
      else if (depth < 0.25) this.digDeep = false;
    }
    const base = this.digDeep ? 0 : -0.48;
    let pitch = base;
    if (swiping) pitch = aimY > 0 ? base + (DIG_PITCH_UP - base) * aimY : base + ((nearBottom ? 0 : DIG_PITCH_DOWN) - base) * -aimY;
    else if (inp.jumpHeld) pitch = 0.75;
    else if (inp.run && !nearBottom) pitch = -0.85;
    this.digPitch += (pitch - this.digPitch) * (1 - Math.exp(-dt * 10));
    const cp = Math.cos(this.digPitch);
    const dir: [number, number, number] = [cp * Math.sin(this.digYaw), Math.sin(this.digPitch), cp * Math.cos(this.digYaw)];
    const o: [number, number, number] = [this.x, this.y + RADIUS, this.z];
    // 上へ掘るときは天井・掘り口までが遠くなるので、届く距離を延ばす
    const reach = DIG.reach + 0.45 * Math.max(0, this.digPitch);
    // 届く距離の少し先（FACE_AHEAD）まで探る：届く距離の中で当たればかき出す。その先で当たった（掘り進めた穴の突き当たりが
    // 少し先にある）なら、かき出さずに照準だけ出す（掘りながら進むと交互に起こるので、空振りの動きにはしない）
    let pr = w.digProbe(o[0], o[1], o[2], dir, reach + FACE_AHEAD);
    // 上へ掘っていて体の中心からは何も無い（地表へ抜けた）とき：足もとの少し上から水平にも探る。斜め上の穴が地表へ
    // 抜けた所には、穴の床と地表の間に足もとの段（登れない急な縁）が残るので、それを掘り取って出口を平らにする
    if (pr.t === null && this.digPitch > 0.15 && w.groundAt(this.x, this.z) - this.y > 0.06) {
      const flat: [number, number, number] = [Math.sin(this.digYaw), 0, Math.cos(this.digYaw)];
      const low = w.digProbe(o[0], o[1] - 0.12, o[2], flat, DIG.reach * 0.6);
      if (low.t !== null) {
        pr = low;
        dir.splice(0, 3, ...flat);
      }
    }
    const inReach = pr.t !== null && pr.t <= reach;
    const A = this.digAim;
    A.active = true;
    A.p = pr.t !== null ? pr.p : [o[0] + dir[0] * reach, o[1] + dir[1] * reach, o[2] + dir[2] * reach];
    A.dir = dir;
    A.material = pr.material;
    A.hit = inReach;
    A.face = pr.t !== null;
    const material: DigMaterial = inReach ? pr.material : 'none';
    // 空振り：照準の先に何も無い（水・空気・掘った穴の中）
    this.digWhiff += ((A.face ? 0 : 1) - this.digWhiff) * (1 - Math.exp(-dt * 8));
    // かき出し：左右の鋏で交互に（位相は 1 回で π）
    this.digPhase += (dt * Math.PI) / this.digInterval;
    this.digT -= dt;
    if (this.digT > 0) return;
    this.digT = Math.max(this.digT + this.digInterval, 0.02);
    this.digStrokes++;
    if (!A.face) this.digWhiffs++;
    if (material === 'none' || diggable(material)) {
      // 斜め下へ掘るときは、元の地表から tunnelDepth より深くは掘らない（走る＝急に下へ・照準を下へずらした、のときだけ深く掘れる）
      // （十分深くなって水平に掘っている間は制限しない。岸の斜面の下では地表が上がっても床を水平に保つ）
      const down = inp.run || aimY < -0.3;
      const floorMin = down || this.digDeep ? -Infinity : w.groundAt(pr.p[0], pr.p[2]) - DIG.tunnelDepth - 0.04;
      // 届かないときも、直前に掘った空洞を太らせる（その場で掘り続けると穴が広がる）。そのときの砂粒は
      // 太らせた空洞の先（res.at）から少しだけ（空振りの鋏の先からは出さない）
      const res = w.dig.stroke(o, dir, diggable(material) ? pr.t : null, this.clock, floorMin, reach);
      if (res.changed) {
        const at = diggable(material) ? pr.p : res.at;
        this.events.push({ kind: 'dig', x: at[0], y: at[1], z: at[2], power: (res.r / DIG.rMax) * (A.hit ? 1 : 0.3), dir, material: material === 'none' ? (A.face && diggable(pr.material) ? pr.material : 'sand') : material });
      }
    } else {
      w.dig.stats.blocked++;
      this.events.push({ kind: 'digBlocked', x: pr.p[0], y: pr.p[1], z: pr.p[2], power: 0.5, dir, material });
    }
  }

  private step(dt: number, inp: CrabInput, first: boolean) {
    const w = this.world;
    const cy = this.y + RADIUS;
    // 0 = 空中, 1 = 水中（中心が水面より 0.25 下で完全に水中）。水面の高さは場所ごと（水槽・濾過槽の各部屋）
    const level = w.waterLevelAt(this.x, cy, this.z);
    this.waterLevel = level;
    const s = smoothstep(level + 0.12, level - 0.25, cy);
    this.submerged = s;
    const inWater = s > 0.5;
    // 水の流れ（管の中は ride：水といっしょに運ばれる）
    const fl = w.flowAt(this.x, cy, this.z, this.flow);
    const ride = fl.ride;
    if (ride) {
      this.swimming = false;
      this.sinking = false;
    }

    // カメラ基準の移動方向（CharacterController と同じ式）
    const yaw = inp.cameraYaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const dx = rx * inp.move.x + fx * inp.move.y;
    const dz = rz * inp.move.x + fz * inp.move.y;
    const mag = Math.min(1, Math.hypot(dx, dz));
    const hasInput = mag > 0.05;

    // 穴掘り：地面（または掘った穴の床・壁）に触れているときだけ。掘った穴へ少し沈み込む間も掘り続ける。水槽の中だけ掘れる
    const touching = this.grounded || this.coyote > 0 || (s > 0.5 && w.contactSolid(this.x, cy, this.z) < RADIUS + 0.2);
    const digging = !!inp.dig && !ride && !this.swimming && touching && this.region === 'tank';

    if (first) {
      // 掘り始め：基準の向き = いまの体の向き。カメラがカニの正面側（顔を見ている）なら、照準の左右を画面に合わせて反転する
      if (digging && !this.digging) {
        this.digBaseYaw = this.digYaw = this.heading;
        this.digSign = Math.cos(inp.cameraYaw - this.heading) > 0.2 ? -1 : 1;
      }
      this.digging = digging;
    }
    // ジャンプ・遊泳の入力（掘っている間のジャンプは「上へ掘る」に使うので跳ばない）
    const pressed = first && inp.jumpHeld && !this.jumpPrev && !inp.dig;
    if (first) this.jumpPrev = inp.jumpHeld;
    if (!inp.jumpHeld) this.holdT = -1;
    else if (this.holdT >= 0) this.holdT += dt;

    // 壁登りをやめる：管に入った・掘り始めた（掘るのは地面に立って。壁からは落ちる）・水槽の外へ出た
    if (this.climbing && (ride || digging || this.region !== 'tank')) this.releaseClimb('drops');
    // 壁から跳ぶ：面の外向きと上へ押し出す（水中で押し続ければ、そのまま遊泳へ移れる）
    let wallJump = false;
    if (this.climbing && pressed) {
      const n = this.climbN;
      const up = lerp(4.6, 3.8, s);
      this.vx = n[0] * 3.2;
      this.vy = n[1] * 3.2 + up;
      this.vz = n[2] * 3.2;
      this.releaseClimb('jumps');
      this.coyote = 0;
      this.holdT = 0;
      wallJump = true;
      this.events.push({ kind: 'jump', x: this.x, y: this.y, z: this.z, power: s });
    }

    if (ride || wallJump) {
      // 管の中ではジャンプ・遊泳を受け付けない（壁から跳んだときは上で済ませた）
    } else if (pressed && (this.grounded || this.coyote > 0) && !this.swimming) {
      // 水中では浮力で、陸上よりゆっくり高く跳ぶ（初速は小さいが重力も小さい）
      this.vy = lerp(7.0, 5.3, s);
      this.grounded = false;
      this.coyote = 0;
      this.holdT = 0;
      this.sinking = false;
      this.events.push({ kind: 'jump', x: this.x, y: this.y, z: this.z, power: s });
    } else if (pressed && inWater && !this.grounded && !this.swimming && this.swimStamina > 0.15) {
      // 水中で空中にいるときに押し直すと、残りがあれば遊泳を再開
      this.holdT = 0.3;
    }
    // 水中でジャンプを長押し → 短い遊泳
    if (!ride && !this.swimming && inWater && inp.jumpHeld && this.holdT > 0.22 && this.swimStamina > 0.15 && !this.grounded) {
      this.swimming = true;
      this.sinking = false;
      this.events.push({ kind: 'swimStart', x: this.x, y: this.y, z: this.z, power: 1 });
    }
    if (this.swimming) {
      this.swimStamina -= dt / this.swimDuration;
      if (!inp.jumpHeld || this.swimStamina <= 0 || s < 0.3) {
        this.swimming = false;
        this.sinking = s > 0.3;
        this.swimStamina = Math.max(0, this.swimStamina);
      }
    }

    // 移動と当たり判定（壁に張り付いている間は climbMove。重力・浮力・水流は効かない）
    const wasGrounded = this.grounded;
    let px: number, py: number, pz: number;
    if (this.climbing) [px, py, pz] = this.climbMove(dt, inp, dx, dz, hasInput, s, cy);
    else {
      // 水平方向の速さと加速
      let maxSpeed = (inp.run ? this.runSpeed : this.walkSpeed) * lerp(1, 0.72, s);
      let accel = this.grounded ? 14 : lerp(3.0, 4.0, s);
      if (this.swimming) {
        maxSpeed = inp.run ? 4.2 : 3.3;
        accel = 5.5;
      }
      if (ride) {
        maxSpeed = 0.8;
        accel = 2;
      }
      // 掘っている間：移動入力の向き（カメラ基準、ふだんと同じ）へゆっくり進む。掘る向きとは別（照準で決める）
      const mx = dx;
      const mz = dz;
      if (digging) {
        maxSpeed = DIG_MOVE_SPEED;
        accel = 10;
      }
      let tvx = mx * maxSpeed, tvz = mz * maxSpeed;
      // 引っ張っている間：穴から PULL_STAND（抜けてくるほど少し後ろへ下がる）の所へ寄る
      if (this.pulling) {
        const ox = this.x - this.pullAt[0], oz = this.z - this.pullAt[1];
        const od = Math.hypot(ox, oz) || 1;
        const err = PULL_STAND + 0.14 * this.pullT - od;
        tvx = (ox / od) * clamp(err * 5, -1.2, 1.2);
        tvz = (oz / od) * clamp(err * 5, -1.2, 1.2);
      }
      // 入力が無いとき：地上ではすぐ止まり、水中・空中ではゆっくり減速する
      const k = 1 - Math.exp(-(hasInput || this.pulling ? accel : this.grounded ? 12 : lerp(0.6, 2.2, s)) * dt);
      if (this.hopT > 0 && !this.grounded) this.hopT -= dt;
      else {
        this.hopT = 0;
        this.vx += (tvx - this.vx) * k;
        this.vz += (tvz - this.vz) * k;
      }

      // 縦方向：重力・浮力・水の抵抗・遊泳の推力
      if (this.swimming) {
        // 押している間はゆっくり浮き上がる。水面の直下では浮上を止める（水面から飛び出さない）
        const top = level - RADIUS - 0.12;
        const targetVy = cy > top ? -0.4 : 1.7;
        this.vy += (targetVy - this.vy) * (1 - Math.exp(-4 * dt));
        this.swimPhase += dt * 11;
        this.strokeT -= dt;
        if (this.strokeT <= 0) {
          this.strokeT = 0.42;
          this.events.push({ kind: 'stroke', x: this.x, y: this.y, z: this.z, power: 0.5 });
        }
      } else if (ride) {
        // 管の中：重力の代わりに下の流れが縦の速さを決める
      } else {
        const g = lerp(-24, -5.2, s);
        if (!this.grounded) this.vy += g * dt;
        // 水の抵抗（上りは弱く、沈むときは強い = ふわっと高く上がり、ゆっくり沈む）
        this.vy *= Math.exp(-dt * s * (this.sinking ? 2.6 : this.vy > 0 ? 0.45 : 1.5));
        if (s > 0.5) this.vy = Math.max(this.vy, this.sinking ? -1.5 : -3.2);
        this.swimPhase += dt * (this.sinking ? 3 : 0);
      }

      // 水の流れへ寄せる（縦は流れに縦の成分がある所だけ。渦の外側で沈むのを止めない）
      if (fl.k > 0) {
        const kf = 1 - Math.exp(-fl.k * dt);
        this.vx += (fl.vx - this.vx) * kf;
        this.vz += (fl.vz - this.vz) * kf;
        if (ride || Math.abs(fl.vy) > 0.05) this.vy += (fl.vy - this.vy) * kf;
      }

      // 上へ掘っている穴を登る：掘っている間、スティックの水平の向きが掘る方位に近ければ（移動の向きは変えない）、
      // 掘る向きの先に体が入る隙間がある間は、掘る向きの傾きに合わせて上へも進む（歩いて坂に押し上げられるだけでは
      // 掘る向き（最大 60°）より緩い角度でしか登れず、掘り線から遅れて段に当たり、掘る面も届く距離の外へ離れて止まっていた）
      if (digging && this.digPitch > 0.2 && hasInput && !this.swimming && !ride && w.dig.count > 0 && w.dig.carve(this.x, cy, this.z) < 0.1) {
        const along = (dx * Math.sin(this.digYaw) + dz * Math.cos(this.digYaw));
        if (along > 0.3) {
          const cp = Math.cos(this.digPitch), sp = Math.sin(this.digPitch);
          const ux = cp * Math.sin(this.digYaw), uz = cp * Math.cos(this.digYaw);
          // 体の中心が元の地表より上へ出るにつれて弱め（地表の 0.3 上で 0）、登っている間は上向きの速さを坂に沿う速さに合わせる
          // （地表で上へ掘ると、掘った浅い穴を登り切った勢いのまま水中へ飛び出していた）
          const under = smoothstep(-0.3, 0.1, w.groundAt(this.x, this.z) - cy);
          if (under > 0 && w.contactSolid(this.x + ux * 0.2, cy + sp * 0.2, this.z + uz * 0.2) > RADIUS * 0.9) {
            this.vy = Math.min(1.8, along * maxSpeed * Math.tan(Math.min(this.digPitch, 1.15))) * under;
            this.coyote = Math.max(this.coyote, 0.12);
          }
        }
      }

      px = this.x;
      py = cy;
      pz = this.z;
      px += this.vx * dt;
      py += this.vy * dt;
      pz += this.vz * dt;
      this.grounded = false;
      // 床とみなす面の向き（法線の y の下限）。掘った穴の中は砂に爪を掛けて急な坂（約 66° まで）も登れる
      // （斜め上へ掘った穴の床はかき出しの継ぎ目で段々になり、平均の傾きより急な所ができるので）。それ以外は約 57° まで
      const floorNY = this.region === 'tank' && w.dig.count > 0 && w.dig.carve(px, py, pz) < 0.3 ? DUG_FLOOR_NY : 0.55;
      for (let it = 0; it < 4; it++) {
        const d = w.contactSolid(px, py, pz);
        if (d >= RADIUS) break;
        const n = w.contactNormal(px, py, pz);
        const push = RADIUS - d;
        px += n[0] * push;
        py += n[1] * push;
        pz += n[2] * push;
        const vn = this.vx * n[0] + this.vy * n[1] + this.vz * n[2];
        if (vn < 0) {
          this.vx -= n[0] * vn;
          this.vy -= n[1] * vn;
          this.vz -= n[2] * vn;
        }
        if (n[1] > floorNY) {
          this.grounded = true;
          this.groundN[0] = n[0];
          this.groundN[1] = n[1];
          this.groundN[2] = n[2];
        }
      }
      // 下り坂・段差：直前まで接地していて上へ跳んでいなければ、少し下の地面へ吸着する
      if (!this.grounded && wasGrounded && this.vy <= 0.5 && !this.swimming && !ride) {
        let t = 0;
        for (let i = 0; i < 6; i++) {
          const dd = w.contactSolid(px, py - t, pz) - RADIUS;
          if (dd < 0.004) break;
          t += dd;
          if (t > 0.32) break;
        }
        // 吸着するのは床（上向きの面）だけ。壁（透明な管・アクリル・岩の側面）に触れているだけなら接地にしない
        // （壁に沿って歩くと、宙に浮いたまま接地扱いになって壁を伝い登るのを防ぐ）
        const nf = t <= 0.32 ? w.contactNormal(px, py - t, pz) : null;
        if (nf && nf[1] > floorNY) {
          py -= t;
          this.grounded = true;
          const n = w.contactNormal(px, py - RADIUS * 0.5, pz);
          if (n[1] > floorNY) this.groundN.splice(0, 3, ...n);
        }
      }
      // 掘った穴の中でよじ登る：床とみなせない急な所に触れていて、進もうとしている向きの斜め上に体が入る隙間があれば、
      // 少し上へ押し上げる（斜め上へ掘った穴の床の継ぎ目・地表へ抜けた出口の縁は、かき出しの継ぎ目で距離関数の向きが
      // 乱れやすく、平均の傾きは登れるのに引っかかって止まるので、面の向きではなく隙間で決める）。
      // 接地していても、進もうとしている向きへほとんど進めていない（坂の上で出口の縁の段に押し返されている）ときは同じ：
      // 斜め上へ掘って地表へ抜けた穴の縁には、残す砂の膜の厚さ（AquariumDig の FILM）ほどの段が残る
      const ux0 = hasInput ? mx / mag : 0, uz0 = hasInput ? mz / mag : 0;
      const stuck = this.grounded && hasInput && (px - this.x) * ux0 + (pz - this.z) * uz0 < 0.3 * maxSpeed * mag * dt;
      if ((!this.grounded || stuck) && hasInput && floorNY === DUG_FLOOR_NY && !this.swimming && !ride && this.vy < 1.2) {
        if (w.contactSolid(px, py, pz) < RADIUS + 0.03) {
          const ux = mx / mag, uz = mz / mag;
          const room = w.contactSolid(px + ux * 0.12, py + 0.18, pz + uz * 0.12);
          const ahead = w.contactSolid(px + ux * 0.12, py, pz + uz * 0.12);
          if (room > RADIUS * 0.9 && ahead < RADIUS) {
            // 接地にはしない（着地の出来事・歩行の位相を起こさない）。掘り続けられるよう、接地の猶予だけ延ばす
            this.vy = 1.2 * mag;
            this.coyote = 0.12;
            this.climbs++;
          }
        }
      }
      // 壁へ向かって押し続けたら張り付く（登れる面＝砂・土・岩・流木だけ。ガラス・管などは climbSolid に入っていない）
      this.tryGrab(dt, inp, px, py, pz, mx, mz, mag, hasInput, floorNY, ride);
      // 押しても進めない縁の下のくぼみ：回り込める道があれば回り込む
      if (!this.climbing && hasInput && mag > 0.5 && !ride && !this.swimming && !inp.dig && this.region === 'tank' && w.contactSolid(px, py, pz) < RADIUS + 0.03) {
        this.tryMantleFromWalk(dt, px, py, pz, ux0, uz0, (px - this.x) * ux0 + (pz - this.z) * uz0 > 0.15 * maxSpeed * mag * dt);
      } else this.pushT = hasInput ? Math.max(0, this.pushT - dt) : 0;
    }
    // 部屋の外へは出ない（ガラス・水槽台・濾過槽の壁は contactSolid の当たり判定で止まる）
    px = clamp(px, ROOM.minX + RADIUS, ROOM.maxX - RADIUS);
    pz = clamp(pz, ROOM.minZ + RADIUS, ROOM.maxZ - RADIUS);
    py = clamp(py, ROOM.floorY + RADIUS, ROOM.ceilY - RADIUS);
    this.region = w.regionAt(px, py, pz);

    // 実際に動いた量から水平の速さを再計算（壁に当たった時に足踏みしない）
    const mvx = (px - this.x) / Math.max(dt, 1e-4);
    const mvy = (py - cy) / Math.max(dt, 1e-4);
    const mvz = (pz - this.z) / Math.max(dt, 1e-4);
    this.x = px;
    this.z = pz;
    this.y = py - RADIUS;
    // 壁に張り付いている間は面に沿った速さ（上下の動きも含む）
    this.speed = this.climbing ? Math.hypot(mvx, mvy, mvz) : Math.hypot(mvx, mvz);

    if (this.grounded) {
      if (!wasGrounded) {
        const impact = clamp(-this.vy / 7, 0, 1);
        this.landImpact = Math.max(this.landImpact, impact);
        this.events.push({ kind: 'land', x: this.x, y: this.y, z: this.z, power: impact });
      }
      if (this.vy < 0) this.vy = 0;
      this.sinking = false;
      this.coyote = 0.1;
      this.airTime = 0;
      this.swimStamina = Math.min(1, this.swimStamina + dt * 0.9);
    } else if (this.climbing) {
      // 壁に張り付いている：体は面の向き（climbN）。跳べる・遊泳の残りも回復する
      this.sinking = false;
      this.coyote = 0.1;
      this.airTime = 0;
      this.swimStamina = Math.min(1, this.swimStamina + dt * 0.9);
      this.groundN[0] = this.climbN[0];
      this.groundN[1] = this.climbN[1];
      this.groundN[2] = this.climbN[2];
    } else {
      this.coyote -= dt;
      this.airTime += dt;
      // 空中・水中では体を起こしていく
      this.groundN[0] *= 1 - dt * 3;
      this.groundN[2] *= 1 - dt * 3;
      this.groundN[1] = Math.sqrt(Math.max(0, 1 - this.groundN[0] ** 2 - this.groundN[2] ** 2));
    }
    this.landImpact *= Math.exp(-dt * 6);

    // 水面を横切った出来事（水しぶき・泡・波紋）
    const under = py < level;
    if (under !== this.wasUnder) {
      // 管の出入り（水面の高さが ±1000）は水面を横切ったことにしない
      if (Math.abs(level) < 500) this.events.push({ kind: under ? 'enterWater' : 'exitWater', x: this.x, y: level, z: this.z, power: clamp(Math.abs(this.vy) / 5 + this.speed / 8, 0.2, 1) });
      this.wasUnder = under;
    }

    // 掘っている間：掘る向き = 基準（押したときの体の向き。移動・カメラでは変えない）+ 照準の左右。
    // 体の正面（鋏の側）を掘る向きへ回す（体の右 = 方位 −90°）
    if (digging) {
      this.digYaw = wrap(this.digBaseYaw - (inp.digAim?.x ?? 0) * DIG_YAW_MAX * this.digSign);
      this.heading = wrap(this.heading + wrap(this.digYaw - this.heading) * (1 - Math.exp(-10 * dt)));
    } else if (this.pulling) {
      // 引っ張っている：正面（鋏の側）を穴へ
      const h = Math.atan2(this.pullAt[0] - this.x, this.pullAt[1] - this.z);
      this.heading = wrap(this.heading + wrap(h - this.heading) * (1 - Math.exp(-12 * dt)));
    } else if (this.climbing) {
      // 壁：面に沿った速度を体の座標（面を床に起こした向き）へ戻し、その向きに対して横歩きになるよう回す
      const L = toSurfaceLocal(this.climbN, this.vx, this.vy, this.vz);
      if (hasInput && Math.hypot(L[0], L[2]) > 0.2) {
        const move = Math.atan2(L[0], L[2]);
        const a = wrap(move + Math.PI / 2 - this.heading), b = wrap(move - Math.PI / 2 - this.heading);
        const d = Math.abs(a) < Math.abs(b) ? a : b;
        this.heading = wrap(this.heading + d * (1 - Math.exp(-6 * dt)));
      }
    } else if (hasInput && Math.hypot(this.vx, this.vz) > 0.2) {
      // 横歩き：移動方向の ±90° のうち、いまの向きに近い方へ体を回す
      const move = Math.atan2(this.vx, this.vz);
      const a = wrap(move + Math.PI / 2 - this.heading), b = wrap(move - Math.PI / 2 - this.heading);
      const d = Math.abs(a) < Math.abs(b) ? a : b;
      this.heading = wrap(this.heading + d * (1 - Math.exp(-(this.grounded ? 7 : 3) * dt)));
    }
    // 体の向き基準の速度（+x = 左, +z = 前）
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    // 壁では、実際に動いた量を面の座標へ戻してから体の向き基準にする（脚が面に沿って進む向きへ振れる）
    const lm = this.climbing ? toSurfaceLocal(this.climbN, mvx, mvy, mvz) : null;
    const lvx = lm ? lm[0] : mvx, lvz = lm ? lm[2] : mvz;
    this.localVX = lvx * ch - lvz * sh;
    this.localVZ = lvx * sh + lvz * ch;

    // 歩行位相（脚 1 歩の振れ幅に合わせ、地面に対して足が滑らない速さ）
    if (this.grounded || this.climbing) this.stridePhase += (this.speed * dt) / (0.64 * (this.speed > 3.2 ? 0.1 : 0.075));

    // 状態
    if (ride) this.state = 'ride';
    else if (this.pulling) this.state = 'pull';
    else if (digging) this.state = 'dig';
    else if (this.climbing) this.state = 'climb';
    else if (this.swimming) this.state = 'swim';
    else if (this.grounded) this.state = this.speed < 0.25 ? 'idle' : this.speed < (this.walkSpeed + this.runSpeed) * 0.5 * lerp(1, 0.72, s) ? 'walk' : 'run';
    else if (this.sinking || (s > 0.5 && this.vy < 0)) this.state = 'sink';
    else this.state = this.vy > 0 ? 'jump' : 'fall';
  }

  // ---------------- 壁登り ----------------

  /**
   * 壁へ向かって押し続けたら張り付く（接地の判定・押し戻しのあと、張り付いていないときだけ呼ぶ）。
   * 条件：水槽の中・管の外・泳いでいない・掘っていない・跳び上がっている途中でない、移動入力がある、
   * 登れる面（climbSolid）に触れていて、その面が床とみなせない急な面（法線の y が floorNY 以下・張り出しは CLIMB_MIN_NY まで）、
   * 入力がその面へ向かっている（CLIMB_INTO 以上）。これが CLIMB_GRAB_T 続いたら張り付く（かすめただけでは張り付かない）。
   * 面の向きは、体の中心から入力の向きへ少し進めた所で測る（床と壁の隅では、中心の距離関数は床と壁のどちらとも言えないので、
   * 押している壁の側を選ぶ）
   */
  private tryGrab(dt: number, inp: CrabInput, px: number, py: number, pz: number, mx: number, mz: number, mag: number, hasInput: boolean, floorNY: number, ride: boolean) {
    const w = this.world;
    this.grabWait = Math.max(0, this.grabWait - dt);
    const ok = hasInput && mag > 0.3 && !ride && !this.swimming && !inp.dig && this.region === 'tank' && this.vy < 2.5 && this.grabWait <= 0;
    if (!ok || w.climbSolid(px, py, pz) > RADIUS + 0.05) {
      this.grabT = 0;
      return;
    }
    const ux = mx / mag, uz = mz / mag;
    const n = w.climbNormal(px + ux * 0.1, py, pz + uz * 0.1);
    const hl = Math.hypot(n[0], n[2]);
    const into = hl > 1e-3 ? -(ux * n[0] + uz * n[2]) / hl : 0;
    const minNY = floorNY === DUG_FLOOR_NY ? GRAB_MIN_NY_DUG : GRAB_MIN_NY;
    if (n[1] >= Math.min(floorNY, 0.55) || n[1] < minNY || into < CLIMB_INTO) {
      this.grabT = 0;
      return;
    }
    this.grabT += dt;
    if (this.grabT < CLIMB_GRAB_T) return;
    this.grabT = 0;
    this.stuckT = 0;
    this.climbing = true;
    this.grounded = false;
    this.climbN[0] = n[0];
    this.climbN[1] = n[1];
    this.climbN[2] = n[2];
    this.vx = this.vy = this.vz = 0;
    this.climbStats.grabs++;
  }

  private releaseClimb(why: 'exits' | 'jumps' | 'lost' | 'drops') {
    this.climbing = false;
    this.mantle = null;
    this.climbStats[why]++;
  }

  /** 張り出しの縁を回り込む道をたどり始める（壁に張り付いた状態で。climbMove の先頭が道を進める） */
  private startMantle(path: [number, number, number][]) {
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
    const e = path[path.length - 1];
    this.mantle = { pts: path, s: 0, len, n: this.world.climbNormal(e[0], e[1], e[2]) };
    this.stuckT = 0;
    this.climbStats.mantles++;
  }

  /**
   * 歩いていて、登れる急な面へ押し続けても進めない（張り出した縁の下のくぼみ・掘った穴の出口の縁）とき：
   * 縁を回り込む道（findMantle。押している向きの逆を「面から離れる向き」とする）があれば、張り付いて回り込む。
   * 道は押している向きへ 0.2 以上先へ進んだ所で終わるので、ガラス・管のように回り込めない物の前では見つからない
   */
  private tryMantleFromWalk(dt: number, px: number, py: number, pz: number, ux: number, uz: number, progress: boolean) {
    if (progress) {
      this.pushT = 0;
      return;
    }
    this.pushT += dt;
    if (this.pushT < 0.4) return;
    this.pushT = 0;
    const w = this.world;
    const ax = px + ux * 0.12, az = pz + uz * 0.12;
    if (w.climbSolid(ax, py, az) > RADIUS) return;
    const na = w.climbNormal(ax, py, az);
    if (na[1] >= 0.55) return;
    const path = this.findMantle(px, py, pz, [-ux, 0, -uz]);
    if (!path) return;
    this.climbing = true;
    this.grounded = false;
    this.climbN[0] = na[0];
    this.climbN[1] = na[1];
    this.climbN[2] = na[2];
    this.vx = this.vy = this.vz = 0;
    this.climbStats.grabs++;
    this.startMantle(path);
  }

  /**
   * 張り出しの縁を回り込む道を探す（壁に張り付いたまま、張り出し・継ぎ目の棚の下で進めなくなったとき）：
   * 面から離れる水平の向きへ a（0〜0.6）→ 真上へ b（0.15〜0.9）→ 壁の側へ a + 0.2（入れなければ + 0.12・+ 0.05）戻る、の折れ線で、途中がすべて
   * 体の入る隙間（contactSolid ≥ 半径）で、着いた所が登れる面のそば（張り出していない面）になる最初の道。
   * 見つからなければ null（離れて小さく跳ぶ）
   */
  private findMantle(cx: number, cy: number, cz: number, n: readonly number[]): [number, number, number][] | null {
    const w = this.world;
    const hl = Math.hypot(n[0], n[2]);
    if (hl < 0.2) return null;
    const ox = n[0] / hl, oz = n[2] / hl;
    const free = (p: readonly number[], q: readonly number[]) => {
      const L = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const k = Math.max(1, Math.ceil(L / 0.05));
      for (let i = 1; i <= k; i++) {
        const f = i / k;
        if (w.contactSolid(p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f) < RADIUS - 0.02) return false;
      }
      return true;
    };
    const p0: [number, number, number] = [cx, cy, cz];
    for (let a = 0; a <= 0.6001; a += 0.1) {
      const p1: [number, number, number] = [cx + ox * a, cy, cz + oz * a];
      if (a > 0 && !free(p0, p1)) break;
      for (let b = 0.15; b <= 0.9001; b += 0.075) {
        const p2: [number, number, number] = [p1[0], p1[1] + b, p1[2]];
        if (!free(p1, p2)) break;
        // 壁の側へ戻る距離：縁の上へ乗れるだけ（0.2）から、真上が壁ならその手前（0.05）まで。どれも出発点より壁の側
        for (const over of [0.2, 0.12, 0.05]) {
          const back = a + over;
          const p3: [number, number, number] = [p2[0] - ox * back, p2[1], p2[2] - oz * back];
          if (!free(p2, p3)) continue;
          if (w.climbSolid(p3[0], p3[1], p3[2]) > RADIUS + 0.15) continue;
          if (w.climbNormal(p3[0], p3[1], p3[2])[1] < 0) continue;
          return a > 0 ? [p0, p1, p2, p3] : [p0, p2, p3];
        }
      }
    }
    return null;
  }

  /**
   * 壁に張り付いている間の移動（1 ステップ）。返すのは体の中心の新しい位置。
   * - 入力の向き（カメラ基準の水平の向き）を面に沿う向きへ写す：壁へ向かう成分 → 面に沿って上、壁から離れる成分 → 下、
   *   壁に沿う成分 → 横。スティックを離すとその場で止まる（重力・浮力・水流は効かない）。
   * - 動いたあと、登れる面（climbSolid）から体の半径の距離へ吸着し（角を回り込む・凹凸に沿う）、そのほかの物
   *   （ガラス・管など）は従来どおり contactSolid で押し戻す。
   * - 面を失った（半径 + 0.12 より離れた）ら落ちる。床とみなせる緩い面（CLIMB_EXIT_NY）へ来たら歩きへ戻る。
   *   張り出しすぎた所（CLIMB_MIN_NY より下向き）へは進まない。
   */
  private climbMove(dt: number, inp: CrabInput, dx: number, dz: number, hasInput: boolean, s: number, cy: number): [number, number, number] {
    const w = this.world;
    const n = this.climbN;
    // 張り出しの縁を回り込んでいる途中：折れ線の道を一定の速さでたどる（入力では変えない）。体の傾きは回り込んだ先の面へ
    const M = this.mantle;
    if (M) {
      const sp = CLIMB_SPEED * 0.9;
      M.s = Math.min(M.len, M.s + sp * dt);
      let rest = M.s, q = M.pts[M.pts.length - 1], dir: number[] = [0, 0, 0];
      for (let i = 1; i < M.pts.length; i++) {
        const a = M.pts[i - 1], b = M.pts[i];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (rest <= L || i === M.pts.length - 1) {
          const f = L > 1e-6 ? Math.min(1, rest / L) : 1;
          q = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
          dir = L > 1e-6 ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L, (b[2] - a[2]) / L] : dir;
          break;
        }
        rest -= L;
      }
      this.vx = dir[0] * sp;
      this.vy = dir[1] * sp;
      this.vz = dir[2] * sp;
      const kn = 1 - Math.exp(-dt * 8);
      for (let k = 0; k < 3; k++) n[k] += (M.n[k] - n[k]) * kn;
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n[0] /= l; n[1] /= l; n[2] /= l;
      if (M.s < M.len) return q;
      // 着いた：その面に張り付き直す（緩い面なら下の判定で歩きへ戻る）
      this.mantle = null;
      this.vx = this.vy = this.vz = 0;
      n[0] = M.n[0]; n[1] = M.n[1]; n[2] = M.n[2];
      this.x = q[0];
      this.z = q[2];
      cy = q[1];
    }
    const hl = Math.hypot(n[0], n[2]) || 1;
    // 壁へ向かう水平の向き・壁に沿う水平の向き・面に沿って上る向き
    const ix = -n[0] / hl, iz = -n[2] / hl;
    const sx = -iz, sz = ix;
    const ul = Math.sqrt(Math.max(1e-6, 1 - n[1] * n[1]));
    const ux = (-n[0] * n[1]) / ul, uy = (1 - n[1] * n[1]) / ul, uz = (-n[2] * n[1]) / ul;
    const into = dx * ix + dz * iz, lat = dx * sx + dz * sz;
    const sp = (inp.run ? CLIMB_RUN : CLIMB_SPEED) * lerp(1, 0.85, s);
    const k = 1 - Math.exp(-(hasInput ? 12 : 18) * dt);
    this.vx += ((ux * into + sx * lat) * sp - this.vx) * k;
    this.vy += (uy * into * sp - this.vy) * k;
    this.vz += ((uz * into + sz * lat) * sp - this.vz) * k;
    // 面に垂直な成分は持たない
    const vn = this.vx * n[0] + this.vy * n[1] + this.vz * n[2];
    this.vx -= n[0] * vn;
    this.vy -= n[1] * vn;
    this.vz -= n[2] * vn;
    let px = this.x + this.vx * dt, py = cy + this.vy * dt, pz = this.z + this.vz * dt;
    // 登れる面へ吸着
    for (let i = 0; i < 3; i++) {
      const d = w.climbSolid(px, py, pz);
      if (d > RADIUS + 0.5 || Math.abs(d - RADIUS) < 0.002) break;
      const m = w.climbNormal(px, py, pz);
      px -= m[0] * (d - RADIUS);
      py -= m[1] * (d - RADIUS);
      pz -= m[2] * (d - RADIUS);
    }
    // そのほかの物（ガラス・管・底板など）の押し戻し
    for (let it = 0; it < 4; it++) {
      const d = w.contactSolid(px, py, pz);
      if (d >= RADIUS) break;
      const m = w.contactNormal(px, py, pz);
      px += m[0] * (RADIUS - d);
      py += m[1] * (RADIUS - d);
      pz += m[2] * (RADIUS - d);
    }
    const d = w.climbSolid(px, py, pz);
    const m = w.climbNormal(px, py, pz);
    if (d > RADIUS + 0.12) {
      // 面を失った：少し離れる向きへ押して落ちる
      this.vx += n[0] * 0.4;
      this.vz += n[2] * 0.4;
      this.releaseClimb('lost');
    } else if (m[1] < CLIMB_MIN_NY && m[1] < n[1] - 0.02) {
      // 張り出しすぎた所へは進まない（岩の根元のくびれのように、張り付いた所がすでに張り出していれば、
      // 張り出しが緩くなる向きへは進める）
      px = this.x;
      py = cy;
      pz = this.z;
      this.vx = this.vy = this.vz = 0;
      this.climbStats.blocked++;
      // 押し続けても進めない（張り出した縁・掘った穴の継ぎ目の棚の下）なら、面から離れる向きと上へ小さく跳んで離れ、
      // しばらく張り付かない（押している向きへの空中の加速で、縁の上へ回り込める。届かなければそのまま落ちる）
      this.stuckT += dt;
      const path = this.stuckT > CLIMB_STUCK_T ? this.findMantle(px, py, pz, n) : null;
      if (path) {
        // 縁を回り込める：その道をたどる（climbMove の先頭）
        this.startMantle(path);
      } else if (this.stuckT > CLIMB_STUCK_T) {
        const hl2 = Math.hypot(n[0], n[2]) || 1;
        this.vx = (n[0] / hl2) * 1.4;
        this.vz = (n[2] / hl2) * 1.4;
        this.vy = lerp(4.2, 3.4, s);
        this.hopT = 0.35;
        this.releaseClimb('drops');
        this.grabWait = GRAB_COOLDOWN;
      }
    } else if (m[1] > CLIMB_EXIT_NY) {
      // 床とみなせる面へ来た：歩きへ戻る
      this.releaseClimb('exits');
      this.grounded = true;
      this.groundN[0] = m[0];
      this.groundN[1] = m[1];
      this.groundN[2] = m[2];
      if (this.vy > 0) this.vy = 0;
    } else {
      this.stuckT = 0;
      const kn = 1 - Math.exp(-dt * 14);
      let a = n[0] + (m[0] - n[0]) * kn, b = n[1] + (m[1] - n[1]) * kn, c = n[2] + (m[2] - n[2]) * kn;
      const l = Math.hypot(a, b, c) || 1;
      a /= l; b /= l; c /= l;
      n[0] = a; n[1] = b; n[2] = c;
    }
    return [px, py, pz];
  }

  /** 見た目側が出来事を受け取る（受け取ったら空にする） */
  drainEvents(): CrabEvent[] {
    return this.events.splice(0, this.events.length);
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * 面（法線 n）に沿ったベクトルを、面を床（上 = +y）へ起こした座標へ戻す（n → 上 の回転。CrabRig の体の傾き
 * = 上 → n の回転の逆）。面に沿ったベクトルは水平になるので、x・z を体の向き基準の速度・向きの計算に使える
 */
export function toSurfaceLocal(n: readonly number[], vx: number, vy: number, vz: number): [number, number, number] {
  const sn = Math.hypot(n[0], n[2]);
  if (sn < 1e-5) return [vx, vy, vz];
  // 回転軸 k = n × 上（の単位）= (−n.z, 0, n.x) / sn、角度 θ：cos = n.y, sin = sn
  const kx = -n[2] / sn, kz = n[0] / sn;
  const c = n[1], si = sn;
  const kv = kx * vx + kz * vz;
  // k × v
  const cx = -kz * vy, cy = kz * vx - kx * vz, cz = kx * vy;
  return [vx * c + cx * si + kx * kv * (1 - c), vy * c + cy * si, vz * c + cz * si + kz * kv * (1 - c)];
}
