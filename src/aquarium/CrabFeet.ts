// 接地 IK とプロシージャル歩行（第 4 段階）。8 本の歩脚それぞれが、地形（AquariumWorld の contactSolid / contactNormal /
// surfaceMaterial）の上に実際の足場を探して足先を置き、置いた足先は世界に固定する（胴体が動いても滑らない）。
// 脚が伸びすぎる・理想の位置から離れすぎる・足場が消えた（掘った）・足場が登れない材質の壁になった、で次の足場へ踏み替える。
//
// - 足場の探し方（probe）：脚の理想の位置（体の座標の休みの位置 + 進む向きへの先読み）の少し上（体の上の向き）から、
//   真下・斜め下（外へ / 進む向きへ）・進む向き（壁）・外向き・上（張り出し・天井）の順に、距離関数を少しずつ進めて最初の面を探し、
//   二分して面の上に置く。面の向き・脚の届く範囲（付け根から l1 + 下の節）・理想の位置からの距離・材質で評価し、点の最も良いものを選ぶ。
//   床（上向きの面）ならどの材質でも立てる。壁・天井は登れる材質（砂・土・岩・流木）だけ（ガラス・管は従来どおり掛けられない）。
// - 踏み替えの順番：急ぐ順。となりの脚（同じ側の前後・反対側の同じ脚）が踏み替え中なら待つ（結果として左右交互の
//   4 本ずつ：右 1・左 2・右 3・左 4 と、その逆、に近い順になる）（伸びすぎ・足場が消えた、の急ぎは待たない）。常に 4 本以上は接地させる。足場を探すのは 1 フレーム 4 本まで
//   （iPhone で探す処理をフレームに分ける）。
// - 踏み替えの軌道：前の足場から次の足場へ、ゆっくり加速・減速しながら運び、その間は面の外向き（体の上）へ持ち上げる（sin）。
//   歩き 0.2 秒・ダッシュ 0.09 秒（速いほど短く、先読みの歩幅は長く）。
// - 胴体：接地している足先の重心と、足先の面の向き（足先の組からの法線）から、胴体の高さと傾きを決める（根の位置・向きを
//   少し補正する。上限：高さ ±0.07、傾き 22°）。異なる高さの足場に立つと自然に傾く。
// - 支え（support）：接地している脚の数・張り付いている面に掛かっている脚の数・脚の伸びを CrabController へ返す。
//   脚が届かない所へ胴体だけが先に進まないよう、伸びきった脚が踏み替えられない間は速さを落とす。壁・天井で掛かっている脚が
//   2 本未満の状態が続いたら、支えを失って離れる（落ちる・沈む）。
// 参考：majidmanzarpour/threejs-procedural-spider（MIT）の、足場を探して踏み替える・となりの脚が踏み替え中は待つ・
// 接地した足先から胴体の面を決める、という考え方（コードは使っていない。このカニの SDF の地形・壁・天井に合わせて作り直した）。

import * as THREE from 'three';
import { CLIMBABLE, type AquariumWorld } from './AquariumWorld';
import { LEGS, legTip } from './crabModel';

type V3 = [number, number, number];

export interface Foot {
  /** 接地している所（世界）・その面の向き・有効か（面の上にある） */
  readonly pos: V3;
  readonly n: V3;
  valid: boolean;
  /** 踏み替え中：元・行き先・行き先の面の向き・進み具合（0..1）・時間 */
  swing: { from: V3; to: V3; n: V3; valid: boolean; t: number; dur: number } | null;
  /** 次の足場の候補（診断の表示用。最後に探した所） */
  readonly next: V3;
  /** 付け根（世界）・脚の届く長さ・いまの伸び（届く長さに対する割合） */
  readonly hip: V3;
  reach: number;
  stretch: number;
  /** 理想の位置（世界）・そこからの距離 */
  readonly home: V3;
  dist: number;
  /** 待機中にずれたままの時間（踏み直し） */
  idleT: number;
  /** 足場の材質 */
  mat: string;
}

/** 左右（右 = sx 1）・前から 0..3 の脚の番号 → 0..7（右 0..3, 左 4..7） */
const legIndex = (sx: 1 | -1, i: number) => (sx === 1 ? 0 : 4) + i;

const PROBE_BUDGET = 4;
/** 足場を探す向き（体の座標：x = 外, y = 上, z = 進む向き） */
const PROBE_DIRS: readonly V3[] = [
  [0, -1, 0],
  [0.55, -0.83, 0],
  [0, -0.75, 0.66],
  [-0.4, -0.9, 0],
  [0, 0, 1],
  [1, 0, 0],
  [0, -0.6, -0.8],
  [0, 1, 0],
  [0.5, 0.86, 0],
];

export class CrabFeet {
  readonly feet: Foot[] = [];
  /** 胴体の補正（根の座標：上へのずれ・傾きの回転） */
  readonly bodyOffset = { up: 0, q: new THREE.Quaternion() };
  /** CrabController へ返す支え：速さに掛ける割合・壁 / 天井で支えを失った */
  support = { speed: 1, lost: false, planted: 8, onClimb: 8, maxStretch: 0 };
  readonly stats = { probes: 0, probeMs: 0, steps: 0, emergency: 0, invalid: 0, slips: 0, frames: 0, ms: 0, maxMs: 0 };
  private lostT = 0;
  private active = false;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly lastRoot = new THREE.Vector3();
  private readonly qT = new THREE.Quaternion();

  constructor(private readonly world: AquariumWorld) {
    for (let k = 0; k < 8; k++) {
      this.feet.push({ pos: [0, 0, 0], n: [0, 1, 0], valid: false, swing: null, next: [0, 0, 0], hip: [0, 0, 0], reach: 0.4, stretch: 0, home: [0, 0, 0], dist: 0, idleT: 0, mat: 'none' });
    }
  }

  /** 次のフレームで全部の脚を足場へ置き直す（瞬間移動・着地・方式の切り替え） */
  reset() {
    this.active = false;
  }

  /** 根の座標の点 → 世界 */
  private toWorld(root: THREE.Matrix4, x: number, y: number, z: number, out: V3): V3 {
    this.v.set(x, y, z).applyMatrix4(root);
    out[0] = this.v.x;
    out[1] = this.v.y;
    out[2] = this.v.z;
    return out;
  }

  /**
   * 1 フレーム進める。root = 根（体の向き・位置。補正の前）、bodyY = 胴体の高さ（根の座標）、
   * vel = カニの速さ（世界）、grounded = 接地 / 張り付いている、climbN = 張り付いている面の向き（張り付いていなければ null）
   */
  update(dt: number, root: THREE.Matrix4, bodyY: number, vel: V3, grounded: boolean, climbN: readonly number[] | null) {
    const t0 = performance.now();
    this.stats.frames++;
    const e = root.elements;
    const up: V3 = [e[4], e[5], e[6]];
    const side: V3 = [e[0], e[1], e[2]];
    const fwd: V3 = [e[8], e[9], e[10]];
    const rp = this.v.set(e[12], e[13], e[14]);
    // 瞬間移動（大きく飛んだ）・空中・水中から戻ったときは、全部置き直す
    if (!grounded) {
      this.active = false;
      for (const f of this.feet) {
        f.valid = false;
        f.swing = null;
      }
      this.support = { speed: 1, lost: false, planted: 0, onClimb: 0, maxStretch: 0 };
      this.relaxBody(dt);
      this.stats.ms = performance.now() - t0;
      return;
    }
    const jumped = rp.distanceTo(this.lastRoot) > 0.6;
    this.lastRoot.copy(rp);
    const speed = Math.hypot(vel[0], vel[1], vel[2]);
    // 進む向き（体の座標の水平）
    const vl = [vel[0] * side[0] + vel[1] * side[1] + vel[2] * side[2], vel[0] * fwd[0] + vel[1] * fwd[1] + vel[2] * fwd[2]];
    // 踏み替えの時間：左右交互の 4 本ずつなので、接地している時間 ≒ 踏み替えの時間。その間に胴体が進む距離が、足先の
    // 動ける幅（理想の位置の前後 0.12 ほど）に収まるよう、速いほど短く（歩き 2.3 / 秒で 0.08 秒、ダッシュ 4.4 / 秒で 0.045 秒）
    const dur = Math.max(0.035, Math.min(0.18, 0.12 / (speed + 0.25)));
    // 先読み：理想の位置より v × 踏み替えの時間だけ前に置き、同じだけ後ろへ過ぎたら踏み替える（接地 ≒ 踏み替えの 2 倍の時間）
    const lead = Math.min(0.16, speed * dur);
    const vlL = Math.hypot(vl[0], vl[1]) || 1;
    const thresh = Math.max(0.045, Math.min(0.3, 2 * speed * dur));
    const lift = 0.045 + Math.min(0.03, speed * 0.008);
    // 付け根・理想の位置
    for (const sx of [1, -1] as const) {
      LEGS.forEach((L, i) => {
        const f = this.feet[legIndex(sx, i)];
        this.toWorld(root, sx * L.hip[0], L.hip[1] + bodyY, L.hip[2], f.hip);
        const tip = legTip(L);
        f.reach = L.l1 + Math.hypot(tip.u, tip.v);
        const hx = sx * L.rest.out + (vl[0] / vlL) * lead, hz = L.rest.fwd + (vl[1] / vlL) * lead;
        this.toWorld(root, hx, 0, hz, f.home);
      });
    }
    let probes = 0;
    const tp = performance.now();
    if (!this.active || jumped) {
      // 全部その場で置く（踏み替えなし）
      for (const f of this.feet) {
        const r = this.probe(f, f.home, up, side, fwd, vl, climbN);
        f.swing = null;
        f.pos.splice(0, 3, ...r.p);
        f.n.splice(0, 3, ...r.n);
        f.valid = r.ok;
        f.mat = r.mat;
        probes++;
      }
      this.active = true;
    }
    // 接地している脚：足場が消えていないか（掘った・崩れた）、伸びすぎていないか、理想から離れすぎていないか
    const want: { k: number; urg: number; emergency: boolean }[] = [];
    let planted = 0, onClimb = 0, maxStretch = 0;
    for (let k = 0; k < 8; k++) {
      const f = this.feet[k];
      if (f.swing) {
        const s = f.swing;
        s.t += dt / s.dur;
        if (s.t >= 1) {
          f.pos.splice(0, 3, ...s.to);
          f.n.splice(0, 3, ...s.n);
          f.valid = s.valid;
          f.swing = null;
        }
        continue;
      }
      // 足場の確かめ：足先の所がもう固体の面でない（空いた）
      if (f.valid && this.world.contactSolid(f.pos[0], f.pos[1], f.pos[2]) > 0.05) {
        f.valid = false;
        this.stats.invalid++;
      }
      f.dist = Math.hypot(f.pos[0] - f.home[0], f.pos[1] - f.home[1], f.pos[2] - f.home[2]);
      f.stretch = Math.hypot(f.pos[0] - f.hip[0], f.pos[1] - f.hip[1], f.pos[2] - f.hip[2]) / f.reach;
      if (f.valid) {
        planted++;
        maxStretch = Math.max(maxStretch, f.stretch);
        if (climbN && f.n[0] * climbN[0] + f.n[1] * climbN[1] + f.n[2] * climbN[2] > 0.3) onClimb++;
      }
      const emergency = !f.valid || f.stretch > 0.92;
      f.idleT = speed < 0.2 && f.dist > 0.035 ? f.idleT + dt : 0;
      if (emergency || f.dist > thresh || f.idleT > 0.35) want.push({ k, urg: emergency ? 10 : f.dist / thresh, emergency });
    }
    // 踏み替えの順番：急ぐ順。となりが踏み替え中なら待つ（急ぎは待たない）。4 本以上は接地させる
    want.sort((a, b) => b.urg - a.urg);
    const swinging = () => this.feet.filter((f) => f.swing).length;
    for (const w of want) {
      if (probes >= PROBE_BUDGET) break;
      const f = this.feet[w.k];
      if (swinging() >= 4) break;
      const nb = this.neighbors(w.k);
      if (!w.emergency && nb.some((j) => this.feet[j].swing)) continue;

      const r = this.probe(f, f.home, up, side, fwd, vl, climbN);
      probes++;
      f.next.splice(0, 3, ...r.p);
      // 行き先が今と変わらない（届く足場が無く、同じ所しか無い）なら踏み替えない
      if (r.ok && Math.hypot(r.p[0] - f.pos[0], r.p[1] - f.pos[1], r.p[2] - f.pos[2]) < 0.015) continue;
      const from: V3 = [...f.pos];
      // 足場が無い脚は宙に浮かせる（理想の位置へ運ぶ）
      f.swing = { from, to: r.p, n: r.n, valid: r.ok, t: 0, dur: w.emergency && !f.valid ? dur * 0.8 : dur };
      f.valid = false;
      f.mat = r.mat;
      this.stats.steps++;
      if (w.emergency) this.stats.emergency++;
    }
    this.stats.probes += probes;
    this.stats.probeMs = performance.now() - tp;
    // 踏み替え中の足先の位置（面の外向きへ持ち上げる）
    for (const f of this.feet) {
      const s = f.swing;
      if (!s) continue;
      const u = Math.min(1, s.t), a = u * u * (3 - 2 * u);
      const h = Math.sin(Math.PI * u) * lift;
      for (let j = 0; j < 3; j++) f.pos[j] = s.from[j] + (s.to[j] - s.from[j]) * a + up[j] * h;
    }
    // 支え：脚が伸びきっているのに踏み替えられない間は速さを落とす（胴体だけ先へ行かない）
    const speedK = Math.max(0.5, Math.min(1, 1 - (maxStretch - 1.0) * 4));
    const few = planted + this.feet.filter((f) => f.swing).length < 3 ? 0.6 : 1;
    // 壁・天井：掛かっている脚が 2 本未満の状態が続くと、支えを失う
    this.lostT = climbN && onClimb < 2 ? this.lostT + dt : 0;
    this.support = { speed: speedK * few, lost: this.lostT > 0.8, planted, onClimb, maxStretch };
    this.bodyPose(dt, root, up, side, fwd);
    const ms = performance.now() - t0;
    this.stats.ms = ms;
    this.stats.maxMs = Math.max(this.stats.maxMs * 0.995, ms);
  }

  /** となりの脚（同じ側の前後・反対側の同じ番号） */
  private neighbors(k: number): number[] {
    const side = k < 4 ? 0 : 4, i = k % 4, out: number[] = [];
    if (i > 0) out.push(side + i - 1);
    if (i < 3) out.push(side + i + 1);
    out.push((side === 0 ? 4 : 0) + i);
    return out;
  }

  /**
   * 足場を探す：理想の位置の少し上（体の上）から、向きを変えて最初の面を探す。
   * 戻り値 p = 足場（見つからなければ理想の位置）、n = 面の向き、ok = 有効な足場か
   */
  private probe(f: Foot, home: V3, up: V3, side: V3, fwd: V3, vl: number[], climbN: readonly number[] | null): { p: V3; n: V3; ok: boolean; mat: string } {
    const w = this.world;
    const t0 = performance.now();
    // 外向き（脚の側）：付け根から理想の位置への水平（体の座標）
    const ox = home[0] - f.hip[0], oy = home[1] - f.hip[1], oz = home[2] - f.hip[2];
    const od = ox * up[0] + oy * up[1] + oz * up[2];
    let out: V3 = [ox - up[0] * od, oy - up[1] * od, oz - up[2] * od];
    const ol = Math.hypot(...out) || 1;
    out = [out[0] / ol, out[1] / ol, out[2] / ol];
    // 進む向き（体の座標の水平。止まっているときは体の前）
    const vL = Math.hypot(vl[0], vl[1]);
    const mv: V3 = vL > 0.1 ? [side[0] * vl[0] / vL + fwd[0] * vl[1] / vL, side[1] * vl[0] / vL + fwd[1] * vl[1] / vL, side[2] * vl[0] / vL + fwd[2] * vl[1] / vL] : [fwd[0], fwd[1], fwd[2]];
    const start: V3 = [home[0] + up[0] * 0.16, home[1] + up[1] * 0.16, home[2] + up[2] * 0.16];
    let best: { p: V3; n: V3; ok: boolean; mat: string; score: number } | null = null;
    // 始めの所が固体の中（体が面にめり込んでいる・段差の中）なら、体の上の向きへ出るまで上げる
    for (let k = 0; k < 6 && w.contactSolid(start[0], start[1], start[2]) < 0; k++) for (let j = 0; j < 3; j++) start[j] += up[j] * 0.05;
    for (const d of PROBE_DIRS) {
      const dir: V3 = [out[0] * d[0] + up[0] * d[1] + mv[0] * d[2], out[1] * d[0] + up[1] * d[1] + mv[1] * d[2], out[2] * d[0] + up[2] * d[1] + mv[2] * d[2]];
      const dl = Math.hypot(...dir) || 1;
      for (let j = 0; j < 3; j++) dir[j] /= dl;
      // 距離関数を進める（最大 0.5）
      let s = 0, hit = -1;
      let prev = w.contactSolid(start[0], start[1], start[2]);
      if (prev <= 0) continue;
      while (s < 0.5) {
        const st = Math.max(0.012, Math.min(0.05, prev * 0.9));
        s += st;
        const q = w.contactSolid(start[0] + dir[0] * s, start[1] + dir[1] * s, start[2] + dir[2] * s);
        if (q <= 0) {
          // 二分して面の上へ
          let lo = s - st, hi = s;
          for (let b = 0; b < 5; b++) {
            const mid = (lo + hi) / 2;
            if (w.contactSolid(start[0] + dir[0] * mid, start[1] + dir[1] * mid, start[2] + dir[2] * mid) > 0) lo = mid;
            else hi = mid;
          }
          hit = lo;
          break;
        }
        prev = q;
      }
      if (hit < 0) continue;
      const p: V3 = [start[0] + dir[0] * hit, start[1] + dir[1] * hit, start[2] + dir[2] * hit];
      const n = w.contactNormal(p[0], p[1], p[2]);
      const nl = Math.hypot(...n) || 1;
      const nn: V3 = [n[0] / nl, n[1] / nl, n[2] / nl];
      const mat = w.surfaceMaterial(p[0] - nn[0] * 0.02, p[1] - nn[1] * 0.02, p[2] - nn[2] * 0.02);
      // 床（上向き）ならどの材質でも立てる。壁・天井は登れる材質だけ
      const floorLike = nn[1] > 0.55;
      if (!floorLike && !CLIMBABLE.has(mat)) continue;
      const reachD = Math.hypot(p[0] - f.hip[0], p[1] - f.hip[1], p[2] - f.hip[2]);
      if (reachD > f.reach * 0.98 || reachD < 0.1) continue;
      const far = Math.hypot(p[0] - home[0], p[1] - home[1], p[2] - home[2]);
      if (far > 0.33) continue;
      // 体の上と反対を向いた面（体の真下でない天井など）は、張り付いている面と合うときだけ
      const face = nn[0] * up[0] + nn[1] * up[1] + nn[2] * up[2];
      const climbFace = climbN ? nn[0] * climbN[0] + nn[1] * climbN[1] + nn[2] * climbN[2] : face;
      if (face < -0.35 && climbFace < 0.3) continue;
      const score = far + 0.18 * (1 - Math.max(face, climbFace));
      if (!best || score < best.score) best = { p, n: nn, ok: true, mat, score };
      if (score < 0.05) break;
    }
    this.stats.probeMs += performance.now() - t0;
    if (best) return best;
    return { p: [...home], n: [up[0], up[1], up[2]], ok: false, mat: 'none' };
  }

  /**
   * 胴体の高さと傾き：接地している足先の重心（体の上の向きの成分）と、足先の組からの面の向き。根の座標で、上へのずれと
   * 回転の補正を平滑化して持つ（CrabRig が根に掛ける）
   */
  private bodyPose(dt: number, root: THREE.Matrix4, up: V3, side: V3, fwd: V3) {
    const P = this.feet.filter((f) => f.valid && !f.swing).map((f) => f.pos);
    if (P.length < 3) return this.relaxBody(dt);
    const e = root.elements;
    let cx = 0, cy = 0, cz = 0;
    for (const p of P) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    cx /= P.length;
    cy /= P.length;
    cz /= P.length;
    // 根から見た足先の重心の高さ（体の上の向き）
    const h = (cx - e[12]) * up[0] + (cy - e[13]) * up[1] + (cz - e[14]) * up[2];
    // 面の向き（Newell の方法：足先を体の座標の角度の順に並べた多角形の法線）
    const ang = P.map((p) => {
      const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
      return Math.atan2(dx * side[0] + dy * side[1] + dz * side[2], dx * fwd[0] + dy * fwd[1] + dz * fwd[2]);
    });
    const ord = P.map((_, i) => i).sort((a, b) => ang[a] - ang[b]);
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < ord.length; k++) {
      const a = P[ord[k]], b = P[ord[(k + 1) % ord.length]];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-6) return this.relaxBody(dt);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    if (nx * up[0] + ny * up[1] + nz * up[2] < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    // 体の上と足先の面の間を半分（傾きの上限 22°）
    const mx = up[0] + nx, my = up[1] + ny, mz = up[2] + nz;
    nl = Math.hypot(mx, my, mz) || 1;
    // 根の座標での回転（世界の up → mix）
    const inv = this.m.copy(root).invert();
    const a = new THREE.Vector3(up[0], up[1], up[2]).transformDirection(inv);
    const b = new THREE.Vector3(mx / nl, my / nl, mz / nl).transformDirection(inv);
    const ang2 = Math.min(a.angleTo(b), (22 * Math.PI) / 180);
    const axis = new THREE.Vector3().crossVectors(a, b);
    if (axis.lengthSq() > 1e-10) this.qT.setFromAxisAngle(axis.normalize(), ang2);
    else this.qT.identity();
    const k = 1 - Math.exp(-dt * 8);
    this.bodyOffset.q.slerp(this.qT, k);
    this.bodyOffset.up += (Math.max(-0.07, Math.min(0.06, h)) - this.bodyOffset.up) * k;
  }

  private relaxBody(dt: number) {
    const k = 1 - Math.exp(-dt * 6);
    this.bodyOffset.q.slerp(this.qT.identity(), k);
    this.bodyOffset.up += (0 - this.bodyOffset.up) * k;
  }
}
