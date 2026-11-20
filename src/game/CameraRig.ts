// 三人称カメラの状態（ヨー・ピッチ・ズーム・注視点）。実際の Three.js カメラへの反映は render 側が行う。

import { clamp } from '../core/math';
import type { Input } from './Input';

export class CameraRig {
  yaw = 0.75;
  pitch = 0.6;
  /** 注視点で見える高さ（ワールド単位） */
  zoom = 15;
  readonly minZoom = 5;
  readonly maxZoom = 70;
  target = { x: 0, y: 0, z: 0 };
  /** 鑑賞モード：キャラクターから独立して操作 */
  viewing = false;
  autoRotate = false;

  update(dt: number, input: Input, follow: { x: number; y: number; z: number }, panKeys: { x: number; y: number }) {
    this.yaw -= input.dragDX * 0.006;
    this.pitch = clamp(this.pitch + input.dragDY * 0.004, 0.12, 1.45);
    if (input.wheel !== 0) this.zoom = clamp(this.zoom * Math.pow(1.12, input.wheel), this.minZoom, this.maxZoom);
    if (this.autoRotate && this.viewing) this.yaw += dt * 0.15;

    if (this.viewing) {
      // 鑑賞モード：右ドラッグ / WASD で注視点を平行移動
      const s = this.zoom / 400;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const kp = dt * this.zoom * 0.9;
      this.target.x += -input.panDX * s * rx + input.panDY * s * fx * 1.4 + panKeys.x * kp * rx + panKeys.y * kp * fx;
      this.target.z += -input.panDX * s * rz + input.panDY * s * fz * 1.4 + panKeys.x * kp * rz + panKeys.y * kp * fz;
    } else {
      const k = 1 - Math.exp(-dt * 6);
      this.target.x += (follow.x - this.target.x) * k;
      this.target.y += (follow.y - this.target.y) * k;
      this.target.z += (follow.z - this.target.z) * k;
    }
  }

  /** 注視点からカメラへの単位ベクトル */
  direction(): [number, number, number] {
    const cp = Math.cos(this.pitch);
    return [cp * Math.sin(this.yaw), Math.sin(this.pitch), cp * Math.cos(this.yaw)];
  }
}
