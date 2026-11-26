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
//   歩いていて急な面の下のくぼみで進めないときは、縁を回り込む道（findMantle）をたどる（掘った穴の継ぎ目の棚・出口の縁）。
//   体の傾きは climbN（groundN へ写す）。
// - 天井歩き：張り付いたまま、張り出し・岩や流木の裏・掘ったトンネルの天井（完全な逆さ）まで回り込める。
//   - 入力の写し方（moveF / moveR = スティックの前・右に当たる面に沿う向き）は面に貼り付けて持ち、面の向きが変わるたびに
//     その回転で一緒に回す（平行移動）。床 → 壁 → 天井 → 反対側の壁と、押したまま連続して進める（途中で向きが反転しない）。
//     スティックを離したら、いまのカメラと面から決め直す（camBasis。壁 = 従来どおり「壁へ = 上」、天井 = 画面の前・右）。
//     押している間も、決め直した向きと近ければ少しずつそちらへ寄せる（反対向きのときは離すまで寄せない）。
//   - 体の前（bodyF）も面に沿う向きとして持ち、同じ回転で回す（逆さでも向きが飛ばない。CrabRig は bodyF と groundN で
//     体の向きを作る）。進む向きに対して横歩きになるよう、面の法線のまわりに回す。
//   - 空中・水中から張り出し・天井へ触れて、移動入力かジャンプを押していれば張り付く（tryGrab）。
//   - ジャンプで離れると、面の外向きへ押し出す（上向きの面ほど上へも跳ぶ。天井からは真下へ）。逆さから離れた後は、
//     体の前を軸に起き上がりながら落ちる・沈む（frameMode の間は体の向きを bodyF から作る）。
// - 接地主導の移動（第 7 段階。CrabInput.lead・CrabLedge）：歩いていて前方に縁（歩いて下りられない急な下り）があれば、
//   先頭の脚が縁より下の足場に掛かるまで縁から出ない（ledgeGate）。段差は脚に支えさせて胴体を下ろし（ledgeSupport。
//   吸着で一気に落とさない）、高い崖は側面へ脚が掛かったら縁を回り込んで壁登りへ移る（startDescentClimb）。
//   足場が無ければ縁で立ち止まり、押し続けたら踏み出す（ledgeUpdate）。
// - 接地主導の壁登り・天井への移り（第 8 段階。CrabLedge の FaceHint・FACE）：
//   - 床 → 壁：登れる急な面へ押している間、前の脚に壁の足場を探させ（wallSeek。壁へ押し込む・壁を滑り上がる速さは持たない）、
//     壁に 2 本以上・接地 4 本以上になったら、床の向きのまま張り付いて面の移り（xfer）を始める。
//   - 壁 → 天井（・壁 → 床）：進む向きの少し先に向きが 40° 以上違う広い面があれば、次の面の手前で胴体を待たせ、脚が 2 本掛かったら移る。
//     0.8 秒探しても掛からなければ従来どおり回り込む。
//   - 面の移り（xferMove）：進み具合は、次の面に掛かった脚の数の上限（faceCap）まで、スティックが次の面へ向かっている間だけ進む。
//     逆へ押せば戻る（床からなら床へ戻る）。崖を降り始める道・縁を回り込む道（mantle）も、道の先の面に掛かった脚の数で止める。
//   - 少しずつ曲がる面（丸い洞窟・倒木の中）：体の面を、接地している足先の組の面から 28° より先へは回さず、差が大きい間は遅くする。
//   - 床 / 壁 / 天井（surf）は足先の組の面の向きを平滑化し、ヒステリシスを付けて決める（歩きへ戻るのも足先の面が床になってから）。

import { clamp, lerp, smoothstep } from '../core/math';
import { TANK, type AquariumWorld } from './AquariumWorld';
import { ROOM, type Flow, type Region } from './AquariumStand';
import { DIG, diggable, FILL, SAND, type DigMaterial } from './AquariumDig';
import { descentPath, FACE, faceBelow, faceCap, gapBelow, LEDGE, scanLedge, type FaceHint, type FaceKind, type Ledge } from './CrabLedge';

/** 床・壁・天井（第 8 段階：接地している足先の組の面の向きから、ヒステリシスを付けて決める） */
export type SurfClass = 'floor' | 'wall' | 'ceil';

/**
 * 接地主導の面の移り（第 8 段階）：床 → 壁・壁 → 天井（・壁 → 床）。kind・元の面 n0 → 次の面 n1・元の面で次の面へ向かう向き t0・
 * 次の面で進む向き t1・体の中心の始め c0 / 終わり c1・次の面の点 pf・進み具合 p（0..1。次の面に掛かった脚の数で上限 faceCap）・
 * 上限で押し続けた時間 hold・少しずつ進めた上限 creep・支えが足りない時間 loose・始めてからの時間 t
 */
interface Xfer {
  kind: FaceKind;
  n0: [number, number, number];
  n1: [number, number, number];
  t0: [number, number, number];
  t1: [number, number, number];
  c0: [number, number, number];
  c1: [number, number, number];
  pf: [number, number, number];
  p: number;
  hold: number;
  creep: number;
  crept: boolean;
  loose: number;
  t: number;
  /** スティックが次の面へ向かっていない時間（FACE.settleAfter を過ぎたら近い方の端へ寄せる） */
  idle: number;
}

export type CrabState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'swim' | 'sink' | 'ride' | 'dig' | 'climb';

export const CRAB_STATE_LABEL: Record<CrabState, string> = {
  idle: '待機', walk: '歩行', run: '走行', jump: 'ジャンプ', fall: '落下', swim: '遊泳', sink: '沈降', ride: '水流に乗る', dig: '穴掘り', climb: '壁登り',
};

/** 見た目側（泡・水しぶき・波紋）に知らせる出来事 */
export type CrabEvent = {
  kind: 'jump' | 'land' | 'enterWater' | 'exitWater' | 'swimStart' | 'stroke' | 'dig' | 'digBlocked' | 'fill';
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
  /** 道具（掘る / 盛る）。盛るとき：盛れるか・盛れない理由・置く砂山の半径の目安・当たった面の法線 */
  tool: SandTool;
  fillOk: boolean;
  fillWhy: FillBlock | null;
  fillR: number;
  n: [number, number, number];
}

/** 掘る / 盛る（PC：G キー・スマホ：掘るボタンの上の切り替えで変える。どちらも同じ「掘る」ボタン・F キーで行う） */
export type SandTool = 'dig' | 'fill';
/** 盛れない理由：砂が足りない・掘れない物（ガラス・管・発見物・底）・カニや仲間に近すぎる・届かない */
export type FillBlock = 'empty' | 'glass' | 'pipe' | 'treasure' | 'bottom' | 'near' | 'far' | 'other';
export const FILL_BLOCK_LABEL: Record<FillBlock, string> = {
  empty: '砂が足りない', glass: 'ガラスのそば', pipe: '配管のそば', treasure: '宝物のそば', bottom: '水槽の底', near: '近すぎる', far: '届かない', other: '盛れない',
};
/** 砂を盛ってよい面（砂・土・岩・流木の上。ガラス・管などの上には盛らない） */
function fillable(m: DigMaterial): boolean {
  return m === 'sand' || m === 'soil' || m === 'rock' || m === 'wood';
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
   * 穴の生き物を鋏で挟んで引っ張っている（AquaBuddy が決める。x, z = 穴、t = 張力 / 生き物の踏ん張り 0..1）。
   * 移動の入力はふだんどおり使う（下がる・横へ動くと引っ張る。手応えは tow）。この間は横歩きに向きを変えず正面（鋏の側）を
   * 穴へ向け、体の中心は穴の口から PULL_KEEP より近づかない（引き戻されても穴の上に乗らない）。壁には張り付かない
   */
  pull?: { x: number; z: number; t: number } | null;
  /**
   * 正面（鋏の側）を向ける点（巣穴のそばで「挟む」を押している間。横歩きで横を向いたままでも、鋏が触角へ届くように
   * 穴の方へ向き直る）。移動の入力はふだんどおり
   */
  face?: { x: number; z: number } | null;
  /**
   * 鋏で挟んでいる物の手応え（AquaGrab.tow）。a = 物が鋏を引く力の反作用の加速度（世界）、slow = 速さの上限に掛ける割合。
   * 横の力は歩いていても効き（重い物を引きずると遅くなり、勢いのついた物に引き戻される）、縦の力は接地していない
   * ときだけ効く（重い物を挟んで泳ぐと沈みやすい。立っているカニは持ち上げない）。壁・天井に張り付いている間は使わない
   */
  tow?: { ax: number; ay: number; az: number; slow: number } | null;
  /**
   * 接地 IK の支え（第 4 段階。CrabFeet.support）：speed = 速さの上限に掛ける割合（伸びきった脚が踏み替えられない間・接地している脚が
   * 少ない間は遅く。脚が届かない所へ胴体だけが先へ行かない）、lost = 壁・天井で掛かっている脚が少ない状態が続いた（離れて落ちる）
   */
  support?: { speed: number; lost: boolean; planted?: number; down?: number; face?: number; next?: number; fn?: readonly number[]; fnN?: number } | null;
  /**
   * 接地主導の移動（第 7 段階。歩き方「接地主導」）：崖・段差の縁では、先頭の脚が下の足場（縁より下）に掛かるまで胴体を
   * 縁から出さず、掛かったら脚に支えさせて胴体を下ろす。高い崖は側面へ脚を掛けて壁登りへ移る（CrabLedge）。
   * support.planted / down / face（接地している脚・縁より下に掛かった脚・崖の側面に掛かった脚）を使う
   */
  lead?: boolean;
  /**
   * 踏ん張り旋回（第 9 段階の比較用。CrabRig.turnStyle = 'pivot'）：床で横歩きの向きへ体を回すとき、回る速さに上限（PIVOT_TURN.max）を
   * 付け、回り始めは脚で押し出すように少しずつ速くする（脚の踏み替えが追いつく速さで回る）
   */
  pivot?: boolean;
}

/**
 * 踏ん張り旋回：体の回る速さの上限（rad / 秒）と、回る速さが目標へ近づく速さ（/秒）。目標 = 従来と同じ（残りの角 × 7）を上限で切ったもの
 * （90° なら従来とほぼ同じ時間で回り終え、回り始めの 1〜2 フレームで一気に回らない）
 */
const PIVOT_TURN = { max: 6.0, walkAdd: 5.0, acc: 22 } as const;

/** 引っ張っている間、体の中心が穴の口へ近づけない距離（水平。AquaBuddy.PULL_KEEP と同じ） */
const PULL_KEEP = 0.4;
/** 引っこ抜いた反動で後ろへ転んでいる時間（この間は移動の入力を使わない） */
const TUMBLE_T = 0.9;
/** 掘った・盛った砂の量を測る処理に、1 フレームで使う時間の上限（ms） */
const MEASURE_MS = 1.5;

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
/**
 * 歩いていて（接地して）張り付き始めてよい面の張り出しの限度（法線の y。約 127°）。張り付いた後は天井（−1）まで回り込める。
 * 掘った穴の中は、ほぼ垂直（約 99°）まで：狭いトンネルを歩いていて頭が天井・丸い突き当たりに触れただけで張り付かないように
 * （壁へ張り付いてから天井へ回り込むのはできる）。継ぎ目の段・坂の床は、張り付かずに歩く・よじ登る
 */
const GRAB_MIN_NY = -0.6;
const GRAB_MIN_NY_DUG = -0.15;
/** 空中・水中から張り付ける面（法線の y がこれより下 = 張り出し・天井） */
const CEIL_GRAB_NY = -0.3;
/** 入力の写し方：天井の決め方に切り替える法線の y（約 127° より張り出した面）・離してから決め直すまでの時間 */
const CEIL_RULE_NY = -0.6;
const REANCHOR_T = 0.12;
/** 押しても進めないまま縁を回り込む道を探すまでの時間と、天井から跳んで離れたあと張り付かない時間 */
const CLIMB_STUCK_T = 0.3;
const GRAB_COOLDOWN = 0.6;
const CLIMB_GRAB_T = 0.1;
const CLIMB_INTO = 0.35;
const CLIMB_SPEED = 1.6;
const CLIMB_RUN = 2.5;
/**
 * 天井歩きの安定化（2026-11-26、iPhone の実機の報告「小さな出っ張りで意図せず裏返る」から）：
 * - 面の向きは、体の中心と、面に沿って NORMAL_SAMPLE_R 離れた 6 点の法線を平均して決める（小さな出っ張り・くぼみで向きが跳ねない）。
 *   同じ面（中心の法線と 0.7 以上そろう）に触れている点の数（cover、最大 7）が NORMAL_COVER_MIN 未満なら、狭い出っ張りとみなす
 * - 張り付いている面の向きは、1 秒あたり CLIMB_TURN_RATE ラジアンより速くは変えない（1 フレームで向きが跳ねない。壁 → 天井で 0.26 秒以上）
 * - 狭い出っ張りの上では、張り出した向き（法線の y < INVERT_NY）へは体を起こさない
 * - 空中・水中から天井へ：ジャンプを押していれば CLIMB_GRAB_T、移動入力だけなら CEIL_GRAB_MOVE_T 触れ続けたら。どちらも広い面だけ
 */
const NORMAL_SAMPLE_R = 0.12;
const NORMAL_COVER_MIN = 4;
const CLIMB_TURN_RATE = 6;
const INVERT_NY = -0.35;
const CEIL_GRAB_MOVE_T = 0.3;

export class CrabController {
  /** 足元の位置（球の中心は y + RADIUS） */
  x: number;
  y: number;
  z: number;
  vx = 0;
  vy = 0;
  vz = 0;
  heading = 0;
  /** 踏ん張り旋回（inp.pivot）：体の回る速さ（rad / 秒） */
  private yawW = 0;
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
  readonly digAim: DigAim = { active: false, p: [0, 0, 0], dir: [0, 0, 1], material: 'none', hit: false, face: false, tool: 'dig', fillOk: false, fillWhy: null, fillR: 0, n: [0, 1, 0] };
  /** 道具（掘る / 盛る）と手持ちの砂（体積。0〜SAND.capacity） */
  tool: SandTool = 'dig';
  sandHeld = 0;
  /** 砂の出入りの記録（自動検証・表示用）：掘って得た・容量を超えて捨てた・盛って使った量、空振り・盛れなかった回数 */
  readonly sandStats = { gained: 0, overflow: 0, spent: 0, places: 0, placeFails: 0, lastGain: 0, lastSpend: 0, measureMs: 0, maxMeasureMs: 0 };
  /** 盛った砂で埋めてはいけない物（仲間など。中心と半径）。main が決める */
  fillBlockers: () => { x: number; y: number; z: number; r: number }[] = () => [];

  /** 掘る ↔ 盛る を切り替える（掘っている・盛っている途中なら、いったん離したことにする） */
  toggleTool(): SandTool {
    this.tool = this.tool === 'dig' ? 'fill' : 'dig';
    this.digT = 0;
    return this.tool;
  }
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
  /**
   * 体の前の向き（単位。groundN に垂直）。張り付いている間と、逆さから起き上がっている途中（frameMode）だけ使う。
   * それ以外の間は heading（体の向き）から決まる向きに合わせておく
   */
  readonly bodyF: [number, number, number] = [0, 0, 1];
  /** 体の向きを bodyF・groundN から作る（張り付いている・逆さから起き上がっている途中）。false なら heading・groundN（従来） */
  frameMode = false;
  /** 張り付いている間のスティックの前・右に当たる面に沿う向き（面の向きが変わると一緒に回す）・離している時間 */
  private readonly moveF: [number, number, number] = [0, 0, 1];
  private readonly moveR: [number, number, number] = [1, 0, 0];
  private idleT = 0;
  /**
   * 張り付いている間に、逆さ（法線の y < −0.7）で過ごした時間・回り込んだ面の向きの範囲・空中から張り付いた回数・
   * 狭い出っ張りなので張り付かなかった / 起こさなかった回数・面の向きを変える速さの上限で止めた回数（自動検証用）
   */
  readonly ceilStats = { invertedT: 0, minNY: 1, grabsAir: 0, narrowSkips: 0, turnCapped: 0 };
  /** 張り付いている間のスティックの前・右に当たる面に沿う向き（画面の案内の矢印。読むだけ） */
  get climbBasis(): { f: readonly number[]; r: readonly number[] } {
    return { f: this.moveF, r: this.moveR };
  }
  /** 壁へ向かって押し続けている時間（CLIMB_GRAB_T で張り付く）・張り付かない残り時間・張り出しで進めない時間 */
  private grabT = 0;
  private grabWait = 0;
  private stuckT = 0;
  /** 張り出しの下から跳んで離れた直後の、移動入力で水平の速さを変えない残り時間（縁の下へ引き戻されない） */
  private hopT = 0;
  /** 歩いていて、押している向きへ進めない時間（縁の下のくぼみから回り込む） */
  private pushT = 0;
  /** 張り出しの縁を回り込んでいる途中（折れ線の道・進んだ距離・全長・回り込んだ先の面の法線） */
  /** （崖を降り始める道は、速さ sp と、始めの面の向き n0 → 着いた所の面の向き n を道の進み具合に合わせて回す） */
  /** （接地主導では、道の進み具合を、道の先の面に掛かった脚の数で止める：hold / creep は xfer と同じ） */
  private mantle: { pts: [number, number, number][]; s: number; len: number; n: [number, number, number]; sp?: number; n0?: [number, number, number]; hold?: number; creep?: number; crept?: boolean } | null = null;
  /**
   * 接地主導の壁登り・天井への移り（第 8 段階）：次の面の手がかり（脚へ渡す。無ければ null）・面の移りの途中（無ければ null）・
   * 足先の組から決めた床 / 壁 / 天井と、その数え（自動検証用）：seeks = 次の面を探し始めた・starts = 移り始めた（startNext /
   * startPlanted = そのときの次の面の脚・接地している脚の合計）・done = 移り終えた・back = 戻った（後退）・aborts = 支えを失った・
   * creeps = 脚が掛からないまま少しずつ進めた・waitT = 脚を待った時間・narrow = 狭い出っ張りで探さなかった・
   * surfSwitches = 床 / 壁 / 天井が替わった回数・footLedT = 体の面を足先の面に合わせて止めていた時間
   */
  faceHint: FaceHint | null = null;
  xfer: Xfer | null = null;
  surf: SurfClass = 'floor';
  /** 床・壁・天井を決める、足先の組の面の向きを平滑化したもの */
  private readonly fnS: [number, number, number] = [0, 1, 0];
  readonly faceStats = { seeks: 0, starts: 0, startNext: 0, startPlanted: 0, done: 0, back: 0, aborts: 0, creeps: 0, waitT: 0, narrow: 0, surfSwitches: 0, exitHeld: 0, footLedT: 0, giveUps: 0 };
  private hintSeen = false;
  /** 脚が次の面に掛からず、探すのをあきらめた手がかり（数えるのは 1 回） */
  private gaveUpHint: FaceHint | null = null;
  /** 前の脚が壁を探している間（毎ステップ延ばす）・その壁の向き */
  private wallHoldT = 0;
  private readonly wallHoldN: [number, number, number] = [0, 0, 0];
  private xferCool = 0;
  private exitWait = 0;
  /** 体の面と脚の面の向きの差で遅くする割合（接地主導で張り付いている間） */
  private lagK = 1;
  /**
   * 接地主導の移動：前方の縁（CrabLedge。無ければ null）と、その数え（自動検証用）：
   * edges = 縁を見つけた・holdT = 縁で待った時間の合計・steps = 段差を脚で降り切った・climbs = 崖の側面へ移った・
   * stepOffs = 足場が無く踏み出した・falls = 降りている途中で支えを失って落ちた・maxDescV = 胴体を下ろした速さの最大
   */
  ledge: Ledge | null = null;
  readonly ledgeStats = { edges: 0, holdT: 0, steps: 0, climbs: 0, stepOffs: 0, falls: 0, maxDescV: 0 };
  /** 最後に支えを失って落ちたときの様子（自動検証用） */
  ledgeFall: { kind: string; over: number; gap: number; down: number; planted: number; t: number } | null = null;
  private ledgeScanN = 0;
  /** 壁登りの回数（張り付いた・床へ戻った・跳んで離れた・面を失って落ちた・掘る等で離した・張り出しで止まった・縁を回り込んだ。自動検証用） */
  readonly climbStats = { grabs: 0, exits: 0, jumps: 0, lost: 0, drops: 0, blocked: 0, mantles: 0, supportLost: 0 };
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
    this.frameMode = false;
    this.groundN.splice(0, 3, 0, 1, 0);
    this.grabT = this.grabWait = this.stuckT = this.hopT = this.pushT = 0;
    this.mantle = null;
    this.ledge = null;
    this.ledgeScanN = 0;
    this.xfer = null;
    this.faceHint = null;
    this.xferCool = this.exitWait = this.wallHoldT = 0;
    this.lagK = 1;
    this.surf = 'floor';
    this.fnS.splice(0, 3, 0, 1, 0);
  }

  /** 穴の生き物を引っ張っているか・張力 / 生き物の踏ん張り（見た目 CrabRig の踏ん張り・鋏に使う） */
  pulling = false;
  pullT = 0;
  private pullAt: [number, number] = [0, 0];
  /** 引っこ抜いた反動で後ろへ転んでいる残り時間（CrabRig が体を後ろへ倒す）・転んだ回数 */
  tumbleT = 0;
  tumbles = 0;

  /** 引っこ抜いた反動：(dx, dz)（水平の単位）へ跳ねて後ろへ転ぶ。power = 0..1 */
  tumble(dx: number, dz: number, power: number) {
    const sp = 1.8 + 1.2 * power;
    this.vx = dx * sp;
    this.vz = dz * sp;
    this.vy = 2.2 + 0.8 * power;
    this.grounded = false;
    this.coyote = 0;
    this.landImpact = 1;
    this.tumbleT = TUMBLE_T;
    this.tumbles++;
    if (this.climbing) this.releaseClimb('drops');
  }

  update(dt: number, inp: CrabInput) {
    // 引っ張っている間：穴へ向く（移動の入力はふだんどおり）。穴掘りはしない（鋏を使っている）
    this.pulling = !!inp.pull;
    if (inp.pull) {
      this.pullT = inp.pull.t;
      this.pullAt = [inp.pull.x, inp.pull.z];
      inp = { ...inp, dig: false };
    } else this.pullT = 0;
    // 転んでいる間：移動・ジャンプ・穴掘りの入力を使わない
    if (this.tumbleT > 0) {
      this.tumbleT = Math.max(0, this.tumbleT - dt);
      inp = { ...inp, move: { x: 0, y: 0 }, run: false, jumpHeld: false, dig: false };
    }
    // 大きな時間差は分割して当たり判定のすり抜けを防ぐ
    const steps = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / steps;
    this.clock += dt;
    // 接地主導：次の面の手がかりは、このフレームに探した・移っているときだけ残す
    this.hintSeen = false;
    this.xferCool = Math.max(0, this.xferCool - dt);
    if (inp.lead) this.updateSurf(inp.support ?? null, dt);
    for (let i = 0; i < steps; i++) this.step(h, inp, i === 0);
    if (!this.hintSeen) this.faceHint = null;
    else if (this.faceHint) this.faceHint.t += dt;
    // 掘った・盛った砂の量を測る処理を少し進める（1 フレームに MEASURE_MS まで。スマホでも画面を止めない）
    if (this.world.dig.measuring) {
      const t0 = performance.now();
      this.world.dig.measureStep(MEASURE_MS);
      const ms = performance.now() - t0;
      this.sandStats.measureMs = ms;
      this.sandStats.maxMeasureMs = Math.max(this.sandStats.maxMeasureMs, ms);
    }
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
    const fillMode = this.tool === 'fill';
    // 上下の向き：地表では斜め下、足元が十分深くなったら（または水槽の底の近く）水平。ジャンプで上へ、走るで急に下へ。
    // 照準を上下へずらしている間は、ずらした量で連続的に上・下へ向ける（自動の切り替えは止める：
    // 地表へ近づいて「斜め下」に戻り、上へ掘っている向きが急に変わることがないように）。
    // 盛るときは、照準をずらしていなければ浅い斜め下（FILL.pitch。体から離れた所へ盛り、体を埋めない）
    const aimY = inp.digAim?.y ?? 0;
    const swiping = Math.abs(aimY) > 0.02;
    const depth = w.groundAt(this.x, this.z) - this.y;
    const nearBottom = this.y < DIG.floorClip + 0.12;
    if (!swiping) {
      if (depth > DIG.tunnelDepth - 0.05 || nearBottom) this.digDeep = true;
      else if (depth < 0.25) this.digDeep = false;
    }
    const base = fillMode ? FILL.pitch : this.digDeep ? 0 : -0.48;
    let pitch = base;
    if (swiping) pitch = aimY > 0 ? base + (DIG_PITCH_UP - base) * aimY : base + ((nearBottom ? 0 : DIG_PITCH_DOWN) - base) * -aimY;
    else if (inp.jumpHeld) pitch = 0.75;
    else if (inp.run && !nearBottom && !fillMode) pitch = -0.85;
    this.digPitch += (pitch - this.digPitch) * (1 - Math.exp(-dt * 10));
    const cp = Math.cos(this.digPitch);
    const dir: [number, number, number] = [cp * Math.sin(this.digYaw), Math.sin(this.digPitch), cp * Math.cos(this.digYaw)];
    const o: [number, number, number] = [this.x, this.y + RADIUS, this.z];
    // 上へ掘るときは天井・掘り口までが遠くなるので、届く距離を延ばす（盛るときは FILL.reach）
    const reach = fillMode ? FILL.reach : DIG.reach + 0.45 * Math.max(0, this.digPitch);
    // 届く距離の少し先（FACE_AHEAD）まで探る：届く距離の中で当たればかき出す。その先で当たった（掘り進めた穴の突き当たりが
    // 少し先にある）なら、かき出さずに照準だけ出す（掘りながら進むと交互に起こるので、空振りの動きにはしない）
    let pr = w.digProbe(o[0], o[1], o[2], dir, reach + (fillMode ? 0 : FACE_AHEAD));
    // 上へ掘っていて体の中心からは何も無い（地表へ抜けた）とき：足もとの少し上から水平にも探る。斜め上の穴が地表へ
    // 抜けた所には、穴の床と地表の間に足もとの段（登れない急な縁）が残るので、それを掘り取って出口を平らにする
    if (!fillMode && pr.t === null && this.digPitch > 0.15 && w.groundAt(this.x, this.z) - this.y > 0.06) {
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
    A.tool = this.tool;
    A.p = pr.t !== null ? pr.p : [o[0] + dir[0] * reach, o[1] + dir[1] * reach, o[2] + dir[2] * reach];
    A.dir = dir;
    A.material = pr.material;
    A.hit = inReach;
    A.face = pr.t !== null;
    const material: DigMaterial = inReach ? pr.material : 'none';
    // 盛るとき：盛れるか（砂が足りる・盛ってよい面・保護する物から離れている・カニや仲間を埋めない）と、砂山の大きさの目安
    let maxR: ((c: readonly number[], r: number) => number) | null = null;
    if (fillMode) {
      const blockers = [{ x: this.x, y: this.y + RADIUS, z: this.z, r: RADIUS }, ...this.fillBlockers()];
      maxR = (c, r) => {
        let m = r;
        for (const b of blockers) m = Math.min(m, Math.hypot(c[0] - b.x, c[1] - b.y, c[2] - b.z) - b.r - FILL.clearance);
        return m;
      };
      A.n = inReach ? w.contactNormal(pr.p[0], pr.p[1], pr.p[2]) : [0, 1, 0];
      // 盛ってよい面かは、当たった所の本当の材質で決める（digProbe は掘れない範囲＝底・ガラス際の砂を「底」「ガラス」と返すが、
      // 盛るのはその上でよい。保護する物から離れているかは planPlace が砂山の中心で決める）
      if (inReach) {
        const sm = w.surfaceMaterial(pr.p[0], pr.p[1], pr.p[2]);
        A.material = sm === 'sand' || sm === 'soil' || sm === 'rock' || sm === 'wood' || sm === 'glass' || sm === 'pipe' ? sm : sm === 'acrylic' ? 'glass' : sm === 'deck' ? 'bottom' : pr.material;
      }
      let why: FillBlock | null = null;
      if (!inReach) why = 'far';
      else if (!fillable(A.material)) why = A.material === 'glass' || A.material === 'pipe' || A.material === 'treasure' || A.material === 'bottom' ? A.material : 'other';
      else if (this.sandHeld < SAND.minPlace) why = 'empty';
      let planR: number = FILL.rMin;
      if (!why) {
        // place と同じ判断（続けて盛っていれば、大きくする・上へ積む）
        const pl = w.dig.planPlace(pr.p, A.n, this.clock, maxR);
        planR = pl.r;
        if (pl.why) why = pl.why === 'near' ? 'near' : pl.why === 'glass' || pl.why === 'pipe' || pl.why === 'treasure' || pl.why === 'bottom' ? pl.why : 'other';
      }
      A.fillWhy = why;
      A.fillOk = why === null;
      A.fillR = planR;
    }
    // 空振り：照準の先に何も無い（水・空気・掘った穴の中）
    this.digWhiff += ((A.face ? 0 : 1) - this.digWhiff) * (1 - Math.exp(-dt * 8));
    // かき出し：左右の鋏で交互に（位相は 1 回で π）
    this.digPhase += (dt * Math.PI) / this.digInterval;
    this.digT -= dt;
    if (this.digT > 0) return;
    this.digT = Math.max(this.digT + this.digInterval, 0.02);
    this.digStrokes++;
    if (!A.face) this.digWhiffs++;
    if (fillMode && maxR) {
      // 盛る：盛れるときだけ。足した砂の量（測った体積）だけ手持ちから減らす
      if (!A.fillOk) {
        this.sandStats.placeFails++;
        if (A.face && A.fillWhy !== 'empty') this.events.push({ kind: 'digBlocked', x: pr.p[0], y: pr.p[1], z: pr.p[2], power: 0.3, dir, material: pr.material });
        return;
      }
      w.dig.beginEdit();
      const res = w.dig.place(pr.p, A.n, this.clock, maxR);
      // 足した砂の量は、測り終えたとき（数フレーム後）に手持ちから減らす（次に盛る・掘る前には必ず測り終える＝beginEdit）
      if (res.changed) w.startMeasureEdit((v) => this.spendSand(Math.max(0, v)));
      else w.dig.endEdit();
      if (res.changed) {
        this.sandStats.places++;
        A.fillR = res.r;
        this.events.push({ kind: 'fill', x: pr.p[0], y: pr.p[1], z: pr.p[2], power: res.r / FILL.rMax, dir, material: pr.material === 'soil' || pr.p[1] > TANK.waterY ? 'soil' : 'sand' });
      } else this.sandStats.placeFails++;
      return;
    }
    if (material === 'none' || diggable(material)) {
      // 斜め下へ掘るときは、元の地表から tunnelDepth より深くは掘らない（走る＝急に下へ・照準を下へずらした、のときだけ深く掘れる）
      // （十分深くなって水平に掘っている間は制限しない。岸の斜面の下では地表が上がっても床を水平に保つ）
      const down = inp.run || aimY < -0.3;
      const floorMin = down || this.digDeep ? -Infinity : w.groundAt(pr.p[0], pr.p[2]) - DIG.tunnelDepth - 0.04;
      // 届かないときも、直前に掘った空洞を太らせる（その場で掘り続けると穴が広がる）。そのときの砂粒は
      // 太らせた空洞の先（res.at）から少しだけ（空振りの鋏の先からは出さない）
      w.dig.beginEdit();
      const res = w.dig.stroke(o, dir, diggable(material) ? pr.t : null, this.clock, floorMin, reach);
      // 実際に取り除いた砂の量（測った体積）だけ手持ちに足す（空振り・掘った穴の中を太らせただけ・岩なら 0。容量を超えた分は捨てる）
      // （測り終えたとき＝数フレーム後に足す）
      if (res.changed) w.startMeasureEdit((v) => this.gainSand(Math.max(0, -v)));
      else w.dig.endEdit();
      if (res.changed) {
        const at = diggable(material) ? pr.p : res.at;
        this.events.push({ kind: 'dig', x: at[0], y: at[1], z: at[2], power: (res.r / DIG.rMax) * (A.hit ? 1 : 0.3), dir, material: material === 'none' ? (A.face && diggable(pr.material) ? pr.material : 'sand') : material });
      }
    } else {
      w.dig.stats.blocked++;
      this.events.push({ kind: 'digBlocked', x: pr.p[0], y: pr.p[1], z: pr.p[2], power: 0.5, dir, material });
    }
  }

  /** 掘って取り除いた砂を手持ちへ（容量 SAND.capacity まで。超えた分は捨てる） */
  private gainSand(v: number) {
    const room = Math.max(0, SAND.capacity - this.sandHeld);
    const take = Math.min(room, v);
    this.sandHeld += take;
    this.sandStats.gained += take;
    this.sandStats.overflow += v - take;
    this.sandStats.lastGain = v;
  }

  /** 盛って足した砂の分を手持ちから減らす（手持ちより多ければ手持ち全部） */
  private spendSand(v: number) {
    const spend = Math.min(this.sandHeld, v);
    this.sandHeld -= spend;
    this.sandStats.spent += spend;
    this.sandStats.lastSpend = spend;
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
    // 接地 IK：壁・天井で脚が掛からない状態が続いた（足場を掘って崩した・登れない所へ出た）→ 支えを失って離れる
    if (this.climbing && inp.support?.lost) {
      this.releaseClimb('drops');
      this.climbStats.supportLost++;
    }
    // 壁から跳ぶ：面の外向きと上へ押し出す（水中で押し続ければ、そのまま遊泳へ移れる）。
    // 張り出し・天井では上へは押さない（上へ押すと天井へ押し戻される）：天井からは真下へ離れて落ちる・沈む
    let wallJump = false;
    if (this.climbing && pressed) {
      const n = this.climbN;
      const up = lerp(4.6, 3.8, s) * smoothstep(-0.45, 0.1, n[1]);
      this.vx = n[0] * 3.2;
      this.vy = n[1] * 3.2 + up;
      this.vz = n[2] * 3.2;
      // 張り出し・天井から離れた直後は張り付かない（ジャンプを押したまま遊泳へ移っても、同じ天井へ戻らない）
      if (n[1] < CEIL_GRAB_NY) this.grabWait = GRAB_COOLDOWN;
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
      // （縁で待っている・脚で支えて下ろしている途中・壁を探している途中でも跳べる：縁の状態は捨てる）
      this.ledge = null;
      this.wallHoldT = 0;
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
    if (this.climbing) {
      this.ledge = null;
      [px, py, pz] = this.climbMove(dt, inp, hasInput, s, cy);
    } else {
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
      // 挟んでいる物が重いほど遅く歩く
      if (inp.tow) maxSpeed *= inp.tow.slow;
      // 接地 IK：脚が追いつかない間は遅く（地上だけ。泳いでいる・空中では使わない）
      if (inp.support && this.grounded && !this.swimming) maxSpeed *= inp.support.speed;
      const tvx = mx * maxSpeed, tvz = mz * maxSpeed;
      // 入力が無いとき：地上ではすぐ止まり、水中・空中ではゆっくり減速する
      const k = 1 - Math.exp(-(hasInput ? accel : this.grounded ? 12 : lerp(0.6, 2.2, s)) * dt);
      if (this.hopT > 0 && !this.grounded) this.hopT -= dt;
      else {
        this.hopT = 0;
        this.vx += (tvx - this.vx) * k;
        this.vz += (tvz - this.vz) * k;
      }
      // 接地主導：縁へ向かう速さを、脚が下の足場に掛かるまで抑える
      if (this.ledge) this.ledgeGate(inp);
      // 接地主導（第 8 段階）：前の脚が壁を探している間は、壁へ押し込む速さと、壁を滑り上がる速さを持たない（水中では、急な壁へ
      // 押すと押し戻しの向きで体が壁を滑り上がり、床から離れて脚が置き直しになっていた。従来は 0.1 秒で張り付いていたので起きなかった）
      if (inp.lead && this.wallHoldT > 0) {
        this.wallHoldT -= dt;
        const n = this.wallHoldN;
        const vin = this.vx * n[0] + this.vy * n[1] + this.vz * n[2];
        if (vin < 0) {
          this.vx -= n[0] * vin;
          this.vy -= n[1] * vin;
          this.vz -= n[2] * vin;
        }
        if (this.vy > 0 && !this.swimming) this.vy = 0;
      }
      // 挟んでいる物の反作用（管の中は水の流れに任せる）
      if (inp.tow && !ride) {
        this.vx += inp.tow.ax * dt;
        this.vz += inp.tow.az * dt;
        if (!this.grounded) this.vy += inp.tow.ay * dt;
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
        // 接地主導：縁を越えた所の段差（0.06 より大きい）へは吸着で一気に落とさず、脚で支えて下ろす（ledgeSupport）
        const held = !!this.ledge && !this.ledge.stepOff && t > 0.06;
        if (nf && nf[1] > floorNY && !held) {
          py -= t;
          this.grounded = true;
          const n = w.contactNormal(px, py - RADIUS * 0.5, pz);
          if (n[1] > floorNY) this.groundN.splice(0, 3, ...n);
        }
      }
      // 接地主導（第 8 段階）：床と壁の隅に押し付けている（中心の押し戻しの向きが床と壁の間になって接地にならない）：足元のすぐ下が
      // 床なら接地のまま（従来は 0.1 秒で壁へ張り付いていたので起きなかった。脚が壁を探している間も床に立っている）
      // （ガラス・管の前の隅でも同じ：押し付けている間に接地が外れて、脚が置き直しになり続けない）
      // （隅の押し戻しで少し上向きの速さが残り、体が跳ね続けるのも止める。跳んだ直後（上向きの速さが大きい）は除く）
      // （縁で脚に支えさせて降りている間は使わない：縁の角で胴体を下へ寄せると、脚より先に胴体が下りる）
      if (!this.grounded && inp.lead && !this.ledge && this.vy <= 0.8 && !this.swimming && !ride && this.tumbleT <= 0 && w.contactSolid(px, py, pz) < RADIUS + 0.03) {
        const yb = py - RADIUS + 0.05;
        const db = w.contactSolid(px, yb, pz);
        if (db < 0.12) {
          const nb = w.contactNormal(px, yb, pz);
          if (nb[1] > floorNY) {
            // （足元を床へ下ろす：浮いたまま接地にしない）
            if (db > 0.05) py -= db - 0.05;
            if (this.vy > 0) this.vy = 0;
            this.grounded = true;
            this.groundN.splice(0, 3, ...nb);
          }
        }
      }
      // 接地主導：縁を越えた胴体を脚で支えて下ろす（床に触れていない間）
      if (this.ledge) py = this.ledgeSupport(dt, inp, px, py, pz, wasGrounded);
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
      // （生き物を挟んで引っ張っている間は張り付かない・回り込まない：鋏が穴から離れて滑り落ちるだけなので）
      if (!this.pulling) this.tryGrab(dt, inp, px, py, pz, mx, mz, mag, hasInput, floorNY, ride);
      // 押しても進めない縁の下のくぼみ：回り込める道があれば回り込む
      // （接地主導：前の脚が壁を探している間は回り込まない。0.8 秒探しても掛からなければ回り込む）
      const seekingWall = inp.lead && this.wallHoldT > 0 && !!this.faceHint && this.faceHint.kind === 'wall' && this.faceHint.t < 0.8;
      if (!this.climbing && !this.pulling && hasInput && mag > 0.5 && !ride && !this.swimming && !inp.dig && this.region === 'tank' && !seekingWall && w.contactSolid(px, py, pz) < RADIUS + 0.03) {
        this.tryMantleFromWalk(dt, px, py, pz, ux0, uz0, (px - this.x) * ux0 + (pz - this.z) * uz0 > 0.15 * maxSpeed * mag * dt, inp.cameraYaw);
      } else this.pushT = hasInput ? Math.max(0, this.pushT - dt) : 0;
      // 接地主導：前方の縁を探す・縁で待つ・崖の側面へ移る・踏み出す
      this.ledgeUpdate(dt, inp, px, py, pz, ux0, uz0, hasInput, digging, ride, first);
    }
    // 引っ張っている間：穴の口の上に乗らない（生き物に引き戻されても、体の中心は口から PULL_KEEP 離れたまま）。
    // 押し出した先が固体の中なら押し出さない（ガラス・岩の際で、体を地形へ押し込まない）
    if (this.pulling && !this.climbing) {
      const ox = px - this.pullAt[0], oz = pz - this.pullAt[1], od = Math.hypot(ox, oz);
      if (od < PULL_KEEP) {
        const ux = od > 1e-4 ? ox / od : Math.sin(this.heading + Math.PI), uz = od > 1e-4 ? oz / od : Math.cos(this.heading + Math.PI);
        const nx = this.pullAt[0] + ux * PULL_KEEP, nz = this.pullAt[1] + uz * PULL_KEEP;
        if (w.contactSolid(nx, py, nz) > RADIUS * 0.8) {
          px = nx;
          pz = nz;
          const vin = this.vx * ux + this.vz * uz;
          if (vin < 0) {
            this.vx -= ux * vin;
            this.vz -= uz * vin;
          }
        }
      }
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
      if (this.climbN[1] < -0.7) this.ceilStats.invertedT += dt;
      this.ceilStats.minNY = Math.min(this.ceilStats.minNY, this.climbN[1]);
    } else if (this.frameMode) {
      // 逆さ・張り出しから離れた直後：体の前（bodyF）を軸に起き上がりながら落ちる（真上へ向き直すのに約 0.5 秒。
      // 法線をいきなり上へ戻すと、逆さから一瞬で正立に飛ぶ）
      this.coyote -= dt;
      this.airTime += dt;
      this.rightUp(dt);
    } else {
      this.coyote -= dt;
      this.airTime += dt;
      // 空中・水中では体を起こしていく
      this.groundN[0] *= 1 - dt * 3;
      this.groundN[2] *= 1 - dt * 3;
      this.groundN[1] = Math.sqrt(Math.max(0, 1 - this.groundN[0] ** 2 - this.groundN[2] ** 2));
    }
    // 床に立った：体の向きは heading・groundN（従来）へ戻す
    if (this.grounded && this.frameMode) this.frameMode = false;
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
    } else if (this.pulling || (inp.face && !this.climbing && this.tumbleT <= 0)) {
      // 引っ張っている・巣穴のそばで挟もうとしている：正面（鋏の側）を穴へ
      const fx = this.pulling ? this.pullAt[0] : inp.face!.x, fz = this.pulling ? this.pullAt[1] : inp.face!.z;
      const h = Math.atan2(fx - this.x, fz - this.z);
      this.heading = wrap(this.heading + wrap(h - this.heading) * (1 - Math.exp(-(this.pulling ? 12 : 8) * dt)));
    } else if (this.climbing) {
      // 面に沿って進む向きに対して横歩きになるよう、体の前（bodyF）を面の法線のまわりに回す（逆さでも同じ式）。
      // heading は面を床に起こした向きの方位（床へ戻ったとき・壁で使う。真逆さの近くでは決まらないので更新しない）
      const n = this.climbN, F = this.bodyF;
      const v = Math.hypot(this.vx, this.vy, this.vz);
      if (hasInput && v > 0.2) {
        // 進む向きに垂直な面の向き 2 つ（n × v と その逆）のうち、いまの体の前に近い方
        let cx = n[1] * this.vz - n[2] * this.vy, cyy = n[2] * this.vx - n[0] * this.vz, cz = n[0] * this.vy - n[1] * this.vx;
        const cl = Math.hypot(cx, cyy, cz) || 1;
        cx /= cl; cyy /= cl; cz /= cl;
        if (cx * F[0] + cyy * F[1] + cz * F[2] < 0) { cx = -cx; cyy = -cyy; cz = -cz; }
        const sinA = (F[1] * cz - F[2] * cyy) * n[0] + (F[2] * cx - F[0] * cz) * n[1] + (F[0] * cyy - F[1] * cx) * n[2];
        const cosA = F[0] * cx + F[1] * cyy + F[2] * cz;
        rotateAbout(F, n, Math.atan2(sinA, cosA) * (1 - Math.exp(-6 * dt)));
      }
      this.headingFromFrame();
    } else if (this.frameMode) {
      // 起き上がっている途中：heading は rightUp が bodyF から決める
    } else if (hasInput && Math.hypot(this.vx, this.vz) > 0.2) {
      // 横歩き：移動方向の ±90° のうち、いまの向きに近い方へ体を回す
      const move = Math.atan2(this.vx, this.vz);
      const a = wrap(move + Math.PI / 2 - this.heading), b = wrap(move - Math.PI / 2 - this.heading);
      const d = Math.abs(a) < Math.abs(b) ? a : b;
      // 鋏で物を挟んでいる間はゆっくり向きを変える（速く回ると鋏の先が大きく振れ、物が振り落とされる）
      const turn = (this.grounded ? 7 : 3) * (inp.tow ? 0.35 : 1);
      if (inp.pivot && this.grounded && !this.ledge && !this.faceHint) {
        // 踏ん張り旋回：回る速さ（yawW）を目標へ寄せ、上限で切る。残りの角を越えては回さない
        // （上限は歩く速さで上げる：歩きながら大きく向きを変えるときは従来に近い速さで回り、体の向きが進む向きから遅れて脚が伸びきらない）
        const cap = PIVOT_TURN.max + PIVOT_TURN.walkAdd * clamp(Math.hypot(this.vx, this.vz) / this.walkSpeed, 0, 1);
        const want = clamp(d * turn, -cap, cap);
        this.yawW += (want - this.yawW) * (1 - Math.exp(-PIVOT_TURN.acc * dt));
        const step = this.yawW * dt;
        this.heading = wrap(this.heading + (Math.abs(step) > Math.abs(d) ? d : step));
      } else {
        this.yawW = 0;
        this.heading = wrap(this.heading + d * (1 - Math.exp(-turn * dt)));
      }
    } else this.yawW *= Math.exp(-dt * 20);
    if (this.digging || this.pulling || this.climbing || this.frameMode) this.yawW = 0;
    // 体の向き基準の速度（+x = 左, +z = 前）
    if (this.climbing || this.frameMode) {
      // 面の上（逆さを含む）：実際に動いた量を体の前（bodyF）と横（n × bodyF）へ分ける（脚が面に沿って進む向きへ振れる）
      const n = this.groundN, F = this.bodyF;
      const Lx = n[1] * F[2] - n[2] * F[1], Ly = n[2] * F[0] - n[0] * F[2], Lz = n[0] * F[1] - n[1] * F[0];
      this.localVX = mvx * Lx + mvy * Ly + mvz * Lz;
      this.localVZ = mvx * F[0] + mvy * F[1] + mvz * F[2];
    } else {
      const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
      this.localVX = mvx * ch - mvz * sh;
      this.localVZ = mvx * sh + mvz * ch;
      // 張り付いていない間の体の前（張り付いたとき・CrabRig の切り替えに使う）：heading の向きを groundN の面へ写したもの
      const f = rotateMin([sh, 0, ch], UP3, this.groundN);
      this.bodyF[0] = f[0]; this.bodyF[1] = f[1]; this.bodyF[2] = f[2];
    }

    // 歩行位相（脚 1 歩の振れ幅に合わせ、地面に対して足が滑らない速さ）
    if (this.grounded || this.climbing) this.stridePhase += (this.speed * dt) / (0.64 * (this.speed > 3.2 ? 0.1 : 0.075));

    // 状態
    // （生き物を引っ張っている間も歩行・待機のまま：脚は歩みに合わせて動き、踏ん張りは CrabRig が pulling で重ねる）
    if (ride) this.state = 'ride';
    else if (digging) this.state = 'dig';
    else if (this.climbing) this.state = 'climb';
    else if (this.swimming) this.state = 'swim';
    else if (this.grounded) this.state = this.speed < 0.25 ? 'idle' : this.speed < (this.walkSpeed + this.runSpeed) * 0.5 * lerp(1, 0.72, s) ? 'walk' : 'run';
    else if (this.sinking || (s > 0.5 && this.vy < 0)) this.state = 'sink';
    else this.state = this.vy > 0 ? 'jump' : 'fall';
  }

  // ---------------- 接地主導：崖・段差を降りる（CrabLedge） ----------------

  /**
   * 縁へ向かう速さ（縁の外向き e の成分）を抑える。縁に沿う向き・縁から離れる向きはそのまま（斜めに近づいても縁に沿って歩ける）。
   * - 段差で先頭の脚が下の足場に needDown 本以上掛かった・踏み出した後は抑えない
   * - それまでは、体の中心のはみ出しが上限（段差 = 身を乗り出す leanOver、崖・足場が無い = holdOver）に近づくほど遅く
   * - 脚で支えて胴体を下ろしている間は、下の隙間が大きいほど外へ進む速さを落とす（胴体だけが崖の先へ浮いて進まない）
   */
  private ledgeGate(inp: CrabInput) {
    const L = this.ledge!;
    const e = L.e;
    let ve = this.vx * e[0] + this.vz * e[2];
    if (ve <= 0) return;
    if (L.lowering && L.gap > 0.05) {
      const k = clamp(1 - L.gap / LEDGE.gapSlow, LEDGE.minK, 1);
      this.vx -= e[0] * ve * (1 - k);
      this.vz -= e[2] * ve * (1 - k);
      ve *= k;
    }
    if (L.stepOff) return;
    const S = inp.support;
    if (L.kind === 'step' && (S?.down ?? 0) >= LEDGE.needDown && (S?.planted ?? 0) >= 4) return;
    const maxOver = L.kind === 'step' ? LEDGE.leanOver : LEDGE.holdOver;
    const allow = Math.max(0, (maxOver - L.over) * LEDGE.approachK);
    if (ve > allow) {
      this.vx -= e[0] * (ve - allow);
      this.vz -= e[2] * (ve - allow);
    }
  }

  /**
   * 縁を越えた胴体を脚で支える（床に触れていない間。戻り値は体の中心の高さ）：
   * - 下の足場（縁より下）に脚が needDown 本以上掛かっていれば、下の足場へ descRate で下ろす
   * - 段差で身を乗り出しているだけ（下に掛かった脚が無い）なら、縁から leanDrop まで下げて支える
   * - どちらでもなければ支えない（落ちる。縁の状態は捨てる）
   * 支えている間は接地のまま（重力を掛けない・歩きの状態のまま）
   */
  private ledgeSupport(dt: number, inp: CrabInput, px: number, py: number, pz: number, wasGrounded: boolean): number {
    const L = this.ledge!;
    if (L.stepOff || this.grounded || this.swimming || this.vy > 0.5 || !(wasGrounded || L.lowering)) {
      L.lowering = false;
      return py;
    }
    const footY = py - RADIUS;
    const gap = gapBelow(this.world, px, footY, pz, 2.5);
    // 小さな隙間（下り坂・小さな段）は従来の吸着に任せる
    if (gap <= 0.06 && !L.lowering) return py;
    L.gap = gap;
    const S = inp.support;
    const down = S?.down ?? 0, planted = S?.planted ?? 0;
    const downOk = L.kind === 'step' && down >= LEDGE.needDown && planted >= 3;
    // （縁の角は急なので、縁で待っている体は床に触れていないことがある：はみ出しが上限の近くまでなら高さを保って支える）
    const leanOk = planted >= 3 && L.over <= (L.kind === 'step' ? LEDGE.leanOver : LEDGE.holdOver) + 0.05;
    // 支えが足りない：踏み替え・足場を探す間（接地が 2 本まで）は looseT まで待つ。それより長い・脚が無いなら落ちる
    const brief = planted >= 2;
    L.loose = downOk || leanOk ? 0 : L.loose + dt;
    if (!downOk && !leanOk && !(brief && L.loose < LEDGE.looseT)) {
      if (gap > 0.1) {
        this.ledgeStats.falls++;
        this.ledgeFall = { kind: L.kind, over: L.over, gap, down, planted, t: L.t };
      }
      this.ledge = null;
      return py;
    }
    // 下の足場に脚が掛かっていれば下ろす。身を乗り出しているだけ（縁の角に乗っている）・待っている間は高さを保つ
    if (downOk) {
      const dy = Math.min(gap, LEDGE.descRate * dt);
      py -= dy;
      this.ledgeStats.maxDescV = Math.max(this.ledgeStats.maxDescV, dy / dt);
    }
    L.lowering = true;
    this.grounded = true;
    this.vy = 0;
    return py;
  }

  /**
   * 縁の状態を進める（歩いている間。押し戻し・張り付きの判定のあと）：
   * - 歩き方が接地主導・水槽の中・接地（脚で支えているのを含む）・泳ぎ / 掘り / 引っ張り / 転倒 / 管の中でない、のときだけ
   * - 縁を越え始めたら（はみ出し > −0.02）探し直さない。下の足場に着いて縁から十分下りたら終わり。縁から離れたら捨てる
   * - まだ越えていなければ、1 フレームに 1 回、移動の向きの前方の縁を探す（同じ縁なら待った時間を続ける）
   * - 縁で押し続けている間：崖は側面に脚が掛かったら側面へ移る（startDescentClimb）。足場が見つからないまま
   *   holdT（足場が無い）/ holdTMax（段差・崖で脚が掛からない）経ったら踏み出す
   */
  private ledgeUpdate(dt: number, inp: CrabInput, px: number, py: number, pz: number, ux: number, uz: number, hasInput: boolean, digging: boolean, ride: boolean, first: boolean) {
    const ok = !!inp.lead && !this.climbing && !this.swimming && !ride && !digging && !this.pulling && this.tumbleT <= 0 && this.region === 'tank' && this.grounded;
    if (!ok) {
      this.ledge = null;
      return;
    }
    const w = this.world;
    const footY = py - RADIUS;
    let L = this.ledge;
    if (L) {
      if (first) L.t += dt;
      L.over = (px - L.lip[0]) * L.e[0] + (pz - L.lip[2]) * L.e[2];
      // （縁の角は急なので、体は縁の少し手前で止まることがある：0.1 手前まで来たら越え始めたとみなす）
      if (L.over > -0.1) L.committed = true;
      // 降り切った：脚で支えずに床に立っていて、縁から十分下
      // （体の下にまだ隙間があれば続ける：吸着で残りを一気に落とさない）
      if (!L.lowering && L.lip[1] - footY > Math.min(L.drop, LEDGE.stepMax) * 0.6 && gapBelow(w, px, footY, pz, 0.4) < 0.06) {
        this.ledgeStats.steps++;
        this.ledge = null;
        return;
      }
      // 縁から離れた・まだ越えていないのに押すのをやめた
      if (L.over < -0.6 || (!hasInput && !L.committed)) L = this.ledge = null;
    }
    // （縁が見えていない間は 3 フレームに 1 回：ダッシュでも 3 フレームで 0.22 しか進まず、探る範囲 0.48 の中）
    if (first && hasInput && (!L || !L.committed) && (L || ++this.ledgeScanN % 3 === 0)) {
      const r = scanLedge(w, px, footY, pz, ux, uz);
      if (!r || r.e[0] * ux + r.e[2] * uz < 0.2) {
        this.ledge = null;
        return;
      }
      const lip: [number, number, number] = [px + ux * r.a, r.lipY, pz + uz * r.a];
      const kind = r.drop <= LEDGE.stepMax ? 'step' : faceBelow(w, lip, r.e) ? 'climb' : 'none';
      if (L && Math.hypot(L.lip[0] - lip[0], L.lip[1] - lip[1], L.lip[2] - lip[2]) < 0.35) {
        // 同じ縁（近づくにつれて測り直す）
        L.lip.splice(0, 3, ...lip);
        L.e.splice(0, 3, ...r.e);
        L.drop = r.drop;
        L.kind = kind;
      } else {
        L = this.ledge = { e: r.e, lip, drop: r.drop, kind, over: 0, holdT: 0, stepOff: false, lowering: false, committed: false, t: 0, gap: 0, retry: 0, loose: 0, seek: true };
        this.ledgeStats.edges++;
      }
      L.over = (px - lip[0]) * r.e[0] + (pz - lip[2]) * r.e[2];
    }
    if (!L || L.stepOff) return;
    // 縁で押し続けている
    const into = hasInput ? ux * L.e[0] + uz * L.e[2] : 0;
    L.seek = into > 0.2;
    const S = inp.support;
    const down = S?.down ?? 0, face = S?.face ?? 0, planted = S?.planted ?? 0;
    const maxOver = L.kind === 'step' ? LEDGE.leanOver : LEDGE.holdOver;
    const freeStep = L.kind === 'step' && down >= LEDGE.needDown && planted >= 4;
    const holding = into > 0.4 && L.over > maxOver - 0.12 && !freeStep;
    if (!holding) {
      if (into <= 0.4) L.holdT = 0;
      return;
    }
    if (first) {
      L.holdT += dt;
      this.ledgeStats.holdT += dt;
    }
    L.retry = Math.max(0, L.retry - dt);
    // （崖の側面が斜めだと、縁より下に掛かった脚の面は「側面」の向きにならないことがある：縁より下の脚が多ければ同じ扱い）
    if (L.kind === 'climb' && L.retry <= 0 && (face >= LEDGE.needFace || down >= LEDGE.needFace + 1 || ((face >= 1 || down >= LEDGE.needFace) && L.holdT > LEDGE.holdFace))) {
      const path = descentPath(w, [px, py, pz], L.lip, L.e, RADIUS);
      if (path) {
        this.startDescentClimb(path, inp.cameraYaw);
        return;
      }
      L.retry = 0.2;
    }
    if (L.holdT > (L.kind === 'none' ? LEDGE.holdT : LEDGE.holdTMax)) {
      L.stepOff = true;
      this.ledgeStats.stepOffs++;
    }
  }

  /**
   * 崖を降り始める：いまの床の向きのまま張り付き、縁を回り込む道（descentPath）をゆっくりたどって側面へ移る
   * （体の向きは道の進み具合に合わせて床 → 側面へ回す）。着いたら壁登りのまま。スティックの写し方は床の向きから
   * 決めて面と一緒に回すので、押し続けた向き（崖の外へ）は「壁から離れる = 下」になる
   */
  private startDescentClimb(path: [number, number, number][], yaw: number) {
    const n0: [number, number, number] = [this.groundN[0], this.groundN[1], this.groundN[2]];
    this.beginClimb(n0, yaw);
    this.startMantle(path);
    const M = this.mantle!;
    M.sp = LEDGE.climbSpeed;
    M.n0 = n0;
    this.ledgeStats.climbs++;
    this.ledge = null;
  }

  // ---------------- 壁登り ----------------

  /**
   * 壁へ向かって押し続けたら張り付く（接地の判定・押し戻しのあと、張り付いていないときだけ呼ぶ）。
   * 条件：水槽の中・管の外・泳いでいない・掘っていない・跳び上がっている途中でない、移動入力がある、
   * 登れる面（climbSolid）に触れていて、その面が床とみなせない急な面（法線の y が floorNY 以下・張り出しは CLIMB_MIN_NY まで）、
   * 入力がその面へ向かっている（CLIMB_INTO 以上）。これが CLIMB_GRAB_T 続いたら張り付く（かすめただけでは張り付かない）。
   * 面の向きは、体の中心から入力の向きへ少し進めた所で測る（床と壁の隅では、中心の距離関数は床と壁のどちらとも言えないので、
   * 押している壁の側を選ぶ）。
   * 空中・水中（接地していない。泳いでいてもよい）では、張り出し・天井（法線の y < CEIL_GRAB_NY）に触れていて、移動入力か
   * ジャンプを押していれば張り付く（跳び上がって・泳いで流木の裏・トンネルの天井につかまる）。上向きに速く動いている間は待つ
   */
  private tryGrab(dt: number, inp: CrabInput, px: number, py: number, pz: number, mx: number, mz: number, mag: number, hasInput: boolean, floorNY: number, ride: boolean) {
    const w = this.world;
    this.grabWait = Math.max(0, this.grabWait - dt);
    const base = !ride && !inp.dig && this.region === 'tank' && this.vy < 2.5 && this.grabWait <= 0;
    if (!base || w.climbSolid(px, py, pz) > RADIUS + 0.05) {
      this.grabT = 0;
      return;
    }
    // 空中・水中から天井へ：触れている面の向きを体の中心で測る（入力の向きは天井の向きと関係ない）
    // （泳いでいる間はジャンプの長押し＝遊泳なので、それだけでは張り付かない：移動入力で天井へ向かったときだけ）
    const jumpIntent = inp.jumpHeld && !this.swimming;
    if (!this.grounded && this.coyote <= 0 && ((hasInput && mag > 0.3) || jumpIntent)) {
      const sn = this.surfaceNormal(px, py, pz);
      const n = sn.n;
      if (n[1] < CEIL_GRAB_NY) {
        // 狭い出っ張り（小石ほどの突起・岩の角）には張り付かない
        if (sn.cover < NORMAL_COVER_MIN) {
          if (this.grabT > 0) this.ceilStats.narrowSkips++;
          this.grabT = 0;
          return;
        }
        this.grabT += dt;
        // 張り付く意思：ジャンプを押している（跳んでつかまる）なら短く、移動入力だけなら長く触れ続けたとき
        if (this.grabT >= (jumpIntent ? CLIMB_GRAB_T : CEIL_GRAB_MOVE_T)) {
          this.ceilStats.grabsAir++;
          this.swimming = false;
          this.beginClimb(n, inp.cameraYaw);
        }
        return;
      }
    }
    const ok = hasInput && mag > 0.3 && !this.swimming;
    if (!ok) {
      this.grabT = 0;
      return;
    }
    const ux = mx / mag, uz = mz / mag;
    let n = w.climbNormal(px + ux * 0.1, py, pz + uz * 0.1);
    // 張り出した面（下向き）へ床から張り付くときは、平均した向きで決め、狭い出っ張りなら張り付かない
    if (n[1] < 0) {
      const sn = this.surfaceNormal(px + ux * 0.1, py, pz + uz * 0.1);
      if (sn.cover < NORMAL_COVER_MIN) {
        this.ceilStats.narrowSkips++;
        this.grabT = 0;
        return;
      }
      n = sn.n;
    }
    const hl = Math.hypot(n[0], n[2]);
    const into = hl > 1e-3 ? -(ux * n[0] + uz * n[2]) / hl : 0;
    const minNY = floorNY === DUG_FLOOR_NY ? GRAB_MIN_NY_DUG : GRAB_MIN_NY;
    if (n[1] >= Math.min(floorNY, 0.55) || n[1] < minNY || into < CLIMB_INTO) {
      this.grabT = 0;
      return;
    }
    // 接地主導（第 8 段階）：押し続けた時間ではなく、前の脚が壁に掛かってから張り付く
    if (inp.lead) {
      this.wallSeek(dt, px, py, pz, ux, uz, n, inp);
      return;
    }
    this.grabT += dt;
    if (this.grabT < CLIMB_GRAB_T) return;
    this.beginClimb(n, inp.cameraYaw);
  }

  /**
   * 面（法線 n）に張り付く：体の前 = いまの体の向き（heading・groundN から決まる向き、起き上がり途中なら bodyF）を面へ写したもの、
   * 入力の写し方 = いまのカメラと面から決めたもの
   */
  private beginClimb(n: readonly number[], cameraYaw: number) {
    this.grabT = 0;
    this.stuckT = 0;
    const from = this.frameMode ? this.groundN : null;
    const f = from ? rotateMin(this.bodyF, from, n) : rotateMin([Math.sin(this.heading), 0, Math.cos(this.heading)], UP3, n);
    this.climbing = true;
    this.frameMode = true;
    this.grounded = false;
    this.climbN[0] = n[0];
    this.climbN[1] = n[1];
    this.climbN[2] = n[2];
    this.bodyF.splice(0, 3, ...tangentUnit(f, n));
    this.camBasis(cameraYaw, this.moveF, this.moveR);
    this.idleT = 0;
    this.vx = this.vy = this.vz = 0;
    this.climbStats.grabs++;
  }

  // ---------------- 接地主導：壁登り・天井への移り（第 8 段階） ----------------

  /** 次の面の手がかりを出す（このフレームの間だけ残る。同じ面なら測り直すだけ） */
  private setFaceHint(kind: FaceKind, n: readonly number[], p: readonly number[], up: readonly number[], phase: 'seek' | 'move') {
    this.hintSeen = true;
    const H = this.faceHint;
    if (H && H.kind === kind && H.n[0] * n[0] + H.n[1] * n[1] + H.n[2] * n[2] > 0.9) {
      H.n.splice(0, 3, n[0], n[1], n[2]);
      H.p.splice(0, 3, p[0], p[1], p[2]);
      H.up.splice(0, 3, up[0], up[1], up[2]);
      H.phase = phase;
      return;
    }
    this.faceHint = { kind, n: [n[0], n[1], n[2]], p: [p[0], p[1], p[2]], up: [up[0], up[1], up[2]], phase, t: 0 };
    if (phase === 'seek') this.faceStats.seeks++;
  }

  /**
   * 床から壁へ（接地主導）：登れる急な面へ押している間、前の脚に壁の足場を探させ（次の面の手がかり）、壁に FACE.needNext 本以上・
   * 接地 FACE.needPlanted 本以上になったら移り始める（startXfer）。狭い出っ張り（まわりの点の多くが同じ面に触れていない）では探さない
   * （小石・岩の角に触れただけで体が起き上がらない）
   */
  private wallSeek(dt: number, px: number, py: number, pz: number, ux: number, uz: number, n: readonly number[], inp: CrabInput) {
    const w = this.world;
    const ax = px + ux * 0.1, az = pz + uz * 0.1;
    const sn = this.surfaceNormal(ax, py, az);
    if (sn.cover < 3) {
      this.faceStats.narrow++;
      return;
    }
    const d = w.climbSolid(ax, py, az);
    const pf = [ax - n[0] * d, py - n[1] * d, az - n[2] * d];
    const up = tangentUnit(this.groundN, n);
    this.setFaceHint('wall', n, pf, up, 'seek');
    this.wallHoldT = 0.12;
    this.wallHoldN.splice(0, 3, n[0], n[1], n[2]);
    const S = inp.support;
    // （従来と同じく CLIMB_GRAB_T 押し続けたときだけ：急な坂を走って越える途中で、足元の坂を「壁」として張り付かない）
    this.grabT += dt;
    if (this.grabT >= CLIMB_GRAB_T && (S?.next ?? 0) >= FACE.needNext && (S?.planted ?? 0) >= FACE.needPlanted) {
      this.startXfer('wall', [this.groundN[0], this.groundN[1], this.groundN[2]], n, pf, up, inp, [px, py, pz]);
    }
  }

  /** 面の移りを始める（床からなら、いまの床の向きのまま張り付く。体の向き・スティックの写し方は進み具合に合わせて面と一緒に回す） */
  private startXfer(kind: FaceKind, n0: [number, number, number], n1: readonly number[], pf: readonly number[], t1: readonly number[], inp: CrabInput, c0: [number, number, number]) {
    if (!this.climbing) this.beginClimb(n0, inp.cameraYaw);
    const S = inp.support;
    const c1: [number, number, number] = [pf[0] + n1[0] * RADIUS + t1[0] * 0.1, pf[1] + n1[1] * RADIUS + t1[1] * 0.1, pf[2] + n1[2] * RADIUS + t1[2] * 0.1];
    this.xfer = { kind, n0, n1: [n1[0], n1[1], n1[2]], t0: tangentUnit([-n1[0], -n1[1], -n1[2]], n0), t1: [t1[0], t1[1], t1[2]], c0, c1, pf: [pf[0], pf[1], pf[2]], p: 0, hold: 0, creep: 0, crept: false, loose: 0, t: 0, idle: 0 };
    this.faceStats.starts++;
    this.faceStats.startNext += S?.next ?? 0;
    this.faceStats.startPlanted += S?.planted ?? 0;
    this.setFaceHint(kind, n1, pf, t1, 'move');
  }

  /**
   * 面の移りの途中（climbMove の代わり）：
   * - 進み具合 p は、スティックが次の面へ向かっている（いまの面の上で t0 → t1 の向き）間だけ、次の面に掛かった脚の数の上限（faceCap）まで進む。
   *   上限で押し続けて FACE.creepAfter 経ったら、少しずつ上限を上げる（脚が掛からないまま詰まらない）。逆へ押せば戻り、0 で元の面へ戻る
   * - 体の向きは n0 → n1、体の中心は c0 → c1 を p に合わせて動かし、ほかの物から押し戻す
   * - 接地が 2 本未満の状態が FACE.looseT 続いたら支えを失う（床からなら床へ戻る、それ以外は離れて落ちる）
   */
  private xferMove(dt: number, inp: CrabInput, hasInput: boolean, cy: number): [number, number, number] {
    const X = this.xfer!;
    const w = this.world;
    X.t += dt;
    this.updateMoveBasis(dt, inp.cameraYaw, hasInput);
    const ix = inp.move.x, iy = inp.move.y;
    let Dx = this.moveR[0] * ix + this.moveF[0] * iy, Dy = this.moveR[1] * ix + this.moveF[1] * iy, Dz = this.moveR[2] * ix + this.moveF[2] * iy;
    const Dl = Math.hypot(Dx, Dy, Dz);
    if (Dl > 1) { Dx /= Dl; Dy /= Dl; Dz /= Dl; }
    if (!hasInput) Dx = Dy = Dz = 0;
    const g = tangentUnit([X.t0[0] * (1 - X.p) + X.t1[0] * X.p, X.t0[1] * (1 - X.p) + X.t1[1] * X.p, X.t0[2] * (1 - X.p) + X.t1[2] * X.p], this.climbN);
    let push = Dx * g[0] + Dy * g[1] + Dz * g[2];
    const S = inp.support;
    const next = S?.next ?? 0, planted = S?.planted ?? 0;
    let cap = Math.max(faceCap(next), X.creep);
    if (push > 0.3 && X.p >= cap - 0.005) {
      X.hold += dt;
      this.faceStats.waitT += dt;
      if (X.hold > FACE.creepAfter && planted >= 3) {
        if (!X.crept) this.faceStats.creeps++;
        X.crept = true;
        X.creep = Math.min(1, Math.max(X.creep, X.p) + FACE.creepRate * dt);
        cap = X.creep;
      }
    } else X.hold = 0;
    const rate = (1 / FACE.xferT) * (S ? Math.max(0.5, S.speed) : 1) * (inp.run ? 1.4 : 1);
    // スティックを離して（次の面へ向かう向きでなく）しばらく経ったら、近い方の端へゆっくり寄せる（途中の傾いた姿勢で止まらない。
    // 次の面の側へは脚が許す所まで）
    X.idle = Math.abs(push) > 0.3 ? 0 : X.idle + dt;
    let settle = 0;
    if (X.idle > FACE.settleAfter) settle = X.p >= 0.5 && cap >= 0.999 ? 0.5 : X.p < 0.5 ? -0.5 : 0;
    if (push > 0.3) X.p = Math.max(X.p, Math.min(cap, X.p + rate * Math.max(push, 0.75) * dt));
    else if (push < -0.3) X.p = Math.max(0, X.p + rate * push * dt);
    else if (settle > 0) X.p = Math.min(1, X.p + rate * settle * dt);
    else if (settle < 0) {
      X.p = Math.max(0, X.p + rate * settle * dt);
      if (X.p <= 0) push = -1;
    }
    X.loose = planted < 2 ? X.loose + dt : 0;
    const fromFloor = X.n0[1] > CLIMB_EXIT_NY - 0.1;
    if (X.loose > FACE.looseT || (X.p <= 0 && push < -0.3)) {
      // 支えを失った・戻った：床からなら床へ戻る。壁から（天井へ）なら、戻ったときは壁のまま、支えを失ったら離れて落ちる
      const back = X.loose <= FACE.looseT;
      if (back) this.faceStats.back++;
      else this.faceStats.aborts++;
      this.xfer = null;
      this.xferCool = FACE.cool;
      if (fromFloor && (back || X.p < 0.5)) {
        this.releaseClimb('exits');
        this.grounded = true;
        this.groundN.splice(0, 3, ...X.n0);
      } else if (back) this.setClimbN(X.n0[0], X.n0[1], X.n0[2]);
      else this.releaseClimb('drops');
      return [this.x, cy, this.z];
    }
    const a = smoothstep(0, 1, X.p);
    this.setClimbN(X.n0[0] + (X.n1[0] - X.n0[0]) * a, X.n0[1] + (X.n1[1] - X.n0[1]) * a, X.n0[2] + (X.n1[2] - X.n0[2]) * a);
    let px = X.c0[0] + (X.c1[0] - X.c0[0]) * a, py = X.c0[1] + (X.c1[1] - X.c0[1]) * a, pz = X.c0[2] + (X.c1[2] - X.c0[2]) * a;
    for (let it = 0; it < 4; it++) {
      const d = w.contactSolid(px, py, pz);
      if (d >= RADIUS) break;
      const m = w.contactNormal(px, py, pz);
      px += m[0] * (RADIUS - d);
      py += m[1] * (RADIUS - d);
      pz += m[2] * (RADIUS - d);
    }
    const idt = 1 / Math.max(dt, 1e-4);
    this.vx = (px - this.x) * idt;
    this.vy = (py - cy) * idt;
    this.vz = (pz - this.z) * idt;
    if (X.p >= 1) {
      // 移り終えた：次の面に張り付いたまま（床なら歩きへ戻る）。しばらく次の角を探さない（ヒステリシス）
      this.xfer = null;
      this.xferCool = FACE.cool;
      this.faceStats.done++;
      this.setClimbN(X.n1[0], X.n1[1], X.n1[2]);
      this.vx = this.vy = this.vz = 0;
      if (X.n1[1] > CLIMB_EXIT_NY) {
        this.releaseClimb('exits');
        this.grounded = true;
        this.groundN.splice(0, 3, ...X.n1);
      }
    } else this.setFaceHint(X.kind, X.n1, X.pf, X.t1, 'move');
    return [px, py, pz];
  }

  /**
   * 床・壁・天井（足先の組の面の向き。足先が 4 本未満なら体の面）。切り替えにヒステリシス：床 → 壁は法線の y < 0.45、壁 → 床は > 0.78、
   * 壁 → 天井は < −0.65、天井 → 壁は > −0.3（境界で行き来しない）
   */
  private updateSurf(S: CrabInput['support'] | null, dt: number) {
    // 足先の組の面の向き（4 本以上のときだけ。足先 3 本の面は踏み替えのたびに大きく振れる）を時間で平滑化してから決める
    // （丸い倒木の中のように、踏み替えのたびに足先の面が境界をまたいで振れる所でも行き来しない）
    const raw = S && (S.fnN ?? 0) >= 4 && S.fn ? S.fn : this.climbing ? this.climbN : this.groundN;
    const k = 1 - Math.exp(-dt * 6);
    const f = this.fnS;
    for (let i = 0; i < 3; i++) f[i] += (raw[i] - f[i]) * k;
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    const ny = f[1] / fl;
    const c = this.surf;
    let n: SurfClass = c;
    if (c === 'floor') {
      if (ny < 0.45) n = ny < -0.65 ? 'ceil' : 'wall';
    } else if (c === 'wall') {
      if (ny > 0.78) n = 'floor';
      else if (ny < -0.65) n = 'ceil';
    } else if (ny > -0.3) n = ny > 0.78 ? 'floor' : 'wall';
    if (n !== c) {
      this.surf = n;
      this.faceStats.surfSwitches++;
    }
  }

  private releaseClimb(why: 'exits' | 'jumps' | 'lost' | 'drops') {
    this.climbing = false;
    this.mantle = null;
    this.xfer = null;
    this.climbStats[why]++;
    // 床へ戻った：体の向きは heading・groundN（従来）へ。それ以外（落ちる・跳ぶ）は起き上がりながら（frameMode のまま）
    if (why === 'exits') this.frameMode = false;
    else this.headingFromFrame();
  }

  /**
   * いまの面（climbN）とカメラの向きから、スティックの前・右に当たる面に沿う向きを決める。
   * - 壁・緩い張り出し（法線の y > CEIL_RULE_NY）：従来の壁登りと同じ（水平の入力を「上 → 面の法線」の最小の回転で面へ写す
   *   = 壁へ向かう = 上、離れる = 下、沿う = 横）
   * - 天井・強い張り出し：カメラの前・右を面へ投影する（画面の前 = カメラから離れる向き、右 = 画面の右。カメラは傾かない）
   */
  private camBasis(yaw: number, F: [number, number, number], R: [number, number, number]) {
    const n = this.climbN;
    const f = [-Math.sin(yaw), 0, -Math.cos(yaw)], r = [Math.cos(yaw), 0, -Math.sin(yaw)];
    if (n[1] > CEIL_RULE_NY) {
      F.splice(0, 3, ...tangentUnit(rotateMin(f, UP3, n), n));
      R.splice(0, 3, ...tangentUnit(rotateMin(r, UP3, n), n));
    } else {
      F.splice(0, 3, ...tangentUnit(f, n));
      R.splice(0, 3, ...tangentUnit(r, n));
    }
  }

  /**
   * 張り付いている面の向きを n0 → n1 へ変える：体の前・入力の写し方を同じ回転で回す（平行移動。面に沿って回り込んでも、
   * 押している向き・体の向きが続く）
   */
  private setClimbN(a: number, b: number, c: number) {
    const n = this.climbN;
    const l = Math.hypot(a, b, c) || 1;
    const m = [a / l, b / l, c / l];
    for (const v of [this.bodyF, this.moveF, this.moveR]) v.splice(0, 3, ...tangentUnit(rotateMin(v, n, m), m));
    n[0] = m[0]; n[1] = m[1]; n[2] = m[2];
  }

  /** heading（面を床に起こした向きの方位）を bodyF から決める。真逆さの近く（決まらない所）では変えない */
  private headingFromFrame() {
    const n = this.frameMode || this.climbing ? (this.climbing ? this.climbN : this.groundN) : null;
    if (!n || n[1] < -0.9) return;
    const L = toSurfaceLocal(n, this.bodyF[0], this.bodyF[1], this.bodyF[2]);
    if (Math.hypot(L[0], L[2]) > 0.2) this.heading = Math.atan2(L[0], L[2]);
  }

  /**
   * 張り出し・天井から離れたあと（空中・水中）：体の上（groundN）を真上へ起こしていく。軸は体の前（真逆さのとき）か、
   * いまの上と真上の外積。体の前も同じ回転で回し、heading を合わせる。十分起きたら従来の体の向き（frameMode = false）へ
   */
  private rightUp(dt: number) {
    const g = this.groundN, F = this.bodyF;
    const ang = Math.acos(clamp(g[1], -1, 1));
    const step = Math.min(ang, Math.max(ang * (1 - Math.exp(-dt * 5)), dt * 1.5));
    // g × 上 = (−g.z, 0, g.x)：この軸のまわりに正の角度で回すと g は上へ近づく
    const ax = -g[2], az = g[0];
    const al = Math.hypot(ax, az);
    let axis: number[];
    if (al < 0.05) axis = F; // 真逆さ：体の前を軸に転がって起きる（前の向きは変わらない）
    else axis = [ax / al, 0, az / al];
    rotateAbout(g, axis, step);
    if (axis !== F) rotateAbout(F, axis, step);
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    g[0] /= gl; g[1] /= gl; g[2] /= gl;
    F.splice(0, 3, ...tangentUnit(F, g));
    this.headingFromFrame();
    if (g[1] > 0.5) this.frameMode = false;
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
  private tryMantleFromWalk(dt: number, px: number, py: number, pz: number, ux: number, uz: number, progress: boolean, yaw: number) {
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
    this.beginClimb(na, yaw);
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
   * - 張り出し・天井（真逆さ）まで回り込める：入力の写し方（moveF / moveR）と体の前は面に貼り付けて、面の向きが変わるたびに
   *   同じ回転で回す（updateMoveBasis・setClimbN）。凹んだ角（壁 → 天井）では、進む向きの少し先の面の向きも混ぜて、
   *   次の面へ早めに体を向ける（角で押し合って止まらない）。
   * - 押しても進めないまま CLIMB_STUCK_T 経ったら、縁を回り込む道（findMantle）を探す（継ぎ目の棚の段など）。
   */
  private climbMove(dt: number, inp: CrabInput, hasInput: boolean, s: number, cy: number): [number, number, number] {
    const w = this.world;
    const n = this.climbN;
    // 接地主導：面の移りの途中（床 → 壁・壁 → 天井）
    if (this.xfer) return this.xferMove(dt, inp, hasInput, cy);
    // 張り出しの縁を回り込んでいる途中：折れ線の道を一定の速さでたどる（入力では変えない）。体の傾きは回り込んだ先の面へ
    // （接地主導：道の先の面に掛かった脚の数で、道を進めてよい所を決める。脚が掛かるまで体は先へ進まない）
    const M = this.mantle;
    if (M) {
      let sp = M.sp ?? CLIMB_SPEED * 0.9;
      if (inp.lead) {
        const e = M.pts[M.pts.length - 1], b = M.pts[0];
        const pf = [e[0] - M.n[0] * RADIUS, e[1] - M.n[1] * RADIUS, e[2] - M.n[2] * RADIUS];
        const up = M.n0 ? tangentUnit([-M.n0[0], -M.n0[1], -M.n0[2]], M.n) : tangentUnit([e[0] - b[0], e[1] - b[1], e[2] - b[2]], M.n);
        this.setFaceHint('mantle', M.n, pf, up, 'move');
        const S = inp.support;
        let cap = Math.max(faceCap(S?.next ?? 0), M.creep ?? 0);
        const frac = M.s / Math.max(M.len, 1e-4);
        if (frac >= cap - 0.005) {
          M.hold = (M.hold ?? 0) + dt;
          this.faceStats.waitT += dt;
          if (M.hold > FACE.creepAfter && (S?.planted ?? 0) >= 3) {
            if (!M.crept) this.faceStats.creeps++;
            M.crept = true;
            M.creep = Math.min(1, Math.max(M.creep ?? 0, frac) + FACE.creepRate * dt);
            cap = M.creep;
          }
        } else M.hold = 0;
        // 進めてよい所（cap = 1 なら終わりまで）より先へは進めない（戻しもしない）
        const sMax = cap >= 0.999 ? M.len : cap * M.len;
        M.s = Math.max(M.s, Math.min(sMax, M.s + sp * (S ? Math.max(0.5, S.speed) : 1) * dt));
      } else M.s = Math.min(M.len, M.s + sp * dt);
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
      if (M.n0) {
        // 崖を降り始める道：縁を越える分だけ体を側面へ向ける（進み具合に合わせる。縁の上で急に回らない）
        const f = smoothstep(0.15, 0.95, M.s / M.len);
        this.setClimbN(M.n0[0] + (M.n[0] - M.n0[0]) * f, M.n0[1] + (M.n[1] - M.n0[1]) * f, M.n0[2] + (M.n[2] - M.n0[2]) * f);
      } else {
        const kn = 1 - Math.exp(-dt * 8);
        this.setClimbN(n[0] + (M.n[0] - n[0]) * kn, n[1] + (M.n[1] - n[1]) * kn, n[2] + (M.n[2] - n[2]) * kn);
      }
      if (M.s < M.len) return q;
      // 着いた：その面に張り付き直す（緩い面なら下の判定で歩きへ戻る）
      this.mantle = null;
      this.vx = this.vy = this.vz = 0;
      this.setClimbN(M.n[0], M.n[1], M.n[2]);
      this.x = q[0];
      this.z = q[2];
      cy = q[1];
    }
    // スティックの前・右 → 面に沿う向き（押している間は面に貼り付けた向き、離したらカメラから決め直す）
    this.updateMoveBasis(dt, inp.cameraYaw, hasInput);
    const ix = inp.move.x, iy = inp.move.y;
    let Dx = this.moveR[0] * ix + this.moveF[0] * iy, Dy = this.moveR[1] * ix + this.moveF[1] * iy, Dz = this.moveR[2] * ix + this.moveF[2] * iy;
    const Dl = Math.hypot(Dx, Dy, Dz);
    if (Dl > 1) { Dx /= Dl; Dy /= Dl; Dz /= Dl; }
    if (!hasInput) Dx = Dy = Dz = 0;
    const sp = (inp.run ? CLIMB_RUN : CLIMB_SPEED) * lerp(1, 0.85, s) * (inp.support ? Math.max(0.5, inp.support.speed) : 1) * (inp.lead ? this.lagK : 1);
    const k = 1 - Math.exp(-(hasInput ? 12 : 18) * dt);
    this.vx += (Dx * sp - this.vx) * k;
    this.vy += (Dy * sp - this.vy) * k;
    this.vz += (Dz * sp - this.vz) * k;
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
    // 面の向き：まわりの点の法線を平均する（小さな出っ張り・くぼみで体の向きが跳ねない）
    const sn = this.surfaceNormal(px, py, pz);
    const m = sn.n;
    let cover = sn.cover;
    // 凹んだ角：進む向きの少し先に別の面があれば、その面の向きも混ぜる（壁を登って天井に頭が当たったら、天井の向きへ早めに起こす）
    const vl = Math.hypot(this.vx, this.vy, this.vz);
    // （接地主導：次の面の手前で待っている間は速さが 0 に近いので、押している向きで探す）
    const DL = Math.hypot(Dx, Dy, Dz);
    const look = vl > 0.3 ? [this.vx / vl, this.vy / vl, this.vz / vl] : inp.lead && DL > 0.3 ? [Dx / DL, Dy / DL, Dz / DL] : null;
    let corner: { n1: [number, number, number]; pf: [number, number, number] } | null = null;
    if (look) {
      const ax = px + look[0] * 0.16, ay = py + look[1] * 0.16, az = pz + look[2] * 0.16;
      const da = w.climbSolid(ax, ay, az);
      if (da < RADIUS + 0.04) {
        const sa = this.surfaceNormal(ax, ay, az);
        const ma = sa.n;
        // （FACE.giveUp 探しても脚が次の面に掛からなければ、従来どおり向きを混ぜて回り込む：脚の届かない角で詰まらない）
        const H = this.faceHint;
        const gaveUp = !!H && H.phase === 'seek' && H.kind !== 'mantle' && H.t > FACE.giveUp && H.n[0] * ma[0] + H.n[1] * ma[1] + H.n[2] * ma[2] > 0.8;
        if (gaveUp) {
          // 手がかりは残す（次のフレームにまた探し始めない）
          this.setFaceHint(H.kind, H.n, H.p, H.up, 'seek');
          if (this.gaveUpHint !== H) this.faceStats.giveUps++;
          this.gaveUpHint = H;
        }
        if (inp.lead && !gaveUp && ma[0] * n[0] + ma[1] * n[1] + ma[2] * n[2] < FACE.cornerDot) {
          // 接地主導：凹んだ角（壁 → 天井・壁 → 床）。体の向きは混ぜず、脚が次の面に掛かるまで次の面の手前で待つ（広い面だけ。狭い出っ張りは無視）
          if (this.xferCool <= 0 && sa.cover >= NORMAL_COVER_MIN) corner = { n1: ma, pf: [ax - ma[0] * da, ay - ma[1] * da, az - ma[2] * da] };
          else if (sa.cover < NORMAL_COVER_MIN) this.faceStats.narrow++;
        } else {
          const wgt = clamp((RADIUS + 0.04 - da) / 0.12, 0, 1);
          for (let q = 0; q < 3; q++) m[q] += ma[q] * wgt;
          const ml = Math.hypot(m[0], m[1], m[2]) || 1;
          m[0] /= ml; m[1] /= ml; m[2] /= ml;
          cover = Math.max(cover, sa.cover);
        }
      }
    }
    if (corner) {
      const n1 = corner.n1, pf = corner.pf;
      // 次の面の手前（体の中心から面まで 半径 + holdGap）より近づかない
      const dpl = (px - pf[0]) * n1[0] + (py - pf[1]) * n1[1] + (pz - pf[2]) * n1[2];
      const lim = RADIUS + FACE.holdGap;
      if (dpl < lim) {
        px += n1[0] * (lim - dpl);
        py += n1[1] * (lim - dpl);
        pz += n1[2] * (lim - dpl);
        const vin = this.vx * n1[0] + this.vy * n1[1] + this.vz * n1[2];
        if (vin < 0) {
          this.vx -= n1[0] * vin;
          this.vy -= n1[1] * vin;
          this.vz -= n1[2] * vin;
        }
      }
      const t1 = tangentUnit(n, n1);
      const kind: FaceKind = n1[1] < CEIL_GRAB_NY ? 'ceil' : 'wall';
      this.setFaceHint(kind, n1, pf, t1, 'seek');
      const S = inp.support;
      if ((S?.next ?? 0) >= FACE.needNext && (S?.planted ?? 0) >= FACE.needPlanted) {
        this.startXfer(kind, [n[0], n[1], n[2]], n1, pf, t1, inp, [px, py, pz]);
        return [px, py, pz];
      }
    }
    // 接地主導：体の面（m）と、接地している足先の組の面の向きの差が大きい（凸の角を回り込んで、脚がまだ元の面にある）間は遅くする
    if (inp.lead) {
      const S = inp.support;
      if (S && (S.fnN ?? 0) >= 4 && S.fn) {
        const ang = (Math.acos(clamp(m[0] * S.fn[0] + m[1] * S.fn[1] + m[2] * S.fn[2], -1, 1)) * 180) / Math.PI;
        this.lagK = clamp(1 - (ang - FACE.lagDeg) / FACE.lagSpan, FACE.lagMin, 1);
      } else this.lagK = 1;
    }
    // 狭い出っ張り（cover が小さい）の上では、張り出した向きへは起こさない（かすめた突起で裏返らない）。
    // 広い張り出し・天井へは、位置が面に沿って回り込むのに合わせて向きも変える（体の向きが実際の面から遅れない）
    const narrowFlip = cover < NORMAL_COVER_MIN && m[1] < INVERT_NY && n[1] >= INVERT_NY;
    if (narrowFlip) this.ceilStats.narrowSkips++;
    // 押しても進めない（凹凸に引っかかった・継ぎ目の棚の段）：しばらく続いたら縁を回り込む道を探す
    const moved = Math.hypot(px - this.x, py - cy, pz - this.z);
    this.stuckT = hasInput && moved < 0.25 * sp * dt ? this.stuckT + dt : 0;
    if (m[1] <= CLIMB_EXIT_NY) this.exitWait = 0;
    // （接地主導で次の面の手前で待っているのは、詰まり（縁を回り込む道を探す）に数えない）
    if (corner) this.stuckT = 0;
    if (d > RADIUS + 0.12) {
      // 面を失った：少し離れる向きへ押して落ちる
      this.vx += n[0] * 0.4;
      this.vy += Math.min(0, n[1]) * 0.4;
      this.vz += n[2] * 0.4;
      this.releaseClimb('lost');
    } else if (this.stuckT > CLIMB_STUCK_T && n[1] > CEIL_GRAB_NY) {
      this.stuckT = 0;
      this.climbStats.blocked++;
      const path = this.findMantle(px, py, pz, n);
      if (path) this.startMantle(path);
    } else if (m[1] > CLIMB_EXIT_NY && this.exitOk(inp, dt)) {
      // 床とみなせる面へ来た：歩きへ戻る
      this.releaseClimb('exits');
      this.grounded = true;
      this.groundN[0] = m[0];
      this.groundN[1] = m[1];
      this.groundN[2] = m[2];
      if (this.vy > 0) this.vy = 0;
    } else if (!narrowFlip) {
      // 接地主導：体の面は、接地している足先の組の面から FACE.leadDeg より先へは回さない（丸い洞窟・倒木の中のように、少しずつ曲がる
      // 面では角として移りを始めないので、脚が次の面へ踏み替えてから体が回り込む）
      const S = inp.support;
      if (inp.lead && S && (S.fnN ?? 0) >= 4 && S.fn) {
        const f = S.fn;
        const c = clamp(m[0] * f[0] + m[1] * f[1] + m[2] * f[2], -1, 1);
        const ang = Math.acos(c), maxA = (FACE.leadDeg * Math.PI) / 180;
        if (ang > maxA && ang < Math.PI - 0.05) {
          const s0 = Math.sin(ang), ka = Math.sin(ang - maxA) / s0, kb = Math.sin(maxA) / s0;
          for (let q = 0; q < 3; q++) m[q] = f[q] * ka + m[q] * kb;
          this.faceStats.footLedT += dt;
        }
      }
      this.turnClimbN(m, dt);
    }
    return [px, py, pz];
  }

  /**
   * 歩きへ戻ってよいか（接地主導：体の面だけでなく、足先の組の面も床（法線の y > 0.5）になってから。凸の角を越えて上の床へ出るとき、
   * 脚がまだ壁にある間は張り付いたまま。0.5 秒待っても足先の面が床にならなければ戻る）
   */
  private exitOk(inp: CrabInput, dt: number): boolean {
    const S = inp.support;
    if (!inp.lead || !S || (S.fnN ?? 0) < 4 || !S.fn || S.fn[1] > 0.5 || this.exitWait > 0.5) {
      this.exitWait = 0;
      return true;
    }
    if (this.exitWait === 0) this.faceStats.exitHeld++;
    this.exitWait += dt;
    return false;
  }

  /**
   * 張り付いている面の向きを目標 m へ寄せる：なめらかに追うが、1 秒あたり CLIMB_TURN_RATE ラジアンより速くは回さない
   * （壁から天井へ回り込むとき、体が自然に起き上がる。面が切り替わる瞬間に向きが跳ねない）
   */
  private turnClimbN(m: readonly number[], dt: number) {
    const n = this.climbN;
    const c = clamp(n[0] * m[0] + n[1] * m[1] + n[2] * m[2], -1, 1);
    const ang = Math.acos(c);
    if (ang < 1e-4) return;
    let step = ang * (1 - Math.exp(-dt * 14));
    if (step > CLIMB_TURN_RATE * dt) {
      step = CLIMB_TURN_RATE * dt;
      this.ceilStats.turnCapped++;
    }
    // 回転の軸 n × m（ほぼ逆向きなら、体の前を軸に）
    let ax = n[1] * m[2] - n[2] * m[1], ay = n[2] * m[0] - n[0] * m[2], az = n[0] * m[1] - n[1] * m[0];
    let al = Math.hypot(ax, ay, az);
    if (al < 1e-5) {
      [ax, ay, az] = this.bodyF;
      al = Math.hypot(ax, ay, az) || 1;
    }
    const v = [n[0], n[1], n[2]];
    rotateAbout(v, [ax / al, ay / al, az / al], step);
    this.setClimbN(v[0], v[1], v[2]);
  }

  /**
   * 面の向きを、点のまわりで平均して測る：中心と、面に沿って NORMAL_SAMPLE_R 離れた 6 点のうち、面の近くにある点の法線の平均。
   * cover = 中心の法線とそろう（0.7 以上）面に触れている点の数（中心を含め最大 7。小さいほど狭い出っ張り）
   */
  surfaceNormal(px: number, py: number, pz: number): { n: [number, number, number]; cover: number } {
    const w = this.world;
    const n0 = w.climbNormal(px, py, pz);
    const t1 = tangentUnit(Math.abs(n0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n0);
    const t2: [number, number, number] = [n0[1] * t1[2] - n0[2] * t1[1], n0[2] * t1[0] - n0[0] * t1[2], n0[0] * t1[1] - n0[1] * t1[0]];
    let sx = n0[0], sy = n0[1], sz = n0[2], cover = 1;
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3, ca = Math.cos(a) * NORMAL_SAMPLE_R, sa = Math.sin(a) * NORMAL_SAMPLE_R;
      const qx = px + t1[0] * ca + t2[0] * sa, qy = py + t1[1] * ca + t2[1] * sa, qz = pz + t1[2] * ca + t2[2] * sa;
      if (w.climbSolid(qx, qy, qz) > RADIUS + 0.1) continue;
      const m = w.climbNormal(qx, qy, qz);
      sx += m[0];
      sy += m[1];
      sz += m[2];
      if (m[0] * n0[0] + m[1] * n0[1] + m[2] * n0[2] > 0.7) cover++;
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    return { n: [sx / l, sy / l, sz / l], cover };
  }

  /**
   * 張り付いている間の入力の写し方：離して REANCHOR_T 経ったら、いまのカメラと面から決め直す。押している間は面に貼り付けたまま
   * （setClimbN が回す）だが、決め直した向きと前・右ともに 60° 以内なら少しずつ寄せる（カメラを回したときに追う。
   * 天井へ回り込んだ直後のように反対向きなら、離すまで寄せない＝押している向きが反転しない）
   */
  private updateMoveBasis(dt: number, yaw: number, hasInput: boolean) {
    const F = this.moveF, R = this.moveR;
    const cf: [number, number, number] = [0, 0, 1], cr: [number, number, number] = [1, 0, 0];
    this.camBasis(yaw, cf, cr);
    if (!hasInput) {
      this.idleT += dt;
      if (this.idleT >= REANCHOR_T) {
        F.splice(0, 3, ...cf);
        R.splice(0, 3, ...cr);
      }
      return;
    }
    this.idleT = 0;
    if (F[0] * cf[0] + F[1] * cf[1] + F[2] * cf[2] > 0.5 && R[0] * cr[0] + R[1] * cr[1] + R[2] * cr[2] > 0.5) {
      const k = 1 - Math.exp(-dt * 3);
      const n = this.climbN;
      for (const [v, c] of [[F, cf], [R, cr]] as const) {
        v.splice(0, 3, ...tangentUnit([v[0] + (c[0] - v[0]) * k, v[1] + (c[1] - v[1]) * k, v[2] + (c[2] - v[2]) * k], n));
      }
    }
  }

  /** 見た目側が出来事を受け取る（受け取ったら空にする） */
  drainEvents(): CrabEvent[] {
    return this.events.splice(0, this.events.length);
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

const UP3: readonly number[] = [0, 1, 0];

/**
 * 単位ベクトル a を b へ重ねる最小の回転（軸 a × b）で v を回したもの（Rodrigues の式）。a と b がほぼ逆向き（回す軸が
 * 決まらない）ときは、a に垂直な軸（v に近い向きを避けて選ぶ）で半回転する
 */
export function rotateMin(v: readonly number[], a: readonly number[], b: readonly number[]): [number, number, number] {
  let kx = a[1] * b[2] - a[2] * b[1], ky = a[2] * b[0] - a[0] * b[2], kz = a[0] * b[1] - a[1] * b[0];
  const s = Math.hypot(kx, ky, kz), c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (s < 1e-6) {
    if (c > 0) return [v[0], v[1], v[2]];
    // 逆向き：a に垂直な軸で半回転
    const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    kx = a[1] * t[2] - a[2] * t[1]; ky = a[2] * t[0] - a[0] * t[2]; kz = a[0] * t[1] - a[1] * t[0];
    const l = Math.hypot(kx, ky, kz);
    const out: [number, number, number] = [v[0], v[1], v[2]];
    rotateAbout(out, [kx / l, ky / l, kz / l], Math.PI);
    return out;
  }
  kx /= s; ky /= s; kz /= s;
  const kv = kx * v[0] + ky * v[1] + kz * v[2];
  const cx = ky * v[2] - kz * v[1], cy = kz * v[0] - kx * v[2], cz = kx * v[1] - ky * v[0];
  return [v[0] * c + cx * s + kx * kv * (1 - c), v[1] * c + cy * s + ky * kv * (1 - c), v[2] * c + cz * s + kz * kv * (1 - c)];
}

/** v（書き換える）を単位ベクトルの軸 k のまわりに角度 a だけ回す */
function rotateAbout(v: number[], k: readonly number[], a: number) {
  const c = Math.cos(a), s = Math.sin(a);
  const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cx = k[1] * v[2] - k[2] * v[1], cy = k[2] * v[0] - k[0] * v[2], cz = k[0] * v[1] - k[1] * v[0];
  const x = v[0] * c + cx * s + k[0] * kv * (1 - c), y = v[1] * c + cy * s + k[1] * kv * (1 - c), z = v[2] * c + cz * s + k[2] * kv * (1 - c);
  v[0] = x; v[1] = y; v[2] = z;
}

/** v を法線 n の面へ投影して単位にしたもの（ほぼ n と平行で決まらなければ、n に垂直な適当な向き） */
function tangentUnit(v: readonly number[], n: readonly number[]): [number, number, number] {
  const d = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  let x = v[0] - n[0] * d, y = v[1] - n[1] * d, z = v[2] - n[2] * d;
  let l = Math.hypot(x, y, z);
  if (l < 1e-5) {
    const t = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
    x = t[0] - n[0] * e; y = t[1] - n[1] * e; z = t[2] - n[2] * e;
    l = Math.hypot(x, y, z);
  }
  return [x / l, y / l, z / l];
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
