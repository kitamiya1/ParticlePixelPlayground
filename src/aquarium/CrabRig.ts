// カニの見た目側のアニメーション：ゲーム状態（速度・位相・接地・遊泳）からボーン行列を作る（既存の CharacterRig と同じ役割）。
// - 歩脚：足先の目標位置を決めて、長節と下の節を 2 関節の IK で曲げる（膝が上に来るカニらしい形）。
//   歩行は交互の 4 脚組（左 1・3 と右 2・4 / 左 2・4 と右 1・3）で、足先は体の進む向き（横歩きなら真横）に振る。
// - 待機：呼吸の上下、ときどき鋏を開閉し、脚を 1 本ずつ踏み直す。
// - ジャンプ：脚を下へ伸ばし、鋏を上げて開く。遊泳：後脚を大きく漕ぎ、他の脚も交互に掻く。沈降：脚を広げてゆっくり。

import * as THREE from 'three';
import { clamp } from '../core/math';
import type { CrabController } from './CrabController';
import { BODY_HEIGHT, CLAWS, CRAB_BONE, CRAB_BONE_COUNT, LEGS, legBone, legTip } from './crabModel';

interface Weights {
  idle: number;
  walk: number;
  run: number;
  air: number;
  swim: number;
  sink: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export class CrabRig {
  readonly bones: THREE.Matrix4[] = Array.from({ length: CRAB_BONE_COUNT }, () => new THREE.Matrix4());
  readonly root = new THREE.Matrix4();
  private readonly w: Weights = { idle: 1, walk: 0, run: 0, air: 0, swim: 0, sink: 0 };
  private t = 0;
  private readonly tilt = new THREE.Quaternion();
  private readonly qTmp = new THREE.Quaternion();
  private readonly qYaw = new THREE.Quaternion();
  private readonly vTmp = new THREE.Vector3();
  private readonly m1 = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly body = new THREE.Matrix4();
  /** 待機中の脚の踏み直し（脚ごとの残り時間） */
  private readonly tap = new Float32Array(8);
  private tapNext = 1.2;
  private clawT = 0;
  private clawOpen = 0;
  /** 移動方向（体の座標）の平滑値 */
  private dirX = 1;
  private dirZ = 0;

  update(dt: number, c: CrabController) {
    this.t += dt;
    const t = this.t;
    // 状態の重み（なめらかに切り替える）
    const target: Weights = { idle: 0, walk: 0, run: 0, air: 0, swim: 0, sink: 0 };
    if (c.state === 'idle') target.idle = 1;
    else if (c.state === 'walk') target.walk = 1;
    else if (c.state === 'run') target.run = 1;
    else if (c.state === 'swim') target.swim = 1;
    else if (c.state === 'sink') target.sink = 1;
    else target.air = 1;
    const k = 1 - Math.exp(-dt * 9);
    for (const key of Object.keys(target) as (keyof Weights)[]) this.w[key] += (target[key] - this.w[key]) * k;
    const W = this.w;
    const move = W.walk + W.run;

    // 根：位置 + 向き + 地面の傾き（なめらかに追従）
    this.qYaw.setFromAxisAngle(UP, c.heading);
    this.vTmp.set(c.groundN[0], c.groundN[1], c.groundN[2]).normalize();
    this.qTmp.setFromUnitVectors(UP, this.vTmp);
    this.tilt.slerp(this.qTmp, 1 - Math.exp(-dt * 8));
    this.root.makeRotationFromQuaternion(this.qTmp.copy(this.tilt).multiply(this.qYaw)).setPosition(c.x, c.y, c.z);

    // 体：歩行の上下・左右の揺れ、呼吸、着地の沈み込み、遊泳の前傾
    const ph = c.stridePhase;
    const bob = Math.abs(Math.cos(ph)) * (0.008 * W.walk + 0.014 * W.run) + Math.sin(t * 2.1) * 0.004 * W.idle;
    const squat = c.landImpact * 0.06 + 0.03 * W.sink;
    const roll = Math.sin(ph) * (0.035 * W.walk + 0.05 * W.run) + Math.sin(c.swimPhase * 0.5) * 0.08 * W.swim;
    const pitch = -0.12 * W.swim + clamp(c.vy * 0.03, -0.12, 0.12) * (W.air + W.swim);
    this.body.makeTranslation(0, BODY_HEIGHT + bob - squat + 0.03 * W.air, 0).multiply(this.m1.makeRotationZ(roll)).multiply(this.m2.makeRotationX(pitch));
    this.bones[CRAB_BONE.body].copy(this.body);

    // 移動方向（体の座標）
    const sp = Math.hypot(c.localVX, c.localVZ);
    if (sp > 0.15) {
      const kd = 1 - Math.exp(-dt * 10);
      this.dirX += (c.localVX / sp - this.dirX) * kd;
      this.dirZ += (c.localVZ / sp - this.dirZ) * kd;
      const l = Math.hypot(this.dirX, this.dirZ) || 1;
      this.dirX /= l;
      this.dirZ /= l;
    }

    // 待機中の脚の踏み直し
    for (let i = 0; i < 8; i++) this.tap[i] = Math.max(0, this.tap[i] - dt);
    this.tapNext -= dt;
    if (this.tapNext <= 0) {
      this.tapNext = 0.6 + ((t * 7.31) % 1.7);
      this.tap[Math.floor((t * 13.7) % 8)] = 0.35;
    }

    // 歩脚
    const amp = 0.075 * W.walk + 0.1 * W.run;
    const lift = 0.055 * W.walk + 0.08 * W.run;
    for (const sx of [1, -1] as const) {
      LEGS.forEach((L, i) => {
        const group = (i + (sx === 1 ? 0 : 1)) % 2;
        const phi = ph + group * Math.PI;
        const restX = sx * L.rest.out, restZ = L.rest.fwd;
        // 歩行：足先を進む向きに振り、前へ戻す間だけ持ち上げる
        let fx = restX + this.dirX * amp * Math.sin(phi);
        let fz = restZ + this.dirZ * amp * Math.sin(phi);
        let fy = lift * Math.max(0, Math.cos(phi));
        // 待機：踏み直し
        const tp = this.tap[(sx === 1 ? 0 : 4) + i];
        fy += Math.sin((tp / 0.35) * Math.PI) * 0.035 * W.idle * (tp > 0 ? 1 : 0);
        fx = fx * (1 - W.air - W.swim - W.sink) + W.air * sx * L.rest.out * 0.9 + W.sink * sx * L.rest.out * 1.06;
        fz = fz * (1 - W.air - W.swim - W.sink) + W.air * L.rest.fwd * 0.85 + W.sink * L.rest.fwd * 1.05;
        fy = fy * (1 - W.air - W.swim - W.sink) + W.air * -0.07 + W.sink * (0.0 + 0.02 * Math.sin(t * 2.2 + i));
        // 遊泳：後脚は大きく漕ぎ、他の脚は交互に掻く
        if (W.swim > 0.001) {
          const sph = c.swimPhase + i * 0.9 + (sx === 1 ? 0 : Math.PI);
          const rear = i === 3;
          const sxs = sx * (rear ? 0.34 : L.rest.out * 0.92);
          const szs = rear ? -0.22 + Math.cos(sph) * 0.14 : L.rest.fwd + Math.cos(sph) * 0.07;
          const sys = rear ? 0.1 + Math.sin(sph) * 0.09 : 0.03 + Math.sin(sph) * 0.05;
          fx += W.swim * sxs;
          fz += W.swim * szs;
          fy += W.swim * sys;
        }
        this.solveLeg(sx, i, fx, fy, fz);
      });
    }

    // 鋏脚
    this.clawT -= dt;
    if (this.clawT <= 0) this.clawT = 2.2 + ((t * 3.7) % 2.4);
    const pulse = this.clawT < 0.5 ? Math.sin((this.clawT / 0.5) * Math.PI) : 0;
    const openTarget = W.idle * pulse * 0.55 + W.air * 0.45 + W.sink * 0.3 + (move * Math.max(0, Math.sin(ph * 0.5)) * 0.1);
    this.clawOpen += (openTarget - this.clawOpen) * (1 - Math.exp(-dt * 14));
    const breathe = Math.sin(t * 2.1) * 0.03 * W.idle;
    const yawA = 0.55 + 0.3 * W.air + 0.2 * W.sink - 0.1 * W.swim;
    const pitchA = 0.28 + breathe - 0.65 * W.air - 0.2 * W.sink - 0.1 * W.run + Math.sin(ph) * 0.05 * move;
    const fold = 1.75 - 0.6 * W.air - 0.35 * W.sink + 0.15 * W.swim;
    for (const [sx, k, arm, hand, finger] of [
      [1, CLAWS.scale.L, CRAB_BONE.armL, CRAB_BONE.handL, CRAB_BONE.fingerL],
      [-1, CLAWS.scale.R, CRAB_BONE.armR, CRAB_BONE.handR, CRAB_BONE.fingerR],
    ] as const) {
      const sh = CLAWS.shoulder;
      const a = this.bones[arm];
      a.copy(this.body).multiply(this.m1.makeTranslation(sx * sh[0], sh[1], sh[2])).multiply(this.m2.makeRotationY(sx * yawA)).multiply(this.m1.makeRotationX(pitchA));
      const h = this.bones[hand];
      h.copy(a).multiply(this.m1.makeTranslation(0, 0, CLAWS.armLen * k)).multiply(this.m2.makeRotationY(-sx * fold)).multiply(this.m1.makeRotationX(-0.12 - 0.3 * W.air));
      const f = this.bones[finger];
      // 大きい右の鋏は少しだけ遅れて開閉する
      const open = this.clawOpen * (sx === 1 ? 1 : 0.85) + 0.04;
      f.copy(h).multiply(this.m1.makeTranslation(0, 0.024 * k, 0.115 * k)).multiply(this.m2.makeRotationX(-open));
    }
  }

  /**
   * 歩脚の 2 関節 IK。足先 (fx, fy, fz) は根の座標（y = 地面からの高さ）。
   * 付け根の向き（前後の振り）→ 長節の持ち上げ → 下の節の曲げ、の順に回す。
   */
  private solveLeg(sx: 1 | -1, i: number, fx: number, fy: number, fz: number) {
    const L = LEGS[i];
    const hipX = sx * L.hip[0], hipY = L.hip[1] + this.body.elements[13], hipZ = L.hip[2];
    const out = (fx - hipX) * sx;
    const fwd = fz - hipZ;
    const psi = Math.atan2(fwd, Math.max(out, 0.02));
    const u = Math.hypot(out, fwd);
    const v = fy - hipY;
    const tip = legTip(L);
    const l2 = Math.hypot(tip.u, tip.v);
    const delta = Math.atan2(tip.v, tip.u);
    const l1 = L.l1;
    const D = clamp(Math.hypot(u, v), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    const phi = Math.atan2(v, u);
    const a1 = Math.acos(clamp((l1 * l1 + D * D - l2 * l2) / (2 * l1 * D), -1, 1));
    const beta = phi + a1; // 膝を上に
    const ku = l1 * Math.cos(beta), kv = l1 * Math.sin(beta);
    const alphaT = Math.atan2(v - kv, u - ku);
    const alpha2 = alphaT - delta;
    const up = this.bones[legBone(sx, i, false)];
    up.copy(this.body)
      .multiply(this.m1.makeTranslation(hipX, L.hip[1], hipZ))
      .multiply(this.m2.makeRotationY(-sx * psi))
      .multiply(this.m1.makeRotationZ(sx * beta));
    const lo = this.bones[legBone(sx, i, true)];
    lo.copy(up).multiply(this.m1.makeTranslation(sx * l1, 0, 0)).multiply(this.m2.makeRotationZ(sx * (alpha2 - beta)));
  }
}
