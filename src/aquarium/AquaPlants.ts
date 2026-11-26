// 水草をかき分ける（第 3 段階）。植物 1 本（テープ状の葉 1 枚・有茎草 1 本・シダ 1 株・葉の広い草 1 株・汀線の草 1 本）ごとに
// 「押された量（根元に対する水平のずれ）・押された高さ・震え」を持ち、SurfelRenderer の PLANT_BEND がその値で円盤を曲げる
// （根元は固定、押された高さまで 3 次の曲線、そこより上は種類ごとの割合まで起き上がる）。
//
// 方式（mode）：
// - 'dyn'（既定）：カニ・挟んでいる物（押す球）の近く（格子で探す）の植物だけ、CPU でばね + 減衰を進め、植物ごとの値を
//   浮動小数のテクスチャ（1 画素 = 1 本）に書く。押されている間は押し出された位置を保ち（止まっていても体と重なった草は
//   分かれたまま）、離れると水の抵抗を感じる速さで戻る（種類ごとの硬さ・減衰）。勢いよく（ダッシュで）分け入ると、
//   押し出す速さの分だけ跳ねて揺れ、しばらく震える。動いている向きの前にある草は、左右へ分ける。
// - 'gpu'：状態を持たず、頂点シェーダーが押す球（カニ・挟んでいる物と、カニの通った跡の球 4 つ：古いほど小さい）から
//   毎回求める。CPU は使わないが、戻りの遅れ・跳ね・左右への分け方は無い（比較用）。
//
// 押す球：カニの体（中心は体の中心より少し下、半径は脚の広がり）と、挟んでいる物・動いている物（半径 = 物の大きさ）。

import * as THREE from 'three';
import type { PlantTable } from './AquariumBuild';

/** 種類ごと（PLANT_KIND の順）：押された所より上に残る割合・曲がりの上限・太さ（当たり）・震えの強さ・硬さ k・減衰の割合 ζ */
export const PLANT_PARAMS = [
  { name: 'テープ状の葉', keep: 0.45, max: 0.75, thick: 0.05, flutter: 1.0, k: 4.5, zeta: 0.62 },
  { name: '有茎草', keep: 0.8, max: 0.5, thick: 0.07, flutter: 0.8, k: 9, zeta: 0.7 },
  { name: 'シダ', keep: 1.0, max: 0.3, thick: 0.28, flutter: 0.6, k: 16, zeta: 0.8 },
  { name: '葉の広い草', keep: 1.0, max: 0.25, thick: 0.2, flutter: 0.5, k: 18, zeta: 0.8 },
  { name: '汀線の草', keep: 0.9, max: 0.3, thick: 0.03, flutter: 0.9, k: 12, zeta: 0.65 },
] as const;

export interface Pusher {
  x: number;
  y: number;
  z: number;
  r: number;
  vx: number;
  vy: number;
  vz: number;
}

/** 'off' は比較用（曲げない。設定の欄には出さない） */
export type PlantMode = 'dyn' | 'gpu' | 'off';

/** 押されている間に押し出した位置へ寄せる速さ（ばねの硬さ）と、ダッシュで跳ねる速さの係数 */
const PUSH_K = 260;
const SPLASH = 0.55;
/** 近くの植物を探す格子の大きさと、押す球のまわりに見る余白 */
const CELL = 0.8;
const MARGIN = 0.4;

export class PlantField {
  readonly n: number;
  mode: PlantMode = 'dyn';
  /** 見通しの線でも草をよけるか（比較・検証用に切れる） */
  sightOn = true;
  readonly texW = 64;
  readonly texH: number;
  /** シェーダーへ渡すユニフォーム（SurfelRenderer.enablePlantBend） */
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly bendData: Float32Array;
  private readonly bendTex: THREE.DataTexture;
  /** 植物ごとの状態：押された量 D（x, z）・その速さ V・押された高さの割合・震え */
  private readonly D: Float32Array;
  private readonly V: Float32Array;
  private readonly fc: Float32Array;
  private readonly fl: Float32Array;
  private readonly touched: Uint8Array;
  private readonly active = new Set<number>();
  private readonly grid = new Map<number, number[]>();
  private dirty = false;
  /** GPU だけの方式で使う、カニの通った跡（古い順。0.12 秒ごと） */
  private trail: Pusher[] = [];
  private trailT = 0;
  readonly stats = { active: 0, touched: 0, ms: 0, maxMs: 0, frames: 0 };

  constructor(readonly table: PlantTable) {
    const n = (this.n = table.count);
    this.texH = Math.max(1, Math.ceil(n / this.texW));
    const info = new Float32Array(this.texW * this.texH * 4);
    for (let i = 0; i < n; i++) {
      info[i * 4] = table.root[i * 3];
      info[i * 4 + 1] = table.root[i * 3 + 1];
      info[i * 4 + 2] = table.root[i * 3 + 2];
      info[i * 4 + 3] = table.kind[i] * 100 + Math.min(99, table.height[i]);
      const key = this.key(Math.floor(table.root[i * 3] / CELL), Math.floor(table.root[i * 3 + 2] / CELL));
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(i);
    }
    const infoTex = new THREE.DataTexture(info, this.texW, this.texH, THREE.RGBAFormat, THREE.FloatType);
    infoTex.needsUpdate = true;
    this.bendData = new Float32Array(this.texW * this.texH * 4);
    this.bendTex = new THREE.DataTexture(this.bendData, this.texW, this.texH, THREE.RGBAFormat, THREE.FloatType);
    this.bendTex.needsUpdate = true;
    this.D = new Float32Array(n * 2);
    this.V = new Float32Array(n * 2);
    this.fc = new Float32Array(n);
    this.fl = new Float32Array(n);
    this.touched = new Uint8Array(n);
    this.uniforms = {
      uPlantInfo: { value: infoTex },
      uPlantBend: { value: this.bendTex },
      uPlantTexW: { value: this.texW },
      uPlantTexH: { value: this.texH },
      uPlantMode: { value: 0 },
      uPush: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
      uPlantKeep: { value: PLANT_PARAMS.map((p) => new THREE.Vector4(p.keep, p.max, p.thick, p.flutter)) },
    };
  }

  private key(ix: number, iz: number) {
    return (ix + 512) * 2048 + (iz + 512);
  }

  setMode(m: PlantMode) {
    if (m === this.mode) return;
    this.mode = m;
    this.uniforms.uPlantMode.value = m === 'gpu' ? 1 : 0;
    // 方式を変えたら、ばねの状態は捨てる（GPU では使わない）
    for (const i of this.active) this.clear(i);
    this.active.clear();
    this.bendTex.needsUpdate = true;
  }

  private clear(i: number) {
    this.D[i * 2] = this.D[i * 2 + 1] = this.V[i * 2] = this.V[i * 2 + 1] = 0;
    this.fl[i] = 0;
    this.bendData[i * 4] = this.bendData[i * 4 + 1] = this.bendData[i * 4 + 2] = this.bendData[i * 4 + 3] = 0;
  }

  /** 押された量の目標（植物 i、押す球 P）。押されていなければ null。戻り値 [x, z, 押された高さの割合, 押し出す速さ] */
  private pushOf(i: number, P: Pusher): [number, number, number, number] | null {
    const T = this.table, rx = T.root[i * 3], ry = T.root[i * 3 + 1], rz = T.root[i * 3 + 2], H = T.height[i];
    const kp = PLANT_PARAMS[T.kind[i]];
    const cy = Math.min(Math.max(P.y, ry + 0.02), ry + H);
    const dy = P.y - cy;
    const re2 = P.r * P.r - dy * dy;
    if (re2 <= 0) return null;
    let dx = rx - P.x, dz = rz - P.z;
    const dl = Math.hypot(dx, dz);
    const pen = Math.sqrt(re2) + kp.thick - dl;
    if (pen <= 0) return null;
    if (dl > 1e-4) {
      dx /= dl;
      dz /= dl;
    } else {
      dx = 1;
      dz = 0;
    }
    // 動いている向きの前にある草は左右へ分ける（押し出す向きを、進む向きと直角の側へ寄せる）
    const sp = Math.hypot(P.vx, P.vz);
    if (sp > 0.15) {
      const hx = P.vx / sp, hz = P.vz / sp;
      const ahead = dx * hx + dz * hz;
      if (ahead > 0) {
        let lx = dx - hx * ahead, lz = dz - hz * ahead;
        let ll = Math.hypot(lx, lz);
        if (ll < 1e-3) {
          // 真正面：植物の番号で左右を決める
          const sgn = i % 2 ? 1 : -1;
          lx = -hz * sgn;
          lz = hx * sgn;
          ll = 1;
        }
        const a = Math.min(1, ahead) * 0.85;
        dx = dx * (1 - a) + (lx / ll) * a;
        dz = dz * (1 - a) + (lz / ll) * a;
        const l2 = Math.hypot(dx, dz) || 1;
        dx /= l2;
        dz /= l2;
      }
    }
    // 押し出す速さ（押す球の速さのうち、押し出す向きの分）
    const out = Math.max(0, P.vx * dx + P.vz * dz) + sp * 0.3;
    return [dx * pen, dz * pen, (cy - ry) / H, out];
  }

  /** 押す球のまわりの植物を集める */
  private near(P: Pusher, cb: (i: number) => void) {
    const R = P.r + MARGIN;
    const x0 = Math.floor((P.x - R) / CELL), x1 = Math.floor((P.x + R) / CELL);
    const z0 = Math.floor((P.z - R) / CELL), z1 = Math.floor((P.z + R) / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const list = this.grid.get(this.key(ix, iz));
      if (list) for (const i of list) cb(i);
    }
  }

  /**
   * sight：カメラ → カニの見通しの線（a → b、半径 r）。'dyn' のとき、この線にかかる草も線と直角の向きへそっと分ける
   * （密集した水草の中でもカニを見失わないための、最小限の遮蔽対策。描画で抜くのではなく、草がよけて見える）
   */
  update(dt: number, pushers: Pusher[], sight: { a: [number, number, number]; b: [number, number, number]; r: number } | null = null) {
    const t0 = performance.now();
    if (this.mode === 'gpu') this.updateGpu(dt, pushers);
    else if (this.mode === 'dyn') this.updateDyn(dt, pushers, sight);
    const ms = performance.now() - t0;
    this.stats.ms = ms;
    this.stats.maxMs = Math.max(this.stats.maxMs * 0.995, ms);
    this.stats.frames++;
  }

  private updateGpu(dt: number, pushers: Pusher[]) {
    // カニ（最初の球）の通った跡を 0.12 秒ごとに覚え、古いほど小さくする（押した草がゆっくり戻って見える）
    this.trailT += dt;
    const c = pushers[0];
    if (c && this.trailT >= 0.12) {
      this.trailT = 0;
      this.trail.push({ ...c });
      if (this.trail.length > 4) this.trail.shift();
    }
    const U = this.uniforms.uPush.value as THREE.Vector4[];
    let k = 0;
    for (const P of pushers.slice(0, 4)) U[k++].set(P.x, P.y, P.z, P.r);
    for (let j = this.trail.length - 1; j >= 0 && k < 8; j--) {
      const P = this.trail[j], age = this.trail.length - j;
      U[k++].set(P.x, P.y, P.z, P.r * Math.max(0, 1 - age * 0.22));
    }
    while (k < 8) U[k++].set(0, 0, 0, 0);
    this.stats.active = 0;
  }

  /** 見通しの線にかかる植物 i を、線と直角の向きへ分ける量（なければ null） */
  private sightOf(i: number, S: { a: [number, number, number]; b: [number, number, number]; r: number }): [number, number, number, number] | null {
    const T = this.table, rx = T.root[i * 3], ry = T.root[i * 3 + 1], rz = T.root[i * 3 + 2], H = T.height[i];
    const kp = PLANT_PARAMS[T.kind[i]];
    const ex = S.b[0] - S.a[0], ez = S.b[2] - S.a[2], el2 = ex * ex + ez * ez;
    if (el2 < 1e-6) return null;
    // 水平に最も近い所（カニの手前 0.4 まで：カニのすぐまわりは体が分ける）
    const L = Math.sqrt(el2);
    let t = ((rx - S.a[0]) * ex + (rz - S.a[2]) * ez) / el2;
    t = Math.min(Math.max(t, 0.05), 1 - 0.4 / L);
    if (t <= 0.05) return null;
    const px = S.a[0] + ex * t, pz = S.a[2] + ez * t, py = S.a[1] + (S.b[1] - S.a[1]) * t;
    if (py < ry - S.r || py > ry + H + S.r) return null;
    let dx = rx - px, dz = rz - pz;
    const dl = Math.hypot(dx, dz);
    const pen = S.r + kp.thick - dl;
    if (pen <= 0) return null;
    if (dl > 1e-4) {
      dx /= dl;
      dz /= dl;
    } else {
      dx = -ez / L;
      dz = ex / L;
    }
    const cy = Math.min(Math.max(py, ry + 0.02), ry + H);
    return [dx * pen, dz * pen, (cy - ry) / H, 0];
  }

  private updateDyn(dt: number, pushers: Pusher[], sight: { a: [number, number, number]; b: [number, number, number]; r: number } | null) {
    if (dt <= 0) return;
    const T = this.table;
    // 1. 押されている植物：目標（押し出す量の和）と押された高さ
    const tgt = new Map<number, [number, number, number, number]>();
    if (sight && this.sightOn) {
      // 見通しの線に沿って格子を調べる
      const seen = new Set<number>();
      const [a, b] = [sight.a, sight.b];
      const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const nS = Math.max(1, Math.ceil(L / (CELL * 0.5)));
      for (let s = 0; s <= nS; s++) {
        const f = s / nS;
        this.near({ x: a[0] + (b[0] - a[0]) * f, y: 0, z: a[2] + (b[2] - a[2]) * f, r: sight.r, vx: 0, vy: 0, vz: 0 }, (i) => {
          if (seen.has(i)) return;
          seen.add(i);
          const p = this.sightOf(i, sight);
          if (!p) return;
          tgt.set(i, p);
          this.active.add(i);
        });
      }
    }
    for (const P of pushers) {
      this.near(P, (i) => {
        const p = this.pushOf(i, P);
        if (!p) return;
        const q = tgt.get(i);
        if (q) {
          q[0] += p[0];
          q[1] += p[1];
          q[2] = Math.max(q[2], p[2]);
          q[3] = Math.max(q[3], p[3]);
        } else tgt.set(i, p);
        this.active.add(i);
      });
    }
    this.stats.touched = tgt.size;
    // 2. ばね + 減衰（押されている間は押し出した位置へ速く寄せる。離れたら種類ごとの硬さで、水の抵抗を感じる速さで戻る）
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (const i of this.active) {
      const kp = PLANT_PARAMS[T.kind[i]];
      const t = tgt.get(i);
      let dx = this.D[i * 2], dz = this.D[i * 2 + 1], vx = this.V[i * 2], vz = this.V[i * 2 + 1];
      if (t) {
        // 新しく押された瞬間・強く押し出された瞬間は、押し出す速さの分だけ跳ねる（ダッシュで勢いよく揺れる）
        if (!this.touched[i] || t[3] > 1.6) {
          const tl = Math.hypot(t[0], t[1]) || 1;
          const kick = Math.max(0, t[3] - 0.6) * SPLASH;
          vx += (t[0] / tl) * kick;
          vz += (t[1] / tl) * kick;
          this.fl[i] = Math.max(this.fl[i], Math.min(1, t[3] / 3));
        }
        this.fc[i] = t[2];
        this.touched[i] = 1;
      } else this.touched[i] = 0;
      for (let s = 0; s < steps; s++) {
        let ax: number, az: number;
        if (t) {
          // 押されている：外へだけ押し出す（目標より外へ揺れている分は、種類のばねで戻す）
          const c = 2 * Math.sqrt(PUSH_K) * 0.9;
          ax = PUSH_K * (t[0] - dx) - c * vx;
          az = PUSH_K * (t[1] - dz) - c * vz;
        } else {
          const c = 2 * Math.sqrt(kp.k) * kp.zeta;
          ax = -kp.k * dx - c * vx;
          az = -kp.k * dz - c * vz;
        }
        vx += ax * h;
        vz += az * h;
        dx += vx * h;
        dz += vz * h;
      }
      const l = Math.hypot(dx, dz);
      if (l > kp.max) {
        dx *= kp.max / l;
        dz *= kp.max / l;
        // 上限に当たった分の速さは捨てる
        const vn = (vx * dx + vz * dz) / (l || 1);
        if (vn > 0) {
          vx -= (dx / kp.max) * vn;
          vz -= (dz / kp.max) * vn;
        }
      }
      this.fl[i] *= Math.exp(-dt * 2.5);
      this.D[i * 2] = dx;
      this.D[i * 2 + 1] = dz;
      this.V[i * 2] = vx;
      this.V[i * 2 + 1] = vz;
      const o = i * 4, B = this.bendData;
      B[o] = dx;
      B[o + 1] = dz;
      B[o + 2] = this.fc[i];
      B[o + 3] = this.fl[i];
      this.dirty = true;
      // 止まった（戻りきった）植物は外す
      if (!t && Math.hypot(dx, dz) < 0.002 && Math.hypot(vx, vz) < 0.01 && this.fl[i] < 0.01) {
        this.clear(i);
        this.active.delete(i);
      }
    }
    this.stats.active = this.active.size;
    if (this.dirty) {
      this.bendTex.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** 植物 i のいまの押された量（検証用。GPU の方式では 0） */
  bendOf(i: number): [number, number] {
    return [this.D[i * 2], this.D[i * 2 + 1]];
  }

  /**
   * 植物 i の高さ y の円盤のずれ（検証用。SurfelRenderer の PLANT_BEND と同じ式。震えは除く）
   */
  offsetAt(i: number, y: number): [number, number, number] {
    const T = this.table, kp = PLANT_PARAMS[T.kind[i]], H = T.height[i], ry = T.root[i * 3 + 1];
    let bx = 0, bz = 0, fc = 0;
    if (this.mode === 'dyn') {
      bx = this.D[i * 2];
      bz = this.D[i * 2 + 1];
      fc = this.fc[i];
    } else if (this.mode === 'gpu') {
      for (const P of this.uniforms.uPush.value as THREE.Vector4[]) {
        if (P.w <= 0) continue;
        const cy = Math.min(Math.max(P.y, ry + 0.02), ry + H), dy = P.y - cy;
        const re = Math.sqrt(Math.max(0, P.w * P.w - dy * dy));
        let dx = T.root[i * 3] - P.x, dz = T.root[i * 3 + 2] - P.z;
        const dl = Math.hypot(dx, dz), pen = re + kp.thick - dl;
        if (re > 0 && pen > 0) {
          if (dl > 1e-3) { dx /= dl; dz /= dl; } else { dx = 1; dz = 0; }
          bx += dx * pen;
          bz += dz * pen;
          fc = Math.max(fc, (cy - ry) / H);
        }
      }
      const bl = Math.hypot(bx, bz);
      if (bl > kp.max) { bx *= kp.max / bl; bz *= kp.max / bl; }
    }
    const f = Math.min(1, Math.max(0, (y - ry) / Math.max(H, 0.05)));
    const fcc = Math.min(1, Math.max(0.12, fc));
    const u = Math.min(1, f / fcc);
    let s = u * u * (3 - 2 * u);
    if (f > fcc) {
      const e = Math.min(1, Math.max(0, (f - fcc) / (Math.min(1, fcc + 0.45) - fcc || 1)));
      s = 1 + (kp.keep - 1) * (e * e * (3 - 2 * e));
    }
    const ox = bx * s, oz = bz * s;
    const dy = Math.min((ox * ox + oz * oz) / Math.max(2 * H * Math.max(f, 0.05), 0.05), 0.6 * H * f);
    return [ox, -dy, oz];
  }
}
