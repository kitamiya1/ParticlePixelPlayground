// 穴掘りの見た目（Three.js 側）。ゲームロジック（DigField・CrabController）が決めた形を描く。
// - 掘った区画の作り直し：DigField.dirty の区画を、カニに近い順に 1 フレームあたりの時間の上限（budgetMs）まで
//   buildDigChunk（Surface Nets）で三角形にし直す。初めて掘った区画は、同じフレームで高さ場の網の三角形を隠す
//   （頂点番号を 0 にして潰す。網の作り直しはしない）。岩・流木・水草・魚・濾過槽などは作り直さない。
// - 周りの物：作り直した区画の中で、根元の砂が無くなった植物の円盤（SurfelRenderer.hideWorldPoints）と小石を消す。
// - 演出：かき出すたびに砂粒（重力で落ちる・水中はゆっくり）と、水中では砂煙（ふくらんで消える）を舞わせる。
//   掘れない物に当たったら灰色の小さなかけらだけ。掘っている間は掘る所に輪と、体からの点線（照準）を出す。

import * as THREE from 'three';
import { hex, mixRGB, type RGB } from '../core/math';
import type { TriMesh } from '../render/pixelmesh/MeshBuild';
import type { SurfelRenderer } from '../render/surfel/SurfelRenderer';
import { buildDigChunk, type LightGrid, type PebbleInfo, type TerrainChunks } from './AquariumBuild';
import { DIG, diggable, type DigMaterial } from './AquariumDig';
import { TANK, type AquariumWorld } from './AquariumWorld';
import type { CrabController, CrabEvent } from './CrabController';
import { cursorVertex, pointFragment, sandVertex } from './aquaShaders';

export interface DigFxDeps {
  world: AquariumWorld;
  light: LightGrid;
  meshScene: THREE.Scene;
  fxScene: THREE.Scene;
  material: THREE.Material;
  toGeometry: (m: TriMesh) => THREE.BufferGeometry;
  terrain: { geo: THREE.BufferGeometry; chunks: TerrainChunks };
  pebbles: { geo: THREE.BufferGeometry; list: PebbleInfo[] };
  surfel: SurfelRenderer;
  /** 植物の円盤の根元（x, y, z。NaN = 岩・流木の上） */
  anchors: Float32Array;
  /** 共有ユニフォーム（水中の色味に使う） */
  uniforms: Record<string, THREE.IUniform>;
}

interface Grain {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  size: number;
  /** 0 = 砂粒, 1 = 砂煙（水中でふくらんで消える）, 2 = 岩のかけら */
  kind: 0 | 1 | 2;
  c: RGB;
  rest: boolean;
}

const SANDS = [hex('#dccba0'), hex('#c5b085'), hex('#a48f6a'), hex('#8c7656')];
const SOILS = [hex('#4a3a2a'), hex('#5b4431'), hex('#3b5529'), hex('#6e5139')];
const STONE = [hex('#8f8981'), hex('#655f59'), hex('#a39c92')];
const CURSOR_OK = hex('#ffe08a'), CURSOR_NG = hex('#e07a5f'), CURSOR_FAR = hex('#9fc7c0');
const RING = 14, DOTS = 5;

export class AquariumDigFx {
  /** 1 フレームに区画を作り直す時間の上限（ms。少なくとも 1 区画は作る） */
  budgetMs = 6;
  readonly stats = {
    /** 作り直した区画の数（のべ）・掘った区画の数・作り直しの時間 */
    rebuilds: 0, chunks: 0, lastMs: 0, maxMs: 0, totalMs: 0,
    /** まだ作り直していない区画 */
    pending: 0,
    /** 掘った区画の三角形の数・隠した高さ場の三角形の数 */
    tris: 0, hiddenTris: 0,
    hiddenPlants: 0, hiddenPebbles: 0,
    grains: 0,
    /** 直近のフレームで作り直しにかかった時間（ms） */
    frameMs: 0,
  };
  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly tris = new Map<number, number>();
  /** 区画ごとの植物（根元が同じ円盤をまとめた株。done = もう消した） */
  private readonly plantsByChunk = new Map<number, { x: number; y: number; z: number; idx: number[]; done: boolean }[]>();
  private readonly pebblesByChunk = new Map<number, number[]>();
  private readonly hiddenPebble: Uint8Array;
  private readonly grains: Grain[] = [];
  private readonly maxGrains = 1400;
  private readonly grainGeo: THREE.BufferGeometry;
  private readonly cursorGeo: THREE.BufferGeometry;
  private readonly cursor: THREE.Points;
  private cursorT = 0;

  constructor(private readonly d: DigFxDeps) {
    const dig = d.world.dig;
    // 植物の円盤・小石を区画ごとに分けておく（作り直した区画の中だけ調べる）
    const A = d.anchors;
    const groups = new Map<string, { x: number; y: number; z: number; idx: number[]; done: boolean }>();
    for (let i = 0; i < A.length / 3; i++) {
      const ax = A[i * 3], ay = A[i * 3 + 1], az = A[i * 3 + 2];
      if (Number.isNaN(ax) || !d.world.insideTank(ax, az)) continue;
      const key = `${ax},${ay},${az}`;
      let g = groups.get(key);
      if (!g) {
        groups.set(key, (g = { x: ax, y: ay, z: az, idx: [], done: false }));
        const id = dig.chunkId(dig.ci(ax), dig.cj(az));
        let l = this.plantsByChunk.get(id);
        if (!l) this.plantsByChunk.set(id, (l = []));
        l.push(g);
      }
      g.idx.push(i);
    }
    d.pebbles.list.forEach((p, i) => {
      const id = dig.chunkId(dig.ci(p.x), dig.cj(p.z));
      let l = this.pebblesByChunk.get(id);
      if (!l) this.pebblesByChunk.set(id, (l = []));
      l.push(i);
    });
    this.hiddenPebble = new Uint8Array(d.pebbles.list.length);

    // 砂粒・砂煙
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxGrains * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(this.maxGrains * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.maxGrains), 1).setUsage(THREE.DynamicDrawUsage));
    this.grainGeo = g;
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: sandVertex, fragmentShader: pointFragment, uniforms: { ...d.uniforms }, defines: { PPP_WATER: '' } }));
    pts.frustumCulled = false;
    d.fxScene.add(pts);

    // 照準（輪 + 点線 + 中心）
    const n = RING + DOTS + 1;
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    cg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    cg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.cursorGeo = cg;
    this.cursor = new THREE.Points(cg, new THREE.ShaderMaterial({ vertexShader: cursorVertex, fragmentShader: pointFragment, depthTest: false, depthWrite: false }));
    this.cursor.frustumCulled = false;
    this.cursor.renderOrder = 5;
    this.cursor.visible = false;
    d.fxScene.add(this.cursor);
  }

  // ---------------- 区画の作り直し ----------------

  private rebuild(id: number) {
    const d = this.d;
    const dig = d.world.dig;
    const i = id % dig.ncx, j = Math.floor(id / dig.ncx);
    const t0 = performance.now();
    const tm = buildDigChunk(d.world, d.light, i, j);
    const geo = d.toGeometry(tm);
    let mesh = this.meshes.get(id);
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new THREE.Mesh(geo, d.material);
      mesh.frustumCulled = false;
      d.meshScene.add(mesh);
      this.meshes.set(id, mesh);
      this.hideTerrainChunk(id);
      this.stats.chunks++;
    }
    this.stats.tris += tm.triCount - (this.tris.get(id) ?? 0);
    this.tris.set(id, tm.triCount);
    this.hideAround(id);
    const ms = performance.now() - t0;
    this.stats.rebuilds++;
    this.stats.lastMs = ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.totalMs += ms;
  }

  /** 高さ場の網のうち、この区画の三角形を潰す（頂点番号をすべて 0 に） */
  private hideTerrainChunk(id: number) {
    const { geo, chunks } = this.d.terrain;
    const start = chunks.start[id], count = chunks.count[id];
    if (count === 0) return;
    const index = geo.getIndex()!;
    (index.array as Uint32Array).fill(0, start, start + count);
    index.addUpdateRange(start, count);
    index.needsUpdate = true;
    this.stats.hiddenTris += count / 3;
  }

  /** 区画の中で、根元の砂が無くなった植物と小石を消す */
  private hideAround(id: number) {
    const d = this.d;
    const w = d.world;
    const plants = this.plantsByChunk.get(id);
    if (plants) {
      const gone: number[] = [];
      for (const g of plants) {
        if (g.done || w.sandSolid(g.x, g.y - 0.04, g.z) <= 0) continue;
        g.done = true;
        for (const i of g.idx) gone.push(i);
      }
      if (gone.length) this.stats.hiddenPlants += d.surfel.hideWorldPoints(gone);
    }
    const pebbles = this.pebblesByChunk.get(id);
    if (pebbles) {
      const pos = d.pebbles.geo.getAttribute('position') as THREE.BufferAttribute;
      for (const k of pebbles) {
        if (this.hiddenPebble[k]) continue;
        const p = d.pebbles.list[k];
        if (w.sandSolid(p.x, p.bottom - 0.02, p.z) <= 0 && w.sandSolid(p.x, p.y, p.z) > -0.2) continue;
        // 頂点を 1 点に集めて三角形を潰す
        for (let v = p.v0; v < p.v0 + p.vn; v++) pos.setXYZ(v, p.x, p.y, p.z);
        pos.addUpdateRange(p.v0 * 3, p.vn * 3);
        pos.needsUpdate = true;
        this.hiddenPebble[k] = 1;
        this.stats.hiddenPebbles++;
      }
    }
  }

  /** 汚れた区画を、カニに近い順に時間の上限まで作り直す */
  private flush(crab: CrabController) {
    const dig = this.d.world.dig;
    const t0 = performance.now();
    if (dig.dirty.size > 0) {
      const ids = [...dig.dirty];
      const cx = dig.ci(crab.x), cz = dig.cj(crab.z);
      ids.sort((a, b) => Math.hypot((a % dig.ncx) - cx, Math.floor(a / dig.ncx) - cz) - Math.hypot((b % dig.ncx) - cx, Math.floor(b / dig.ncx) - cz));
      for (const id of ids) {
        this.rebuild(id);
        dig.dirty.delete(id);
        if (performance.now() - t0 > this.budgetMs) break;
      }
    }
    this.stats.pending = dig.dirty.size;
    this.stats.frameMs = performance.now() - t0;
  }

  /** 汚れた区画をすべて作り直す（自動検証用） */
  flushAll() {
    const dig = this.d.world.dig;
    for (const id of [...dig.dirty]) {
      this.rebuild(id);
      dig.dirty.delete(id);
    }
    this.stats.pending = 0;
  }

  // ---------------- 砂粒・照準 ----------------

  /** かき出し（dig）・掘れない物に当たった（digBlocked）出来事 */
  burst(e: CrabEvent) {
    const dir = e.dir ?? [0, 0, 1];
    const under = e.y < TANK.waterY;
    const soil = e.material === 'soil';
    if (e.kind === 'digBlocked') {
      // 掘れない：灰色の小さなかけらが跳ねるだけ
      for (let i = 0; i < 5; i++) this.add(e.x, e.y, e.z, -dir[0] * 1.2 + rs(1.2), 1.0 + Math.random() * 1.0, -dir[2] * 1.2 + rs(1.2), 0.35, 0.03, 2, STONE[i % STONE.length]);
      return;
    }
    const pal = soil ? SOILS : SANDS;
    // 砂粒：掘った所から、カニの後ろ（手前）と上へ跳ね上がる
    const n = Math.round(12 + e.power * 10);
    for (let i = 0; i < n; i++) {
      const sp = 0.8 + Math.random() * 1.4;
      const c = mixRGB(pal[Math.floor(Math.random() * pal.length)], pal[0], Math.random() * 0.3);
      this.add(e.x + rs(0.12), e.y + rs(0.08), e.z + rs(0.12), -dir[0] * sp + rs(1.1), 1.2 + Math.random() * 1.8, -dir[2] * sp + rs(1.1), under ? 1.4 + Math.random() : 0.7 + Math.random() * 0.4, 0.028 + Math.random() * 0.03, 0, c);
    }
    // 水中：砂煙（ふくらんで消える）
    if (under) {
      for (let i = 0; i < 4; i++) {
        const c = mixRGB(pal[1], hex('#9fb8a0'), 0.35);
        this.add(e.x + rs(0.15), e.y + 0.05 + rs(0.1), e.z + rs(0.15), -dir[0] * 0.3 + rs(0.35), 0.15 + Math.random() * 0.3, -dir[2] * 0.3 + rs(0.35), 1.2 + Math.random() * 0.8, 0.09 + Math.random() * 0.05, 1, c);
      }
    }
  }

  private add(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, kind: 0 | 1 | 2, c: RGB) {
    if (this.grains.length >= this.maxGrains) this.grains.shift();
    this.grains.push({ x, y, z, vx, vy, vz, life, max: life, size, kind, c, rest: false });
  }

  private updateGrains(dt: number) {
    const w = this.d.world;
    let o = 0;
    for (let i = 0; i < this.grains.length; i++) {
      const g = this.grains[i];
      g.life -= dt;
      if (g.life <= 0) continue;
      if (!g.rest) {
        const under = g.y < TANK.waterY;
        if (g.kind === 1) {
          // 砂煙：ゆっくり漂って止まる
          const k = Math.exp(-dt * 2.2);
          g.vx *= k;
          g.vz *= k;
          g.vy = g.vy * k - 0.05 * dt;
        } else {
          g.vy -= (under ? 3.2 : 13) * dt;
          const k = Math.exp(-dt * (under ? 3.0 : 0.6));
          g.vx *= k;
          g.vz *= k;
          if (under) g.vy = Math.max(g.vy * Math.exp(-dt * 1.5), -0.9);
        }
        const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt, nz = g.z + g.vz * dt;
        if (g.kind !== 1 && w.solid(nx, ny, nz) < 0) {
          // 地面に落ちたら止まって、少しして消える
          g.rest = true;
          g.life = Math.min(g.life, 0.25 + Math.random() * 0.3);
        } else {
          g.x = nx;
          g.y = ny;
          g.z = nz;
        }
      }
      this.grains[o++] = g;
    }
    this.grains.length = o;
    const pos = this.grainGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.grainGeo.getAttribute('aColor') as THREE.BufferAttribute;
    const size = this.grainGeo.getAttribute('aSize') as THREE.BufferAttribute;
    for (let i = 0; i < this.maxGrains; i++) {
      const g = this.grains[i];
      if (!g) {
        size.setX(i, 0);
        continue;
      }
      const f = g.life / g.max;
      // 砂煙はふくらんでから縮んで消える。砂粒・かけらは消える直前に小さくなる
      const s = g.kind === 1 ? g.size * Math.sin(Math.PI * Math.min(1, (1 - f) * 1.15 + 0.08)) : g.size * Math.min(1, f * 4);
      pos.setXYZ(i, g.x, g.y, g.z);
      col.setXYZ(i, g.c[0], g.c[1], g.c[2]);
      size.setX(i, s);
    }
    pos.needsUpdate = col.needsUpdate = size.needsUpdate = true;
    this.stats.grains = this.grains.length;
  }

  /** 照準：掘る所に輪（面の向きに沿う）と、体から掘る所への点線。掘れる = 黄、掘れない = 赤、届かない = 薄い水色 */
  private updateCursor(dt: number, crab: CrabController) {
    const A = crab.digAim;
    this.cursor.visible = A.active;
    if (!A.active) return;
    this.cursorT += dt;
    const pos = this.cursorGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.cursorGeo.getAttribute('aColor') as THREE.BufferAttribute;
    const size = this.cursorGeo.getAttribute('aSize') as THREE.BufferAttribute;
    const m: DigMaterial = A.material;
    const c = !A.hit ? CURSOR_FAR : diggable(m) ? CURSOR_OK : CURSOR_NG;
    // 輪の面：当たった面の法線（届かなければ掘る向き）に垂直
    const n = A.hit ? this.d.world.contactNormal(A.p[0], A.p[1], A.p[2]) : [-A.dir[0], -A.dir[1], -A.dir[2]];
    const ref = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t1 = norm(cross(ref, n)), t2 = cross(n, t1);
    const pulse = 0.5 + 0.5 * Math.sin(this.cursorT * 9);
    const R = (diggable(m) ? DIG.rMax * 0.55 : 0.2) * (0.85 + 0.15 * pulse);
    const lift = 0.05;
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * Math.PI * 2 + this.cursorT * 1.5;
      pos.setXYZ(i, A.p[0] + n[0] * lift + (t1[0] * Math.cos(a) + t2[0] * Math.sin(a)) * R, A.p[1] + n[1] * lift + (t1[1] * Math.cos(a) + t2[1] * Math.sin(a)) * R, A.p[2] + n[2] * lift + (t1[2] * Math.cos(a) + t2[2] * Math.sin(a)) * R);
      col.setXYZ(i, c[0], c[1], c[2]);
      size.setX(i, 2);
    }
    // 点線：体の中心から掘る所へ（流れるように動く）
    const ox = crab.x, oy = crab.y + crab.radius, oz = crab.z;
    for (let k = 0; k < DOTS; k++) {
      const f = ((k + (this.cursorT * 2.5) % 1) / DOTS) * 0.9 + 0.08;
      pos.setXYZ(RING + k, ox + (A.p[0] - ox) * f, oy + (A.p[1] - oy) * f, oz + (A.p[2] - oz) * f);
      col.setXYZ(RING + k, c[0], c[1], c[2]);
      size.setX(RING + k, k === DOTS - 1 ? 1 : 2);
    }
    pos.setXYZ(RING + DOTS, A.p[0] + n[0] * lift, A.p[1] + n[1] * lift, A.p[2] + n[2] * lift);
    col.setXYZ(RING + DOTS, 1, 1, 1);
    size.setX(RING + DOTS, 2 + pulse);
    pos.needsUpdate = col.needsUpdate = size.needsUpdate = true;
  }

  update(dt: number, crab: CrabController) {
    this.flush(crab);
    this.updateGrains(dt);
    this.updateCursor(dt, crab);
  }
}

function rs(a: number): number {
  return (Math.random() - 0.5) * a;
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: number[]): number[] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
