// 水槽ゲームの 2 種類のカメラ（状態だけ。Three.js のカメラへの反映は AquariumRenderer が行う）。
// 角度の決め方・ドラッグ量の係数は既存の CameraRig と同じ（yaw / pitch / direction()）。
// - 冒険カメラ：カニの斜め後方から追従する三人称。岩・流木に遮られたら手前へ寄り、
//   水面の高さちょうどに来ないよう（水面を真横から見て割れて見えないよう）カニのいる側へずらす。
// - 箱庭カメラ：水槽の外から全体を見回す。回転・ズームのみ（カニの位置は画面上の印で示す）。
// 切り替えてもカニの位置・向きは変えない（カメラの状態は別々に持つ）。
// - 水槽の外：カニのいる区画（CrabController.region）ごとに範囲と遮蔽を変える。
//   排水管の中は真上から覗き込み（管の内側に留める）、給水管の中は流れの上流から追う。濾過槽・水槽台・部屋は
//   不透明な物だけで遮蔽を判定し、透明な壁（ガラス・アクリル・管）はカニがその内側にいないときだけ遮る。
//   区画が変わった直後はカメラの位置をなめらかにつなぐ。箱庭カメラは水槽・排水管・真下の濾過槽が一度に入る構図。
// - 見晴らし：見晴らしの良い場所（setVista）でカニが立ち止まり、しばらく視点を触らないでいると、
//   冒険カメラがその場所の眺めの向きへゆっくり回り込む（ドラッグ・ホイールですぐ手放す）。

import { clamp } from '../core/math';
import type { Input } from '../game/Input';
import { TANK, type AquariumWorld } from './AquariumWorld';
import { DECK, ROOM, SUMP, SUMP_IN, type Region } from './AquariumStand';
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

function direction(o: { yaw: number; pitch: number }): [number, number, number] {
  const cp = Math.cos(o.pitch);
  return [cp * Math.sin(o.yaw), Math.sin(o.pitch), cp * Math.cos(o.yaw)];
}

export class AquaCamera {
  mode: CameraMode = 'adventure';
  readonly adventure: Orbit = { yaw: 0, pitch: 0.3, zoom: 3.2, minZoom: 1.4, maxZoom: 10, minPitch: -0.35, maxPitch: 1.35 };
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
    const o = this.mode === 'adventure' ? this.adventure : this.diorama;
    // 既存の CameraRig と同じ係数（ドラッグ 1px あたりの回転量、ホイール 1 段で 1.12 倍）
    o.yaw -= input.dragDX * 0.006;
    o.pitch = clamp(o.pitch + input.dragDY * 0.004, o.minPitch, o.maxPitch);
    if (input.wheel !== 0) o.zoom = clamp(o.zoom * Math.pow(1.12, input.wheel), o.minZoom, o.maxZoom);
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
    if (c.region !== this.region) {
      this.region = c.region;
      this.blendT = 0.8;
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
    } else next = this.region === 'tank' ? this.tankPose(o, c, dt) : this.outsidePose(o, c, dt);
    // 区画が変わった直後は、前の位置からなめらかにつなぐ
    if (this.blendT > 0) {
      this.blendT -= dt;
      const k = 1 - Math.exp(-dt * 7);
      next = [prev[0] + (next[0] - prev[0]) * k, prev[1] + (next[1] - prev[1]) * k, prev[2] + (next[2] - prev[2]) * k];
    }
    this.pose.pos = next;
    // 見晴らしで眺めの先が決まっている場所（部屋から水槽を見上げる等）は、注視点をそちらへ寄せる
    if (this.aimW > 0.01 && v?.aim) aim = [aim[0] + (v.aim[0] - aim[0]) * this.aimW, aim[1] + (v.aim[1] - aim[1]) * this.aimW, aim[2] + (v.aim[2] - aim[2]) * this.aimW];
    this.pose.target = aim;
    this.pose.fov = 55 + (v?.fov ? (v.fov - 55) * Math.min(1, this.aimW / 0.62) : 0);
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

  /** 濾過槽・水槽台・部屋：不透明な物で遮蔽を判定し、区画の範囲に留める */
  private outsidePose(o: Orbit, c: CrabController, dt: number): [number, number, number] {
    const [dx, dy, dz] = direction(o);
    const tx = this.target.x, ty = this.target.y, tz = this.target.z;
    const region = this.region;
    const w = this.world;
    const camR = 0.16;
    let hit = o.zoom;
    let s = 0.25;
    for (let i = 0; i < 56 && s < o.zoom; i++) {
      const qx = tx + dx * s, qy = ty + dy * s, qz = tz + dz * s;
      const d = w.viewSolid(qx, qy, qz, region);
      if (d < camR) {
        // 床（上向きの面）には寄らずに、あとでカメラを床の上へ持ち上げる
        if (w.viewNormal(qx, qy, qz, region)[1] > 0.7) {
          s += 0.1;
          continue;
        }
        hit = Math.max(0.5, s - 0.08);
        break;
      }
      s += Math.max(0.05, d - camR * 0.5);
    }
    this.occluded = hit < o.zoom - 0.05;
    const kd = 1 - Math.exp(-dt * (hit < this.dist ? 24 : 3));
    this.dist += (hit - this.dist) * kd;
    let px = tx + dx * this.dist, py = ty + dy * this.dist, pz = tz + dz * this.dist;
    if (region === 'sump') {
      px = clamp(px, SUMP_IN.minX + 0.2, SUMP_IN.maxX - 0.2);
      pz = clamp(pz, SUMP_IN.minZ + 0.2, SUMP_IN.maxZ - 0.2);
      py = clamp(py, SUMP.floorTop + 0.3, DECK.y0 - 0.3);
    } else {
      px = clamp(px, ROOM.minX + 0.5, ROOM.maxX - 0.5);
      pz = clamp(pz, ROOM.minZ + 0.5, ROOM.maxZ - 0.5);
      py = clamp(py, ROOM.floorY + 0.3, ROOM.ceilY - 1);
    }
    // 床・壁にめり込んでいたら外へ押し出す
    for (let i = 0; i < 4; i++) {
      const d = w.viewSolid(px, py, pz, region);
      if (d >= camR) break;
      const n = w.viewNormal(px, py, pz, region);
      px += n[0] * (camR - d);
      py += n[1] * (camR - d);
      pz += n[2] * (camR - d);
    }
    // 濾過槽の水面の高さちょうどを避ける（カニのいる側へ寄せる）
    if (region === 'sump') {
      const level = w.stand.chamberAt(px).level;
      const band = 0.18;
      if (Math.abs(py - level) < band) py = c.y + 0.3 < c.waterLevel ? level - band : level + band;
    }
    return [px, py, pz];
  }

  /** 水槽の中（これまでの冒険カメラ） */
  private tankPose(o: Orbit, c: CrabController, dt: number): [number, number, number] {
    const [dx, dy, dz] = direction(o);
    const tx = this.target.x, ty = this.target.y, tz = this.target.z;
    // 遮蔽の回避：注視点からカメラへ向かって距離関数で球を進め、固体に当たったら手前で止める
    const camR = 0.16;
    let hit = o.zoom;
    let s = 0.25;
    for (let i = 0; i < 48 && s < o.zoom; i++) {
      const qx = tx + dx * s, qy = ty + dy * s, qz = tz + dz * s;
      const d = this.world.viewSolid(qx, qy, qz, 'tank');
      if (d < camR) {
        // 底床（下から見上げたときの砂）は寄らずに、あとでカメラを持ち上げる。岩・流木なら手前で止める
        if (qy - this.world.groundAt(qx, qz) < 0.45) {
          s += 0.1;
          continue;
        }
        hit = Math.max(0.5, s - 0.08);
        break;
      }
      s += Math.max(0.05, d - camR * 0.5);
    }
    this.occluded = hit < o.zoom - 0.05;
    // 寄るときは速く、離れるときはゆっくり（ちらつき防止）
    const kd = 1 - Math.exp(-dt * (hit < this.dist ? 24 : 3));
    this.dist += (hit - this.dist) * kd;
    let px = tx + dx * this.dist, py = ty + dy * this.dist, pz = tz + dz * this.dist;
    // ガラスの内側に留める（上は水槽の縁より少し上まで）
    const m = 0.2;
    px = clamp(px, TANK.minX + m, TANK.maxX - m);
    pz = clamp(pz, TANK.minZ + m, TANK.maxZ - m);
    py = clamp(py, this.world.groundAt(px, pz) + 0.3, TANK.topY + 4);
    // 水面の高さちょうどを避ける（カニのいる側へ寄せる）
    const band = 0.22;
    if (Math.abs(py - TANK.waterY) < band) py = c.y + 0.3 < TANK.waterY ? TANK.waterY - band : TANK.waterY + band;
    return [px, py, pz];
  }

  /** カメラ基準の移動に使う向き（どちらのカメラでも、いま見ている向き） */
  get yaw(): number {
    if (this.mode === 'adventure') return this.adventure.yaw;
    return this.diorama.yaw;
  }
}
