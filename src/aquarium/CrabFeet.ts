// 接地 IK とプロシージャル歩行（第 4 段階）。8 本の歩脚それぞれが、地形（AquariumWorld の contactSolid / contactNormal /
// surfaceMaterial）の上に実際の足場を探して足先を置き、置いた足先は世界に固定する（胴体が動いても滑らない）。
// 脚が伸びすぎる・理想の位置から離れすぎる・足場が消えた（掘った）・足場が登れない材質の壁になった、で次の足場へ踏み替える。
//
// - 足場の探し方（probe）：脚の理想の位置（体の座標の休みの位置 + 進む向きへの先読み）の少し上（体の上の向き）から、
//   真下・斜め下（外へ / 進む向きへ）・進む向き（壁）・外向き・上（張り出し・天井）の順に、距離関数を少しずつ進めて最初の面を探し、
//   二分して面の上に置く。面の向き・脚の届く範囲（付け根から l1 + 下の節）・理想の位置からの距離・材質で評価し、点の最も良いものを選ぶ。
//   床（上向きの面）ならどの材質でも立てる。壁・天井は登れる材質（砂・土・岩・流木）だけ（ガラス・管は従来どおり掛けられない）。
// - 踏み替えの順番（第 6 段階で作り直し。GAIT の説明）：歩いている・体を回している間は、歩行の周期の位相で左右交互の 4 本ずつ
//   （右 1・左 2・右 3・左 4 と、その逆）が半周期ごとに踏み替える。止まっている間は、止まった直後に 1 回だけ踏ん張り直し、
//   その後は大きくずれたときだけ（ヒステリシス・踏み替えの後の待ち・足場が見つからないときの待ち）。止まっている間は、となりの脚
//   （同じ側の前後・反対側の同じ脚）が踏み替え中なら待つ（伸びすぎ・足場が消えた、の急ぎは待たない）。足場を探すのは 1 フレーム 4 本まで
//   （iPhone で探す処理をフレームに分ける）。
// - 踏み替えの軌道：前の足場から次の足場へ、ゆっくり加速・減速しながら運び、その間は面の外向き（体の上）へ持ち上げる（sin）。
//   踏み替えの時間は 歩幅 / 速さ（歩き約 0.1 秒・ダッシュ約 0.08 秒。止まっている間の踏ん張り直しは 0.16 秒以上でゆっくり）。
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
  /** 次に（急ぎでなく）踏み替えられるまでの時間（踏み替えたばかりの脚は少し待つ） */
  cool: number;
  /** 足場が見つからなかった：次に探すまでの時間・続けて見つからなかった回数（待つ時間を倍にしていく） */
  failT: number;
  failN: number;
  /** 止まってから踏ん張り直したか（1 回の停止で 1 回だけ） */
  settled: boolean;
  /** 踏み替える番が来た（歩行の周期のその組の番。探すのが次のフレームへ回ったときも残る） */
  want: boolean;
  /** 足場が無く、宙で構えている（同じ所へ何度も運ばない） */
  hang: boolean;
}

/** 左右（右 = sx 1）・前から 0..3 の脚の番号 → 0..7（右 0..3, 左 4..7） */
const legIndex = (sx: 1 | -1, i: number) => (sx === 1 ? 0 : 4) + i;

const PROBE_BUDGET = 4;

/**
 * 歩き方（第 6 段階：iPhone の確認から。踏み替えが速すぎる・静止中も小刻みに踏み替え続ける・足先が浮く、への対応）。
 * - 歩行の周期：左右交互の 4 本ずつ（右 1・左 2・右 3・左 4 の組と、その逆の組）が、半周期ずつ交互に踏み替える（位相 phase で
 *   決める。カニらしい揃ったリズム）。1 回の接地の間に胴体が進む距離（歩幅 S）を速さで伸ばし、踏み替えの時間 = S / 速さ
 *   （歩き 2.3 / 秒で約 0.1 秒・約 5 歩 / 秒、ダッシュ 4.4 / 秒で約 0.08 秒。以前は歩きで 0.047 秒だった）。
 * - 止まっている間：止まってから settleDelay 後に 1 回だけ、理想の位置から settleTol より離れた脚を組ごとに踏ん張り直す。
 *   その後は idleTol（> settleTol：ヒステリシス）より離れる・伸びきる・足場が消えるまで踏み替えない。踏み替えた脚は
 *   cooldown の間は（急ぎでなければ）踏み替えない
 * - 足場が見つからない：その脚は failT の間は探さない（続けて見つからなければ倍にする）。足場がある脚はそのまま立ち、
 *   足場の無い脚は宙で構える（同じ無効な所へ何度も運ばない）
 * - 接地している足先は毎フレーム地形の面へ寄せる（浮き・めり込みを直す。消えた足場は踏み替える）
 */
const GAIT = {
  strideMin: 0.15,
  strideK: 0.032,
  strideMax: 0.36,
  swingMin: 0.075,
  swingMax: 0.2,
  /** 動いているとみなす速さ・体の向きの回る速さ（rad / 秒） */
  moveV: 0.18,
  moveW: 0.8,
  /** 体を回すときの、足先の回る半径（回る速さ × これ = 足先の速さ） */
  turnR: 0.42,
  settleDelay: 0.18,
  settleTol: 0.06,
  idleTol: 0.13,
  cooldown: 0.35,
  failWait: 0.3,
  failWaitMax: 1.6,
  /** 足先を面へ寄せる：これより離れて・めり込んでいたら寄せる。これより離れたら足場が消えた */
  snapTol: 0.004,
  lostTol: 0.05,
} as const;

/** 歩行の周期の組（0 = 右 1・右 3・左 2・左 4、1 = その逆） */
const groupOf = (k: number) => ((k % 4) + (k < 4 ? 0 : 1)) % 2;
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
  /**
   * 数え（検証用）：idleSteps = 止まって踏ん張り直した後の踏み替え（ふつうは 0 に近いはず）・settleSteps = 止まった直後の踏ん張り直し・
   * probeFail = 足場が見つからなかった回数・snaps = 足先を面へ寄せた回数・gapMax / gapSum / gapN = 接地している足先と面の距離
   */
  readonly stats = { probes: 0, probeMs: 0, steps: 0, emergency: 0, invalid: 0, slips: 0, frames: 0, ms: 0, maxMs: 0, idleSteps: 0, settleSteps: 0, probeFail: 0, snaps: 0, gapMax: 0, gapSum: 0, gapN: 0 };
  /** 歩行の周期の位相（0..1 で 1 周期。半周期ごとに組が替わる）と、止まっている時間・動いているか */
  phase = 0;
  private half = -1;
  stillT = 0;
  moving = false;
  private lostT = 0;
  private active = false;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly lastRoot = new THREE.Vector3();
  private readonly lastFwd: V3 = [0, 0, 1];
  private readonly qT = new THREE.Quaternion();

  constructor(private readonly world: AquariumWorld) {
    for (let k = 0; k < 8; k++) {
      this.feet.push({ pos: [0, 0, 0], n: [0, 1, 0], valid: false, swing: null, next: [0, 0, 0], hip: [0, 0, 0], reach: 0.4, stretch: 0, home: [0, 0, 0], dist: 0, idleT: 0, mat: 'none', cool: 0, failT: 0, failN: 0, settled: false, want: false, hang: false });
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
    // 進む向き（体の座標の水平）と、面に沿った速さ（体の上の向きの成分は除く：段差を上り下りしても歩幅は変えない）
    const vl = [vel[0] * side[0] + vel[1] * side[1] + vel[2] * side[2], vel[0] * fwd[0] + vel[1] * fwd[1] + vel[2] * fwd[2]];
    const speed = Math.hypot(vl[0], vl[1]);
    // 体の向きの回る速さ（前の向きの、体の上のまわりの角度）
    const cr = this.lastFwd[0] * fwd[0] + this.lastFwd[1] * fwd[1] + this.lastFwd[2] * fwd[2];
    const cx = this.lastFwd[1] * fwd[2] - this.lastFwd[2] * fwd[1], cy = this.lastFwd[2] * fwd[0] - this.lastFwd[0] * fwd[2], cz = this.lastFwd[0] * fwd[1] - this.lastFwd[1] * fwd[0];
    const turn = dt > 0 ? Math.atan2(cx * up[0] + cy * up[1] + cz * up[2], cr) / dt : 0;
    this.lastFwd.splice(0, 3, fwd[0], fwd[1], fwd[2]);
    // 動いているか（歩く・体を回す）。足先の速さ：歩く速さと、回るときの足先の速さの大きい方
    const veff = Math.max(speed, Math.abs(turn) * GAIT.turnR);
    this.moving = speed > GAIT.moveV || Math.abs(turn) > GAIT.moveW;
    // 歩幅と踏み替えの時間（左右交互の 4 本ずつ：接地している時間 = 踏み替えの時間 = 半周期）。踏み替えが速くなりすぎるときは
    // 歩幅の方を伸ばす（ダッシュで脚が細かく震えない）
    let S = Math.min(GAIT.strideMax, GAIT.strideMin + GAIT.strideK * veff);
    S = Math.min(GAIT.strideMax, Math.max(S, veff * GAIT.swingMin));
    const dur = Math.max(GAIT.swingMin, Math.min(GAIT.swingMax, veff > 1e-3 ? (S / veff) * 0.92 : GAIT.swingMax));
    // 先読み：踏み替えを始める時に探す所は、理想の位置（休みの位置）より、踏み替えの間に胴体が進む分 + 接地の間に進む分の半分だけ前
    // （= 接地の間、足先が理想の位置の前後に同じだけ振れる）。止まっている間は 0
    const T = veff > 1e-3 ? (2 * S) / veff : 1;
    const lead = this.moving ? Math.min(S * 1.6, speed * (T + dur) * 0.5) : 0;
    const vlL = Math.hypot(vl[0], vl[1]) || 1;
    const leadW: V3 = [0, 0, 0];
    for (let j = 0; j < 3; j++) leadW[j] = (side[j] * vl[0] + fwd[j] * vl[1]) / vlL * lead;
    const lift = 0.04 + Math.min(0.035, speed * 0.008);
    // 付け根・理想の位置（休みの位置。先読みは探すときだけ足す）
    for (const sx of [1, -1] as const) {
      LEGS.forEach((L, i) => {
        const f = this.feet[legIndex(sx, i)];
        this.toWorld(root, sx * L.hip[0], L.hip[1] + bodyY, L.hip[2], f.hip);
        const tip = legTip(L);
        f.reach = L.l1 + Math.hypot(tip.u, tip.v);
        this.toWorld(root, sx * L.rest.out, 0, L.rest.fwd, f.home);
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
        f.cool = f.failT = f.failN = 0;
        f.hang = !r.ok;
        f.want = false;
        f.settled = true;
        probes++;
      }
      this.active = true;
      this.half = -1;
    }
    // 歩行の周期：動いている間だけ位相を進め、半周期が替わったら、その組の脚に番を出す
    if (this.moving) {
      this.stillT = 0;
      this.phase = (this.phase + (veff * dt) / (2 * S)) % 1;
      const h = Math.floor(this.phase * 2);
      if (h !== this.half) {
        this.half = h;
        for (let k = 0; k < 8; k++) if (groupOf(k) === h) this.feet[k].want = true;
      }
      for (const f of this.feet) f.settled = false;
    } else {
      this.stillT += dt;
      this.half = -1;
      // （止まったら、歩いている間の番は捨てる。踏ん張り直しは下で）
      for (const f of this.feet) f.want = false;
    }
    const settling = !this.moving && this.stillT > GAIT.settleDelay;
    // 接地している脚：面へ寄せる・足場が消えていないか（掘った・崩れた）・伸びすぎていないか・理想から離れすぎていないか
    const want: { k: number; urg: number; emergency: boolean; settle: boolean }[] = [];
    let planted = 0, onClimb = 0, maxStretch = 0;
    for (let k = 0; k < 8; k++) {
      const f = this.feet[k];
      f.cool = Math.max(0, f.cool - dt);
      f.failT = Math.max(0, f.failT - dt);
      if (f.swing) {
        const s = f.swing;
        s.t += dt / s.dur;
        if (s.t >= 1) {
          f.pos.splice(0, 3, ...s.to);
          f.n.splice(0, 3, ...s.n);
          f.valid = s.valid;
          f.swing = null;
          f.cool = GAIT.cooldown;
        }
        continue;
      }
      if (f.valid) {
        // 足場の確かめ：足先の所がもう固体の面でない（空いた）。少しだけ浮いた・めり込んだ（盛った・崩れた・二分の誤差）なら面へ寄せる
        const d = this.world.contactSolid(f.pos[0], f.pos[1], f.pos[2]);
        if (d > GAIT.lostTol) {
          f.valid = false;
          f.hang = false;
          this.stats.invalid++;
        } else {
          if (Math.abs(d) > GAIT.snapTol) {
            const n = this.world.contactNormal(f.pos[0], f.pos[1], f.pos[2]);
            const nl = Math.hypot(n[0], n[1], n[2]) || 1;
            for (let j = 0; j < 3; j++) f.pos[j] -= (n[j] / nl) * (d - 0.001);
            this.stats.snaps++;
          }
          const g = Math.abs(this.world.contactSolid(f.pos[0], f.pos[1], f.pos[2]));
          this.stats.gapMax = Math.max(this.stats.gapMax, g);
          this.stats.gapSum += g;
          this.stats.gapN++;
        }
      }
      f.dist = Math.hypot(f.pos[0] - f.home[0], f.pos[1] - f.home[1], f.pos[2] - f.home[2]);
      f.stretch = Math.hypot(f.pos[0] - f.hip[0], f.pos[1] - f.hip[1], f.pos[2] - f.hip[2]) / f.reach;
      if (f.valid) {
        planted++;
        maxStretch = Math.max(maxStretch, f.stretch);
        if (climbN && f.n[0] * climbN[0] + f.n[1] * climbN[1] + f.n[2] * climbN[2] > 0.3) onClimb++;
      }
      // 急ぎ：伸びきった・足場が無い（足場が無い脚は、探し直す時間が来たら）
      // （足場が見つからずに待っている間でも、伸びきりを越えた脚・体から離れて宙に残った脚は待たない：脚が胴体に置いていかれない）
      const emergency = f.valid ? f.stretch > 0.95 && (f.failT <= 0 || f.stretch > 1.02) : (!f.hang && f.failT <= 0) || f.dist > 0.2;
      f.idleT = !this.moving && f.dist > GAIT.settleTol ? f.idleT + dt : 0;
      if (emergency) {
        want.push({ k, urg: 10, emergency: true, settle: false });
        continue;
      }
      if (f.failT > 0) continue;
      if (this.moving) {
        // 歩いている：その組の番が来た脚（行き先と今の所がほとんど同じなら、踏み替えずに番を終える：下の probe の後）
        if (f.want) want.push({ k, urg: 1 + f.dist, emergency: false, settle: false });
        else if (f.dist > S * 0.8 + 0.08) want.push({ k, urg: 5, emergency: false, settle: false });
      } else if (settling && !f.settled && f.dist > GAIT.settleTol && f.cool <= 0) {
        // 止まった：1 回だけ踏ん張り直す
        want.push({ k, urg: 1 + f.dist, emergency: false, settle: true });
      } else if (f.dist > GAIT.idleTol && f.cool <= 0) {
        // 止まっている：大きくずれたときだけ（体を傾けた・押された・足場が少し崩れた）
        want.push({ k, urg: 2 + f.dist, emergency: false, settle: false });
      }
    }
    // 止まった後の踏ん張り直しは、この時点で 1 回きり（踏み替えなかった脚も、次に止まるまでしない）
    // （ずれていない脚だけ済みにする。踏み替えた直後で待っている脚・となりを待っている脚は、待ちが明けてから踏ん張り直す）
    if (settling) for (const f of this.feet) if (!f.swing && f.valid && f.dist <= GAIT.settleTol) f.settled = true;
    // 踏み替えの順番：急ぐ順。歩いている間は組ごとなので、となりを待たない。止まっている間は、となりが踏み替え中なら待つ
    // （急ぎは待たない）。4 本より多くは同時に上げない
    want.sort((a, b) => b.urg - a.urg);
    const swinging = () => this.feet.filter((f) => f.swing).length;
    for (const w of want) {
      if (probes >= PROBE_BUDGET) break;
      const f = this.feet[w.k];
      if (swinging() >= 4 && !w.emergency) break;
      if (!this.moving && !w.emergency && this.neighbors(w.k).some((j) => this.feet[j].swing)) continue;

      // 探す所：歩いている間は先読みの分だけ前（止まっている・急ぎで止まっているときは理想の位置）
      const target: V3 = this.moving ? [f.home[0] + leadW[0], f.home[1] + leadW[1], f.home[2] + leadW[2]] : f.home;
      const r = this.probe(f, target, up, side, fwd, vl, climbN);
      probes++;
      f.want = false;
      if (w.settle) f.settled = true;
      f.next.splice(0, 3, ...r.p);
      if (!r.ok) {
        // 足場が見つからない：しばらく探さない（続けば倍）。足場のある脚はそのまま立つ。足場の無い脚は、理想の位置の少し下で
        // 宙に構える（もう構えている所の近くなら運ばない：同じ無効な所へ何度も運ばない）
        this.stats.probeFail++;
        f.failN++;
        f.failT = Math.min(GAIT.failWaitMax, GAIT.failWait * 2 ** (f.failN - 1));
        // 足場のある脚は、伸びきっていなければそのまま立つ（伸びきった脚は足場を離れて宙に構える）
        if (f.valid && f.stretch <= 1.0) continue;
        const hang: V3 = [f.home[0] - up[0] * 0.04, f.home[1] - up[1] * 0.04, f.home[2] - up[2] * 0.04];
        f.hang = true;
        if (Math.hypot(hang[0] - f.pos[0], hang[1] - f.pos[1], hang[2] - f.pos[2]) < 0.04) continue;
        f.swing = { from: [...f.pos], to: hang, n: [up[0], up[1], up[2]], valid: false, t: 0, dur: dur * 1.2 };
        f.mat = 'none';
        this.stats.steps++;
        continue;
      }
      f.failN = 0;
      f.hang = false;
      // 行き先が今と変わらないなら踏み替えない
      if (f.valid && Math.hypot(r.p[0] - f.pos[0], r.p[1] - f.pos[1], r.p[2] - f.pos[2]) < 0.025) continue;
      const from: V3 = [...f.pos];
      f.swing = { from, to: r.p, n: r.n, valid: true, t: 0, dur: w.emergency && !f.valid ? dur * 0.8 : w.settle || !this.moving ? Math.max(dur, 0.16) : dur };
      f.valid = false;
      f.mat = r.mat;
      this.stats.steps++;
      if (w.emergency) this.stats.emergency++;
      if (!this.moving) {
        if (w.settle) this.stats.settleSteps++;
        else if (this.stillT > GAIT.settleDelay + 0.4) this.stats.idleSteps++;
      }
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
