// カニの見た目側のアニメーション：ゲーム状態（速度・位相・接地・遊泳）からボーン行列を作る（既存の CharacterRig と同じ役割）。
// - 歩脚：足先の目標位置を決めて、長節と下の節を 2 関節の IK で曲げる（膝が上に来るカニらしい形）。
//   歩行は交互の 4 脚組（左 1・3 と右 2・4 / 左 2・4 と右 1・3）で、足先は体の進む向き（横歩きなら真横）に振る。
// - 待機：呼吸の上下、ときどき鋏を開閉し、脚を 1 本ずつ踏み直す。
// - ジャンプ：脚を下へ伸ばし、鋏を上げて開く。遊泳：後脚を大きく漕ぎ、他の脚も交互に掻く。沈降：脚を広げてゆっくり。
// - 穴掘り：体を掘る向きへ傾け、左右の鋏で交互に砂をすくっては後ろへかき出す（位相は CrabController.digPhase）。
//   前脚も交互に砂を後ろへ蹴り、進んでいるときは歩行と同じ足運びを重ねる。照準の先に何も無いとき（digWhiff）は
//   すくわずに、鋏を掘る向きへ伸ばして宙で振る（空振り）。
// - 壁登り・天井歩き：体は張り付いた面の向き（groundN = CrabController.climbN）と体の前（bodyF）の座標軸で向け
//   （逆さでも向きが飛ばない）、根を球の中心から面の側へ半径だけ下げた所に置く。
//   進んでいる間は面に沿った歩行の足運び（体の座標の速度は面を床に起こして計算済み）、止まっている間は脚を広げて
//   足先を面へ押し付け、ゆっくり踏ん張り直す。鋏は前へ伸ばして面をつかむ。
// - 挟む（AquaGrab）：右の大きな鋏を前の上へ構え（構えた鋏の先 = anchor。物をつなぐばねの目標）、grip.target
//   （挟む物のつかみ点）があれば、鋏の先がそこへ来るよう腕の 3 つの角（付け根の左右・上下、掌の折り）を
//   減衰付き最小二乗の IK で解く。物がばねで遅れても、鋏はいつも物の表面を挟んで見える（重い物は腕が引っ張られる）。
//   閉じ具合（grip.close）で可動指を開閉し、挟んでいる間は物の厚みの分だけ少し開いたまま。

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/math';
import type { CrabController } from './CrabController';
import { BODY_HEIGHT, CLAWS, CRAB_BONE, CRAB_BONE_COUNT, LEGS, legBone, legTip } from './crabModel';

interface Weights {
  idle: number;
  walk: number;
  run: number;
  air: number;
  swim: number;
  sink: number;
  dig: number;
  climb: number;
  /** 穴の生き物を引っ張る（鋏で前の穴をつかみ、後ろへ体を反らして踏ん張る） */
  pull: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** 右の鋏（大きい方）の向きと大きさ・挟む所（掌の座標。不動指と可動指の間） */
const GRIP_SX = -1;
const GRIP_K = CLAWS.scale.R;
const PINCH: [number, number, number] = [0, 0, 0.165 * GRIP_K];
/**
 * 挟む構え（腕の付け根の左右・上下、掌の折り）。この姿勢の鋏の先が anchor：口の前の少し上（体の座標で約 (−0.06, 0.05, 0.36)）。
 * 付け根から 0.27（伸ばしきると 0.35）なので、物が遅れても 8 cm ほどは鋏を伸ばして挟んだままでいられる。
 * 体の球（半径 0.24）の中心から 0.36 離れていて、挟んだ物が甲羅に食い込まない
 */
const HOLD = { yaw: 0.3, pitch: -0.45, fold: 1.4 };
/** IK の角の範囲 */
const IK_MIN = [-0.9, -1.45, 0.05];
const IK_MAX = [1.25, 1.35, 2.1];

/** 右の鋏の先（体の座標）：付け根の左右 yaw・上下 pitch・掌の折り fold・掌の傾き c（CrabRig の行列と同じ順） */
function clawTip(yaw: number, pitch: number, fold: number, c: number, out: [number, number, number]): [number, number, number] {
  const sx = GRIP_SX;
  // 掌の座標 → 腕の座標：RotX(c) → RotY(−sx·fold) → 腕の長さだけ前へ
  let x = PINCH[0], y = PINCH[1] * Math.cos(c) - PINCH[2] * Math.sin(c), z = PINCH[1] * Math.sin(c) + PINCH[2] * Math.cos(c);
  const fa = -sx * fold, cf = Math.cos(fa), sf = Math.sin(fa);
  [x, z] = [x * cf + z * sf, -x * sf + z * cf];
  z += CLAWS.armLen * GRIP_K;
  // 腕の座標 → 体の座標：RotX(pitch) → RotY(sx·yaw) → 付け根へ
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  [y, z] = [y * cp - z * sp, y * sp + z * cp];
  const ya = sx * yaw, cy = Math.cos(ya), sy = Math.sin(ya);
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  out[0] = x + sx * CLAWS.shoulder[0];
  out[1] = y + CLAWS.shoulder[1];
  out[2] = z + CLAWS.shoulder[2];
  return out;
}

/** 挟む鋏の状態（AquaGrab.rigGrip が毎フレーム書く） */
export interface RigGrip {
  on: boolean;
  /** 閉じ具合（0 = 開き、1 = 閉じ） */
  close: number;
  /** 物を挟んでいる */
  hold: boolean;
  /** 鋏の先を伸ばす所（世界）。null = 構えの位置 */
  target: [number, number, number] | null;
  /** 滑りそうな度合い（0..1。鋏が震える） */
  shake: number;
}

export class CrabRig {
  readonly bones: THREE.Matrix4[] = Array.from({ length: CRAB_BONE_COUNT }, () => new THREE.Matrix4());
  readonly root = new THREE.Matrix4();
  private readonly w: Weights = { idle: 1, walk: 0, run: 0, air: 0, swim: 0, sink: 0, dig: 0, climb: 0, pull: 0 };
  private t = 0;
  private readonly tilt = new THREE.Quaternion();
  private readonly qTmp = new THREE.Quaternion();
  private readonly qYaw = new THREE.Quaternion();
  private readonly vTmp = new THREE.Vector3();
  private readonly vF = new THREE.Vector3();
  private readonly vL = new THREE.Vector3();
  /** 体の座標軸から作った向き（平滑化）と、前のフレームでそれを使ったか */
  private readonly qFrame = new THREE.Quaternion();
  private wasFrame = false;
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
  /** 挟む（右の鋏）：AquaGrab が書く状態・構えの重み（平滑）・IK の解（前のフレームから続けて解く） */
  readonly grip: RigGrip = { on: false, close: 0, hold: false, target: null, shake: 0 };
  /** 引っ張っている生き物が引き戻す強さ（0..1。main が AquaTug.env から書く。体が前へ揺すられる） */
  tugShake = 0;
  private gw = 0;
  private readonly ik = [HOLD.yaw, HOLD.pitch, HOLD.fold];
  /** 構えた鋏の先・いま描いている鋏の先・鋏の付け根（世界）と、鋏を目標へ伸ばしきれなかった距離 */
  readonly anchor: [number, number, number] = [0, 0, 0];
  readonly pinch: [number, number, number] = [0, 0, 0];
  readonly shoulder: [number, number, number] = [0, 0, 0];
  reachErr = 0;
  private readonly bodyW = new THREE.Matrix4();
  private readonly bodyInv = new THREE.Matrix4();
  private readonly t3: [number, number, number] = [0, 0, 0];

  update(dt: number, c: CrabController) {
    this.t += dt;
    const t = this.t;
    // 状態の重み（なめらかに切り替える）
    const target: Weights = { idle: 0, walk: 0, run: 0, air: 0, swim: 0, sink: 0, dig: 0, climb: 0, pull: 0 };
    if (c.state === 'climb') target.climb = 1;
    else if (c.state === 'idle') target.idle = 1;
    else if (c.state === 'walk') target.walk = 1;
    else if (c.state === 'run') target.run = 1;
    else if (c.state === 'swim') target.swim = 1;
    else if (c.state === 'sink') target.sink = 1;
    else if (c.state === 'dig') target.dig = 1;
    else target.air = 1;
    // 生き物を引っ張る：ほかの状態（歩く・待機）に重ねる。強く張っているほど深く踏ん張る
    target.pull = c.pulling ? 0.4 + 0.6 * clamp(c.pullT, 0, 1) : 0;
    const k = 1 - Math.exp(-dt * 9);
    for (const key of Object.keys(target) as (keyof Weights)[]) this.w[key] += (target[key] - this.w[key]) * k;
    const W = this.w;
    // 引っこ抜いた反動で後ろへ転ぶ（c.tumbleT：TUMBLE_T から 0 へ）：すぐ仰向けに近く倒れ、着地してから起き上がる
    const tp = c.tumbleT > 0 ? 1 - c.tumbleT / 0.9 : 1;
    const tumble = c.tumbleT > 0 ? (tp < 0.3 ? smoothstep(0, 0.3, tp) : 1 - smoothstep(0.45, 1, tp)) : 0;
    const move = W.walk + W.run;
    // 穴掘り中に進んでいる分（歩行の足運びを重ねる）
    const digMove = W.dig * clamp(c.speed / 1.0, 0, 1);
    const dph = c.digPhase;
    // 空振りの度合い（掘っている間だけ）
    const wh = clamp(c.digWhiff, 0, 1);
    // 壁登り：面に沿って進んでいる分（歩行の足運び）と、止まって踏ん張っている分
    const climbMove = W.climb * clamp(c.speed / 0.9, 0, 1);
    const cling = W.climb - climbMove;

    // 根：位置 + 向き + 地面の傾き（なめらかに追従）。壁では傾きが大きいので、根は球の中心から「体の上」の逆へ
    // 半径だけ下げた所（面に接する所）に置く（平らな床では従来と同じ、足元 = 中心の真下）
    this.qYaw.setFromAxisAngle(UP, c.heading);
    const R = c.radius;
    if (c.frameMode) {
      // 張り付いている・逆さから起き上がっている途中：体の向きは 体の上 = groundN・前 = bodyF の座標軸から作る
      // （「上 → 法線」の最小の回転 + 方位では、真逆さの近くで回転の軸が決まらず体が急に回る）
      if (!this.wasFrame) this.qFrame.copy(this.tilt).multiply(this.qYaw);
      const n = this.vTmp.set(c.groundN[0], c.groundN[1], c.groundN[2]).normalize();
      const f = this.vF.set(c.bodyF[0], c.bodyF[1], c.bodyF[2]);
      const l = this.vL.crossVectors(n, f).normalize();
      f.crossVectors(l, n);
      this.m1.makeBasis(l, n, f);
      this.qTmp.setFromRotationMatrix(this.m1);
      this.qFrame.slerp(this.qTmp, 1 - Math.exp(-dt * 14));
      this.root.makeRotationFromQuaternion(this.qFrame);
      this.vTmp.set(0, 1, 0).applyQuaternion(this.qFrame);
      this.wasFrame = true;
    } else {
      // 従来：傾き（上 → groundN の最小の回転、平滑化）× 方位。体の座標軸の向きから戻ったときは、いまの向きから続ける
      if (this.wasFrame) this.tilt.copy(this.qFrame).multiply(this.qTmp.copy(this.qYaw).invert());
      this.wasFrame = false;
      this.vTmp.set(c.groundN[0], c.groundN[1], c.groundN[2]).normalize();
      this.qTmp.setFromUnitVectors(UP, this.vTmp);
      // 張り付いた直後・離れた直後は傾きが大きく変わるので、壁登りの間は少し速く追う
      this.tilt.slerp(this.qTmp, 1 - Math.exp(-dt * (8 + 4 * W.climb)));
      this.vTmp.set(0, 1, 0).applyQuaternion(this.tilt);
      this.root.makeRotationFromQuaternion(this.qTmp.copy(this.tilt).multiply(this.qYaw));
    }
    this.root.setPosition(c.x - this.vTmp.x * R, c.y + R - this.vTmp.y * R, c.z - this.vTmp.z * R);

    // 体：歩行の上下・左右の揺れ、呼吸、着地の沈み込み、遊泳の前傾
    const ph = c.stridePhase;
    const bob = Math.abs(Math.cos(ph)) * (0.008 * W.walk + 0.014 * W.run + 0.008 * digMove + 0.006 * climbMove) + Math.sin(t * 2.1) * 0.004 * (W.idle + 0.5 * cling) + Math.abs(Math.sin(dph)) * 0.012 * W.dig;
    // 壁では体を面へ寄せる（脚を広げて踏ん張る）
    const squat = c.landImpact * 0.06 + 0.03 * W.sink + 0.025 * W.climb + 0.03 * W.pull;
    // 引っ張り：強く張っているほど体を後ろへ反らし、生き物が引き戻すたび（tugShake）に前へ揺すられる
    const pt = clamp(c.pullT, 0, 1), sh = this.tugShake;
    const tug = (Math.sin(t * 31) * 0.018 + Math.sin(t * 19.7) * 0.012) * W.pull * (0.35 + sh) + 0.07 * sh * W.pull;
    const roll = Math.sin(ph) * (0.035 * W.walk + 0.05 * W.run) + Math.sin(c.swimPhase * 0.5) * 0.08 * W.swim + Math.sin(dph) * 0.045 * W.dig + Math.sin(t * 23) * 0.03 * sh * W.pull;
    // 穴掘り：掘る向きへ頭を下げる（上へ掘るときは上げる）。かき出すたびに小さく前へのめる（空振りではのめらず、少し伸び上がる）
    const pitch = -0.12 * W.swim + clamp(c.vy * 0.03, -0.12, 0.12) * (W.air + W.swim) + W.dig * (0.14 - c.digPitch * 0.4 + Math.abs(Math.sin(dph)) * 0.06 * (1 - wh) - 0.05 * wh) - W.pull * (0.06 + 0.22 * pt) + tug - 0.95 * tumble;
    this.body.makeTranslation(0, BODY_HEIGHT + bob - squat + 0.03 * W.air + 0.06 * tumble, 0).multiply(this.m1.makeRotationZ(roll)).multiply(this.m2.makeRotationX(pitch));
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
    const amp = 0.075 * W.walk + 0.1 * W.run + 0.06 * digMove + 0.07 * climbMove;
    const lift = 0.055 * W.walk + 0.08 * W.run + 0.045 * digMove + 0.06 * climbMove;
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
        // 壁登り：脚を広げ（前脚は前へ・後脚は後ろへ）、足先を面へ押し付けて爪を掛ける。止まっている間は
        // ゆっくり踏ん張り直す（前後の脚が交互にわずかに掛け直す）
        if (W.climb > 0.001) {
          fx += W.climb * sx * L.rest.out * 0.12;
          fz += W.climb * L.rest.fwd * 0.18;
          fy -= W.climb * 0.014;
          fy += cling * 0.012 * Math.max(0, Math.sin(t * 1.7 + i * 1.6 + (sx === 1 ? 0 : 2.1)));
        }
        // 引っ張り：脚を広げて後ろへ踏ん張る
        if (W.pull > 0.001) {
          fx += W.pull * sx * 0.035;
          fz -= W.pull * (0.04 + 0.04 * pt);
        }
        // 転んだ：脚を宙でばたつかせる
        if (tumble > 0.001) {
          fy += tumble * (0.05 + 0.03 * Math.sin(t * 17 + i * 1.7 + (sx === 1 ? 0 : 1.3)));
          fx += tumble * sx * 0.03;
        }
        // 穴掘り：前脚で砂を後ろへ蹴る（左右交互）。他の脚は少し広げて踏ん張る
        if (W.dig > 0.001) {
          const kp = dph + (sx === 1 ? 0 : Math.PI);
          if (i === 0) {
            fz += W.dig * (0.02 - 0.07 * Math.sin(kp));
            fy += W.dig * 0.035 * Math.max(0, Math.cos(kp));
          } else fx += W.dig * sx * 0.03;
        }
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
    // 壁登り：鋏を少し開いて前へ伸ばし、面をつかむ（進んでいる間は歩みに合わせて開閉）
    const openTarget = W.idle * pulse * 0.55 + W.air * 0.45 + W.sink * 0.3 + (move * Math.max(0, Math.sin(ph * 0.5)) * 0.1) + W.climb * (0.18 + 0.2 * climbMove * Math.max(0, Math.sin(ph * 0.5)));
    this.clawOpen += (openTarget - this.clawOpen) * (1 - Math.exp(-dt * 14));
    const breathe = Math.sin(t * 2.1) * 0.03 * W.idle;
    const yawA0 = 0.55 + 0.3 * W.air + 0.2 * W.sink - 0.1 * W.swim - 0.25 * W.dig + 0.12 * W.climb;
    const pitchA0 = 0.28 + breathe - 0.65 * W.air - 0.2 * W.sink - 0.1 * W.run + Math.sin(ph) * 0.05 * (move + climbMove) - 0.18 * W.climb;
    const fold0 = 1.75 - 0.6 * W.air - 0.35 * W.sink + 0.15 * W.swim - 0.3 * W.climb;
    // 挟む：右の鋏の構え（anchor）と、鋏の先を grip.target へ伸ばす IK（体の座標で解く）
    const handTilt = -0.12 - 0.3 * W.air;
    this.gw += ((this.grip.on ? 1 : 0) - this.gw) * (1 - Math.exp(-dt * 16));
    this.bodyW.multiplyMatrices(this.root, this.body);
    this.bodyInv.copy(this.bodyW).invert();
    const anchorL = clawTip(HOLD.yaw, HOLD.pitch, HOLD.fold, handTilt, [0, 0, 0]);
    this.toWorld(anchorL, this.anchor);
    this.toWorld([GRIP_SX * CLAWS.shoulder[0], CLAWS.shoulder[1], CLAWS.shoulder[2]], this.shoulder);
    if (this.gw > 0.001) {
      if (this.gw < 0.05) this.ik.splice(0, 3, HOLD.yaw, HOLD.pitch, HOLD.fold);
      const T = this.grip.target;
      const tl: [number, number, number] = T ? (this.vTmp.set(T[0], T[1], T[2]).applyMatrix4(this.bodyInv), [this.vTmp.x, this.vTmp.y, this.vTmp.z]) : anchorL;
      this.reachErr = this.solveGrip(tl, handTilt);
    } else this.reachErr = 0;
    for (const [sx, k, arm, hand, finger] of [
      [1, CLAWS.scale.L, CRAB_BONE.armL, CRAB_BONE.handL, CRAB_BONE.fingerL],
      [-1, CLAWS.scale.R, CRAB_BONE.armR, CRAB_BONE.handR, CRAB_BONE.fingerR],
    ] as const) {
      // 穴掘り：左右交互に、鋏を前の下へ伸ばして開き（すくう）→ 閉じて手前へ引き上げる（かき出す）
      // 空振り（照準の先に何も無い）：すくわずに、鋏を掘る向きへ伸ばしたまま左右に大きく振り、宙をつまむように開閉する
      const sp = dph + (sx === 1 ? 0 : Math.PI);
      const scoop = Math.sin(sp);
      const dg = W.dig * (1 - wh), wf = W.dig * wh;
      // 引っ張り：両方の鋏を前の下（穴）へ伸ばして閉じ、抜けてくるほど持ち上げる
      let yawA = yawA0 + dg * 0.1 * scoop + wf * (0.05 + 0.32 * scoop) - W.pull * 0.32;
      let pitchA = pitchA0 + dg * (0.2 - c.digPitch * 0.5 + 0.38 * scoop) + wf * (0.08 - c.digPitch * 0.65 + 0.16 * Math.cos(sp)) + W.pull * (0.55 - 0.45 * pt + tug * 1.6);
      let fold = fold0 - dg * (0.55 + 0.4 * scoop) - wf * (0.85 + 0.2 * scoop) - W.pull * 0.8;
      // 大きい右の鋏は少しだけ遅れて開閉する
      let open = this.clawOpen * (sx === 1 ? 1 : 0.85) * (1 - W.dig) * (1 - W.pull) + 0.04 + dg * 0.5 * Math.max(0, Math.sin(sp + 0.9)) + wf * 0.55 * Math.max(0, Math.sin(sp * 2));
      // 右の鋏：挟む構え・IK の解へ寄せる（poseGripClaw。物を動かした後にも呼び直す）
      if (sx === GRIP_SX) {
        this.rBase = [yawA, pitchA, fold, open, handTilt];
        this.poseGripClaw();
        continue;
      }
      this.poseClaw(sx, k, arm, hand, finger, yawA, pitchA, fold, open, handTilt);
    }
  }

  /** 右の鋏の、挟む構えを混ぜる前の角（このフレームのふだんの動き）と掌の傾き */
  private rBase = [0, 0, 0, 0, 0];

  /** 鋏脚 1 本のボーン（腕節 → 掌 → 可動指） */
  private poseClaw(sx: 1 | -1, k: number, arm: number, hand: number, finger: number, yawA: number, pitchA: number, fold: number, open: number, tilt: number) {
    const sh = CLAWS.shoulder;
    const a = this.bones[arm];
    a.copy(this.body).multiply(this.m1.makeTranslation(sx * sh[0], sh[1], sh[2])).multiply(this.m2.makeRotationY(sx * yawA)).multiply(this.m1.makeRotationX(pitchA));
    const h = this.bones[hand];
    h.copy(a).multiply(this.m1.makeTranslation(0, 0, CLAWS.armLen * k)).multiply(this.m2.makeRotationY(-sx * fold)).multiply(this.m1.makeRotationX(tilt));
    const f = this.bones[finger];
    f.copy(h).multiply(this.m1.makeTranslation(0, 0.024 * k, 0.115 * k)).multiply(this.m2.makeRotationX(-open));
  }

  /**
   * 右の鋏：ふだんの角（rBase）を、挟む構え・IK の解へ構えの重みだけ寄せて描く。指は閉じ具合で開閉し、
   * 挟んでいる間は物の厚みの分だけ少し開く。描いた鋏の先を pinch に書く
   */
  private poseGripClaw() {
    let [yawA, pitchA, fold, open] = this.rBase;
    const tilt = this.rBase[4], gw = this.gw;
    if (gw > 0.001) {
      yawA = lerp(yawA, this.ik[0], gw);
      pitchA = lerp(pitchA, this.ik[1], gw);
      fold = lerp(fold, this.ik[2], gw);
      open = lerp(open, this.grip.hold ? 0.16 : 0.62 * (1 - this.grip.close), gw);
      // 滑りそう：鋏が小刻みに震え、少し開きかける（離せば止まる）
      const sh = this.grip.hold ? this.grip.shake : 0;
      if (sh > 0.01) {
        yawA += Math.sin(this.t * 47) * 0.035 * sh;
        pitchA += Math.cos(this.t * 53) * 0.035 * sh;
        open += 0.12 * sh;
      }
    }
    this.toWorld(clawTip(yawA, pitchA, fold, tilt, this.t3), this.pinch);
    this.poseClaw(GRIP_SX, GRIP_K, CRAB_BONE.armR, CRAB_BONE.handR, CRAB_BONE.fingerR, yawA, pitchA, fold, open, tilt);
  }

  /**
   * 物を動かした後（AquaGrab.update の後）に、右の鋏を新しいつかみ点へ伸ばし直す（物と鋏が 1 フレームずれない）。
   * 体の姿勢はこのフレームの update のまま
   */
  reaimGrip() {
    if (this.gw <= 0.001) return;
    const T = this.grip.target;
    if (T) {
      this.vTmp.set(T[0], T[1], T[2]).applyMatrix4(this.bodyInv);
      this.reachErr = this.solveGrip([this.vTmp.x, this.vTmp.y, this.vTmp.z], this.rBase[4]);
    }
    this.poseGripClaw();
  }

  /** 体の座標の点 → 世界（このフレームの根 × 体） */
  private toWorld(l: readonly number[], out: [number, number, number]) {
    this.vTmp.set(l[0], l[1], l[2]).applyMatrix4(this.bodyW);
    out[0] = this.vTmp.x;
    out[1] = this.vTmp.y;
    out[2] = this.vTmp.z;
  }

  /**
   * 右の鋏の先を体の座標の点 t へ伸ばす角（付け根の左右・上下、掌の折り）を、減衰付き最小二乗（Levenberg 型）で解く。
   * 前のフレームの解から数回だけ進める（毎フレーム続けて解くので、少ない回数でなめらかに追う）。届かない所へは
   * 届く範囲でいちばん近い姿勢になる。返り値は解いた後に残った距離
   */
  private solveGrip(t: readonly number[], c: number): number {
    const err = this.solveFrom(t, c);
    if (err < 0.015) return err;
    // 角の範囲の端で止まった（体が急に回った・壁へ張り付いた直後）：構えから解き直して、近い方を使う
    const prev = this.ik.slice();
    this.ik.splice(0, 3, HOLD.yaw, HOLD.pitch, HOLD.fold);
    const err2 = this.solveFrom(t, c);
    if (err2 <= err) return err2;
    this.ik.splice(0, 3, ...prev);
    return err;
  }

  private solveFrom(t: readonly number[], c: number): number {
    const x = this.ik, p = this.t3, q: [number, number, number] = [0, 0, 0];
    const J = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const h = 1e-3, lam2 = 0.03 * 0.03;
    let err = 0;
    for (let it = 0; it < 6; it++) {
      clawTip(x[0], x[1], x[2], c, p);
      const ex = t[0] - p[0], ey = t[1] - p[1], ez = t[2] - p[2];
      err = Math.hypot(ex, ey, ez);
      if (err < 1e-3) break;
      for (let j = 0; j < 3; j++) {
        const s = x[j];
        x[j] = s + h;
        clawTip(x[0], x[1], x[2], c, q);
        x[j] = s;
        J[j] = (q[0] - p[0]) / h;
        J[3 + j] = (q[1] - p[1]) / h;
        J[6 + j] = (q[2] - p[2]) / h;
      }
      // Δ = Jᵀ (J Jᵀ + λ² I)⁻¹ e
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) A[r * 3 + k] = J[r * 3] * J[k * 3] + J[r * 3 + 1] * J[k * 3 + 1] + J[r * 3 + 2] * J[k * 3 + 2] + (r === k ? lam2 : 0);
      const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
      if (Math.abs(det) < 1e-12) break;
      const e = [ex, ey, ez];
      // y = A⁻¹ e（クラメルの公式）
      const y = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const M = A.slice();
        for (let r = 0; r < 3; r++) M[r * 3 + k] = e[r];
        y[k] = (M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6])) / det;
      }
      for (let j = 0; j < 3; j++) {
        const d = J[j] * y[0] + J[3 + j] * y[1] + J[6 + j] * y[2];
        x[j] = clamp(x[j] + clamp(d, -0.35, 0.35), IK_MIN[j], IK_MAX[j]);
      }
    }
    clawTip(x[0], x[1], x[2], c, p);
    return Math.hypot(t[0] - p[0], t[1] - p[1], t[2] - p[2]);
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
