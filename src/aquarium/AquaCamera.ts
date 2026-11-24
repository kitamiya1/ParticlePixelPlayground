// 水槽ゲームの 2 種類のカメラ（状態だけ。Three.js のカメラへの反映は AquariumRenderer が行う）。
// 角度の決め方・ドラッグ量の係数は既存の CameraRig と同じ（yaw / pitch / direction()）。
// - 冒険カメラ：カニの斜め後方から追従する三人称。水面の高さちょうどに来ないよう（水面を真横から見て割れて見えないよう）
//   カニのいる側へずらす。障害物の避け方（orbitPose）：
//   1. 床（上向きの面：砂・岩の上面・部屋の床）は、カメラを床の上に留めたまま、それ以上下へ回した分を「見上げる」角度に
//      変える（床から水槽を見上げる・水中から水面を見上げる）。見上げるほど画角を少し広げる。
//   2. 壁・岩・流木は、そこで止める距離を決めて滑らかに寄る（寄るのは速く、離れるのはゆっくり）。細い枝は通り抜ける。
//      大きく寄らされたときはカメラを少し持ち上げ、上から越えて元の距離に近づける。
//   3. 透明な板（ガラス・アクリル）はカメラの移動を止めない（板の中にだけは留まらない）。
//   4. 最後に、カメラの位置が固体の中なら注視点の側へ戻す（めり込み防止の安全網）。
//   ズームの上限は区画ごと（部屋は水槽全体が入るよう遠くまで引ける）。
// - 箱庭カメラ：水槽の外から全体を見回す。回転・ズームのみ（カニの位置は画面上の印で示す）。
// 切り替えてもカニの位置・向きは変えない（カメラの状態は別々に持つ）。
// - 水槽の外：カニのいる区画（CrabController.region）ごとに範囲と遮蔽を変える。
//   排水管の中は真上から覗き込み（管の内側に留める）、給水管の中は流れの上流から追う。濾過槽・水槽台・部屋は
//   不透明な物だけで遮蔽を判定し、透明な壁（ガラス・アクリル・管）はカニがその内側にいないときだけ遮る。
//   区画が変わった直後はカメラの位置をなめらかにつなぐ。箱庭カメラは水槽・排水管・真下の濾過槽が一度に入る構図。
// - 掘ったトンネルの中（元の地表より下の空洞）：仰角を水平近くへ寄せ、距離を縮める（天井に当たって真上から
//   見下ろせないので、トンネルの奥行きに沿って後ろから見る）。プレイヤーの仰角そのものは変えないので、出れば元に戻る。
// - 見晴らし：見晴らしの良い場所（setVista）でカニが立ち止まり、しばらく視点を触らないでいると、
//   冒険カメラがその場所の眺めの向きへゆっくり回り込む（ドラッグ・ホイールですぐ手放す）。

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
/** 狭い場所で横へ回り込むときに試す向きのずれ（ラジアン） */
const SWING = [0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6];
/** 透明な板からカメラを離しておく距離 */
const PANEL_GAP = 0.18;
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
  /** 床に止められたカメラの仰角の下限（平滑化。−2 = 制限なし） */
  private floorPitch = -2;
  /** 壁に寄らされたときにカメラを持ち上げる量（平滑化） */
  private raise = 0;
  /** 狭い場所で横へ回り込んでいる量（平滑化。視点の向きと移動の向きの両方に足す） */
  private swing = 0;
  /** 見上げている量（床で止まった分。表示・検証用） */
  lookUp = 0;
  /** トンネルの中にいる度合い（0..1。平滑化） */
  tunnel = 0;
  /** トンネルの中：カニの後ろへ向かう床の傾き（仰角。平滑化。坂の下から見上げる・上から見下ろす） */
  private slope = 0;

  constructor(private readonly world: AquariumWorld) {}

  /** カニの背中側（体の後ろ）から見る向きにする */
  placeBehind(c: CrabController) {
    this.adventure.yaw = c.heading + Math.PI + 0.45;
    this.swing = this.raise = 0;
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
    this.target.x += (c.x - this.target.x) * kf;
    this.target.y += (c.y + 0.3 - this.target.y) * kf;
    this.target.z += (c.z - this.target.z) * kf;
    // 掘ったトンネルの中か（カニの体の中心が空洞の中で、元の地表より 0.25 以上下）
    const cy = c.y + c.radius;
    const inTunnel = c.region === 'tank' && this.world.dig.tunnelDepth(c.x, cy, c.z, this.world.groundAt(c.x, c.z)) > 0.25 ? 1 : 0;
    this.tunnel += (inTunnel - this.tunnel) * (1 - Math.exp(-dt * (inTunnel ? 5 : 2)));
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
    if (c.region === 'drain' || c.region === 'return') this.lookUp = this.swing = this.raise = 0;
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
    // 見上げるほど画角を広げる（足もとのカニと上の景色が一緒に入る）
    const fov = 55 + 20 * smoothstep(0.05, 0.9, this.lookUp);
    this.pose.fov = fov + (v?.fov ? (v.fov - fov) * Math.min(1, this.aimW / 0.62) : 0);
  }

  /** 排水管の中：真上（管の内側）から覗き込む。管の口より上へは出すぎない */
  private drainPose(o: Orbit, c: CrabController): [number, number, number] {
    const S = this.world.stand;
    const [ax, az] = S.drainAxis;
    const D = clamp(o.zoom * 0.75, 1.4, 3.2);
    const r0 = Math.min(0.3, S.drain.inner - 0.3);
    this.occluded = false;
    this.dist = D;
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
   * 水槽・濾過槽・水槽台・部屋の冒険カメラ。ファイル先頭の 1〜4 の順に障害物を避け、
   * 視点の向き（yaw）はプレイヤーの操作のまま変えない（避けるのは距離・高さ・見上げる角度で行う）
   */
  private orbitPose(o: Orbit, c: CrabController, dt: number): V3 {
    const w = this.world;
    const region = this.region;
    const T: V3 = [this.target.x, this.target.y, this.target.z];
    // トンネルの中：距離を縮め、仰角を水平近く（少し上から）にする
    const tu = this.tunnel;
    const Z = Math.min(o.zoom, ZOOM_MAX[region]) * (1 - tu) + Math.min(o.zoom, 2.3) * tu;
    // （天井の高さは床から約 0.85。後ろへ 2 離れても天井に当たらない程度のほぼ水平）
    //  坂（上・下へ掘ったトンネル）では、後ろへ向かう床の傾きに合わせる（水平のままだと坂の天井に当たって寄りすぎる）
    const n = c.groundN, dx0 = Math.sin(o.yaw), dz0 = Math.cos(o.yaw);
    const slopeWant = c.grounded ? Math.atan(-(n[0] * dx0 + n[2] * dz0) / Math.max(n[1], 0.3)) : this.slope;
    this.slope += (slopeWant - this.slope) * (1 - Math.exp(-dt * 4));
    const op = o.pitch * (1 - tu) + (clamp(o.pitch, -0.08, 0.09) + this.slope) * tu;

    // 1. 床：いまの仰角で床に当たるなら、当たらない最小の仰角を二分探索で求める
    let fp = -2;
    if (this.floorHit(T, o.yaw, op, Z)) {
      let lo = op, hi = op;
      for (const step of [0.12, 0.3, 0.6, 1.0, 1.6]) {
        hi = Math.min(op + step, o.maxPitch);
        if (!this.floorHit(T, o.yaw, hi, Z)) break;
        lo = hi;
      }
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        if (this.floorHit(T, o.yaw, mid, Z)) lo = mid;
        else hi = mid;
      }
      fp = hi;
    }
    // 床が上がるときは速く、下がるときはゆっくり追う（砂の起伏で上下に揺れない）。追いつくまでの間のめり込みは 4 が床の上へ押し出す
    this.floorPitch += (fp - this.floorPitch) * (1 - Math.exp(-dt * (fp > this.floorPitch ? 14 : 4)));
    const base = Math.max(op, this.floorPitch);
    // 床より下へ回した分は、カメラを動かさずに見上げる角度にする
    this.lookUp = base - op;

    // 2. 壁・岩・流木。狭い場所（トンネルの中・壁ぎわ）でカニのすぐ後ろまで寄らされるなら、
    //    空いている向きへ横に回り込む（判定はいつもプレイヤーの向きで行うので、行ったり来たりしない）
    const free0 = this.castFree(T, o.yaw, base, Z);
    let swingWant = 0;
    if (free0 < 1.3 && Z > 1.6) {
      let best = free0;
      for (const sy of SWING) {
        const f = this.castFree(T, o.yaw + sy, base, Z);
        // 回る量が少ないほど・いま回っている側ほど良い
        const score = f - Math.abs(sy) * 0.6 + (sy * this.swing > 0 ? 0.3 : 0);
        if (score > best + 0.4) {
          best = score;
          swingWant = sy;
        }
      }
    }
    this.swing += (swingWant - this.swing) * (1 - Math.exp(-dt * 3));
    const yaw = o.yaw + this.swing;
    // 大きく寄らされるなら、少し持ち上げて上から越えられるか試す
    const free = Math.abs(this.swing) < 1e-3 ? free0 : this.castFree(T, yaw, base, Z);
    let want = 0;
    if (free < Z * 0.7 && free < Z - 0.5) {
      const r = Math.min(0.45, (1 - free / Z) * 0.6);
      const p2 = Math.min(base + r, o.maxPitch);
      if (this.castFree(T, yaw, p2, Z) > free + 0.3) want = p2 - base;
    }
    this.raise += (want - this.raise) * (1 - Math.exp(-dt * 3));
    const pitch = Math.min(base + this.raise, o.maxPitch);
    const [dx, dy, dz] = direction({ yaw, pitch });
    // 左右を少し（カメラの位置で約 1 の幅）先読みして、回している先の壁の縁へは手前から寄り始める（縁を横切った瞬間に飛び込まない）
    // （トンネルの中は幅が狭く、先読みの向きが壁に当たって寄りすぎるので小さくする）
    const ahead = Math.min(0.25, 1 / Z) * (1 - 0.8 * tu);
    const hit = Math.min(pitch === base && this.raise < 1e-3 ? free : this.castFree(T, yaw, pitch, Z), this.castFree(T, yaw + ahead, pitch, Z), this.castFree(T, yaw - ahead, pitch, Z));
    this.occluded = hit < Z - 0.05;
    // 寄るときは速く、離れるときはゆっくり（ちらつき防止）。めり込みは 4 の安全網が防ぐので、寄るのも一瞬ではなくてよい
    this.dist += (hit - this.dist) * (1 - Math.exp(-dt * (hit < this.dist ? 14 : 2.5)));
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
    for (let i = 0; i < 4; i++) {
      const d = w.cameraSolid(px, py, pz, region);
      if (d >= CAM_HARD || !this.isFloor(px, py, pz, d)) break;
      // 斜面では押し上げた分より距離の増え方が小さいので、少し多めに持ち上げる
      py += (CAM_HARD + 0.03 - d) / 0.75;
    }
    if (w.cameraSolid(px, py, pz, region) < CAM_HARD * 0.8) {
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
    return [px, py, pz];
  }

  /**
   * 点の近くの面が床（上向き。法線の y が 0.55 より大きい）か。距離 d の点から少し上で距離がどれだけ増えるかで見る
   * （平面なら増え方 = 高さ × 法線の y。勾配を 6 回評価するより安い）
   */
  private isFloor(x: number, y: number, z: number, d: number): boolean {
    return this.world.cameraSolid(x, y + 0.15, z, this.region) - d > 0.15 * 0.55;
  }

  /** 注視点から (yaw, pitch) の向きへ距離 Z まで球を進めて、最初に当たる物が床（上向きの面）か */
  private floorHit(T: V3, yaw: number, pitch: number, Z: number): boolean {
    const w = this.world, region = this.region;
    const [dx, dy, dz] = direction({ yaw, pitch });
    let s = 0.3;
    for (let i = 0; i < 48; i++) {
      const t = Math.min(s, Z);
      const qx = T[0] + dx * t, qy = T[1] + dy * t, qz = T[2] + dz * t;
      const d = w.cameraSolid(qx, qy, qz, region);
      if (d < CAM_R) return this.isFloor(qx, qy, qz, d);
      if (s >= Z) return false;
      s += Math.max(0.05, d - CAM_R * 0.5);
    }
    return false;
  }

  /** 注視点から (yaw, pitch) の向きへ、カメラを置ける距離（床は 1 で扱うので素通りし、壁・岩・流木で止まる） */
  private castFree(T: V3, yaw: number, pitch: number, Z: number): number {
    const w = this.world, region = this.region;
    const [dx, dy, dz] = direction({ yaw, pitch });
    let s = 0.3;
    for (let i = 0; i < 48 && s < Z; i++) {
      const qx = T[0] + dx * s, qy = T[1] + dy * s, qz = T[2] + dz * s;
      const d = w.cameraSolid(qx, qy, qz, region);
      if (d < CAM_R) {
        if (this.isFloor(qx, qy, qz, d)) {
          s += 0.15;
          continue;
        }
        return Math.max(0.6, s - 0.08);
      }
      s += Math.max(0.05, d - CAM_R * 0.5);
    }
    return Z;
  }

  /** カメラ基準の移動に使う向き（どちらのカメラでも、いま見ている向き） */
  get yaw(): number {
    if (this.mode === 'adventure') return this.adventure.yaw + this.swing;
    return this.diorama.yaw;
  }
}
