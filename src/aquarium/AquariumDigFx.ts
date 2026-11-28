// 穴掘りの見た目（Three.js 側）。ゲームロジック（DigField・CrabController）が決めた形を描く。
// - 掘った区画の作り直し（ひとまとまりずつ）：DigField.dirty の区画をまとめて取り出し、そのときの空洞の形を写して
//   （DigField.snapshot）、カニに近い順に 1 フレームあたりの時間の上限（budgetMs）まで buildDigChunk（Surface Nets）で
//   三角形にする。できた三角形はすぐには出さず、まとまりの全区画ができたフレームで一斉に差し替え、同時に当たり判定へ
//   入れる（DigField.commit）。区画ごとにばらばらに差し替えると、作り直した区画と待っている区画の境で空洞の壁が
//   片側だけになり、また当たり判定だけ先に変わるとカニ・カメラが「見た目では固体の中」へ入って裏面しか描かれず、
//   向こう側が透けて見える。初めて掘った区画は、差し替えるフレームで高さ場の網の三角形（ガラスに接する区画は
//   ガラス際の断面も。作り直した区画が穴の開いた断面を持つ）を隠す
//   （頂点番号を 0 にして潰す。網の作り直しはしない）。岩・流木・水草・魚・濾過槽などは作り直さない。
// - 周りの物：作り直した区画の中で、根元の砂が無くなった植物の円盤（SurfelRenderer.hideWorldPoints）と小石を消す。
// - 演出：かき出すたびに砂粒（重力で落ちる・水中はゆっくり）と、水中では砂煙（ふくらんで消える）を舞わせる。
//   掘れない物に当たったら灰色の小さなかけらだけ。掘っている間は掘る所に輪と、体からの点線（照準）を出す
//   （掘れるときは輪を掘る向きに垂直＝穴の断面にし、当たった所の先へも点を伸ばして穴の伸びる向きを見せる）。

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
const CURSOR_OK = hex('#ffe08a'), CURSOR_NG = hex('#e07a5f'), CURSOR_FAR = hex('#9fc7c0'), CURSOR_FILL = hex('#b6f07a');
const RING = 14, DOTS = 6, EXT = 4;

export class AquariumDigFx {
  /** 1 フレームに区画を作り直す時間の上限（ms。少なくとも 1 区画は作る） */
  budgetMs = 6;
  readonly stats = {
    /** 作り直した区画の数（のべ）・掘った区画の数・作り直しの時間 */
    rebuilds: 0, chunks: 0, lastMs: 0, maxMs: 0, totalMs: 0,
    /** まだ作り直していない区画（作り直し中のまとまりの残り + 次のまとまりを待つ区画） */
    pending: 0,
    /** 作り直し中のまとまりの区画数・できた数・差し替えたまとまりの数・最後のまとまりにかかった時間（ms、実時間） */
    batch: 0, built: 0, batches: 0, lastBatchMs: 0, maxBatchMs: 0,
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
  /**
   * 根元の砂が無くなった景色の小石（番号）を、消す代わりに物理の物にして落とす（AquaDecor.pebbleLost。true = 引き受けた）。
   * 無い・false なら従来どおり消す
   */
  pebbleLost: ((k: number) => boolean) | null = null;
  private readonly grains: Grain[] = [];
  private readonly maxGrains = 1400;
  private readonly grainGeo: THREE.BufferGeometry;
  private readonly cursorGeo: THREE.BufferGeometry;
  private readonly cursor: THREE.Points;
  private cursorT = 0;
  /** 作り直し中のまとまり（区画の番号・次に作る位置・できた三角形・始めた時刻） */
  private work: { ids: number[]; next: number; built: Map<number, { geo: THREE.BufferGeometry; tris: number }>; t0: number } | null = null;

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

    // 照準（輪 + 点線 + 当たった所の先の点 + 中心）
    const n = RING + DOTS + EXT + 1;
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

  /** 区画（'snap' の版の空洞）を三角形にする。差し替えは swap でまとめて行う */
  private build(id: number) {
    const d = this.d;
    const dig = d.world.dig;
    const i = id % dig.ncx, j = Math.floor(id / dig.ncx);
    const t0 = performance.now();
    const tm = buildDigChunk(d.world, d.light, i, j, 'snap');
    this.work!.built.set(id, { geo: d.toGeometry(tm), tris: tm.triCount });
    const ms = performance.now() - t0;
    this.stats.rebuilds++;
    this.stats.lastMs = ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.totalMs += ms;
  }

  /** できた区画を一斉に差し替え、同じ瞬間に当たり判定へ入れる */
  private swap() {
    const d = this.d;
    const dig = d.world.dig;
    const w = this.work!;
    for (const [id, b] of w.built) {
      let mesh = this.meshes.get(id);
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = b.geo;
      } else {
        mesh = new THREE.Mesh(b.geo, d.material);
        mesh.frustumCulled = false;
        d.meshScene.add(mesh);
        this.meshes.set(id, mesh);
        this.hideTerrainChunk(id);
        this.stats.chunks++;
      }
      this.stats.tris += b.tris - (this.tris.get(id) ?? 0);
      this.tris.set(id, b.tris);
    }
    dig.commit();
    // 根元の砂が無くなった植物・小石（当たり判定を入れたあとの形で調べる）
    for (const id of w.built.keys()) this.hideAround(id);
    const ms = performance.now() - w.t0;
    this.stats.batches++;
    this.stats.lastBatchMs = ms;
    this.stats.maxBatchMs = Math.max(this.stats.maxBatchMs, ms);
    this.work = null;
  }

  /** 汚れた区画をまとめて取り出し、そのときの空洞の形を写して作り直しを始める */
  private begin(crab: { x: number; z: number }) {
    const dig = this.d.world.dig;
    const ids = [...dig.dirty];
    dig.dirty.clear();
    const cx = dig.ci(crab.x), cz = dig.cj(crab.z);
    const dist = (a: number) => Math.hypot((a % dig.ncx) - cx, Math.floor(a / dig.ncx) - cz);
    ids.sort((a, b) => dist(a) - dist(b));
    dig.snapshot();
    this.work = { ids, next: 0, built: new Map(), t0: performance.now() };
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

  /**
   * 矩形（x0..x1, z0..z1）の中で、高さ top より下に根元・中心がある植物と景色の小石を消す（積み木の検証エリアの石の床の下。
   * 床を突き抜けて見えない）。消した数を返す
   */
  hideInRect(x0: number, x1: number, z0: number, z1: number, top: number): { plants: number; pebbles: number } {
    const d = this.d;
    const gone: number[] = [];
    let np = 0, nb = 0;
    for (const plants of this.plantsByChunk.values()) {
      for (const g of plants) {
        if (g.done || g.x < x0 || g.x > x1 || g.z < z0 || g.z > z1 || g.y > top + 0.05) continue;
        g.done = true;
        np++;
        for (const i of g.idx) gone.push(i);
      }
    }
    if (gone.length) this.stats.hiddenPlants += d.surfel.hideWorldPoints(gone);
    const pos = d.pebbles.geo.getAttribute('position') as THREE.BufferAttribute;
    d.pebbles.list.forEach((p, k) => {
      if (this.hiddenPebble[k] || p.x < x0 - 0.05 || p.x > x1 + 0.05 || p.z < z0 - 0.05 || p.z > z1 + 0.05 || p.bottom > top) return;
      for (let v = p.v0; v < p.v0 + p.vn; v++) pos.setXYZ(v, p.x, p.y, p.z);
      pos.addUpdateRange(p.v0 * 3, p.vn * 3);
      pos.needsUpdate = true;
      this.hiddenPebble[k] = 1;
      nb++;
    });
    return { plants: np, pebbles: nb };
  }

  /** 区画の中で、根元の砂が無くなった植物と小石を消す */
  private hideAround(id: number) {
    const d = this.d;
    const w = d.world;
    const plants = this.plantsByChunk.get(id);
    if (plants) {
      const gone: number[] = [];
      for (const g of plants) {
        // 根元の砂が残っていて、盛った砂に埋まってもいない（根元の 0.15 上が砂の外）株は残す
        if (g.done || (w.sandSolid(g.x, g.y - 0.04, g.z) <= 0 && w.sandSolid(g.x, g.y + 0.15, g.z) > 0)) continue;
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
        // 物理の物にして落とせた：消さない（この後は AquaDecor が頂点を動かす）
        if (this.pebbleLost?.(k)) {
          this.hiddenPebble[k] = 1;
          continue;
        }
        // 頂点を 1 点に集めて三角形を潰す
        for (let v = p.v0; v < p.v0 + p.vn; v++) pos.setXYZ(v, p.x, p.y, p.z);
        pos.addUpdateRange(p.v0 * 3, p.vn * 3);
        pos.needsUpdate = true;
        this.hiddenPebble[k] = 1;
        this.stats.hiddenPebbles++;
      }
    }
  }

  /**
   * 作り直し：まとまりが無ければ汚れた区画で始め、時間の上限まで（少なくとも 1 区画）作る。
   * まとまりの全区画ができたら一斉に差し替える（次のまとまりは次のフレームから）
   */
  private flush(crab: CrabController) {
    const dig = this.d.world.dig;
    const t0 = performance.now();
    if (!this.work && dig.dirty.size > 0) this.begin(crab);
    // 区画に触れない形の変化（作り直さない区画の中だけ）は、そのまま当たり判定へ
    else if (!this.work && dig.uncommitted > 0) {
      dig.snapshot();
      dig.commit();
    }
    const w = this.work;
    if (w) {
      while (w.next < w.ids.length) {
        this.build(w.ids[w.next++]);
        if (performance.now() - t0 > this.budgetMs) break;
      }
      if (w.next >= w.ids.length) this.swap();
    }
    const cur = this.work;
    this.stats.batch = cur ? cur.ids.length : 0;
    this.stats.built = cur ? cur.next : 0;
    this.stats.pending = dig.dirty.size + (cur ? cur.ids.length - cur.next : 0);
    this.stats.frameMs = performance.now() - t0;
  }

  /** 汚れた区画をすべて作り直して差し替える（自動検証用） */
  flushAll() {
    const dig = this.d.world.dig;
    for (let k = 0; k < 2; k++) {
      if (!this.work && dig.dirty.size > 0) this.begin({ x: 0, z: 0 });
      const w = this.work;
      if (!w) break;
      while (w.next < w.ids.length) this.build(w.ids[w.next++]);
      this.swap();
    }
    // 区画に触れない形の変化（作り直さない区画の中だけ）も当たり判定へ（flush と同じ）
    if (!this.work && dig.uncommitted > 0) {
      dig.snapshot();
      dig.commit();
    }
    this.stats.pending = 0;
    this.stats.batch = this.stats.built = 0;
  }

  /**
   * 起動時の復元用：汚れた区画をすべて作り直して差し替える（flushAll と同じ結果）。sliceMs ごとに処理を手放して
   * 進み具合を知らせる（掘った区画が多いと数秒かかるので、読み込みの表示を止めない）。差し替え（swap = 見た目と
   * 当たり判定の切り替え）は、すべての区画ができてから 1 回だけ行う
   */
  async flushAllAsync(onProgress?: (done: number, total: number) => void, sliceMs = 40) {
    const dig = this.d.world.dig;
    for (let k = 0; k < 2; k++) {
      if (!this.work && dig.dirty.size > 0) this.begin({ x: 0, z: 0 });
      const w = this.work;
      if (!w) break;
      while (w.next < w.ids.length) {
        const t0 = performance.now();
        while (w.next < w.ids.length && performance.now() - t0 < sliceMs) this.build(w.ids[w.next++]);
        onProgress?.(w.next, w.ids.length);
        await new Promise((r) => setTimeout(r, 0));
      }
      this.swap();
    }
    this.flushAll();
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
    if (e.kind === 'fill') {
      // 盛る：盛る所の少し上から、砂粒がこぼれ落ちて積もる（水中は砂煙も少し）
      const n = Math.round(10 + e.power * 8);
      for (let i = 0; i < n; i++) {
        const c = mixRGB(pal[Math.floor(Math.random() * pal.length)], pal[0], 0.2 + Math.random() * 0.3);
        this.add(e.x + rs(0.3), e.y + 0.25 + Math.random() * 0.25, e.z + rs(0.3), dir[0] * 0.3 + rs(0.3), -0.3 - Math.random() * 0.6, dir[2] * 0.3 + rs(0.3), under ? 1.2 + Math.random() * 0.6 : 0.6 + Math.random() * 0.3, 0.03 + Math.random() * 0.03, 0, c);
      }
      if (under) for (let i = 0; i < 2; i++) this.add(e.x + rs(0.2), e.y + 0.08, e.z + rs(0.2), rs(0.3), 0.1 + Math.random() * 0.2, rs(0.3), 1.0 + Math.random() * 0.6, 0.08 + Math.random() * 0.04, 1, mixRGB(pal[1], hex('#9fb8a0'), 0.35));
      return;
    }
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

  /**
   * 穴の縁の砂が崩れる（引っこ抜きで生き物が暴れている・踏ん張っている所）：縁の輪（半径 r）の上から、n 粒が穴へこぼれ落ちる。
   * toward = 崩れる側（水平の単位。null = 輪の全周）
   */
  crumble(x: number, y: number, z: number, r: number, n: number, toward: readonly number[] | null) {
    const under = y < TANK.waterY;
    for (let i = 0; i < n; i++) {
      let a = Math.random() * Math.PI * 2;
      if (toward) a = Math.atan2(toward[0], toward[1]) + rs(1.2);
      const cx = Math.sin(a), cz = Math.cos(a);
      const c = mixRGB(SANDS[Math.floor(Math.random() * SANDS.length)], SANDS[0], Math.random() * 0.3);
      const sp = 0.25 + Math.random() * 0.35;
      this.add(x + cx * r * (0.8 + Math.random() * 0.4), y + 0.03 + Math.random() * 0.04, z + cz * r * (0.8 + Math.random() * 0.4), -cx * sp + rs(0.15), 0.25 + Math.random() * 0.5, -cz * sp + rs(0.15), under ? 0.9 + Math.random() * 0.5 : 0.5, 0.022 + Math.random() * 0.02, 0, c);
    }
    if (under && n > 3) this.add(x + rs(0.08), y + 0.06, z + rs(0.08), rs(0.2), 0.12 + Math.random() * 0.15, rs(0.2), 1.0 + Math.random() * 0.5, 0.07 + Math.random() * 0.04, 1, mixRGB(SANDS[1], hex('#9fb8a0'), 0.35));
  }

  /**
   * 食べかす（食事の 1 口。AquaEat）：口元から n 粒が前・横へこぼれ、水中ではゆっくり沈む（色 = 食べ物の色）。
   * fwd = カニの前の向き（水平の単位）
   */
  crumbs(x: number, y: number, z: number, n: number, colors: readonly RGB[], fwd: readonly number[]) {
    const under = y < TANK.waterY;
    for (let i = 0; i < n; i++) {
      const c = colors[Math.floor(Math.random() * colors.length)];
      const sp = 0.12 + Math.random() * 0.25;
      this.add(x + rs(0.03), y + rs(0.02), z + rs(0.03), fwd[0] * sp + rs(0.22), 0.05 + Math.random() * 0.25, fwd[1] * sp + rs(0.22), under ? 1.2 + Math.random() * 0.8 : 0.5, 0.012 + Math.random() * 0.014, 0, c);
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

  /**
   * 照準：体から掘る向きへの点線と、掘る所の輪。
   * - 掘れる（黄）：輪は掘る向きに垂直（これから伸びる穴の太さの断面）。当たった所の先へも点線を少し伸ばし、
   *   穴が伸びていく向きを見せる
   * - 掘れない（赤）：当たった面に沿った小さな輪
   * - 何も無い（届かない）：薄い水色の短い点線だけ（文字は出さず、カニの空振りで分かる）
   */
  private updateCursor(dt: number, crab: CrabController) {
    const A = crab.digAim;
    this.cursor.visible = A.active;
    if (!A.active) return;
    this.cursorT += dt;
    const pos = this.cursorGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.cursorGeo.getAttribute('aColor') as THREE.BufferAttribute;
    const size = this.cursorGeo.getAttribute('aSize') as THREE.BufferAttribute;
    const m: DigMaterial = A.material;
    const fillMode = A.tool === 'fill';
    // 盛る：盛れる所なら砂色の輪を面の上へ寝かせて（置く砂山の大きさ）、盛れなければ赤い小さな輪
    const ok = fillMode ? A.fillOk : A.face && diggable(m);
    const c = !A.face ? CURSOR_FAR : ok ? (fillMode ? CURSOR_FILL : CURSOR_OK) : CURSOR_NG;
    const d = A.dir;
    // 輪の面：掘れる = 掘る向きに垂直、掘れない・盛る = 当たった面の法線に垂直
    const n = fillMode && A.face ? A.n : ok || !A.face ? [-d[0], -d[1], -d[2]] : this.d.world.contactNormal(A.p[0], A.p[1], A.p[2]);
    const ref = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t1 = norm(cross(ref, n)), t2 = cross(n, t1);
    const pulse = 0.5 + 0.5 * Math.sin(this.cursorT * 9);
    // 掘れる輪は穴の断面より少し細く（穴の縁に重なって見えるように）。体からの距離で太さが変わらないよう固定
    const R = (fillMode && ok ? Math.max(A.fillR, 0.2) * 1.5 : ok ? DIG.rMax * 0.62 : 0.2) * (0.88 + 0.12 * pulse);
    const lift = ok && !fillMode ? 0 : 0.05;
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * Math.PI * 2 + this.cursorT * 1.5;
      pos.setXYZ(i, A.p[0] + n[0] * lift + (t1[0] * Math.cos(a) + t2[0] * Math.sin(a)) * R, A.p[1] + n[1] * lift + (t1[1] * Math.cos(a) + t2[1] * Math.sin(a)) * R, A.p[2] + n[2] * lift + (t1[2] * Math.cos(a) + t2[2] * Math.sin(a)) * R);
      col.setXYZ(i, c[0], c[1], c[2]);
      size.setX(i, A.face ? 2 : 0);
    }
    // 点線：鋏の先（体の中心から 0.25 前）から掘る所へ流れる。何も無いときは届く距離の半分まで、細く
    const ox = crab.x + d[0] * 0.25, oy = crab.y + crab.radius + d[1] * 0.25, oz = crab.z + d[2] * 0.25;
    const L = A.face ? 1 : 0.55;
    const ex = ox + (A.p[0] - ox) * L, ey = oy + (A.p[1] - oy) * L, ez = oz + (A.p[2] - oz) * L;
    for (let k = 0; k < DOTS; k++) {
      const f = (k + ((this.cursorT * 2.5) % 1)) / DOTS;
      pos.setXYZ(RING + k, ox + (ex - ox) * f, oy + (ey - oy) * f, oz + (ez - oz) * f);
      col.setXYZ(RING + k, c[0], c[1], c[2]);
      size.setX(RING + k, A.face ? 2 : k < DOTS - 2 ? 1.5 : 1);
    }
    // 掘れるときだけ：当たった所から先へ（穴が伸びる向き）、だんだん小さく
    for (let k = 0; k < EXT; k++) {
      const s = 0.14 * (k + 1) + 0.06 * ((this.cursorT * 2.5) % 1);
      pos.setXYZ(RING + DOTS + k, A.p[0] + d[0] * s, A.p[1] + d[1] * s, A.p[2] + d[2] * s);
      col.setXYZ(RING + DOTS + k, c[0], c[1], c[2]);
      size.setX(RING + DOTS + k, ok && !fillMode ? (k < 2 ? 2 : 1) : 0);
    }
    const ci = RING + DOTS + EXT;
    pos.setXYZ(ci, A.p[0] + n[0] * lift, A.p[1] + n[1] * lift, A.p[2] + n[2] * lift);
    col.setXYZ(ci, 1, 1, 1);
    size.setX(ci, A.face ? 2 + pulse : 0);
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
