// 粒データを型付き配列に積み上げるビルダー。最終的に 1 つの BufferGeometry にまとめて描画する
// （粒ごとに Three.js オブジェクトを作らない）。

import * as THREE from 'three';
import type { RGB, Rng } from '../core/math';

export interface ParticleOptions {
  size: number;
  /** 風の影響度 0..1 */
  wind?: number;
  /** ボーン番号（キャラクター用） */
  bone?: number;
  /**
   * 草の葉の順位（0..1。同じ葉の粒は同じ値）。描画方式 F で草を葉 1 枚単位に間引くための CPU 側データで、
   * シェーダーには渡さない（未指定 = -1 = 草の葉ではない）。
   */
  grassRank?: number;
}

export class ParticleBuilder {
  count = 0;
  private cap: number;
  pos: Float32Array;
  col: Uint8Array;
  nrm: Int8Array;
  /** size, wind, sunVisibility */
  misc: Float32Array;
  bone: Float32Array | null;
  /** 粒ごとのカテゴリ番号（catNames の添字。描画方式 B の形状差し替えに使う） */
  cat: Uint8Array;
  /** 草の葉の順位（ParticleOptions.grassRank。-1 = 草の葉ではない） */
  grassRank: Float32Array;
  /** カテゴリ番号 → 名前 */
  readonly catNames: string[] = [];
  /** カテゴリ別の粒数（統計表示用） */
  readonly categories = new Map<string, number>();
  private category = 'misc';
  private catIndex = -1;

  constructor(initialCap = 1 << 16, withBones = false) {
    this.cap = initialCap;
    this.pos = new Float32Array(initialCap * 3);
    this.col = new Uint8Array(initialCap * 3);
    this.nrm = new Int8Array(initialCap * 3);
    this.misc = new Float32Array(initialCap * 3);
    this.bone = withBones ? new Float32Array(initialCap) : null;
    this.cat = new Uint8Array(initialCap);
    this.grassRank = new Float32Array(initialCap);
  }

  setCategory(name: string) {
    this.category = name;
    let i = this.catNames.indexOf(name);
    if (i < 0) i = this.catNames.push(name) - 1;
    this.catIndex = i;
  }

  private grow() {
    const cap = this.cap * 2;
    const g = <T extends Float32Array | Uint8Array | Int8Array>(a: T, n: number): T => {
      const b = new (a.constructor as { new (n: number): T })(cap * n);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, 3);
    this.col = g(this.col, 3);
    this.nrm = g(this.nrm, 3);
    this.misc = g(this.misc, 3);
    if (this.bone) this.bone = g(this.bone, 1);
    this.cat = g(this.cat, 1);
    this.grassRank = g(this.grassRank, 1);
    this.cap = cap;
  }

  push(x: number, y: number, z: number, c: RGB, nx: number, ny: number, nz: number, o: ParticleOptions) {
    if (this.count >= this.cap) this.grow();
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.col[i3] = Math.max(0, Math.min(255, Math.round(c[0] * 255)));
    this.col[i3 + 1] = Math.max(0, Math.min(255, Math.round(c[1] * 255)));
    this.col[i3 + 2] = Math.max(0, Math.min(255, Math.round(c[2] * 255)));
    const nl = Math.hypot(nx, ny, nz) || 1;
    this.nrm[i3] = Math.round((nx / nl) * 127);
    this.nrm[i3 + 1] = Math.round((ny / nl) * 127);
    this.nrm[i3 + 2] = Math.round((nz / nl) * 127);
    this.misc[i3] = o.size;
    this.misc[i3 + 1] = o.wind ?? 0;
    this.misc[i3 + 2] = 1;
    if (this.bone) this.bone[i] = o.bone ?? 0;
    if (this.catIndex < 0) this.setCategory(this.category);
    this.cat[i] = this.catIndex;
    this.grassRank[i] = o.grassRank ?? -1;
    this.categories.set(this.category, (this.categories.get(this.category) ?? 0) + 1);
  }

  /**
   * 粒の順番をシャッフルする。こうしておくと「先頭から N 個だけ描く」(drawRange) で
   * 全体から均一に間引いた密度調整ができる。
   */
  shuffle(rng: Rng) {
    const n = this.count;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      this.swap(i, j);
    }
  }

  private swap(i: number, j: number) {
    const sw3 = (a: Float32Array | Uint8Array | Int8Array) => {
      for (let k = 0; k < 3; k++) {
        const t = a[i * 3 + k];
        a[i * 3 + k] = a[j * 3 + k];
        a[j * 3 + k] = t;
      }
    };
    sw3(this.pos);
    sw3(this.col);
    sw3(this.nrm);
    sw3(this.misc);
    if (this.bone) {
      const t = this.bone[i];
      this.bone[i] = this.bone[j];
      this.bone[j] = t;
    }
    const tc = this.cat[i];
    this.cat[i] = this.cat[j];
    this.cat[j] = tc;
    const tr = this.grassRank[i];
    this.grassRank[i] = this.grassRank[j];
    this.grassRank[j] = tr;
  }

  toGeometry(): THREE.BufferGeometry {
    const n = this.count;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3, true));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, n * 3), 3, true));
    g.setAttribute('aMisc', new THREE.BufferAttribute(this.misc.slice(0, n * 3), 3));
    if (this.bone) g.setAttribute('aBone', new THREE.BufferAttribute(this.bone.slice(0, n), 1));
    // シェーダーでは使わない。描画方式 B（スプラット）への変換時にカテゴリを判別するための CPU 側データ
    g.userData.cat = this.cat.slice(0, n);
    g.userData.catNames = [...this.catNames];
    g.userData.grassRank = this.grassRank.slice(0, n);
    g.computeBoundingSphere();
    return g;
  }
}
