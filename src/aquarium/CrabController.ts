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

import { clamp, lerp, smoothstep } from '../core/math';
import { TANK, type AquariumWorld } from './AquariumWorld';
import { ROOM, type Flow, type Region } from './AquariumStand';

export type CrabState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'swim' | 'sink' | 'ride';

export const CRAB_STATE_LABEL: Record<CrabState, string> = {
  idle: '待機', walk: '歩行', run: '走行', jump: 'ジャンプ', fall: '落下', swim: '遊泳', sink: '沈降', ride: '水流に乗る',
};

/** 見た目側（泡・水しぶき・波紋）に知らせる出来事 */
export type CrabEvent = { kind: 'jump' | 'land' | 'enterWater' | 'exitWater' | 'swimStart' | 'stroke'; x: number; y: number; z: number; power: number };

export interface CrabInput {
  move: { x: number; y: number };
  run: boolean;
  jumpHeld: boolean;
  cameraYaw: number;
}

const RADIUS = 0.24;

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
  }

  update(dt: number, inp: CrabInput) {
    // 大きな時間差は分割して当たり判定のすり抜けを防ぐ
    const steps = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, inp, i === 0);
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

    // ジャンプ・遊泳の入力
    const pressed = first && inp.jumpHeld && !this.jumpPrev;
    if (first) this.jumpPrev = inp.jumpHeld;
    if (!inp.jumpHeld) this.holdT = -1;
    else if (this.holdT >= 0) this.holdT += dt;

    if (ride) {
      // 管の中ではジャンプ・遊泳を受け付けない
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
    const tvx = dx * maxSpeed, tvz = dz * maxSpeed;
    // 入力が無いとき：地上ではすぐ止まり、水中・空中ではゆっくり減速する
    const k = 1 - Math.exp(-(hasInput ? accel : this.grounded ? 12 : lerp(0.6, 2.2, s)) * dt);
    this.vx += (tvx - this.vx) * k;
    this.vz += (tvz - this.vz) * k;

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

    // 移動と当たり判定
    const wasGrounded = this.grounded;
    let px = this.x, py = cy, pz = this.z;
    px += this.vx * dt;
    py += this.vy * dt;
    pz += this.vz * dt;
    this.grounded = false;
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
      if (n[1] > 0.55) {
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
      if (nf && nf[1] > 0.55) {
        py -= t;
        this.grounded = true;
        const n = w.contactNormal(px, py - RADIUS * 0.5, pz);
        if (n[1] > 0.55) this.groundN.splice(0, 3, ...n);
      }
    }
    // 部屋の外へは出ない（ガラス・水槽台・濾過槽の壁は contactSolid の当たり判定で止まる）
    px = clamp(px, ROOM.minX + RADIUS, ROOM.maxX - RADIUS);
    pz = clamp(pz, ROOM.minZ + RADIUS, ROOM.maxZ - RADIUS);
    py = clamp(py, ROOM.floorY + RADIUS, ROOM.ceilY - RADIUS);
    this.region = w.regionAt(px, py, pz);

    // 実際に動いた量から水平の速さを再計算（壁に当たった時に足踏みしない）
    const mvx = (px - this.x) / Math.max(dt, 1e-4);
    const mvz = (pz - this.z) / Math.max(dt, 1e-4);
    this.x = px;
    this.z = pz;
    this.y = py - RADIUS;
    this.speed = Math.hypot(mvx, mvz);

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

    // 横歩き：移動方向の ±90° のうち、いまの向きに近い方へ体を回す
    if (hasInput && Math.hypot(this.vx, this.vz) > 0.2) {
      const move = Math.atan2(this.vx, this.vz);
      const a = wrap(move + Math.PI / 2 - this.heading), b = wrap(move - Math.PI / 2 - this.heading);
      const d = Math.abs(a) < Math.abs(b) ? a : b;
      this.heading = wrap(this.heading + d * (1 - Math.exp(-(this.grounded ? 7 : 3) * dt)));
    }
    // 体の向き基準の速度（+x = 左, +z = 前）
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    this.localVX = mvx * ch - mvz * sh;
    this.localVZ = mvx * sh + mvz * ch;

    // 歩行位相（脚 1 歩の振れ幅に合わせ、地面に対して足が滑らない速さ）
    if (this.grounded) this.stridePhase += (this.speed * dt) / (0.64 * (this.speed > 3.2 ? 0.1 : 0.075));

    // 状態
    if (ride) this.state = 'ride';
    else if (this.swimming) this.state = 'swim';
    else if (this.grounded) this.state = this.speed < 0.25 ? 'idle' : this.speed < (this.walkSpeed + this.runSpeed) * 0.5 * lerp(1, 0.72, s) ? 'walk' : 'run';
    else if (this.sinking || (s > 0.5 && this.vy < 0)) this.state = 'sink';
    else this.state = this.vy > 0 ? 'jump' : 'fall';
  }

  /** 見た目側が出来事を受け取る（受け取ったら空にする） */
  drainEvents(): CrabEvent[] {
    return this.events.splice(0, this.events.length);
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
