// 描画方式 A・B・C で共有する形状データ（点群）。Spark に依存しないので、方式 A・C から静的に使える。
// 各点は位置・色・法線・サイズ・風の影響度・焼き込み日照を持つ。B はこれをスプラットへ、C はサーフェル（円盤）へ変換する。

import type * as THREE from 'three';
import { mulberry32 } from '../../core/math';
import type { ParticleBuilder } from '../../visual/ParticleBuilder';

/** 描画方式 A・B・C 共通の点群（CPU 側。破棄・再生成時に再利用する） */
export interface SplatPointSet {
  count: number;
  pos: Float32Array;
  /** 0..255 の RGB */
  col: Uint8Array;
  nrm: Float32Array;
  size: Float32Array;
  wind: Float32Array;
  /** 焼き込んだ日照（0..1） */
  sun: Float32Array;
}

/**
 * 粒ジオメトリから点群を取り出す。excludeCats に含まれるカテゴリの粒は除く。
 * keep を渡すと、さらに粒ごとに（カテゴリ名・風の影響度で）残すかを決める（方式 F の草花・葉の取り出し用）
 */
export function pointSetFromGeometry(g: THREE.BufferGeometry, excludeCats: string[] = [], keep?: (cat: string, wind: number) => boolean): SplatPointSet {
  const pos = g.getAttribute('position').array as Float32Array;
  const col = g.getAttribute('aColor').array as Uint8Array;
  const nrm = g.getAttribute('normal').array as Int8Array;
  const misc = g.getAttribute('aMisc').array as Float32Array;
  const n = g.getAttribute('position').count;
  const cat = g.userData.cat as Uint8Array | undefined;
  const names = (g.userData.catNames as string[] | undefined) ?? [];
  const excl = new Set(excludeCats.map((c) => names.indexOf(c)).filter((i) => i >= 0));
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (cat && excl.has(cat[i])) continue;
    if (keep && !keep(cat ? names[cat[i]] ?? '' : '', misc[i * 3 + 1])) continue;
    idx.push(i);
  }
  const m = idx.length;
  const out = allocPointSet(m);
  for (let o = 0; o < m; o++) {
    const i = idx[o];
    for (let k = 0; k < 3; k++) {
      out.pos[o * 3 + k] = pos[i * 3 + k];
      out.col[o * 3 + k] = col[i * 3 + k];
      out.nrm[o * 3 + k] = nrm[i * 3 + k] / 127;
    }
    out.size[o] = misc[i * 3];
    out.wind[o] = misc[i * 3 + 1];
    out.sun[o] = misc[i * 3 + 2];
  }
  return out;
}

export function pointSetFromBuilder(b: ParticleBuilder): SplatPointSet {
  const n = b.count;
  const out = allocPointSet(n);
  for (let i = 0; i < n * 3; i++) {
    out.pos[i] = b.pos[i];
    out.col[i] = b.col[i];
    out.nrm[i] = b.nrm[i] / 127;
  }
  for (let i = 0; i < n; i++) {
    out.size[i] = b.misc[i * 3];
    out.wind[i] = b.misc[i * 3 + 1];
    out.sun[i] = b.misc[i * 3 + 2];
  }
  return out;
}

function allocPointSet(n: number): SplatPointSet {
  return {
    count: n,
    pos: new Float32Array(n * 3),
    col: new Uint8Array(n * 3),
    nrm: new Float32Array(n * 3),
    size: new Float32Array(n),
    wind: new Float32Array(n),
    sun: new Float32Array(n),
  };
}

/** 点群をつなげてシャッフルする（先頭から N 個描けば全体から均一に間引ける） */
export function mergeAndShuffle(sets: SplatPointSet[], seed = 3): SplatPointSet {
  const n = sets.reduce((a, s) => a + s.count, 0);
  const out = allocPointSet(n);
  let o = 0;
  for (const s of sets) {
    out.pos.set(s.pos, o * 3);
    out.col.set(s.col, o * 3);
    out.nrm.set(s.nrm, o * 3);
    out.size.set(s.size, o);
    out.wind.set(s.wind, o);
    out.sun.set(s.sun, o);
    o += s.count;
  }
  const rng = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    for (let k = 0; k < 3; k++) {
      swap(out.pos, i * 3 + k, j * 3 + k);
      swap(out.col, i * 3 + k, j * 3 + k);
      swap(out.nrm, i * 3 + k, j * 3 + k);
    }
    swap(out.size, i, j);
    swap(out.wind, i, j);
    swap(out.sun, i, j);
  }
  return out;
}

function swap(a: Float32Array | Uint8Array, i: number, j: number) {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}
