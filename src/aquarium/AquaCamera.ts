// 水槽ゲームの 2 種類のカメラ（状態だけ。Three.js のカメラへの反映は AquariumRenderer が行う）。
// 角度の決め方・ドラッグ量の係数は既存の CameraRig と同じ（yaw / pitch / direction()）。
// - 冒険カメラ：カニの斜め後方から追従する三人称。岩・流木に遮られたら手前へ寄り、
//   水面の高さちょうどに来ないよう（水面を真横から見て割れて見えないよう）カニのいる側へずらす。
// - 箱庭カメラ：水槽の外から全体を見回す。回転・ズームのみ（カニの位置は画面上の印で示す）。
// 切り替えてもカニの位置・向きは変えない（カメラの状態は別々に持つ）。
// - 見晴らし：見晴らしの良い場所（setVista）でカニが立ち止まり、しばらく視点を触らないでいると、
//   冒険カメラがその場所の眺めの向きへゆっくり回り込む（ドラッグ・ホイールですぐ手放す）。

import { clamp } from '../core/math';
import type { Input } from '../game/Input';
import { TANK, type AquariumWorld } from './AquariumWorld';
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
  readonly diorama: Orbit = { yaw: 0.35, pitch: 0.36, zoom: 50, minZoom: 22, maxZoom: 95, minPitch: -0.08, maxPitch: 1.45 };
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

    // 注視点はカニを追う（箱庭カメラ中も追っておき、戻したときに飛ばないようにする）
    const kf = 1 - Math.exp(-dt * 8);
    this.target.x += (c.x - this.target.x) * kf;
    this.target.y += (c.y + 0.3 - this.target.y) * kf;
    this.target.z += (c.z - this.target.z) * kf;

    if (this.mode === 'diorama') {
      const [dx, dy, dz] = direction(o);
      const t: [number, number, number] = [0, TANK.waterY * 0.8, 0];
      this.pose.target = t;
      this.pose.pos = [t[0] + dx * o.zoom, t[1] + dy * o.zoom, t[2] + dz * o.zoom];
      this.pose.fov = 40;
      this.occluded = false;
      return;
    }

    const [dx, dy, dz] = direction(o);
    const tx = this.target.x, ty = this.target.y, tz = this.target.z;
    // 遮蔽の回避：注視点からカメラへ向かって距離関数で球を進め、固体に当たったら手前で止める
    const camR = 0.16;
    let hit = o.zoom;
    let s = 0.25;
    for (let i = 0; i < 48 && s < o.zoom; i++) {
      const qx = tx + dx * s, qy = ty + dy * s, qz = tz + dz * s;
      const d = this.world.solid(qx, qy, qz);
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
    this.pose.pos = [px, py, pz];
    this.pose.target = [tx, ty, tz];
    this.pose.fov = 55;
  }

  /** カメラ基準の移動に使う向き（どちらのカメラでも、いま見ている向き） */
  get yaw(): number {
    if (this.mode === 'adventure') return this.adventure.yaw;
    return this.diorama.yaw;
  }
}
