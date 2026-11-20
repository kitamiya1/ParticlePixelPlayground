// 操作キャラクターの移動・状態管理（ゲームロジック）。見た目（粒・ボーン）は render/CharacterRig が担当する。

import type { IslandLayout } from '../world/IslandLayout';

export type MoveState = 'idle' | 'walk' | 'run';

export const MOVE_STATE_LABEL: Record<MoveState, string> = { idle: '待機', walk: '歩行', run: '走行' };

export class CharacterController {
  x: number;
  y: number;
  z: number;
  vx = 0;
  vz = 0;
  heading = 0;
  speed = 0;
  state: MoveState = 'idle';
  /** 歩行サイクルの位相（移動距離に比例） */
  stridePhase = 0;
  readonly radius = 0.3;
  readonly walkSpeed = 3.0;
  readonly runSpeed = 6.2;

  constructor(private readonly layout: IslandLayout) {
    this.x = layout.spawn.x;
    this.z = layout.spawn.z;
    this.y = layout.terrain.heightAt(this.x, this.z);
  }

  update(dt: number, move: { x: number; y: number }, run: boolean, cameraYaw: number) {
    // カメラ基準の移動方向
    const fx = -Math.sin(cameraYaw), fz = -Math.cos(cameraYaw);
    const rx = Math.cos(cameraYaw), rz = -Math.sin(cameraYaw);
    const dx = rx * move.x + fx * move.y;
    const dz = rz * move.x + fz * move.y;
    const hasInput = move.x !== 0 || move.y !== 0;
    const maxSpeed = run ? this.runSpeed : this.walkSpeed;
    const tvx = dx * maxSpeed, tvz = dz * maxSpeed;
    const accel = hasInput ? 12 : 10;
    const k = 1 - Math.exp(-accel * dt);
    this.vx += (tvx - this.vx) * k;
    this.vz += (tvz - this.vz) * k;

    const nx = this.x + this.vx * dt;
    const nz = this.z + this.vz * dt;
    const res = this.layout.resolve(nx, nz, this.radius);
    // 実際に動いた量から速度を再計算（壁に当たった時に足踏みしない）
    const mvx = (res.x - this.x) / Math.max(dt, 1e-4);
    const mvz = (res.z - this.z) / Math.max(dt, 1e-4);
    this.x = res.x;
    this.z = res.z;
    this.speed = Math.hypot(mvx, mvz);

    if (hasInput) {
      const target = Math.atan2(dx, dz);
      let d = target - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * (1 - Math.exp(-14 * dt));
    }

    const ground = this.layout.terrain.heightAt(this.x, this.z);
    this.y += (ground - this.y) * (1 - Math.exp(-20 * dt));

    this.stridePhase += this.speed * dt * 2.4;
    this.state = this.speed < 0.25 ? 'idle' : this.speed < (this.walkSpeed + this.runSpeed) * 0.5 ? 'walk' : 'run';
  }
}
