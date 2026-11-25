// 水槽ゲームの 2 種類のカメラ（状態だけ。Three.js のカメラへの反映は AquariumRenderer が行う）。
// 角度の決め方・ドラッグ量の係数は既存の CameraRig と同じ（yaw / pitch / direction()）。
// - 冒険カメラ：カニの斜め後方から追従する三人称。水面の高さちょうどに来ないよう（水面を真横から見て割れて見えないよう）
//   カニのいる側へずらす。視点の向き（yaw / pitch）はプレイヤーが決めたものをカメラが勝手に変えない（横へ回り込む・
//   持ち上げる・トンネルで水平に戻す、はしない）。障害物の避け方（orbitPose）：
//   1. 床（上向きの面：砂・岩の上面・部屋の床）は、カメラを床の上に留めたまま、それ以上下へ回した分を「見上げる」角度に
//      変える（床から水槽を見上げる・水中から水面を見上げる）。見上げるほど画角を少し広げる。
//      天井（下向きの面：トンネル・洞窟の天井）も同じ考え方で、天井の下に留めたまま、それ以上上へ回した分を「見下ろす」角度に
//      変える（操作が止まったように感じない）。
//   2. 薄い物（流木の殻・枝・岩の縁・台の板・家具。厚さ THIN 以下で、その先にカメラを置ける）は距離を縮めずに越え、
//      カメラとカニの間に入った部分だけを描画でディザ状に抜く（cut。AquariumRenderer の OCCLUDER_CUT）。
//      砂（掘ったトンネルの壁・地面）と厚い岩は越えない（抜くと中身の無い断面＝裏側が見えるので）：そこで止まる距離へ
//      なめらかに寄る（寄るのは少し速く、離れるのはゆっくり。回している先の縁は少し先読みする）。
//      寄らされて近いときは画角を少し広げ、狭い所でもカニのまわりと進む先が見えるようにする。
//   3. 透明な板（ガラス・アクリル）はカメラの移動を止めない（板の中にだけは留まらない）。
//   4. 最後に、カメラの位置が固体の中なら注視点の側へ戻す（めり込み防止の安全網。2 で越えた薄い物の中を通る間は除く）。
//   ズームの上限は区画ごと（部屋は水槽全体が入るよう遠くまで引ける）。
//   どこかの値が数でなくなったら（NaN・無限大）、カニの後ろの既定の視点へ戻す（異常な状態から必ず復帰する）。
// - 箱庭カメラ：水槽の外から全体を見回す。回転・ズームのみ（カニの位置は画面上の印で示す）。
// 切り替えてもカニの位置・向きは変えない（カメラの状態は別々に持つ）。
// - 水槽の外：カニのいる区画（CrabController.region）ごとに範囲と遮蔽を変える。
//   排水管の中は真上から覗き込み（管の内側に留める）、給水管の中は流れの上流から追う。濾過槽・水槽台・部屋は
//   不透明な物だけで遮蔽を判定し、透明な壁（ガラス・アクリル・管）はカニがその内側にいないときだけ遮る。
//   区画が変わった直後はカメラの位置をなめらかにつなぐ。箱庭カメラは水槽・排水管・真下の濾過槽が一度に入る構図。
// - 見晴らし：見晴らしの良い場所（setVista）でカニが立ち止まり、しばらく視点を触らないでいると、
//   冒険カメラがその場所の眺めの向きへゆっくり回り込む（ドラッグ・ホイールですぐ手放す）。
// - 地下（掘ったトンネルの中）：三人称の腕は砂の壁で縮み、カニが画面を塞いで向きが分からなくなる。そこで、
//   カニの体の中心が掘った空洞の中にあり、元の地表より下で、頭の上に砂の天井があるほど（tunnel 0..1。なめらかに変える）、
//   頭の上からの近い視点（tunnelCam = 'near'：一人称に近い構図）へ寄せる。
//   - 視点の向き（yaw / pitch）は三人称と同じ値をそのまま使う（三人称で「カニを見る向き」＝近い視点で「前を見る向き」）。
//     移動の基準（camera.yaw）も変わらないので、出入りで移動の向き・掘る向きが変わらない。
//   - 三人称の姿勢と近い視点の姿勢を、毎フレームそれぞれ求めて tunnel で混ぜる（位置・見る向き・画角）。
//     どちらも壁から離した位置なので、混ぜた位置が砂の中に入ったときだけ近い視点の位置を使う。
//   - カメラがカニに近いほど、カニの体・脚をディザで透かす（crabFade。鋏は半分だけ。視界を塞がない）。
//   - 掘った穴のそば（digNear）だけ：カニの進む先（LEAD 秒後）でも床・天井・腕の長さ・地下の度合いを先読みし、
//     遮蔽で寄る速さに上限（CLOSE_SPEED）を設け、最後にカメラの位置の動きを「カニの動き + SMOOTH まで」に抑える
//     （地上 ↔ トンネルの出入りで 1 フレームに大きく飛ばない。見る向き・プレイヤーの yaw / pitch は変えない。
//     固体に入るときだけ最小限に詰める。視点の操作中は抑えない）。それ以外の場所の振る舞いは変えない。
//   比べた方式（tunnelCam）：'orbit' = 従来の三人称のまま、'shoulder' = 腕を 1.1 に縮めた肩越し、'near' = 頭の上の近い視点。
//   既定は 'near'（docs/aquarium/free-dig-tunnel-cam/report.md の比較）。

import { clamp, smoothstep } from '../core/math';
import type { Input } from '../game/Input';
import { TANK, type AquariumWorld } from './AquariumWorld';
import { DECK, ROOM, SUMP_IN, type Region } from './AquariumStand';

/** 区画ごとの冒険カメラのズームの上限（部屋は水槽台と水槽の全体が入るまで引ける） */
const ZOOM_MAX: Record<Region, number> = { tank: 10, drain: 10, return: 10, sump: 10, stand: 9, room: 26 };
/** カメラの球の半径（遮蔽・床の判定）と、めり込みの安全網の半径 */
const CAM_R = 0.22;
const CAM_HARD = 0.1;
/** 見上げる角度の上限（真上ちょうどは向きが決まらないので少し手前まで） */
const LOOK_UP_MAX = 1.38;
/** 越えて描画で抜いてよい物の厚さ（カメラの向きに沿った長さ。カメラの球の半径の分 2 × CAM_R を含む）と、抜く範囲の半径（カニの位置での） */
const THIN = 1.5;
const CUT_RADIUS = 0.8;
/** 見下ろす角度の上限（天井で止まったとき） */
const LOOK_DOWN_MAX = 1.2;
/** 透明な板からカメラを離しておく距離 */
const PANEL_GAP = 0.18;
/**
 * 地下の近い視点：頭の上の高さ（体の中心から。天井が低ければ下げる）・見る向きの水平な後ろへ引く最大の距離・壁から離す距離・画角。
 * 肩越し：腕の長さ（注視点はカニ）
 */
const NEAR = { lift: 0.44, back: 0.9, gap: 0.12, fov: 68, maxPitch: 1.1 };
const SHOULDER = { back: 1.1, fov: 64 };
/**
 * 先読みの時間（秒）：カニの進む先（いまの速度でこの時間後）の注視点でも、床・天井・腕の長さ・地下の度合いを調べ、
 * 厳しい方を使う。地表から斜め下の坂を下ってトンネルへ入ると、坂の床・溝の縁・入口の上の砂で腕が 0.3 秒ほどの間に
 * 3 → 0.7 に縮み、カメラが 1 フレームに 0.4 近く飛んでいた。先に動き始めて、同じ動きを長い時間に分ける
 */
const LEAD = 0.35;
/** 遮蔽で寄るときの速さの上限（1 秒あたり。カメラの位置がまだ固体から離れている間） */
const CLOSE_SPEED = 3.5;
/**
 * 掘った穴のそば（digNear）での、カメラの位置の動きの上限（カニの動きを除いた分。1 秒あたり）。
 * カニが見えている間は SMOOTH.see、砂に隠れている間は SMOOTH.hidden（早く追いつく）。視点を操作している間は制限しない
 */
const SMOOTH = { see: 4.5, hidden: 9 };
/** 壁登り中に注視点を面の外向きへ離す距離 */
const CLIMB_LIFT = 0.3;

export type TunnelCam = 'orbit' | 'shoulder' | 'near';
import type { VistaView } from './AquariumSpots';
import type { CrabController } from './CrabController';

export type CameraMode = 'adventure' | 'diorama';
export const CAMERA_MODE_LABEL: Record<CameraMode, string> = { adventure: '冒険カメラ', diorama: '箱庭カメラ' };

export interface CameraPose {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
}

interface Orbit {
  yaw: number;
  pitch: number;
  /** 注視点からの距離 */
  zoom: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly minPitch: number;
  readonly maxPitch: number;
}

type V3 = [number, number, number];

function direction(o: { yaw: number; pitch: number }): V3 {
  const cp = Math.cos(o.pitch);
  return [cp * Math.sin(o.yaw), Math.sin(o.pitch), cp * Math.cos(o.yaw)];
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, -1];
}

/** 位置 p から aim を見る向きを、上へ a ラジアン起こした注視点（真上の少し手前で止める） */
function tiltUp(p: V3, aim: V3, a: number): V3 {
  const fx = aim[0] - p[0], fy = aim[1] - p[1], fz = aim[2] - p[2];
  const h = Math.hypot(fx, fz);
  if (h < 1e-3) return aim;
  const L = Math.max(4, Math.hypot(h, fy));
  const el = Math.min(Math.atan2(fy, h) + a, LOOK_UP_MAX);
  const ce = Math.cos(el) * L;
  return [p[0] + (fx / h) * ce, p[1] + Math.sin(el) * L, p[2] + (fz / h) * ce];
}

export class AquaCamera {
  mode: CameraMode = 'adventure';
  // minPitch が深いのは、床で止まったカメラから見上げられるようにするため（床より下へ回した分は見上げる角度になる）
  readonly adventure: Orbit = { yaw: 0, pitch: 0.3, zoom: 3.2, minZoom: 1.4, maxZoom: ZOOM_MAX.room, minPitch: -1.25, maxPitch: 1.35 };
  readonly diorama: Orbit = { yaw: 0.42, pitch: 0.3, zoom: 68, minZoom: 22, maxZoom: 115, minPitch: -0.12, maxPitch: 1.45 };
  /** 追従する注視点（平滑化） */
  readonly target = { x: 0, y: 0, z: 0 };
  /** 遮蔽を避けたあとの実際の距離 */
  private dist = 3.6;
  /** 直前の姿勢（描画側が読む） */
  readonly pose: CameraPose = { pos: [0, 10, 40], target: [0, 5, 0], fov: 50 };
  /** 遮蔽で寄っているか（表示用） */
  occluded = false;
  autoRotate = false;
  /** いまいる見晴らしの良い場所の眺め（無ければ null） */
  private vista: VistaView | null = null;
  /** カニが止まっている時間・視点を最後に触ってからの時間 */
  private stillT = 0;
  private userT = 10;
  /** 見晴らしの眺めへ回り込んでいる最中か（表示用） */
  viewing = false;
  /** カメラが追っている区画 */
  region: Region = 'tank';
  /** 区画が変わってからの、位置をつなぐ残り時間 */
  private blendT = 0;
  /** 見晴らしで注視点を眺めの先（aim）へ寄せる割合 */
  private aimW = 0;
  /** 床に止められたカメラの仰角の下限・天井に止められた上限（平滑化。±2 = 制限なし） */
  private floorPitch = -2;
  private ceilPitch = 2;
  /** 見上げている量（床で止まった分）・見下ろしている量（天井で止まった分）。表示・検証用 */
  lookUp = 0;
  lookDown = 0;
  /** トンネルの中にいる度合い（0..1。平滑化。地下の近い視点へ寄せる割合） */
  tunnel = 0;
  /** 地下の視点の方式（比較用に切り替えられる） */
  tunnelCam: TunnelCam = 'near';
  /** カニを透かす量（0..1。カメラがカニに近いほど大きい。描画側が読む） */
  crabFade = 0;
  /** 地下の近い視点の、頭の上から後ろへ引いた距離（肩越しは腕の長さ。平滑化） */
  private nearDist = 0;
  /** 混ぜた位置が砂の中で、近い視点の位置を使った回数（検証用） */
  blendFallback = 0;
  /** 寄らされて近いときに広げる画角（度。平滑化） */
  private closeFov = 0;
  /**
   * 描画で抜く範囲（薄い物を越えたとき）：to = カニの体の中心、near / far = カメラからの距離の範囲、
   * radius = カニの位置での半径（カメラに近いほど細い円すい）、on = 強さ 0..1（平滑化）
   */
  readonly cut = { to: [0, 0, 0] as V3, near: 0, far: 0, radius: CUT_RADIUS, on: 0 };
  /** 異常な値から戻した回数（検証用） */
  recovered = 0;
  /** 掘った穴のそばにいるか（先読み・動きの上限を使う。update が決める） */
  private digNear = false;
  /** カニの体の中心の先読みの位置（掘った穴のそばだけ。それ以外は null） */
  private lead: V3 | null = null;
  /** 動きの上限：直前のカメラの位置・カニの位置（null = つながない）と、上限で詰められずに固体の手前まで寄せた回数（検証用） */
  private smoothPrev: { pos: V3; crab: V3 } | null = null;
  smoothSnaps = 0;
  /** 壁登り中の度合い（0..1。平滑化。注視点を面から離す） */
  private climbW = 0;

  constructor(private readonly world: AquariumWorld) {}

  /** カニの背中側（体の後ろ）から見る向きにする */
  placeBehind(c: CrabController) {
    this.adventure.yaw = c.heading + Math.PI + 0.45;
    this.target.x = c.x;
    this.target.y = c.y + 0.3;
    this.target.z = c.z;
  }

  setVista(v: VistaView | null) {
    if (v !== this.vista) this.viewing = false;
    this.vista = v;
  }

  toggle(): CameraMode {
    this.mode = this.mode === 'adventure' ? 'diorama' : 'adventure';
    return this.mode;
  }

  update(dt: number, input: Input, c: CrabController) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    this.sanitize(c);
    const o = this.mode === 'adventure' ? this.adventure : this.diorama;
    // 既存の CameraRig と同じ係数（ドラッグ 1px あたりの回転量、ホイール 1 段で 1.12 倍）
    o.yaw -= input.dragDX * 0.006;
    o.pitch = clamp(o.pitch + input.dragDY * 0.004, o.minPitch, o.maxPitch);
    const zMax = this.mode === 'adventure' ? ZOOM_MAX[c.region] : o.maxZoom;
    if (input.wheel !== 0) o.zoom = clamp(o.zoom * Math.pow(1.12, input.wheel), o.minZoom, zMax);
    if (this.autoRotate && this.mode === 'diorama') o.yaw += dt * 0.12;
    const touched = input.dragDX !== 0 || input.dragDY !== 0 || input.wheel !== 0;
    this.userT = touched ? 0 : this.userT + dt;
    this.stillT = c.state === 'idle' && c.grounded ? this.stillT + dt : 0;
    // 見晴らし：止まって 1.2 秒・視点を触らず 1.5 秒で、眺めの向きへ回り込む
    const v = this.vista;
    this.viewing = this.mode === 'adventure' && v !== null && this.stillT > 1.2 && this.userT > 1.5;
    if (this.viewing && v) {
      const k = 1 - Math.exp(-dt * 0.9);
      const dy = Math.atan2(Math.sin(v.yaw - o.yaw), Math.cos(v.yaw - o.yaw));
      o.yaw += dy * k;
      o.pitch += (clamp(v.pitch, o.minPitch, o.maxPitch) - o.pitch) * k;
      o.zoom += (clamp(v.zoom, o.minZoom, o.maxZoom) - o.zoom) * k;
    }

    this.aimW += ((this.viewing && v?.aim ? 0.62 : 0) - this.aimW) * (1 - Math.exp(-dt * 1.2));

    // 注視点はカニを追う（箱庭カメラ中も追っておき、戻したときに飛ばないようにする）。管の中は速く流れるので強めに追う
    const fast = c.region === 'drain' || c.region === 'return';
    const kf = 1 - Math.exp(-dt * (fast ? 20 : 8));
    // 壁登り：注視点を面から離す（体の中心から面の外向きへ CLIMB_LIFT。腕が面のすぐそばから始まって壁へ食い込み、
    // カメラがカニに寄りすぎて壁しか見えなくなるのを防ぐ）。張り付く・離れるときはなめらかに
    this.climbW += ((c.climbing ? 1 : 0) - this.climbW) * (1 - Math.exp(-dt * 5));
    const lift = CLIMB_LIFT * this.climbW, n = c.climbN;
    this.target.x += (c.x + n[0] * lift - this.target.x) * kf;
    this.target.y += (c.y + 0.3 + n[1] * lift - this.target.y) * kf;
    this.target.z += (c.z + n[2] * lift - this.target.z) * kf;
    // 掘ったトンネルの中にいる度合い：体の中心が空洞の中で元の地表より下（深さ 0.05〜0.4 で 0→1）× 頭の上の砂の天井
    // （上が開いた溝・地表へ抜けた出口では 0）。入るときは少し速く、出るときはゆっくり変える（境目で急に変わらない）
    const cy = c.y + c.radius;
    // 掘った穴のそば：体の中心が空洞の近く（先読みの位置を含む）。それ以外の場所のカメラの振る舞いは変えない
    // （先読みもここだけで使う。1 フレームに 1 回求めて使い回す）
    const dg = this.world.dig;
    const Ld = c.region === 'tank' && dg.count > 0 ? this.leadPoint(c) : null;
    this.digNear = c.region === 'tank' && dg.count > 0 && (dg.carve(c.x, cy, c.z) < 0.8 || (Ld !== null && dg.carve(Ld[0], Ld[1], Ld[2]) < 0.8));
    this.lead = this.digNear ? Ld : null;
    const want = this.tunnelWant(c, cy);
    this.tunnel += (want - this.tunnel) * (1 - Math.exp(-dt * (want > this.tunnel ? 3 : 2)));
    if (c.region !== this.region) {
      this.region = c.region;
      this.blendT = 0.8;
      // 部屋で遠くまで引いたまま狭い区画へ入ったら、その区画の上限まで戻す
      this.adventure.zoom = Math.min(this.adventure.zoom, ZOOM_MAX[c.region]);
    }

    if (this.mode === 'diorama') {
      const [dx, dy, dz] = direction(o);
      // 水槽（y 0〜13）と、その真下の水槽台・濾過槽（y −12〜−1）が一度に入る高さを見る
      const t: [number, number, number] = [0, -0.5, 1.0];
      this.pose.target = t;
      this.pose.pos = [t[0] + dx * o.zoom, t[1] + dy * o.zoom, t[2] + dz * o.zoom];
      this.pose.fov = 40;
      this.occluded = false;
      this.blendT = 0;
      return;
    }

    const prev = this.pose.pos;
    let next: [number, number, number];
    let aim: [number, number, number] = [this.target.x, this.target.y, this.target.z];
    if (c.region === 'drain') {
      next = this.drainPose(o, c);
      aim = [c.x, c.y + c.radius, c.z];
    } else if (c.region === 'return') {
      next = this.returnPose(o, c);
      aim = [c.x, c.y + c.radius, c.z];
    } else next = this.orbitPose(o, c, dt);
    if (c.region === 'drain' || c.region === 'return') {
      this.lookUp = this.lookDown = 0;
      this.cut.on = 0;
    }
    // 区画が変わった直後は、前の位置からなめらかにつなぐ
    // （つないだ途中の位置が壁・床の中になるとき＝瞬間移動などで遠くから来たときは、つながずに切り替える）
    if (this.blendT > 0) {
      this.blendT -= dt;
      const k = 1 - Math.exp(-dt * 7);
      const b: V3 = [prev[0] + (next[0] - prev[0]) * k, prev[1] + (next[1] - prev[1]) * k, prev[2] + (next[2] - prev[2]) * k];
      if (this.world.cameraSolid(b[0], b[1], b[2], this.region) >= CAM_HARD * 0.8) next = b;
      else this.blendT = 0;
    }
    this.pose.pos = next;
    // 床で止まったカメラは、それ以上下へ回した分だけ見上げる（0.85 倍にして画角の広がりと合わせ、
    // 見上げ始めはカニが画面の下に残る。さらに回すと真上近くまで見上げられ、カニは画面の外へ出る）
    if (this.lookUp > 1e-3) aim = tiltUp(next, aim, this.lookUp * 0.85);
    // 見晴らしで眺めの先が決まっている場所（部屋から水槽を見上げる等）は、注視点をそちらへ寄せる
    if (this.aimW > 0.01 && v?.aim) aim = [aim[0] + (v.aim[0] - aim[0]) * this.aimW, aim[1] + (v.aim[1] - aim[1]) * this.aimW, aim[2] + (v.aim[2] - aim[2]) * this.aimW];
    this.pose.target = aim;
    // 天井で止まったカメラは、それ以上上へ回した分だけ見下ろす
    if (this.lookDown > 1e-3) aim = tiltUp(next, aim, -this.lookDown * 0.85);
    // 見上げるほど画角を広げる（足もとのカニと上の景色が一緒に入る）。寄らされて近いときも少し広げる
    const fov = 55 + 20 * smoothstep(0.05, 0.9, this.lookUp) + this.closeFov;
    this.pose.fov = fov + (v?.fov ? (v.fov - fov) * Math.min(1, this.aimW / 0.62) : 0);
    // 地下：三人称の姿勢を近い視点（または肩越し）へ寄せる
    const e = this.tunnelCam === 'orbit' || this.region !== 'tank' ? 0 : smoothstep(0, 1, this.tunnel);
    if (e > 1e-3) this.blendTunnel(o, c, e, dt);
    else this.nearDist = 0;
    this.smoothPose(c, dt, touched);
    // カメラがカニに近いほど、カニを透かす（体の中心から 1.0 で 0、0.35 で最大）
    const P = this.pose.pos;
    this.crabFade = 0.75 * smoothstep(1.0, 0.35, Math.hypot(P[0] - c.x, P[1] - cy, P[2] - c.z));
    this.sanitize(c);
  }

  /** 掘ったトンネルの中にいる度合いの目標（0..1）：空洞の中で元の地表より下にいる深さ × 頭の上の砂の天井 */
  private tunnelWant(c: CrabController, cy: number): number {
    if (c.region !== 'tank') return 0;
    // いまの位置と、進む先（先読み）の位置の大きい方（入口へ近づく間に近い視点へ寄せ始める）
    const L = this.lead;
    return Math.max(this.tunnelWantAt(c.x, cy, c.z), L ? this.tunnelWantAt(L[0], L[1], L[2]) : 0);
  }

  private tunnelWantAt(x: number, y: number, z: number): number {
    const w = this.world;
    if (!w.insideTank(x, z)) return 0;
    const depth = w.dig.tunnelDepth(x, y, z, w.groundAt(x, z));
    if (depth <= 0) return 0;
    let roof = 0;
    for (const h of [0.6, 0.9, 1.25]) if (w.sandSolid(x, y + h, z) < 0) roof++;
    return smoothstep(0.05, 0.4, depth) * Math.min(1, roof / 2);
  }

  /**
   * カニの体の中心の LEAD 秒後の位置（先読み）。ゆっくりのとき・水槽の外は null。進む先の途中が固体なら、その手前まで
   * （壁へ向かって押しているときに、壁の中から腕を調べてカメラが寄らないように）
   */
  private leadPoint(c: CrabController): V3 | null {
    if (c.region !== 'tank') return null;
    const vx = c.vx, vy = c.vy, vz = c.vz;
    if (Math.hypot(vx, vz) < 0.3) return null;
    const w = this.world, cy = c.y + c.radius;
    let k = 0;
    for (const f of [0.25, 0.5, 0.75, 1]) {
      if (w.contactSolid(c.x + vx * LEAD * f, cy + vy * LEAD * f, c.z + vz * LEAD * f) < c.radius * 0.5) break;
      k = f;
    }
    if (k === 0) return null;
    const x = c.x + vx * LEAD * k, z = c.z + vz * LEAD * k;
    let y = cy + vy * LEAD * k;
    // 歩いているとき（接地）は、進む先の床の高さに合わせる（坂を下ってトンネルへ入る・登って出るのを先に見る。
    // 接地中は縦の速さが 0 なので、速度だけでは下りを先読みできない）
    if (c.grounded) {
      // （探り始めが天井の砂の中なら、体の中心の高さから探る）
      const floor = w.contactSurfaceBelow(x, w.contactSolid(x, cy + 0.4, z) > 0.05 ? cy + 0.4 : cy, z) + c.radius;
      if (Number.isFinite(floor) && floor > cy - 1.2) y = floor;
    }
    return [x, y, z];
  }

  /**
   * 地下の視点へ寄せる（e = 寄せる割合 0..1）。近い視点：頭の上（天井が低ければ下げる）を中心に、視点の向きの後ろへ
   * 見る向きの水平な後ろへ NEAR.back（壁の手前まで）引き、前（三人称でカニを見ていた向き）を見る。肩越し：三人称の注視点から腕 1.1 で、カニを見る
   */
  private blendTunnel(o: Orbit, c: CrabController, e: number, dt: number) {
    const w = this.world, region = this.region, P = this.pose;
    const cx = c.x, cy = c.y + c.radius, cz = c.z;
    const shoulder = this.tunnelCam === 'shoulder';
    let pivot: V3;
    if (shoulder) pivot = [this.target.x, this.target.y, this.target.z];
    else {
      let h = NEAR.lift;
      while (h > 0.02 && w.cameraSolid(cx, cy + h, cz, region) < NEAR.gap) h -= 0.03;
      pivot = [cx, cy + Math.max(0, h), cz];
    }
    const d = direction({ yaw: o.yaw, pitch: clamp(o.pitch, -NEAR.maxPitch, NEAR.maxPitch) });
    // 近い視点は、頭の上（天井の近く）から見る向きの水平な後ろへ、トンネルが許すだけ（最大 NEAR.back）引く：
    // トンネルに沿って見ていれば、低い後ろからカニを小さく画面の下に入れて先を見通す。壁・天井を向いていて引けなければ、
    // 頭の上からの一人称に近い構図になる（カニは視界の下の外）。肩越しは腕の向きへ引く。
    // どちらも壁・天井の手前まで。近づくときはすぐ、離れるときはゆっくり（壁の凹凸で前後に揺れない）
    const hl = Math.hypot(d[0], d[2]) || 1;
    const m: V3 = shoulder ? d : [d[0] / hl, 0, d[2] / hl];
    const reach = shoulder ? Math.min(SHOULDER.back, o.zoom) : NEAR.back;
    let s = 0;
    while (s < reach) {
      const t = Math.min(reach, s + 0.04);
      if (w.cameraSolid(pivot[0] + m[0] * t, pivot[1] + m[1] * t, pivot[2] + m[2] * t, region) < NEAR.gap) break;
      s = t;
    }
    this.nearDist += (s - this.nearDist) * (1 - Math.exp(-dt * (s < this.nearDist ? 14 : 3)));
    this.nearDist = Math.min(this.nearDist, s);
    const pn: V3 = [pivot[0] + m[0] * this.nearDist, pivot[1] + m[1] * this.nearDist, pivot[2] + m[2] * this.nearDist];
    // 見る向き：近い視点は前、肩越しはカニ
    const fN = shoulder ? unit([this.target.x - pn[0], this.target.y - pn[1], this.target.z - pn[2]]) : [-d[0], -d[1], -d[2]];
    const pO = P.pos, tO = P.target;
    const fO = unit([tO[0] - pO[0], tO[1] - pO[1], tO[2] - pO[2]]);
    const mix = (k: number): V3 => [pO[0] + (pn[0] - pO[0]) * k, pO[1] + (pn[1] - pO[1]) * k, pO[2] + (pn[2] - pO[2]) * k];
    let pos = mix(e);
    // 混ぜた位置が砂の中なら（曲がったトンネルで三人称の位置と近い視点の間に壁がある）、近い視点の側へ少しずつ寄せる。
    // 三人称の位置そのものが壁に近いときは、それより近くなければよい（e が小さいときに近い視点へ飛ばない）
    const need = Math.min(CAM_HARD * 0.5, w.cameraSolid(pO[0], pO[1], pO[2], region) - 0.01);
    for (let k = e; k < 1 && w.cameraSolid(pos[0], pos[1], pos[2], region) < need; ) {
      k = Math.min(1, k + 0.1);
      pos = mix(k);
      this.blendFallback++;
    }
    const f = unit([fO[0] + (fN[0] - fO[0]) * e, fO[1] + (fN[1] - fO[1]) * e, fO[2] + (fN[2] - fO[2]) * e]);
    P.pos = pos;
    P.target = [pos[0] + f[0] * 3, pos[1] + f[1] * 3, pos[2] + f[2] * 3];
    P.fov += ((shoulder ? SHOULDER.fov : NEAR.fov) - P.fov) * e;
    // 越えた薄い物を抜く処理は、地下では使わない（カメラとカニの間に物が無い）
    this.cut.on = Math.min(this.cut.on, 1 - e);
  }

  /**
   * 掘った穴のそばでの、カメラの位置の動きの上限。求めた位置（pose.pos）へ、直前の位置 + カニの動きから、
   * 1 秒あたり SMOOTH まで近づける（地上 ↔ トンネルの出入りで、床・天井・腕の長さ・近い視点への寄せ方が一度に変わって
   * 1 フレームで飛ばないように）。見る向きは変えない（注視点も同じだけ動かす）。
   * 制限した位置が固体に近ければ、求めた位置との間で固体から離れる最初の所まで進める（地形の中・裏側を見せない）。
   * 視点を操作している間・瞬間移動・区画が変わったとき・穴のそばを離れたときはつながない
   */
  private smoothPose(c: CrabController, dt: number, touched: boolean) {
    const P = this.pose, w = this.world;
    const crab: V3 = [c.x, c.y + c.radius, c.z];
    const prev = this.smoothPrev;
    const ok = this.digNear && !touched && prev !== null && dt > 0 && this.blendT <= 0 &&
      Math.hypot(crab[0] - prev.crab[0], crab[1] - prev.crab[1], crab[2] - prev.crab[2]) < 0.5;
    if (ok) {
      const base: V3 = [prev.pos[0] + crab[0] - prev.crab[0], prev.pos[1] + crab[1] - prev.crab[1], prev.pos[2] + crab[2] - prev.crab[2]];
      const want = P.pos;
      const dx = want[0] - base[0], dy = want[1] - base[1], dz = want[2] - base[2];
      const len = Math.hypot(dx, dy, dz);
      const vmax = (this.sees(base, crab) ? SMOOTH.see : SMOOTH.hidden) * dt;
      if (len > vmax) {
        let k = vmax / len;
        let q: V3 = [base[0] + dx * k, base[1] + dy * k, base[2] + dz * k];
        if (w.cameraSolid(q[0], q[1], q[2], this.region) < CAM_HARD) {
          // 固体に近い：まず面の外向きへ最小限だけ押し出す（急な坂を登り始めたときなど、天井・壁が少し近づいただけで
          // 求めた位置の側へ大きく進めると 1 フレームに 0.5 近く飛んでいた）
          for (let i = 0; i < 4; i++) {
            const d = w.cameraSolid(q[0], q[1], q[2], this.region);
            if (d >= CAM_HARD) break;
            const n = w.cameraNormal(q[0], q[1], q[2], this.region);
            q = [q[0] + n[0] * (CAM_HARD + 0.01 - d), q[1] + n[1] * (CAM_HARD + 0.01 - d), q[2] + n[2] * (CAM_HARD + 0.01 - d)];
          }
          // それでも中なら、求めた位置の側へ、固体から離れる最初の所まで
          if (w.cameraSolid(q[0], q[1], q[2], this.region) < CAM_HARD * 0.8) q = [base[0] + dx * k, base[1] + dy * k, base[2] + dz * k];
          while (k < 1 && w.cameraSolid(q[0], q[1], q[2], this.region) < CAM_HARD * 0.8) {
            k = Math.min(1, k + 0.08);
            q = [base[0] + dx * k, base[1] + dy * k, base[2] + dz * k];
          }
          this.smoothSnaps++;
        }
        const ox = q[0] - want[0], oy = q[1] - want[1], oz = q[2] - want[2];
        P.pos = q;
        P.target = [P.target[0] + ox, P.target[1] + oy, P.target[2] + oz];
      }
    }
    this.smoothPrev = { pos: [...P.pos], crab };
  }

  /** カメラの位置 p からカニの体の中心が見えるか（間に砂・固体が無い） */
  private sees(p: V3, crab: V3): boolean {
    const w = this.world;
    for (let i = 1; i < 6; i++) {
      const f = i / 6;
      if (w.cameraSolid(p[0] + (crab[0] - p[0]) * f, p[1] + (crab[1] - p[1]) * f, p[2] + (crab[2] - p[2]) * f, this.region) < 0.02) return false;
    }
    return true;
  }

  /** 状態のどこかが数でなくなったら（NaN・無限大）、カニの後ろの既定の視点へ戻す */
  private sanitize(c: CrabController) {
    const o = this.adventure, d = this.diorama, t = this.target, P = this.pose;
    const ok = [o.yaw, o.pitch, o.zoom, d.yaw, d.pitch, d.zoom, t.x, t.y, t.z, this.dist, this.floorPitch, this.ceilPitch, this.tunnel, this.nearDist, ...P.pos, ...P.target, P.fov].every(Number.isFinite);
    if (ok) return;
    this.recovered++;
    if (!Number.isFinite(d.yaw)) d.yaw = 0.42;
    if (!Number.isFinite(d.pitch)) d.pitch = 0.3;
    if (!Number.isFinite(d.zoom)) d.zoom = 68;
    o.pitch = 0.3;
    o.zoom = 3.2;
    this.dist = 3.2;
    this.floorPitch = -2;
    this.ceilPitch = 2;
    this.lookUp = this.lookDown = this.closeFov = this.aimW = 0;
    this.tunnel = this.crabFade = 0;
    this.nearDist = 0;
    this.cut.on = 0;
    this.smoothPrev = null;
    this.placeBehind(c);
    const dir = direction(o);
    P.pos = [t.x + dir[0] * 3.2, t.y + dir[1] * 3.2, t.z + dir[2] * 3.2];
    P.target = [t.x, t.y, t.z];
    P.fov = 55;
  }

  /** 排水管の中：真上（管の内側）から覗き込む。管の口より上へは出すぎない */
  private drainPose(o: Orbit, c: CrabController): [number, number, number] {
    const S = this.world.stand;
    const [ax, az] = S.drainAxis;
    const D = clamp(o.zoom * 0.75, 1.4, 3.2);
    const r0 = Math.min(0.3, S.drain.inner - 0.3);
    this.occluded = false;
    this.dist = D;
    this.closeFov = 0;
    return [ax + Math.sin(o.yaw) * r0, Math.min(c.y + c.radius + D, S.drainRim + 1.6), az + Math.cos(o.yaw) * r0];
  }

  /** 給水管の中：流れの上流（管の中心線の少し後ろ）から追う */
  private returnPose(o: Orbit, c: CrabController): [number, number, number] {
    const P = this.world.stand.ret;
    const h = P.closest(c.x, c.y + c.radius, c.z);
    const D = clamp(o.zoom * 0.6, 1.2, 2.4);
    const sc = h.s - D;
    let p: [number, number, number];
    if (sc >= 0) p = P.pointAt(sc, [0, 0, 0]);
    else {
      const p0 = P.pts[0], u0 = P.tangentAt(0);
      p = [p0[0] + u0[0] * sc, p0[1] + u0[1] * sc + 0.3, p0[2] + u0[2] * sc];
    }
    // 真下・真上を向いたときにも向きが決まるよう、中心線から少しずらす
    const u = P.tangentAt(Math.max(0, sc));
    if (Math.abs(u[1]) > 0.8) p[0] += 0.12;
    else p[1] += 0.12;
    this.occluded = false;
    this.dist = D;
    return p;
  }

  /**
   * 水槽・濾過槽・水槽台・部屋の冒険カメラ。ファイル先頭の 1〜4 の順に障害物を避ける。
   * 視点の向き（yaw）はプレイヤーの操作のまま変えない（避けるのは距離・見上げる / 見下ろす角度・描画で抜く範囲で行う）
   */
  private orbitPose(o: Orbit, c: CrabController, dt: number): V3 {
    const w = this.world;
    const region = this.region;
    const T: V3 = [this.target.x, this.target.y, this.target.z];
    const Z = Math.min(o.zoom, ZOOM_MAX[region]);
    const yaw = o.yaw;
    const op = o.pitch;

    // 1. 床：いまの仰角で最初に当たるのが床なら、床に当たらない最小の仰角を探す（その分は見上げる）。
    //    天井：最初に当たるのが越えられない天井で、そこで大きく縮むなら、当たらない最大の仰角を探す（その分は見下ろす）
    const first = this.firstContact(T, yaw, op, Z);
    let fp = first === 'floor' ? this.searchPitch(T, yaw, op, Z, o.maxPitch, 'floor') : -2;
    let cp = first === 'ceil' ? this.searchPitch(T, yaw, op, Z, Math.max(o.minPitch, op - LOOK_DOWN_MAX), 'ceil') : 2;
    // 先読み：進む先の注視点でも調べて、厳しい方（床は高い方・天井は低い方）を使う
    const L = this.lead;
    const T2: V3 | null = L ? [L[0], L[1] + (this.target.y - (c.y + c.radius)), L[2]] : null;
    if (T2) {
      const f2 = this.firstContact(T2, yaw, op, Z);
      if (f2 === 'floor') fp = Math.max(fp, this.searchPitch(T2, yaw, op, Z, o.maxPitch, 'floor'));
      else if (f2 === 'ceil') cp = Math.min(cp, this.searchPitch(T2, yaw, op, Z, Math.max(o.minPitch, op - LOOK_DOWN_MAX), 'ceil'));
    }
    // 床・天井が近づくときは速く、離れるときはゆっくり追う（砂の起伏で上下に揺れない）。追いつくまでの間のめり込みは 4 が押し出す
    this.floorPitch += (fp - this.floorPitch) * (1 - Math.exp(-dt * (fp > this.floorPitch ? 14 : 4)));
    this.ceilPitch += (cp - this.ceilPitch) * (1 - Math.exp(-dt * (cp < this.ceilPitch ? 14 : 4)));
    const pitch = clamp(op, this.floorPitch, Math.max(this.floorPitch, this.ceilPitch));
    this.lookUp = Math.max(0, pitch - op);
    this.lookDown = Math.max(0, op - pitch);

    // 2. 腕（注視点 → カメラ）に沿って球を進める。薄い物は越えて、描画で抜く範囲を覚える
    const [dx, dy, dz] = direction({ yaw, pitch });
    const arm = this.castArm(T, yaw, pitch, Z);
    // 回している先の縁は手前から寄り始める（縁を横切った瞬間に飛び込まない）。左右を少し（カメラの位置で約 0.8 の幅）先読み
    const ahead = Math.min(0.25, 0.8 / Z);
    let hit = Math.min(arm.free, this.castArm(T, yaw + ahead, pitch, Z).free, this.castArm(T, yaw - ahead, pitch, Z).free);
    // 先読み：進む先の注視点からの腕も縮むなら、先に寄り始める
    if (T2) hit = Math.min(hit, this.castArm(T2, yaw, pitch, Z).free);
    this.occluded = hit < Z - 0.05;
    // 寄るときは少し速く、離れるときはゆっくり（ちらつき防止）。めり込みは 4 の安全網が防ぐので、寄るのも一瞬ではなくてよい。
    // 寄るのは、いまの距離のカメラの位置がまだ固体から離れている間は CLOSE_SPEED（1 秒あたり）まで
    // （大きく縮むときに 1 フレームで飛ばない。先読みで早めに寄り始めるので、間に合う）。固体に近ければ従来どおり速く寄る
    const closing = hit < this.dist;
    let nd = this.dist + (hit - this.dist) * (1 - Math.exp(-dt * (closing ? 9 : 2.5)));
    if (closing && this.digNear && this.dist - nd > CLOSE_SPEED * dt) {
      const q = direction({ yaw, pitch });
      const safe = w.cameraSolid(T[0] + q[0] * this.dist, T[1] + q[1] * this.dist, T[2] + q[2] * this.dist, region) > CAM_R;
      if (safe) nd = this.dist - CLOSE_SPEED * dt;
    }
    this.dist = nd;
    // 越えた薄い物の中をカメラが通る間は、4 の安全網で手前へ戻さない（戻すと遠ざかる向きに越えられなくなる）。
    // その物はカメラとカニの間で抜いて描くので、中を通っても視界は遮られない（面はカメラと反対を向いていて描かれない）
    const inPassed = arm.passed.some(([a0, a1]) => this.dist > a0 - 0.1 && this.dist < a1 + 0.05);
    // 寄らされて近いほど画角を広げる（最大 +16°）
    const near = this.dist < Z - 0.05 ? 1 - smoothstep(0.7, Math.max(1.2, Math.min(Z, 3)), this.dist) : 0;
    this.closeFov += (16 * near - this.closeFov) * (1 - Math.exp(-dt * 4));

    // 3. 透明な板（ガラス・アクリル）は通り抜けてよいが、板の中には留まらない（板の近い面の外へ押し出す。
    //    押し出した先がガラス際の砂にかかったら、4 が床の上へ持ち上げる）
    let s = this.dist;
    let px = T[0] + dx * s, py = T[1] + dy * s, pz = T[2] + dz * s;
    const pd = w.panelSolid(px, py, pz, region);
    if (pd < PANEL_GAP) {
      const n = w.panelNormal(px, py, pz, region);
      px += n[0] * (PANEL_GAP - pd);
      py += n[1] * (PANEL_GAP - pd);
      pz += n[2] * (PANEL_GAP - pd);
    }
    // 区画の範囲（部屋の壁の内側。濾過槽を追うときは水槽台の中の高さ。水槽を追うときは水槽の縁より少し上まで）
    px = clamp(px, ROOM.minX + 0.5, ROOM.maxX - 0.5);
    pz = clamp(pz, ROOM.minZ + 0.5, ROOM.maxZ - 0.5);
    py = clamp(py, ROOM.floorY + CAM_HARD, region === 'sump' ? DECK.y0 - 0.3 : region === 'tank' ? TANK.topY + 4 : ROOM.ceilY - 1);

    // 4. めり込みの安全網：床（上向きの面）なら上へ押し出す。壁なら注視点の側へ戻し、それでも中なら外へ押し出す
    for (let i = 0; i < 4 && !inPassed; i++) {
      const d = w.cameraSolid(px, py, pz, region);
      if (d >= CAM_HARD || !this.isFloor(px, py, pz, d)) break;
      // 斜面では押し上げた分より距離の増え方が小さいので、少し多めに持ち上げる
      py += (CAM_HARD + 0.03 - d) / 0.75;
    }
    if (!inPassed && w.cameraSolid(px, py, pz, region) < CAM_HARD * 0.8) {
      while (s > 0.45) {
        s -= 0.06;
        if (w.cameraSolid(T[0] + dx * s, T[1] + dy * s, T[2] + dz * s, region) >= CAM_HARD) break;
      }
      this.dist = Math.min(this.dist, s);
      px = T[0] + dx * s;
      py = T[1] + dy * s;
      pz = T[2] + dz * s;
      for (let i = 0; i < 4; i++) {
        const d = w.cameraSolid(px, py, pz, region);
        if (d >= CAM_HARD) break;
        const n = w.cameraNormal(px, py, pz, region);
        px += n[0] * (CAM_HARD - d);
        py += n[1] * (CAM_HARD - d);
        pz += n[2] * (CAM_HARD - d);
      }
    }

    // 水面の高さちょうどを避ける（カニのいる側へ寄せる）
    if (region === 'tank') {
      const band = 0.22;
      if (Math.abs(py - TANK.waterY) < band) py = c.y + 0.3 < TANK.waterY ? TANK.waterY - band : TANK.waterY + band;
    } else if (region === 'sump' && px > SUMP_IN.minX && px < SUMP_IN.maxX && pz > SUMP_IN.minZ && pz < SUMP_IN.maxZ) {
      const level = w.stand.chamberAt(px).level;
      const band = 0.18;
      if (Math.abs(py - level) < band) py = c.y + 0.3 < c.waterLevel ? level - band : level + band;
    }

    // 描画で抜く範囲：カメラから見た、越えた薄い物の区間（前後に少し余白）。カニの手前 0.5 より先は抜かない
    const D = Math.hypot(px - T[0], py - T[1], pz - T[2]);
    const cut = this.cut;
    const want = arm.cutFrom >= 0 && arm.cutFrom < D - 0.2 ? 1 : 0;
    if (want) {
      cut.near = Math.max(0, D - arm.cutTo - 0.3);
      cut.far = Math.max(cut.near, D - Math.max(arm.cutFrom - 0.3, 0.5));
    }
    cut.on += (want - cut.on) * (1 - Math.exp(-dt * (want ? 14 : 5)));
    cut.to = [c.x, c.y + c.radius, c.z];
    return [px, py, pz];
  }

  /**
   * 点の近くの面が床（上向き。法線の y が 0.55 より大きい）か。距離 d の点から少し上で距離がどれだけ増えるかで見る
   * （平面なら増え方 = 高さ × 法線の y。勾配を 6 回評価するより安い）
   */
  private isFloor(x: number, y: number, z: number, d: number): boolean {
    return this.world.cameraSolid(x, y + 0.15, z, this.region) - d > 0.15 * 0.55;
  }

  /** 点の近くの面が天井（下向き。法線の y が −0.55 より小さい）か */
  private isCeil(x: number, y: number, z: number, d: number): boolean {
    return this.world.cameraSolid(x, y - 0.15, z, this.region) - d > 0.15 * 0.55;
  }

  /**
   * 当たった物が砂（底床・掘った穴の壁）か：距離 v の点で、いちばん近い物が砂なら砂。砂は越えない
   * （描画で抜くと、中身の無い断面が見えるので）。砂の上に載った流木・岩は、近くに砂があっても越えてよい
   */
  private isSand(x: number, y: number, z: number, v: number): boolean {
    return this.region === 'tank' && this.world.insideTank(x, z) && this.world.sandSolid(x, y, z) < v + 0.03;
  }

  /** 薄い物か：腕の上の距離 s から先へ、THIN 以内に再びカメラを置ける所へ抜けるか。抜けた距離を返す（抜けなければ −1） */
  private thinExit(T: V3, d: V3, s: number, Z: number): number {
    const w = this.world, region = this.region;
    for (let e = s + 0.06; e <= s + THIN && e <= Z; e += 0.06) {
      if (w.cameraSolid(T[0] + d[0] * e, T[1] + d[1] * e, T[2] + d[2] * e, region) >= CAM_R) return e;
    }
    return -1;
  }

  /** 注視点から (yaw, pitch) の向きへ距離 Z まで球を進めて、最初に当たる面の種類（薄い物は越える） */
  private firstContact(T: V3, yaw: number, pitch: number, Z: number): 'none' | 'floor' | 'ceil' | 'wall' {
    const w = this.world, region = this.region;
    const d = direction({ yaw, pitch });
    let s = 0.3;
    for (let i = 0; i < 48; i++) {
      const t = Math.min(s, Z);
      const qx = T[0] + d[0] * t, qy = T[1] + d[1] * t, qz = T[2] + d[2] * t;
      const v = w.cameraSolid(qx, qy, qz, region);
      if (v < CAM_R) {
        if (this.isFloor(qx, qy, qz, v)) return 'floor';
        if (!this.isSand(qx, qy, qz, v)) {
          const e = this.thinExit(T, d, t, Z);
          if (e > 0) {
            s = e;
            continue;
          }
        }
        // 天井で大きく縮む（腕の 3/4 より手前で当たる）ときだけ見下ろしに変える。先のほうの天井は 2 の距離で寄る
        if (this.isCeil(qx, qy, qz, v)) return t < Z * 0.75 ? 'ceil' : 'wall';
        return 'wall';
      }
      if (s >= Z) return 'none';
      s += Math.max(0.05, v - CAM_R * 0.5);
    }
    return 'none';
  }

  /** 床（kind = floor：上へ）・天井（ceil：下へ）に当たらない仰角を、op から limit の向きへ探す（粗く進めてから二分探索） */
  private searchPitch(T: V3, yaw: number, op: number, Z: number, limit: number, kind: 'floor' | 'ceil'): number {
    const sgn = kind === 'floor' ? 1 : -1;
    let lo = op, hi = op;
    let found = false;
    for (const step of [0.12, 0.3, 0.6, 1.0, 1.6]) {
      hi = sgn > 0 ? Math.min(op + step, limit) : Math.max(op - step, limit);
      if (this.firstContact(T, yaw, hi, Z) !== kind) {
        found = true;
        break;
      }
      lo = hi;
    }
    if (!found) return hi;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (this.firstContact(T, yaw, mid, Z) === kind) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  /**
   * 注視点から (yaw, pitch) の向きへ、カメラを置ける距離（free）。腕の先のほうの床は 1 の仰角で扱うので素通りし、
   * 薄い物（砂以外で、THIN 以内に抜けられる物）は越える（cutFrom..cutTo = 越えた区間の全体、passed = 越えた物ごとの区間。
   * どちらも注視点からの距離）。
   * 砂・厚い物・腕の途中の床で止まる
   */
  private castArm(T: V3, yaw: number, pitch: number, Z: number): { free: number; cutFrom: number; cutTo: number; passed: [number, number][] } {
    const w = this.world, region = this.region;
    const d = direction({ yaw, pitch });
    let s = 0.3, cutFrom = -1, cutTo = -1;
    const passed: [number, number][] = [];
    for (let i = 0; i < 64 && s < Z; i++) {
      const qx = T[0] + d[0] * s, qy = T[1] + d[1] * s, qz = T[2] + d[2] * s;
      const v = w.cameraSolid(qx, qy, qz, region);
      if (v < CAM_R) {
        if (s > Z - 0.7 && this.isFloor(qx, qy, qz, v)) {
          s += 0.15;
          continue;
        }
        if (!this.isSand(qx, qy, qz, v)) {
          const e = this.thinExit(T, d, s, Z);
          if (e > 0) {
            if (cutFrom < 0) cutFrom = s;
            cutTo = e;
            passed.push([s, e]);
            s = e;
            continue;
          }
        }
        return { free: Math.max(0.6, s - 0.08), cutFrom, cutTo, passed };
      }
      s += Math.max(0.05, v - CAM_R * 0.5);
    }
    return { free: Z, cutFrom, cutTo, passed };
  }

  /** カメラ基準の移動に使う向き（どちらのカメラでも、いま見ている向き） */
  get yaw(): number {
    if (this.mode === 'adventure') return this.adventure.yaw;
    return this.diorama.yaw;
  }
}
