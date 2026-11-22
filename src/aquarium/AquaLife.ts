// 水槽の小さな生き物（ゲームロジック側。Three.js に依存しない）。見た目は AquariumRenderer がインスタンス描画する。
// - 小魚：群れごとに水中の決まった輪を回る目標点を追い、群れの中の決まった位置へ寄る。
//   カニが近づくと離れる向きへ速く逃げ、岩・流木・底床・水面・ガラスからは押し戻す。
// - エビ：決まった住みかのまわりの底（岩・流木の上を含む）を歩いて止まってを繰り返し、
//   カニが近づくと後ろへ跳ねて逃げる（エビの尾の一打ちのような、短く速い後退 + 小さな跳ね上がり）。

import { clamp, lerp, mulberry32, type Rng } from '../core/math';
import { TANK, type AquariumWorld } from './AquariumWorld';

export interface Fish {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  heading: number;
  pitch: number;
  /** 尾の振りの位相 */
  phase: number;
  school: number;
  off: [number, number, number];
  /** 逃げている強さ（0..1。尾を速く振る） */
  fear: number;
}

interface School {
  c: [number, number, number];
  rx: number;
  rz: number;
  ry: number;
  speed: number;
  a: number;
  /** 回る向き（1 / -1） */
  dir: number;
}

export type ShrimpState = 'idle' | 'walk' | 'dart';

export interface Shrimp {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  heading: number;
  state: ShrimpState;
  timer: number;
  home: [number, number];
  range: number;
  /** 脚・触角の動きの位相 */
  phase: number;
  /** 歩く目標 */
  tx: number;
  tz: number;
  airborne: boolean;
}

/** カニの位置（体の中心） */
export interface Threat {
  x: number;
  y: number;
  z: number;
}

const FLEE_FISH = 1.9;
const FLEE_SHRIMP = 1.15;

export class AquaLife {
  readonly fish: Fish[] = [];
  readonly shrimp: Shrimp[] = [];
  private readonly schools: School[] = [];
  private readonly rng: Rng = mulberry32(77);

  constructor(private readonly world: AquariumWorld) {
    const rng = this.rng;
    // 群れ：砂の広場の上 / 洞窟と柱のあいだの開けた水 / 柱の奥（滝壺の手前）
    const defs: [number, number, number, number, number, number, number, number][] = [
      [-8.5, 3.4, 5.4, 3.8, 1.9, 0.5, 0.9, 9],
      [-3.4, 4.1, -0.6, 2.6, 2.0, 0.6, 1.1, 8],
      [-0.2, 3.9, -7.4, 2.2, 1.3, 0.4, 0.8, 7],
    ];
    defs.forEach(([cx, cy, cz, rx, rz, ry, speed, n], si) => {
      this.schools.push({ c: [cx, cy, cz], rx, rz, ry, speed, a: rng() * Math.PI * 2, dir: si % 2 ? -1 : 1 });
      for (let i = 0; i < n; i++) {
        const off: [number, number, number] = [(rng() - 0.5) * 1.3, (rng() - 0.5) * 0.6, (rng() - 0.5) * 1.3];
        this.fish.push({ x: cx + off[0] + rx, y: cy + off[1], z: cz + off[2], vx: 0, vy: 0, vz: 0, heading: 0, pitch: 0, phase: rng() * 6.28, school: si, off, fear: 0 });
      }
    });
    // エビの住みか（x, z, 歩き回る範囲）：広場・森・岩の柱の根元・浅瀬・流木の小屋の中・倒木の中・洞窟の中
    const L = world.landmarks;
    const homes: [number, number, number][] = [
      [-6.2, 6.0, 1.2], [-10.4, 7.4, 1.0], [-2.6, 6.6, 0.9],
      [-11.4, -5.6, 1.2], [-6.8, -6.2, 0.9],
      [-1.3, -5.0, 0.9], [0.6, 5.6, 0.8],
      [L.hut.x, L.hut.z, 0.6],
      [(L.logA[0] + L.logB[0]) / 2, (L.logA[2] + L.logB[2]) / 2, 1.0],
      [-12.6, -1.3, 0.8],
    ];
    for (const [hx, hz, range] of homes) {
      const y = this.floorAt(hx, hz, TANK.waterY - 0.3);
      this.shrimp.push({ x: hx, y, z: hz, vx: 0, vy: 0, vz: 0, heading: rng() * 6.28, state: 'idle', timer: rng() * 2, home: [hx, hz], range, phase: rng() * 6.28, tx: hx, tz: hz, airborne: false });
    }
    // 小屋・倒木・洞窟の中のエビは、屋根の上ではなく中の床に置く
    for (const s of this.shrimp) s.y = this.floorAt(s.x, s.z, this.innerStart(s.x, s.z));
  }

  /** 屋根のある場所（小屋・倒木・洞窟）では、床から探し始める高さ */
  private innerStart(x: number, z: number): number {
    return this.world.groundAt(x, z) + 0.35;
  }

  private floorAt(x: number, z: number, yFrom: number): number {
    return this.world.surfaceBelow(x, yFrom, z);
  }

  update(dt: number, threat: Threat) {
    if (dt <= 0) return;
    this.updateFish(dt, threat);
    this.updateShrimp(dt, threat);
  }

  private updateFish(dt: number, t: Threat) {
    const w = this.world;
    for (const s of this.schools) s.a += (dt * s.speed * s.dir) / Math.max(1, (s.rx + s.rz) * 0.5);
    for (const f of this.fish) {
      const s = this.schools[f.school];
      // 群れの目標点（輪の上を回る） + 群れの中の位置。輪の進む向きへ並ぶよう、位置は少しずつ揺らす
      const tx = s.c[0] + Math.cos(s.a) * s.rx + f.off[0];
      const ty = s.c[1] + Math.sin(s.a * 2) * s.ry + f.off[1] + Math.sin(f.phase * 0.13) * 0.12;
      const tz = s.c[2] + Math.sin(s.a) * s.rz + f.off[2];
      let dx = (tx - f.x) * 1.4, dy = (ty - f.y) * 1.4, dz = (tz - f.z) * 1.4;
      // カニから逃げる
      const ex = f.x - t.x, ey = f.y - t.y, ez = f.z - t.z;
      const ed = Math.hypot(ex, ey, ez);
      let fear = 0;
      if (ed < FLEE_FISH) {
        fear = 1 - ed / FLEE_FISH;
        const k = (fear * 9) / Math.max(ed, 0.1);
        dx += ex * k;
        dy += ey * k * 0.5;
        dz += ez * k;
      }
      f.fear += (fear - f.fear) * (1 - Math.exp(-dt * 6));
      const maxV = lerp(1.5, 4.2, f.fear);
      const dl = Math.hypot(dx, dy, dz);
      if (dl > maxV) {
        dx *= maxV / dl;
        dy *= maxV / dl;
        dz *= maxV / dl;
      }
      const k = 1 - Math.exp(-dt * lerp(2.5, 7, f.fear));
      f.vx += (dx - f.vx) * k;
      f.vy += (dy - f.vy) * k;
      f.vz += (dz - f.vz) * k;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      // 岩・流木・底床から押し戻す
      const d = w.solid(f.x, f.y, f.z);
      if (d < 0.22) {
        const n = w.solidNormal(f.x, f.y, f.z);
        const push = 0.22 - d;
        f.x += n[0] * push;
        f.y += n[1] * push;
        f.z += n[2] * push;
        const vn = f.vx * n[0] + f.vy * n[1] + f.vz * n[2];
        if (vn < 0) {
          f.vx -= n[0] * vn;
          f.vy -= n[1] * vn;
          f.vz -= n[2] * vn;
        }
      }
      f.x = clamp(f.x, TANK.minX + 0.3, TANK.maxX - 0.3);
      f.z = clamp(f.z, TANK.minZ + 0.3, TANK.maxZ - 0.3);
      f.y = clamp(f.y, w.groundAt(f.x, f.z) + 0.2, TANK.waterY - 0.25);
      // 向き：進む向きへなめらかに
      const sp = Math.hypot(f.vx, f.vz);
      if (sp > 0.05) {
        const h = Math.atan2(f.vx, f.vz);
        f.heading = f.heading + wrap(h - f.heading) * (1 - Math.exp(-dt * 8));
      }
      f.pitch += (clamp(Math.atan2(f.vy, Math.max(sp, 0.2)), -0.6, 0.6) - f.pitch) * (1 - Math.exp(-dt * 5));
      f.phase += dt * (7 + Math.hypot(f.vx, f.vy, f.vz) * 5 + f.fear * 10);
    }
  }

  private updateShrimp(dt: number, t: Threat) {
    const w = this.world;
    const rng = this.rng;
    for (const s of this.shrimp) {
      s.phase += dt * (s.state === 'walk' ? 9 : s.state === 'dart' ? 18 : 2.5);
      const ex = s.x - t.x, ez = s.z - t.z, ey = s.y - t.y;
      const ed = Math.hypot(ex, ey, ez);
      if (ed < FLEE_SHRIMP && s.state !== 'dart') {
        // 頭をカニへ向けたまま、尾の方（後ろ）へ跳ねて逃げる
        const l = Math.hypot(ex, ez) || 1;
        s.heading = Math.atan2(-ex, -ez);
        s.vx = (ex / l) * 3.2;
        s.vz = (ez / l) * 3.2;
        s.vy = 1.3;
        s.airborne = true;
        s.state = 'dart';
        s.timer = 0.7;
      }
      s.timer -= dt;
      if (s.state === 'idle' && s.timer <= 0) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * s.range;
        s.tx = s.home[0] + Math.cos(a) * r;
        s.tz = s.home[1] + Math.sin(a) * r;
        s.state = 'walk';
        s.timer = 4;
      }
      let nx = s.x, nz = s.z;
      if (s.state === 'walk') {
        const dx = s.tx - s.x, dz = s.tz - s.z;
        const dl = Math.hypot(dx, dz);
        if (dl < 0.05 || s.timer <= 0) {
          s.state = 'idle';
          s.timer = 0.8 + rng() * 2.5;
        } else {
          const h = Math.atan2(dx, dz);
          s.heading += wrap(h - s.heading) * (1 - Math.exp(-dt * 5));
          const v = 0.32;
          nx += Math.sin(s.heading) * v * dt;
          nz += Math.cos(s.heading) * v * dt;
        }
      } else if (s.state === 'dart') {
        s.vx *= Math.exp(-dt * 3.2);
        s.vz *= Math.exp(-dt * 3.2);
        nx += s.vx * dt;
        nz += s.vz * dt;
        if (s.timer <= 0 && !s.airborne) {
          s.state = 'idle';
          s.timer = 1.5 + rng() * 2;
        }
      }
      // 住みかから離れすぎない
      const hx = nx - s.home[0], hz = nz - s.home[1];
      const hl = Math.hypot(hx, hz), lim = s.range + 0.9;
      if (hl > lim) {
        nx = s.home[0] + (hx / hl) * lim;
        nz = s.home[1] + (hz / hl) * lim;
      }
      nx = clamp(nx, TANK.minX + 0.2, TANK.maxX - 0.2);
      nz = clamp(nz, TANK.minZ + 0.2, TANK.maxZ - 0.2);
      // 壁（岩・流木の側面）には入らない
      if (w.solid(nx, s.y + 0.08, nz) > 0.03) {
        s.x = nx;
        s.z = nz;
      } else {
        s.vx = s.vz = 0;
        if (s.state === 'walk') s.timer = 0;
      }
      const floor = this.floorAt(s.x, s.z, s.y + 0.3);
      if (s.airborne) {
        s.vy -= 3.4 * dt;
        s.y += s.vy * dt;
        if (s.y <= floor) {
          s.y = floor;
          s.airborne = false;
          s.vy = 0;
        }
      } else s.y += (floor - s.y) * (1 - Math.exp(-dt * 20));
      s.y = Math.min(s.y, TANK.waterY - 0.15);
    }
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
