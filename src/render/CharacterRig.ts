// キャラクターの見た目側のアニメーション：ゲーム状態（速度・歩行位相）からボーン行列を作る。

import * as THREE from 'three';
import type { CharacterController } from '../game/CharacterController';
import { BONE, BONE_COUNT, BONE_PIVOTS } from '../visual/emitters/character';

export class CharacterRig {
  readonly bones: THREE.Matrix4[] = Array.from({ length: BONE_COUNT }, () => new THREE.Matrix4());
  readonly root = new THREE.Matrix4();
  private walkW = 0;
  private runW = 0;
  private t = 0;
  private readonly tmp = new THREE.Matrix4();
  private readonly tmp2 = new THREE.Matrix4();

  update(dt: number, c: CharacterController) {
    this.t += dt;
    const k = 1 - Math.exp(-dt * 8);
    const tw = c.state === 'walk' ? 1 : c.state === 'run' ? 0 : 0;
    const tr = c.state === 'run' ? 1 : 0;
    this.walkW += (tw - this.walkW) * k;
    this.runW += (tr - this.runW) * k;
    const moveW = Math.min(1, this.walkW + this.runW);
    const idleW = 1 - moveW;

    const ph = c.stridePhase;
    const s = Math.sin(ph);
    const legAmp = 0.55 * this.walkW + 0.95 * this.runW;
    const armAmp = 0.45 * this.walkW + 0.9 * this.runW;
    const bob = Math.abs(Math.cos(ph)) * (0.035 * this.walkW + 0.07 * this.runW) + Math.sin(this.t * 2.2) * 0.012 * idleW;
    const lean = 0.06 * this.walkW + 0.28 * this.runW;
    const breathe = Math.sin(this.t * 2.2) * 0.04 * idleW;

    this.root.makeRotationY(c.heading).setPosition(c.x, c.y, c.z);

    const body = this.bones[BONE.body];
    body.makeTranslation(0, BONE_PIVOTS[BONE.body][1] + bob, 0).multiply(this.tmp.makeRotationX(lean)).multiply(this.tmp2.makeRotationY(s * 0.12 * moveW));

    const head = this.bones[BONE.head];
    head.copy(body).multiply(this.tmp.makeTranslation(0, 0.36, 0)).multiply(this.tmp2.makeRotationX(-lean * 0.5 + breathe * 0.5 + Math.sin(this.t * 0.7) * 0.04 * idleW));

    for (const [bone, sx] of [[BONE.armL, 1], [BONE.armR, -1]] as const) {
      const m = this.bones[bone];
      const swing = -s * sx * armAmp + (this.runW * -0.5);
      m.copy(body)
        .multiply(this.tmp.makeTranslation(BONE_PIVOTS[bone][0], 0.3, 0))
        .multiply(this.tmp2.makeRotationX(swing))
        .multiply(this.tmp.makeRotationZ(sx * (0.08 + breathe * 0.5 + 0.15 * this.runW)));
    }
    for (const [bone, sx] of [[BONE.legL, 1], [BONE.legR, -1]] as const) {
      const m = this.bones[bone];
      m.makeTranslation(BONE_PIVOTS[bone][0], BONE_PIVOTS[bone][1] + bob * 0.4, 0).multiply(this.tmp.makeRotationX(s * sx * legAmp));
    }
  }
}
