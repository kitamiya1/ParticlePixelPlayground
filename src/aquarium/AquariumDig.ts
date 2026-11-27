// カニの穴掘り（ゲームロジック側。Three.js に依存しない）。
// 方式：高さ場（AquariumWorld の 0.2 間隔の底床）はそのまま残し、掘った空洞だけを 3 次元の SDF で持つハイブリッド。
// - 空洞 = 平らな床を付けたカプセル（球はカプセルの両端が同じ点のもの）の集まり。1 回かき出すたびに 1 個足すか、
//   直前のものを伸ばす・太らせる（掘り続けると徐々に広がる）。
// - 砂（底床）の距離 d に対して smax(d, −空洞, RIM_K) を取る（cut）。縁は丸く盛り上がらずに落ち込む。
//   AquariumWorld.solid がこれを使うので、カニ・カメラ・泡・日照の当たり判定は自動で掘った形に従う。
// - 岩・流木・ガラス・底板・管は solid / contactSolid で砂のあとに min するので削れない。
//   さらに空洞自体を、水槽の底の少し上・ガラスの内側の面の外・縦の管のまわりの区画・発見物のまわりで打ち切る（clip）。
//   ガラス際はガラスの内側の面まで掘れる（ガラス越しに穴の中が見える。ガラス際の断面は描画側が区画ごとに作り直す）。
// - 見た目：水槽を 1×1 の区画（高さ場 5 マス分）に分け、空洞が触れた区画だけを「汚れた」印にする。
//   描画側（AquariumDigFx）がその区画の高さ場の三角形を隠し、同じ関数を Surface Nets（MeshBuild）で三角形にし直す。
// - 見た目と当たり判定を同じ瞬間に変える（2 つの版）：かき出し（stroke）が書き換えるのは「最新の形」だけ。
//   描画側は作り直しを始めるときに最新の形を写し（snapshot = 'snap' の版）、その版で区画を何フレームかかけて
//   三角形にし、全部できたら同時に差し替えて commit する（'snap' → 'live'）。当たり判定（solid・カメラ・照準）は
//   'live' の版だけを見るので、見た目のメッシュがまだ無い空洞にカニ・カメラが入らない
//   （入ると、見た目では固体の中＝裏面しか描かれず、向こう側が透けて見える）。
//
// 空洞の値は、近くに空洞が無い所では PAD（下限）を返す。区画ごとの登録は空洞の外接箱 + PAD で行うので、
// PAD より近い空洞は必ず登録されていて、どの場所でも値は「真の距離以下」になる（球の追跡・Surface Nets の間引きが安全）。
//
// 盛った砂（M2）：掘った空洞と同じ並び（prims）に、盛った砂の形（球。fill = 1）も編集の順に入れる。
// - 合成の順序：元の砂（高さ場）→ 編集を順にたどる。同じ種類が続く間（層 layer）はまとめて滑らかに合わせ、
//   掘った層は carveSand（従来の削り方）、盛った層は smin（砂を足す。FILL.blendK で地面・隣の砂山となじむ）で当てる。
//   層は「種類が変わるたびに 1 増える番号」で、空洞・砂山ごとに足したときに決まる（あとで太らせても変わらない）。
//   これで「先に掘った穴の中へ砂を置く」（掘った層のあとの盛った層）・「置いた砂を再び掘る」（盛った層のあとの掘った層）
//   が、どちらも後の編集が勝つ形になる。掘るだけのとき（層が 1 つ）は、従来とまったく同じ値になる。
// - 区画ごとの一覧は番号順なので、同じ層の物は一覧の中で続いて並ぶ（区画をまたいでも層の番号は同じ＝境目で値が食い違わない）。
// - 盛った砂も打ち切り（clip：ガラスの面の外・管の区画・発見物のまわり・底）の外にだけできる（保護する物を貫かない）。
// - 版（live / snap）・区画の作り直しの印・保存の並びは、掘った空洞と同じ仕組みを通す。

import { clamp } from '../core/math';
import { smin } from '../visual/sdf/sdf';
import { TANK } from './aquaConst';

type V3 = [number, number, number];

/** 穴掘りの寸法（ワールド単位。カニの脚を広げた幅が約 0.9、当たり判定の球の半径 0.24） */
export const DIG = {
  /** 区画の一辺（高さ場 5 マス分）と、区画を三角形にする Surface Nets の格子 */
  chunk: 1.0,
  cell: 0.1,
  /** 1 回目のかき出しの半径 → 1 回ごとに grow ずつ広がり、rMax で止まる */
  rMin: 0.3,
  rMax: 0.58,
  grow: 0.07,
  /** 平らな床：中心から r × floorK 下。rMax のとき床の幅 ≈ 1.04（脚を広げても入る）、高さ ≈ 0.84 */
  floorK: 0.45,
  /** 掘れる距離（体の中心から） */
  reach: 1.05,
  /** 地表から斜め下へ掘るときの、足元の深さの目標（これより深くなったら水平に掘る） */
  tunnelDepth: 1.15,
  /**
   * 水槽の底（ガラス）の上に残す砂の厚み・ガラス際の打ち切り（ガラスの内側の面からの距離。負 = 面の外まで空洞にしてよい）。
   * ガラス際は内側の面の外（0.12。ガラスの厚みの中）まで空洞を作る：ガラスの内側の面まで穴が届き、外からガラス越しに穴の中が見える。
   * 面の外の空洞の端（ガラスの裏の砂の壁）は、ガラスに押し付けたカニの体から 0.36 離れるので、壁登りで張り付けない
   * （AquariumWorld.climbSolid はガラスの面で切らない）
   * （アリの巣の観察ケースのように）。ガラス自体は contactSolid の当たり判定で残るので、削れず・越えられない。
   * 面の外の空洞は見た目では断面（buildDigChunk のガラスの面）で切り、当たり判定ではガラスに隠れる
   */
  floorClip: TANK.floorY + 0.3,
  glassClip: -0.12,
  /**
   * 地表と空洞のつなぎの丸み・空洞どうしのつなぎの丸み。空洞どうしの継ぎ目（砂が空洞の側へ尖った稜線）は、
   * Surface Nets（格子 0.1）では頂点が平均されて丸まるので、距離関数の側も格子に見合うだけ丸める
   * （0.08 では稜線が三角形より 0.01〜0.03 内側へ尖り、かすめる向きで見た目と当たり判定が食い違った）。
   * carve は外接箱から 0.3 より離れた空洞を箱までの距離で済ませるので、unionK は 0.3 より小さくしておく
   */
  rimK: 0.12,
  unionK: 0.2,
  /** 何回まで空洞を足せるか（超えたら古い区画をまとめ直さず、それ以上は太らせるだけ） */
  maxPrims: 6000,
} as const;

/**
 * 盛った砂の寸法：1 回目の砂山の半径 → 続けて同じ所へ盛ると grow ずつ大きく、rMax で止まる（その上へ次の砂山を足す）。
 * 砂山の中心は、置いた所（面）から半径 × sink だけ面の内側（ドーム状に盛り上がる）。blendK = 元の砂・下の砂山とのなじませ。
 * reach = 盛れる距離（体の中心から）。pitch = 照準を上下へずらしていないときの向き（掘るより浅い斜め下：体から離れた所へ盛る）
 */
export const FILL = {
  // 第 10 段階：1 回の量を増やす（rMin 0.2 → 0.22・grow 0.05 → 0.08・rMax 0.42 → 0.56。保存の検証の半径の上限 DIG.rMax 0.58 以下）。
  // 1 回たたくと小さな砂山（小さな所を埋める）、押し続けると大きく・横に広い砂山（カプセル。wMax まで左右へ伸ばす）になり、
  // いっぱいになったら上へ rStack から積む（つながった砂山・幅のある足場）
  rMin: 0.22,
  rMax: 0.56,
  grow: 0.08,
  rStack: 0.34,
  /** 押し続けて大きくした砂山を、盛る向きに垂直な横へ伸ばす長さの半分の上限（半径が rMin → rMax の間に 0 → wMax） */
  wMax: 0.34,
  sink: 0.45,
  blendK: 0.22,
  reach: 1.5,
  pitch: -0.3,
  /**
   * 体・仲間から砂山の面まで空けておく距離（なじませのふくらみの分を含む）。第 10 段階：0.1 → 0.2（砂山どうしのなじませ unionK と
   * 地面とのなじませ blendK が重なると 0.1 ほどふくらみ、押し続けるとカニが砂山に囲まれて 0.1 めり込んだまま動けなくなった）
   */
  clearance: 0.2,
  /** 砂山の体積のうち、地面の上へ出る分の見積もり（手持ちの砂で盛れる大きさの上限を決める。実際に使う量は測った体積） */
  aboveK: 0.6,
} as const;

/**
 * 手持ちの砂：表示の 1 杯の体積・1 回盛るのに要る最小の量・保存データの検証で受け付ける上限（水槽の砂の全部より十分大きい）。
 * 第 10 段階：持てる量の上限（以前の capacity 4。超えた分は捨てていた）をなくした。掘った砂は全部手持ちになり、盛ると測った体積だけ減る
 */
export const SAND = {
  unit: 0.05,
  minPlace: 0.02,
  maxStore: 100000,
} as const;

/** 砂山（両端 a, b・半径 r のカプセル）の体積 */
export function fillVolume(r: number, halfLen: number): number {
  return (4 / 3) * Math.PI * r * r * r + 2 * Math.PI * r * r * halfLen;
}

/** 半径 r の砂山を横へ伸ばす長さの半分（押し続けて大きくなるほど幅が広い） */
export function fillWidth(r: number): number {
  return FILL.wMax * clamp((r - FILL.rMin) / (FILL.rMax - FILL.rMin), 0, 1);
}

/** 盛る計画の結果（a, b = 砂山の両端・c = 中心・r = 半径・grow = 大きくする砂山の番号（新しく足すなら −1）・add = 増える体積の見積もり） */
export interface FillPlan {
  a: V3;
  b: V3;
  c: V3;
  r: number;
  grow: number;
  add: number;
  why: DigMaterial | 'near' | 'empty' | null;
}

/** 砂山の両端 a, b・半径 r に許す半径の上限（カニ・仲間を埋めない。呼ぶ側が決める） */
export type FillMaxR = (a: V3, b: V3, r: number) => number;

/** 盛る所のまわり（呼ぶ側が決める）：積む砂山の上の端の上限（カニの足元 + 登れる高さ）・(x, y, z) から真下の面の高さ */
export interface FillEnv {
  topMax?: number;
  /** いまの地形の距離（負 = 固体の中）。もう砂の中になる所には新しい砂山を置かない */
  solid?: (x: number, y: number, z: number) => number;
  surf?: (x: number, y: number, z: number) => number;
}

/** 近くに空洞が無いときの下限（区画への登録の余白と同じ） */
const PAD = 0.45;
/** 打ち切り（clip）を調べるのは空洞の値がこれより小さい所だけ */
const CLIP_NEAR = 0.4;
/**
 * 空洞と元の地表の間に残る砂の膜の厚さの下限。これより薄い膜（斜め上へ掘ってトンネルの天井が地表へ近づいた所）は
 * 当たり判定でも見た目でも開ける。Surface Nets の格子（DIG.cell = 0.1）より薄い膜は格子点に負の値が現れず三角形に
 * ならない（見た目は穴が開いている）のに、距離関数には −0.01〜−0.03 ほどの膜が残り、カニ・カメラが見えない膜で
 * 止まっていた（docs/aquarium/free-dig-tunnel-cam/report.md の光線検査）
 */
const FILM = 0.2;
/**
 * 空洞の近く（空洞の値 c が SHAVE_FAR より小さい所）だけ砂の値を最大 SHAVE 正へずらす（砂をわずかに削る）。
 * 掘った縁・継ぎ目の丸みが重なる所には、値がほぼ 0（深さ 0.001〜0.03）の膜が広く残り、格子では三角形にならないのに
 * 当たり判定には残る。見た目（meshValue）と当たり判定（cut）の両方で同じ値を使うので、消えた膜はどちらからも消える。
 * c ≥ SHAVE_FAR では 0（作り直しの印は空洞の外接箱 + 0.25 なので、作り直さない区画の高さ場の網とずれない）
 */
const SHAVE = 0.03;
const SHAVE_FAR = 0.25;

/**
 * 砂の距離 d と空洞の値 c（内側が負）から、掘った後の砂の値。smax(d, −c) に「膜の厚さ（c − d）が FILM より薄ければ開ける」
 * と、空洞の近くの SHAVE を加える。膜でない所（空洞の中 c < 0・地表より上 d > 0・厚い砂）では符号は smax と同じ。
 * 加えた項の傾き（(FILM + d − c) / 2 は 1 以下、SHAVE は 0.15）は小さいので、距離の下限として使える
 * （球の追跡・Surface Nets の間引きが安全。ずらす分 SHAVE だけ表面が空洞側から離れる）
 */
function carveSand(d: number, c: number): number {
  return Math.max(smax(d, -c, DIG.rimK), (FILM + d - c) * 0.5) + SHAVE * clamp((SHAVE_FAR - c) / 0.2, 0, 1);
}

/**
 * ガラスの内側の面から GLASS_ROW（= 格子 DIG.cell の 1 マス。区画の格子はガラスの面に揃っているので、面から 1 列目の格子点）
 * より近い所の空洞の値は、面から GLASS_ROW の所（1 列目）の値 c1 から、ガラスへ近づくほど GLASS_SLOPE の傾きで下げた値にする
 * （c1 − GLASS_SLOPE ×（GLASS_ROW − e）。carveAt）。
 * 穴の突き当たりがガラスの手前 0.1 ほどで止まると、その間の砂は格子より薄い板になり、1 列目の格子点では空洞なのに
 * 面との間に砂が残る所は、見た目（ガラスの面で切った Surface Nets）では穴がガラスまで抜けて外が透け、当たり判定には板が残っていた
 * （mesh_check の 49 本。突き当たりは丸いので、板の厚みは場所ごとに格子の 1 マスをまたいで変わる）。
 * 1 列目より内側を c1 だけで決めると、1 列目が空洞（c1 < 0）なら面まで空洞、砂なら面の側の砂は 1 列目まで続く。
 * 面に垂直な向きには値が 1 次式なので、Surface Nets が面と 1 列目の格子点の値から求める断面の位置は当たり判定の面と同じ所になる。
 * 傾きを 0 にすると（そのまま延ばすと）、突き当たりが 1 列目ちょうどの所で値がほぼ 0 の平らな帯になり、格子点ごとに符号が
 * ばらばらな砂のかけらが残った。傾きを大きくすると、穴の縁とガラスの角（格子では丸まる）に残る砂のくさびも小さくなる
 * （mesh_check の不一致：傾き 0.5 → 24 本、1 → 13 本、2 → 6 本）。ガラスの面では穴の輪郭が最大 0.2 広がる（漏斗のような面取り）。
 * 傾きが 1 より大きい分、この帯（ガラスの 0.1 内側）だけ距離の下限より値が大きくなりうるが、帯はガラスの当たり判定に接している
 */
const GLASS_ROW = DIG.cell;
const GLASS_SLOPE = 2.0;
const GLASS_SLOPE_FAR = 0.3;

export interface CarvePrim {
  a: V3;
  b: V3;
  r: number;
  min: V3;
  max: V3;
  /** 0 = 掘った空洞、1 = 盛った砂 */
  fill: 0 | 1;
  /** 編集の層（種類が変わるたびに 1 増える。同じ層の物はまとめて合わせる） */
  layer: number;
}

/**
 * 空洞の形のどの版を使うか（live = 当たり判定・いま見えている形、snap = 作り直し中の区画の形、
 * latest = 最新の形（まだ見た目・当たり判定に入っていない編集を含む）、before = 直前の編集の前の形（取り除いた・足した量を測る））
 */
export type DigView = 'live' | 'snap' | 'latest' | 'before';

export type DigMaterial = 'sand' | 'soil' | 'rock' | 'wood' | 'glass' | 'bottom' | 'pipe' | 'treasure' | 'none';

export const DIG_MATERIAL_LABEL: Record<DigMaterial, string> = {
  sand: '砂', soil: '土', rock: '岩', wood: '流木', glass: 'ガラス', bottom: '水槽の底', pipe: '配管', treasure: '宝物のそば', none: 'なし',
};

export function diggable(m: DigMaterial): boolean {
  return m === 'sand' || m === 'soil';
}

/** 1 回のかき出しの結果 */
export interface DigStrokeResult {
  changed: boolean;
  /** 新しい空洞の中心 */
  at: V3;
  r: number;
  ms: number;
}

function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** 外接箱までの距離の 2 乗（carve が箱から遠い空洞を平方根なしで飛ばす） */
function boxDist2(min: V3, max: V3, x: number, y: number, z: number): number {
  const dx = Math.max(min[0] - x, 0, x - max[0]);
  const dy = Math.max(min[1] - y, 0, y - max[1]);
  const dz = Math.max(min[2] - z, 0, z - max[2]);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * 平らな床を付けたカプセル（床は軸の高さから r × floorK 下。坂のカプセルは床も坂になる）。
 * カプセルは sdCapsule（共有の距離関数）と同じ式を、ここだけ Math.hypot の代わりに平方根で計算する（区画の作り直しで
 * いちばん多く呼ばれる所。hypot は遅い。値は丸め誤差の範囲で同じ）
 */
function primDist(p: CarvePrim, x: number, y: number, z: number): number {
  const [ax, ay, az] = p.a, [bx, by, bz] = p.b;
  const vx = bx - ax, vy = by - ay, vz = bz - az;
  const L2 = vx * vx + vy * vy + vz * vz;
  const px = x - ax, py = y - ay, pz = z - az;
  const tr = L2 > 1e-9 ? (px * vx + py * vy + pz * vz) / L2 : 0;
  const t = clamp(tr, 0, 1);
  const qx = px - vx * t, qy = py - vy * t, qz = pz - vz * t;
  const d = Math.sqrt(qx * qx + qy * qy + qz * qz) - p.r;
  // 両端の丸い部分では床を平らに伸ばさず、端から離れるほど上げる（約 42°）。平らなままだと、次に上・下へ向きを
  // 変えて掘った坂の床より下に「踊り場」が残り、カニがそこへ進んで坂の始まりの段差に引っかかる
  const over = (tr < 0 ? -tr : tr > 1 ? tr - 1 : 0) * Math.sqrt(L2);
  // 床までの深さは軸に垂直な向きで r × floorK にする（鉛直に測ると、急な坂ほど床が軸へ近づき、60° では 0.13 しか
  // 空かずにカニの体（半径 0.24）が軸に沿って通れなかった＝最大の上向きで掘るとカニが遅れて止まる）
  const cosP = L2 > 1e-9 ? Math.max(0.5, Math.hypot(vx, vz) / Math.sqrt(L2)) : 1;
  const floor = ay + vy * t - (p.r * DIG.floorK) / cosP + over * 0.9;
  return smax(d, floor - y, 0.06);
}

/** 盛った砂の形（両端 a, b・半径 r のカプセル。いまは a = b の球）までの距離 */
function fillDist(p: CarvePrim, x: number, y: number, z: number): number {
  const [ax, ay, az] = p.a, [bx, by, bz] = p.b;
  const vx = bx - ax, vy = by - ay, vz = bz - az;
  const L2 = vx * vx + vy * vy + vz * vz;
  const px = x - ax, py = y - ay, pz = z - az;
  const t = L2 > 1e-9 ? clamp((px * vx + py * vy + pz * vz) / L2, 0, 1) : 0;
  const qx = px - vx * t, qy = py - vy * t, qz = pz - vz * t;
  return Math.sqrt(qx * qx + qy * qy + qz * qz) - p.r;
}

export class DigField {
  /** 最新の形（かき出しが書き換える） */
  readonly prims: CarvePrim[] = [];
  /** 版ごとの形（まだその版に無い空洞は null）。snapshot / commit で最新の形から写す */
  private readonly live: (CarvePrim | null)[] = [];
  private readonly snap: (CarvePrim | null)[] = [];
  /** 最後の snapshot から形が変わった空洞・snapshot で写したがまだ commit していない空洞 */
  private readonly changed = new Set<number>();
  private readonly staged = new Set<number>();
  /** 区画の数（x, z） */
  readonly ncx: number;
  readonly ncz: number;
  /** 区画ごとの登録（空洞の番号）。空洞の外接箱 + PAD に重なる区画に入れる */
  private readonly cells: number[][];
  /** 三角形を作り直す必要がある区画 */
  readonly dirty = new Set<number>();
  /** 縦の管が通る区画（作り直さない。空洞もここまで届かせない） */
  readonly locked: Uint8Array;
  private readonly lockRects: { x0: number; z0: number; x1: number; z1: number }[] = [];
  /** 掘らない場所（発見物のまわり） */
  private readonly protect: { x: number; y: number; z: number; r: number }[] = [];
  /** かき出しの続き（同じ場所で続けて掘ると、直前の空洞を伸ばす・太らせる） */
  private session = { last: -1, r: 0, time: -10, recent: [] as number[] };
  /** 盛り続け（同じ場所へ続けて盛ると、直前の砂山を大きくする） */
  private fillSession = { last: -1, time: -10, side: [1, 0, 0] as readonly number[] };
  /** いまの層の番号と種類（次に足す物が同じ種類なら同じ層） */
  private layerNo = 0;
  private layerFill: 0 | 1 = 0;
  /** 区画ごとの盛った砂の数と、そのいちばん高い所（meshValue が地表より上を飛ばしてよいか） */
  private readonly fillN: Uint16Array;
  private readonly fillTop: Float32Array;
  /** 直前の編集（beginEdit 〜）で形が変わった物の前の形（足した物は null）と、変わった範囲（前と後の外接箱の和） */
  private editOld: Map<number, CarvePrim | null> | null = null;
  readonly editBox = { min: [0, 0, 0] as V3, max: [0, 0, 0] as V3, empty: true };
  /** 'before' の版（measure の間だけ作る） */
  private beforeArr: (CarvePrim | null)[] | null = null;
  /** 計測（自動検証・表示用）。fills = 盛った回数 */
  readonly stats = { strokes: 0, carves: 0, blocked: 0, carveMs: 0, lastCarveMs: 0, maxCarveMs: 0, fills: 0, fillMs: 0, auditMs: 0, fillShift: 0 };

  constructor(columns: readonly { x: number; z: number; r: number }[]) {
    this.ncx = Math.round((TANK.maxX - TANK.minX) / DIG.chunk);
    this.ncz = Math.round((TANK.maxZ - TANK.minZ) / DIG.chunk);
    this.cells = Array.from({ length: this.ncx * this.ncz }, () => []);
    this.locked = new Uint8Array(this.ncx * this.ncz);
    this.fillN = new Uint16Array(this.ncx * this.ncz);
    this.fillTop = new Float32Array(this.ncx * this.ncz).fill(-Infinity);
    // 縦の管が砂を貫く所：管の円に重なる区画の外接矩形をまとめて固定する（そこの砂の網は管の丸い穴の形のまま残す）
    for (const c of columns) {
      const R = c.r + 0.1;
      const i0 = this.ci(c.x - R), i1 = this.ci(c.x + R), j0 = this.cj(c.z - R), j1 = this.cj(c.z + R);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.locked[j * this.ncx + i] = 1;
      this.lockRects.push({ x0: TANK.minX + i0 * DIG.chunk, z0: TANK.minZ + j0 * DIG.chunk, x1: TANK.minX + (i1 + 1) * DIG.chunk, z1: TANK.minZ + (j1 + 1) * DIG.chunk });
    }
  }

  /** 発見物（貝殻・光る石・泡の湧く所）のまわりは掘らない（掘ると宙に浮くので） */
  protectPoint(x: number, y: number, z: number, r: number) {
    this.protect.push({ x, y, z, r });
  }

  get count(): number {
    return this.prims.length;
  }

  ci(x: number): number {
    return clamp(Math.floor((x - TANK.minX) / DIG.chunk), 0, this.ncx - 1);
  }

  cj(z: number): number {
    return clamp(Math.floor((z - TANK.minZ) / DIG.chunk), 0, this.ncz - 1);
  }

  chunkId(i: number, j: number): number {
    return j * this.ncx + i;
  }

  /** 区画に登録された空洞の番号（読み取り専用で使う） */
  chunkPrims(id: number): readonly number[] {
    return this.cells[id];
  }

  /** 区画の中の空洞のいちばん低い所（区画を三角形にする縦の範囲を決める） */
  chunkMinY(id: number, view: DigView = 'live'): number {
    const V = this.arr(view);
    let y = Infinity;
    for (const k of this.cells[id]) {
      const p = V[k];
      if (p) y = Math.min(y, p.min[1]);
    }
    return y;
  }

  /** 区画の中の盛った砂のいちばん高い所（盛った砂が無ければ −∞。区画を三角形にする縦の範囲の上端） */
  chunkMaxY(id: number, view: DigView = 'live'): number {
    if (this.fillN[id] === 0) return -Infinity;
    const V = this.arr(view);
    let y = -Infinity;
    for (const k of this.cells[id]) {
      const p = V[k];
      if (p && p.fill) y = Math.max(y, p.max[1]);
    }
    return y;
  }

  /** 盛った砂の数（全体） */
  get fillCount(): number {
    let n = 0;
    for (const p of this.prims) n += p.fill;
    return n;
  }

  private arr(view: DigView): readonly (CarvePrim | null)[] {
    return view === 'live' ? this.live : view === 'snap' ? this.snap : view === 'latest' ? this.prims : (this.beforeArr ?? this.prims);
  }

  // ---------------- 版（見た目と当たり判定を同時に変える） ----------------

  /** 最新の形を 'snap' の版へ写す（区画の作り直しを始めるとき） */
  snapshot() {
    for (const id of this.changed) {
      this.snap[id] = copyPrim(this.prims[id]);
      this.staged.add(id);
    }
    this.changed.clear();
  }

  /** 'snap' の版を 'live'（当たり判定）にする（作り直した区画をすべて差し替えたとき） */
  commit() {
    for (const id of this.staged) this.live[id] = this.snap[id];
    this.staged.clear();
  }

  /** まだ当たり判定に入っていない形の変化があるか（自動検証・表示用） */
  get uncommitted(): number {
    return this.changed.size + this.staged.size;
  }

  // ---------------- 距離関数 ----------------

  /** 空洞の打ち切り（正 = 空洞を作らない所）。底の少し上・ガラス際・管の区画・発見物のまわり */
  clip(x: number, y: number, z: number, floor = true): number {
    let c = DIG.glassClip - Math.min(x - TANK.minX, TANK.maxX - x, z - TANK.minZ, TANK.maxZ - z);
    if (floor) c = Math.max(c, DIG.floorClip - y);
    // 管の区画・発見物は、c より大きくなりうる近さのときだけ平方根を取る（離れた所の値は max に効かない）
    for (const r of this.lockRects) {
      const lim = 0.3 - c;
      if (lim <= 0) continue;
      const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
      const q = dx * dx + dz * dz;
      if (q < lim * lim) c = 0.3 - Math.sqrt(q);
    }
    for (const p of this.protect) {
      const lim = p.r - c;
      if (lim <= 0) continue;
      const dx = x - p.x, dy = y - p.y, dz = z - p.z;
      const q = dx * dx + dy * dy + dz * dz;
      if (q < lim * lim) c = p.r - Math.sqrt(q);
    }
    return c;
  }

  /**
   * 盛った砂の打ち切り（正 = 砂を足さない所）：clip から水槽の底の項を除いたもの（ガラス際・管の区画・発見物のまわり）。
   * 底の少し上（floorClip）より下へ砂を足しても底のガラスは削れないので、掘れる深さいっぱいのトンネルの床にも盛れる
   */
  fillClip(x: number, y: number, z: number): number {
    return this.clip(x, y, z, false);
  }

  /** 打ち切りの理由（掘れない場所の表示用） */
  clipReason(x: number, y: number, z: number, withFloor = true): DigMaterial {
    const floor = withFloor ? DIG.floorClip - y : -Infinity;
    const glass = DIG.glassClip - Math.min(x - TANK.minX, TANK.maxX - x, z - TANK.minZ, TANK.maxZ - z);
    let pipe = -Infinity;
    for (const r of this.lockRects) {
      const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
      pipe = Math.max(pipe, 0.3 - Math.hypot(dx, dz));
    }
    let tr = -Infinity;
    for (const p of this.protect) tr = Math.max(tr, p.r - Math.hypot(x - p.x, y - p.y, z - p.z));
    const m = Math.max(floor, glass, pipe, tr);
    return m === floor ? 'bottom' : m === glass ? 'glass' : m === pipe ? 'pipe' : 'treasure';
  }

  /**
   * 空洞までの距離（内側が負）。近くに空洞が無ければ PAD。掘った空洞だけ（層・盛った砂は見ない）：
   * 「掘った穴のそばか」（床とみなす傾き・カメラの地下の判定・掘った面の色）に使う。砂の値そのものは cut
   */
  carve(x: number, y: number, z: number, view: DigView = 'live'): number {
    const list = this.cells[this.cj(z) * this.ncx + this.ci(x)];
    if (list.length === 0) return PAD;
    const V = this.arr(view);
    let c = PAD;
    for (let i = 0; i < list.length; i++) {
      const p = V[list[i]];
      if (!p || p.fill) continue;
      const b2 = boxDist2(p.min, p.max, x, y, z);
      // 外接箱から離れていれば箱までの距離（下限）で十分（つなぎの丸みが届かない）。今の c 以上なら何も変わらない
      if (b2 > 0.09) {
        if (c > 0 && b2 < c * c) c = Math.sqrt(b2);
      } else c = smin(c, primDist(p, x, y, z), DIG.unionK);
    }
    if (c < CLIP_NEAR) c = Math.max(c, this.clip(x, y, z));
    return c;
  }

  /** 盛った砂の形までの距離（盛った砂だけ・層は見ない。近くに無ければ PAD）。盛った面の色・自動検証に使う */
  fillDist(x: number, y: number, z: number, view: DigView = 'live'): number {
    const id = this.cj(z) * this.ncx + this.ci(x);
    if (this.fillN[id] === 0) return PAD;
    const V = this.arr(view);
    let f = PAD;
    for (const k of this.cells[id]) {
      const p = V[k];
      if (!p || !p.fill) continue;
      const b2 = boxDist2(p.min, p.max, x, y, z);
      if (b2 > 0.09) {
        if (f > 0 && b2 < f * f) f = Math.sqrt(b2);
      } else f = smin(f, fillDist(p, x, y, z), DIG.unionK);
    }
    return f;
  }

  /** compose が最後に、掘った層のどれかが近かった（値が PAD より小さかった）か。meshValue の深い砂の省略に使う */
  private carveNear = false;

  /**
   * 砂（底床）の距離 d に、区画の一覧 list の編集を層の順に当てる（AquariumDig の先頭の説明）。
   * 掘った層：空洞の値（ガラスの内側の面から GLASS_ROW より近い所は面から GLASS_ROW の所の値を GLASS_SLOPE で下げる。
   * 角では両方の面から。ガラスの外へは glassClip で打ち切る）を carveSand で当てる。層の物がこの版にまだ無くても
   * PAD で当てる（従来の cut と同じ値にする）。盛った層：盛った砂の値（打ち切りの外だけ）を smin で足す（この版に無ければ何もしない）
   */
  private compose(d: number, x: number, y: number, z: number, view: DigView, list: readonly number[]): number {
    const V = this.arr(view), P = this.prims;
    const e = Math.min(x - TANK.minX, TANK.maxX - x, z - TANK.minZ, TANK.maxZ - z);
    const nearGlass = e < GLASS_ROW;
    const qx = nearGlass ? clamp(x, TANK.minX + GLASS_ROW, TANK.maxX - GLASS_ROW) : x;
    const qz = nearGlass ? clamp(z, TANK.minZ + GLASS_ROW, TANK.maxZ - GLASS_ROW) : z;
    this.carveNear = false;
    let i = 0;
    while (i < list.length) {
      const head = P[list[i]];
      const L = head.layer, fill = head.fill;
      const px = fill ? x : qx, pz = fill ? z : qz;
      let u = PAD, any = false;
      for (; i < list.length && P[list[i]].layer === L; i++) {
        const p = V[list[i]];
        if (!p) continue;
        any = true;
        const b2 = boxDist2(p.min, p.max, px, y, pz);
        // 外接箱から離れていれば箱までの距離（下限）で十分（つなぎの丸みが届かない）。今の u 以上なら何も変わらない
        if (b2 > 0.09) {
          if (u > 0 && b2 < u * u) u = Math.sqrt(b2);
        } else u = smin(u, fill ? fillDist(p, px, y, pz) : primDist(p, px, y, pz), DIG.unionK);
      }
      if (u < CLIP_NEAR) u = Math.max(u, this.clip(px, y, pz, !fill));
      if (fill) {
        if (any) d = smin(d, u, FILL.blendK);
        continue;
      }
      if (nearGlass && u < GLASS_SLOPE_FAR) {
        // 空洞から離れた砂（GLASS_SLOPE_FAR 以上）は下げない：作り直さない区画の砂の値（SHAVE・丸み）を変えない
        const k = clamp((GLASS_SLOPE_FAR - u) / 0.15, 0, 1);
        u = Math.max(u - GLASS_SLOPE * k * (GLASS_ROW - e), DIG.glassClip - e);
      }
      if (u < PAD) this.carveNear = true;
      d = carveSand(d, u);
    }
    return d;
  }

  /** 砂（底床）の距離 d を編集（掘った空洞・盛った砂）で変える。近くに編集が無ければ d のまま */
  cut(d: number, x: number, y: number, z: number, view: DigView = 'live'): number {
    if (this.prims.length === 0) return d;
    const list = this.cells[this.cj(z) * this.ncx + this.ci(x)];
    if (list.length === 0) return d;
    return this.compose(d, x, y, z, view, list);
  }

  /**
   * 区画を三角形にするときの値（buildDigChunk の Surface Nets 用）。符号と、表面のすぐ近く（|値| < 0.25）の値は cut と同じ。
   * 表面から離れた所は cut の代わりに砂の距離 d をそのまま返し、4×4×4 のブロックをまとめて飛ばせるようにする：
   * - 地表より 0.25 以上上：cut ≥ d（smax は max 以上）なので符号は同じ
   * - 近くに空洞が無い（carve が PAD = 空洞まで PAD 以上）深い砂：cut は −PAD 付近に張り付き（|値| < 飛ばす閾値）、
   *   ブロックを飛ばせずに全点を評価していた。ブロックの中心から隅まで（0.35）より空洞が遠いので、d を返しても安全
   */
  meshValue(d: number, x: number, y: number, z: number, view: DigView): number {
    const id = this.cj(z) * this.ncx + this.ci(x);
    // 地表より上：盛った砂が無い区画・盛った砂のいちばん高い所より十分上なら d のまま（盛った砂はここより下にしか無い）
    if (d > 0.25 && (this.fillN[id] === 0 || y > this.fillTop[id] + 0.3)) return d;
    if (this.prims.length === 0) return d;
    const list = this.cells[id];
    if (list.length === 0) return d;
    const v = this.compose(d, x, y, z, view, list);
    // 近くに空洞が無い深い砂：盛った砂は値を下げるだけなので、符号は d と同じ
    if (!this.carveNear && d < -0.6) return d;
    return v;
  }

  /** 掘った空洞の中で、元の地表より下（トンネルの中）か。カメラの寄せ方に使う */
  tunnelDepth(x: number, y: number, z: number, ground: number): number {
    if (this.prims.length === 0 || this.carve(x, y, z) > -0.02) return 0;
    return ground - y;
  }

  // ---------------- 保存・復元 ----------------

  /** 保存用：最新の形の編集を 8 個ずつ（a.xyz, b.xyz, r, 種類 0 = 掘った / 1 = 盛った）並べたもの。編集した順 */
  exportPrims(): Float64Array {
    const S = PRIM_STRIDE_V2;
    const out = new Float64Array(this.prims.length * S);
    this.prims.forEach((p, i) => {
      out.set(p.a, i * S);
      out.set(p.b, i * S + 3);
      out[i * S + 6] = p.r;
      out[i * S + 7] = p.fill;
    });
    return out;
  }

  /**
   * 保存データから空洞を戻す（まだ何も掘っていないときだけ。掘った後に呼ぶと形が二重になるので例外）。
   * かき出し（stroke）と同じ add を通すので、区画の登録・作り直しの印・版（live / snap）の扱いは掘ったときと同じ：
   * 戻した空洞はまだ当たり判定（live）に入っていない。描画側が作り直しを済ませて commit した瞬間に、見た目と当たり判定が
   * 同時に穴の開いた形になる（起動時は AquariumDigFx.flushAll で、最初のフレームより前に済ませる）。
   * 値は呼ぶ側（AquaSave.validateSave）で検証済みのもの。ここでも有限でない・太さが範囲外の空洞は飛ばす。返り値 = 戻した数
   */
  restore(data: ArrayLike<number>, stride: 7 | 8 = PRIM_STRIDE_V2): number {
    if (this.prims.length > 0) throw new Error('DigField.restore は掘る前にだけ呼べます');
    const n = Math.min(Math.floor(data.length / stride), DIG.maxPrims);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      const a: V3 = [data[o], data[o + 1], data[o + 2]], b: V3 = [data[o + 3], data[o + 4], data[o + 5]];
      const r = data[o + 6];
      const fill = stride === 8 && data[o + 7] === 1;
      if (![...a, ...b, r].every(Number.isFinite) || r <= 0.01 || r > DIG.rMax + 1e-3) continue;
      this.add(a, b, r, fill);
      k++;
    }
    // 掘り続け（伸ばす・太らせる）・盛り続けは戻した物につながない（次に掘る・盛るときは新しく始める）
    this.session = { last: -1, r: 0, time: -10, recent: [] };
    this.fillSession = { last: -1, time: -10, side: [1, 0, 0] };
    this.editOld = null;
    return k;
  }

  // ---------------- 量を測る（取り除いた・足した砂） ----------------

  /**
   * これからの編集で変わる物の前の形を覚え始める（endEdit / startMeasure まで）。前の編集の量を測っている途中なら、
   * 先に測り終える（測る間は形を変えない＝「後」の形が次の編集を含まない）
   */
  beginEdit() {
    if (this.job) this.measureStep(Infinity);
    this.editOld = new Map();
    this.editBox.empty = true;
  }

  /** 編集の記録を、測らずに終える（形が変わらなかったとき） */
  endEdit() {
    this.editOld = null;
    this.editBox.empty = true;
  }

  private touchEdit(id: number, min: V3, max: V3, isNew: boolean) {
    if (!this.editOld) return;
    if (!this.editOld.has(id)) this.editOld.set(id, isNew ? null : copyPrim(this.prims[id]));
    const B = this.editBox;
    for (let k = 0; k < 3; k++) {
      B.min[k] = B.empty ? min[k] : Math.min(B.min[k], min[k]);
      B.max[k] = B.empty ? max[k] : Math.max(B.max[k], max[k]);
    }
    B.empty = false;
  }

  /** 測っている途中の編集（前の形・格子の範囲・進んだ列・数えた差・終わったら呼ぶ関数） */
  private job: {
    before: (CarvePrim | null)[]; h: number; i0: number; i1: number; j0: number; j1: number; k0: number; k1: number;
    i: number; k: number; delta: number; sample: (x: number, y: number, z: number, view: DigView) => number; done: (v: number) => void;
  } | null = null;

  /** 前の編集の量を測っている途中か */
  get measuring(): boolean {
    return this.job !== null;
  }

  /**
   * 直前の編集の前と後で、砂（sample(x, y, z, view) < 0）だった格子点の数の差から、取り除いた（負）・足した（正）砂の体積を
   * 測り始める（measureStep で少しずつ進め、終わったら done(体積)）。格子は水槽全体で共通（間隔 h = 0.12。体積の誤差は数 %）。
   * 編集で形が変わった物の外接箱（+ なじませの分）の中だけ。sample は AquariumWorld が渡す（高さ場から砂の値を作る）。
   * 測り始めたら編集の記録を終える。1 回のかき出しで数 ms かかる（スマホでは数十 ms）ので、フレームに分けて測る
   */
  startMeasure(sample: (x: number, y: number, z: number, view: DigView) => number, done: (v: number) => void, h = 0.12) {
    if (this.job) this.measureStep(Infinity);
    const old = this.editOld;
    this.editOld = null;
    if (!old || this.editBox.empty) {
      done(0);
      return;
    }
    const before = this.prims.slice() as (CarvePrim | null)[];
    for (const [id, p] of old) before[id] = p;
    // 余白：空洞のつなぎの丸み（rimK）・盛った砂のなじませ（blendK 0.22）で面が動く分（第 10 段階：0.15 → 0.25。なじませの分を測り漏らしていた）
    const B = this.editBox, m = 0.25;
    const i0 = Math.ceil((B.min[0] - m) / h), i1 = Math.floor((B.max[0] + m) / h);
    const j0 = Math.ceil((Math.max(B.min[1] - m, TANK.floorY)) / h), j1 = Math.floor((B.max[1] + m) / h);
    const k0 = Math.ceil((B.min[2] - m) / h), k1 = Math.floor((B.max[2] + m) / h);
    this.job = { before, h, i0, i1, j0, j1, k0, k1, i: i0, k: k0, delta: 0, sample, done };
  }

  /**
   * 測る処理を進める（1 列 = 同じ x, z の縦の格子点ずつ、budgetMs を超えるまで）。終わったら done を呼ぶ。返り値 = 終わったか。
   * 測っている間は形を変えない（形を変える前の beginEdit・add・modify が先に測り終える）
   */
  measureStep(budgetMs: number): boolean {
    const J = this.job;
    if (!J) return true;
    const t0 = performance.now();
    this.beforeArr = J.before;
    const h = J.h;
    try {
      while (J.i <= J.i1) {
        const x = J.i * h, z = J.k * h;
        if (x > TANK.minX && x < TANK.maxX && z > TANK.minZ && z < TANK.maxZ) {
          for (let j = J.j0; j <= J.j1; j++) {
            const y = j * h;
            const a = J.sample(x, y, z, 'latest') < 0, b = J.sample(x, y, z, 'before') < 0;
            if (a !== b) J.delta += a ? 1 : -1;
          }
        }
        if (++J.k > J.k1) {
          J.k = J.k0;
          J.i++;
        }
        if (performance.now() - t0 > budgetMs) break;
      }
    } finally {
      this.beforeArr = null;
    }
    if (J.i <= J.i1) return false;
    this.job = null;
    J.done(J.delta * h * h * h);
    return true;
  }

  // ---------------- 砂の量の見直し（第 10 段階：救済） ----------------

  /** 形を変えた回数（add / modify ごとに 1 増える。見直しの途中で形が変わったら測り直す） */
  private editSerial = 0;
  private audit: { cells: number[]; ci: number; i: number; k: number; serial: number; delta: number; h: number; after: (x: number, y: number, z: number) => number; base: (x: number, y: number, z: number) => number; done: (v: number) => void; t0: number } | null = null;

  /** 盛る計画の候補の記録（自動検証用。配列を入れたときだけ書く） */
  planDbg: { c: V3; room: number; why: string }[] | null = null;

  /** 砂の量を見直している途中か */
  get auditing(): boolean {
    return this.audit !== null;
  }

  /**
   * 全部の編集（掘った・盛った）で変わった砂の体積（取り除いた分は負）を測り始める（auditStep で少しずつ進め、終わったら done(体積)）。
   * 編集の記録を持たない古い保存データ（以前の持てる量の上限で捨てた砂がある）でも、地形から「掘って手元にあるはずの砂」が分かる。
   * 編集が登録された区画ごとに、区画の格子（startMeasure と同じ間隔 h の格子）で、編集の後 after と元の砂 base の符号の差を数える。
   * 区画の高さは、その区画に登録された編集の外接箱 ± 0.3 だけ。途中で形が変わったら初めから測り直す
   */
  startAudit(after: (x: number, y: number, z: number) => number, base: (x: number, y: number, z: number) => number, done: (v: number) => void, h = 0.12) {
    const cells: number[] = [];
    for (let id = 0; id < this.cells.length; id++) if (this.cells[id].length > 0) cells.push(id);
    this.audit = { cells, ci: 0, i: NaN, k: NaN, serial: this.editSerial, delta: 0, h, after, base, done, t0: performance.now() };
  }

  /** 見直しを進める（budgetMs を超えるまで、1 列ずつ）。返り値 = 終わったか */
  auditStep(budgetMs: number): boolean {
    const A = this.audit;
    if (!A) return true;
    if (A.serial !== this.editSerial) {
      // 途中で形が変わった：測り直す
      A.ci = 0;
      A.i = A.k = NaN;
      A.delta = 0;
      A.serial = this.editSerial;
    }
    const t0 = performance.now(), h = A.h, P = this.prims;
    while (A.ci < A.cells.length) {
      const id = A.cells[A.ci];
      const cx = id % this.ncx, cz = Math.floor(id / this.ncx);
      const x0 = TANK.minX + cx * DIG.chunk, z0 = TANK.minZ + cz * DIG.chunk;
      const i0 = Math.ceil(x0 / h), i1 = Math.ceil((x0 + DIG.chunk) / h) - 1, k0 = Math.ceil(z0 / h), k1 = Math.ceil((z0 + DIG.chunk) / h) - 1;
      // （格子の番号は負にもなるので、区画の始めは NaN で表す）
      if (Number.isNaN(A.i)) {
        A.i = i0;
        A.k = k0;
      }
      let ylo = Infinity, yhi = -Infinity;
      for (const n of this.cells[id]) {
        ylo = Math.min(ylo, P[n].min[1]);
        yhi = Math.max(yhi, P[n].max[1]);
      }
      const j0 = Math.ceil(Math.max(ylo - 0.3, TANK.floorY) / h), j1 = Math.floor((yhi + 0.3) / h);
      while (A.i <= i1) {
        const x = A.i * h, z = A.k * h;
        if (x > TANK.minX && x < TANK.maxX && z > TANK.minZ && z < TANK.maxZ) {
          for (let j = j0; j <= j1; j++) {
            const y = j * h;
            const a = A.after(x, y, z) < 0, b = A.base(x, y, z) < 0;
            if (a !== b) A.delta += a ? 1 : -1;
          }
        }
        if (++A.k > k1) {
          A.k = k0;
          A.i++;
        }
        if (performance.now() - t0 > budgetMs) return false;
      }
      A.ci++;
      A.i = A.k = NaN;
    }
    this.audit = null;
    this.stats.auditMs = performance.now() - A.t0;
    A.done(A.delta * h * h * h);
    return true;
  }

  /** 直前の編集の量をすぐ測る（startMeasure + 測り終えるまで。自動検証用） */
  measureEdit(sample: (x: number, y: number, z: number, view: DigView) => number, h = 0.12): number {
    let v = 0;
    this.startMeasure(sample, (r) => (v = r), h);
    this.measureStep(Infinity);
    return v;
  }

  // ---------------- 盛る ----------------

  /**
   * 1 回盛る。at = 照準が当たった面の点、n = その面の外向きの法線、now = 時刻（秒）。
   * 続けて同じ所（直前の砂山の面のそば）へ盛っている間は、直前の砂山を FILL.grow ずつ大きくする（FILL.rMax まで）。
   * それ以外は、面から半径 × sink 内側を中心に新しい砂山を足す。maxR(中心, 半径) = その砂山に許す半径の上限
   * （カニ・仲間を埋めない。呼ぶ側が決める）。打ち切り（ガラス・管・発見物・底）に中心が近すぎる所には盛らない。
   * 返り値：changed = 形が変わった、r = 砂山の半径、at = 砂山の中心、why = 盛れなかった理由
   */
  place(at: V3, n: V3, now: number, maxR: FillMaxR, side: readonly number[] = [1, 0, 0], budget = Infinity, env: FillEnv = {}): { changed: boolean; r: number; at: V3; why: FillPlan['why'] } {
    const t0 = performance.now();
    const S = this.fillSession;
    const pl = this.planPlace(at, n, now, maxR, side, budget, env);
    S.time = now;
    let res: { changed: boolean; r: number; at: V3; why: FillPlan['why'] };
    if (pl.why) {
      if (pl.grow < 0) S.last = -1;
      res = { changed: false, r: pl.r, at: pl.c, why: pl.why };
    } else if (pl.grow >= 0) {
      this.modify(pl.grow, pl.b, pl.r, pl.a);
      res = { changed: true, r: pl.r, at: pl.c, why: null };
    } else {
      S.last = this.add(pl.a, pl.b, pl.r, true);
      S.side = [side[0], side[1], side[2]];
      res = { changed: true, r: pl.r, at: pl.c, why: null };
    }
    if (res.changed) {
      this.stats.fills++;
      this.stats.fillMs += performance.now() - t0;
    }
    return res;
  }

  /**
   * 次に盛る砂山の計画（形は変えない。照準の表示と place が同じ判断をする）：
   * - 続けて盛っていて（直前の砂山から 0.6 秒以内）、照準が直前の砂山のそばなら：まだ小さければ大きくする（grow = その番号）、
   *   いっぱい（FILL.rMax）なら、その上（中心から半径 × 0.8 上）へ新しい砂山を積む（砂山が上へ高くなる）
   * - それ以外は、照準の面から半径 × sink 内側を中心に新しい砂山
   * 盛れない（why）：打ち切りの近く（ガラス・管・発見物・底）・カニや仲間に近すぎる（maxR で決まる半径が小さすぎる）・上限
   */
  planPlace(at: readonly number[], n: readonly number[], now: number, maxR: FillMaxR, side: readonly number[] = [1, 0, 0], budget = Infinity, env: FillEnv = {}): FillPlan {
    const S = this.fillSession;
    const lp = S.last >= 0 && now - S.time <= 0.6 ? this.prims[S.last] : null;
    const lc: V3 | null = lp ? [(lp.a[0] + lp.b[0]) / 2, (lp.a[1] + lp.b[1]) / 2, (lp.a[2] + lp.b[2]) / 2] : null;
    const lw = lp ? Math.hypot(lp.b[0] - lp.a[0], lp.b[1] - lp.a[1], lp.b[2] - lp.a[2]) / 2 : 0;
    const near = lp && lp.fill && Math.hypot(at[0] - lc![0], at[1] - lc![1], at[2] - lc![2]) < lp.r + lw + 0.45;
    // 砂山の両端（中心 c から、横 sd へ ±w。盛る向きに垂直な水平）
    const ends = (c: V3, sd: readonly number[], w: number): [V3, V3] => [[c[0] - sd[0] * w, c[1] - sd[1] * w, c[2] - sd[2] * w], [c[0] + sd[0] * w, c[1] + sd[1] * w, c[2] + sd[2] * w]];
    // 端がガラス・管・発見物の打ち切りに近ければ横へ伸ばさない（中心は打ち切りから離れている）
    const clipW = (c: V3, sd: readonly number[], w: number) => {
      for (let k = 0; k < 3 && w > 0.01; k++) {
        const [a, b] = ends(c, sd, w);
        if (this.fillClip(a[0], a[1], a[2]) <= -FILL.rMin * 0.5 && this.fillClip(b[0], b[1], b[2]) <= -FILL.rMin * 0.5) return w;
        w *= 0.5;
      }
      return 0;
    };
    // 手持ちの砂で盛れる半径（増える体積の見積もり × aboveK が budget 以下）
    const fit = (r0: number, w0: number, r: number, c: V3, sd: readonly number[]) => {
      const v0 = fillVolume(r0, w0);
      let rr = r;
      for (let k = 0; k < 8; k++) {
        const add = (fillVolume(rr, clipW(c, sd, fillWidth(rr))) - v0) * FILL.aboveK;
        if (add <= budget) return { r: rr, add };
        rr = r0 + (rr - r0) * 0.6;
      }
      return { r: r0, add: 0 };
    };
    if (lp && near && lp.r < FILL.rMax - 1e-3) {
      const sd = S.side;
      let r = Math.min(FILL.rMax, lp.r + FILL.grow);
      let [a, b] = ends(lc!, sd, clipW(lc!, sd, fillWidth(r)));
      r = Math.min(r, maxR(a, b, r));
      const f = fit(lp.r, lw, r, lc!, sd);
      r = f.r;
      // 大きくできない（カニに近い・砂が足りない）ときは、上へ積む方を試す
      if (r > lp.r + 1e-3) {
        [a, b] = ends(lc!, sd, Math.max(lw, clipW(lc!, sd, fillWidth(r))));
        return { a, b, c: lc!, r, grow: S.last, add: f.add, why: null };
      }
    }
    const stack = !!(lp && near);
    const sd = stack ? S.side : side;
    // 盛る向き（水平。side に垂直で、カニから離れる向き）
    const fw: V3 = [-side[2], 0, side[0]];
    // （押し続けている間に照準を動かして新しい砂山を始めるときも rStack から：小さな砂山から始めるのは押した最初の 1 回だけ）
    const holding = now - S.time <= 0.6;
    const r0 = stack || holding ? FILL.rStack : FILL.rMin;
    // 新しい砂山の中心の候補（第 10 段階）：
    // - 積む：上（ただし上の端がカニの足元より env.topMax を越えるなら後回し）→ 奥の肩 → 左右の肩。高い塔より、奥・横へつながって広がる
    // - 新しく盛る：照準の所 → 奥へ 0.12 ずつ（照準がカニのすぐ前の地面に当たると、カニとの間を空けるために小さな砂山しか置けず、
    //   上へ積み上がってカニの目の前に塔ができていた）。ずらした所は env.surf で真下の面の高さへ下ろす（穴の中なら穴の底：穴は底から埋まる）
    const surf = env.surf;
    let cands: V3[];
    if (stack) {
      const L = lp!, sh = lw + L.r * 0.9;
      const top: V3 = [lc![0], lc![1] + L.r * 0.8, lc![2]];
      const far: V3 = [lc![0] + fw[0] * L.r * 0.9, lc![1] + L.r * 0.15, lc![2] + fw[2] * L.r * 0.9];
      const sl: V3 = [lc![0] + sd[0] * sh, lc![1] + L.r * 0.15, lc![2] + sd[2] * sh];
      const sr: V3 = [lc![0] - sd[0] * sh, lc![1] + L.r * 0.15, lc![2] - sd[2] * sh];
      cands = top[1] + r0 <= (env.topMax ?? Infinity) ? [top, far, sl, sr] : [far, sl, sr, top];
    } else {
      cands = [0, 0.12, 0.24, 0.36, 0.5, 0.65, 0.8, 1.0].map((k) => {
        if (k === 0 || !surf) return [at[0] - n[0] * FILL.rMin * FILL.sink + fw[0] * k, at[1] - n[1] * FILL.rMin * FILL.sink, at[2] - n[2] * FILL.rMin * FILL.sink + fw[2] * k] as V3;
        const x = at[0] + fw[0] * k, z = at[2] + fw[2] * k;
        return [x, Math.max(surf(x, at[1] + 0.8, z), at[1] - 2.5) - r0 * FILL.sink, z] as V3;
      });
    }
    if (this.prims.length >= DIG.maxPrims) return { a: cands[0], b: cands[0], c: cands[0], r: 0, grow: -1, add: 0, why: 'none' };
    let c = cands[0], w = 0, a: V3 = c, b: V3 = c, r = 0;
    let why: FillPlan['why'] = null;
    // いちばん初めに、大きく育てられる（rMax の 0.8 倍まで空いている）候補。無ければ、いちばん空いている候補
    // （カニのすぐ前に置くと、空ける間のせいで小さいまま上へ積むだけになり、1 回に足せる量がわずかだった）
    let best: { c: V3; w: number; a: V3; b: V3; r: number; room: number } | null = null;
    for (const cc of cands) {
      const ww = stack ? clipW(cc, sd, Math.min(lw, fillWidth(r0))) : 0;
      const [aa, bb] = ends(cc, sd, ww);
      const room = maxR(aa, bb, FILL.rMax);
      const rr = Math.min(r0, room);
      if (this.fillClip(cc[0], cc[1], cc[2]) > -FILL.rMin * 0.5) {
        why ??= this.clipReason(cc[0], cc[1], cc[2], false);
        continue;
      }
      // （もう砂の中：盛っても増えない。その先へ送る）
      if (env.solid && env.solid(cc[0], cc[1], cc[2]) < -r0 * 0.55) {
        if (this.planDbg) this.planDbg.push({ c: cc, room, why: 'solid' });
        continue;
      }
      if (this.planDbg) this.planDbg.push({ c: cc, room, why: rr < FILL.rMin * 0.6 ? 'near' : 'ok' });
      if (rr < FILL.rMin * 0.6) {
        why = why ?? 'near';
        continue;
      }
      if (!best || room > best.room + 1e-3) best = { c: cc, w: ww, a: aa, b: bb, r: rr, room };
      if (room >= FILL.rMax * 0.8) break;
    }
    if (!best) return { a: c, b: c, c, r: 0, grow: -1, add: 0, why: why ?? 'near' };
    ({ c, w, a, b, r } = best);
    why = null;
    if (cands.indexOf(c) > 0) this.stats.fillShift++;
    // 手持ちの砂が足りなければ小さく（小さすぎれば盛れない）
    let add = fillVolume(r, w) * FILL.aboveK;
    if (add > budget) {
      r = Math.cbrt(budget / FILL.aboveK / ((4 / 3) * Math.PI));
      [a, b] = ends(c, sd, 0);
      add = fillVolume(r, 0) * FILL.aboveK;
      if (r < FILL.rMin * 0.5) return { a, b, c, r: 0, grow: -1, add: 0, why: 'empty' };
    }
    return { a, b, c, r, grow: -1, add, why: null };
  }

  // ---------------- かき出し ----------------

  /**
   * 区画の一覧へ番号の小さい順に入れる。carve の滑らかな min（smin）は足す順で値がわずかに変わるので、
   * 掘りながら（太らせた空洞があとから別の区画へ入る）でも、保存データから一度に戻しても同じ順＝同じ値になるようにする
   */
  private register(id: number) {
    const p = this.prims[id];
    const i0 = this.ci(p.min[0] - PAD), i1 = this.ci(p.max[0] + PAD), j0 = this.cj(p.min[2] - PAD), j1 = this.cj(p.max[2] + PAD);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cid = j * this.ncx + i;
      const list = this.cells[cid];
      let added = true;
      if (list.length === 0 || list[list.length - 1] < id) list.push(id);
      else if (!list.includes(id)) {
        let k = list.length;
        while (k > 0 && list[k - 1] > id) k--;
        list.splice(k, 0, id);
      } else added = false;
      if (p.fill) {
        if (added) this.fillN[cid]++;
        this.fillTop[cid] = Math.max(this.fillTop[cid], p.max[1]);
      }
    }
  }

  /** 形が変わった範囲の区画を作り直しの印にする（Surface Nets の重なり 0.1 + 縁の丸みの分だけ広げる） */
  private markDirty(min: V3, max: V3) {
    const m = 0.25;
    const i0 = this.ci(min[0] - m), i1 = this.ci(max[0] + m), j0 = this.cj(min[2] - m), j1 = this.cj(max[2] + m);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const id = j * this.ncx + i;
      if (!this.locked[id]) this.dirty.add(id);
    }
  }

  private bounds(p: CarvePrim) {
    for (let k = 0; k < 3; k++) {
      p.min[k] = Math.min(p.a[k], p.b[k]) - p.r;
      p.max[k] = Math.max(p.a[k], p.b[k]) + p.r;
    }
  }

  /**
   * 空洞・盛った砂を足す（a = b なら球）。種類が直前に足した物と違えば新しい層にする。そのとき、もう一方の続け
   * （掘り続け・盛り続け）を切る（前の層の物をあとから太らせると、層の順序と見た目の順序が食い違うので）
   */
  private add(a: V3, b: V3, r: number, fill = false): number {
    if (this.job) this.measureStep(Infinity);
    const f: 0 | 1 = fill ? 1 : 0;
    if (this.prims.length === 0) {
      this.layerNo = 0;
      this.layerFill = f;
    } else if (f !== this.layerFill) {
      this.layerNo++;
      this.layerFill = f;
      if (f) this.session = { last: -1, r: 0, time: -10, recent: [] };
      else this.fillSession = { last: -1, time: -10, side: [1, 0, 0] };
    }
    const p: CarvePrim = { a: [...a], b: [...b], r, min: [0, 0, 0], max: [0, 0, 0], fill: f, layer: this.layerNo };
    this.bounds(p);
    const id = this.prims.push(p) - 1;
    this.editSerial++;
    this.live.push(null);
    this.snap.push(null);
    this.changed.add(id);
    this.register(id);
    this.markDirty(p.min, p.max);
    this.touchEdit(id, p.min, p.max, true);
    return id;
  }

  /** 空洞・砂山の形を変える（伸ばす・太らせる）。変わる前と後の両方の範囲を作り直す */
  private modify(id: number, b: V3 | null, r: number, a: V3 | null = null) {
    if (this.job) this.measureStep(Infinity);
    const p = this.prims[id];
    const oldMin: V3 = [...p.min], oldMax: V3 = [...p.max];
    this.touchEdit(id, oldMin, oldMax, false);
    this.editSerial++;
    if (a) p.a = [...a];
    if (b) p.b = [...b];
    p.r = Math.max(p.r, r);
    this.bounds(p);
    this.changed.add(id);
    this.register(id);
    this.touchEdit(id, p.min, p.max, false);
    this.markDirty([Math.min(oldMin[0], p.min[0]), Math.min(oldMin[1], p.min[1]), Math.min(oldMin[2], p.min[2])], [Math.max(oldMax[0], p.max[0]), Math.max(oldMax[1], p.max[1]), Math.max(oldMax[2], p.max[2])]);
  }

  /**
   * 1 回のかき出し。o = 体の中心、dir = 掘る向き（単位）、tHit = o から dir へ最初に当たった砂までの距離（届かなければ null）、
   * now = 時刻（秒）、floorMin = 空洞の床をこれより下げない高さ。続けて掘っている間は半径が広がり、直前の空洞を伸ばす。
   * 届かなくても直前の空洞を太らせる
   */
  stroke(o: V3, dir: V3, tHit: number | null, now: number, floorMin = -Infinity, reach: number = DIG.reach): DigStrokeResult {
    const t0 = performance.now();
    const S = this.session;
    if (now - S.time > 0.6) {
      S.last = -1;
      S.r = DIG.rMin - DIG.grow;
      S.recent = [];
    }
    S.time = now;
    S.r = Math.min(DIG.rMax, S.r + DIG.grow);
    const r = S.r;
    this.stats.strokes++;
    let changed = false;
    let at: V3 = [o[0] + dir[0] * reach * 0.6, o[1] + dir[1] * reach * 0.6, o[2] + dir[2] * reach * 0.6];
    const last = S.last >= 0 ? this.prims[S.last] : null;
    // 直前の空洞から離れすぎた（歩いて移動した）ら、新しく掘り始める
    if (last && Math.hypot(last.b[0] - o[0], last.b[1] - o[1], last.b[2] - o[2]) > 1.6) {
      S.last = -1;
      S.recent = [];
    }
    if (tHit !== null && this.prims.length < DIG.maxPrims) {
      const s = Math.min(tHit + r * 0.3, reach);
      const c: V3 = [o[0] + dir[0] * s, o[1] + dir[1] * s, o[2] + dir[2] * s];
      c[1] = Math.max(c[1], floorMin + r * DIG.floorK);
      at = c;
      const lp = S.last >= 0 ? this.prims[S.last] : null;
      const gap = lp ? Math.hypot(c[0] - lp.b[0], c[1] - lp.b[1], c[2] - lp.b[2]) : Infinity;
      if (lp && gap < 0.18) this.modify(S.last, c, r);
      else {
        // 新しい空洞はカニの体の位置から掘る所へ伸ばす（床がちょうど足元から始まる）。直前の空洞の端から伸ばすと、
        // 上・下へ向きを変えたときに坂の床が足元より上から始まり、越えられない段差が残る
        const start: V3 = [o[0], o[1] - 0.26 + r * DIG.floorK, o[2]];
        S.last = this.add(start, c, r);
        S.recent.push(S.last);
        if (S.recent.length > 3) S.recent.shift();
      }
      changed = true;
    }
    // 掘り続けると手前の空洞も広がる（入口が細いまま残ってカニが入れない、を防ぐ）
    for (const id of S.recent) {
      if (this.prims[id].r < r - 1e-3) {
        this.modify(id, null, r);
        // 届かずに太らせただけのときは、太らせた空洞の先を「掘った所」にする（砂粒を出す位置）
        if (tHit === null) at = [...this.prims[id].b];
        changed = true;
      }
    }
    const ms = performance.now() - t0;
    if (changed) {
      this.stats.carves++;
      this.stats.carveMs += ms;
      this.stats.lastCarveMs = ms;
      this.stats.maxCarveMs = Math.max(this.stats.maxCarveMs, ms);
    }
    return { changed, at, r, ms };
  }
}

function copyPrim(p: CarvePrim): CarvePrim {
  return { a: [...p.a], b: [...p.b], r: p.r, min: [...p.min], max: [...p.max], fill: p.fill, layer: p.layer };
}

/** 保存の並び：版 2 は 1 個 = a.xyz, b.xyz, r, 種類（版 1 は種類なしの 7 個。AquaSave の migrate が 8 個へ直す） */
export const PRIM_STRIDE_V2 = 8;
