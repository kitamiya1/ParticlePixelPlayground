// ハサミ集中モード（2026-11-28）：カニはその場に留まり、左右の腕を独立して自由に動かす。腕の移動と鋏の開閉は別の入力。
// 積み木・組み立て・引き裂き・物理パズルの土台になる遊び（docs/aquarium/claw-focus/report.md）。
//
// - 鋏の目標（世界の点）を左右それぞれ持ち、毎フレーム入力で動かして CrabRig.focusR / focusL へ書く（構え = ばねの目標が
//   そこへ寄る。鋏の IK はつかみ点・目標を速さの上限つきで追う）。開閉は GrabSystem.squeeze（集中モードの GrabSystem は開閉を
//   連続で扱う）。
// - 腕の動かし方（scheme。比べられる）：
//   surface = 面に沿う（既定）：スティックはカメラから見た床の向き（前後左右）に動かし、高さは鋏の下の面（地形・箱。挟んでいる物は
//             除く）の上に自動で保つ。挟んだ物の下の端が面に当たらない高さ + 手で足した高さ（バンパー + スティックの上下・Q / E）
//   ground  = 床に沿う + 高さは手で：前後左右は surface と同じ、高さは手で上げ下げするだけ（面より下へは行かない）
//   screen  = 画面に沿う：スティックの上下左右 = 画面の上下左右。奥行きは手で（バンパー + スティックの上下・Q / E）
// - 届く範囲：鋏の付け根から腕の長さ（ARM_REACH × 大きさ）まで。体の中・もう片方の鋏の所・地形の中には入れない（面に触れたら止まる）。
//   挟んでいる間は、目標をつかみ点から LEAD 以内に留める（物が岩・箱に当たって止まれば、鋏もそこで止まる。押し続けても腕が
//   物から離れていかない＝ばねの力は約 LEAD × ばねの強さで頭打ち）。
// - 入る・戻る：目標はいまの構えから始め、重み w を約 0.25 秒で 0 ↔ 1 にする（腕も物も瞬間移動しない）。挟んでいる物は
//   GrabSystem.setMode が新しいモードで押し直すまで持ったままにする。カメラは作業している所（両方の鋏の間）へ注視点を寄せ、
//   近く・少し上から見る（触っていなければ）。戻るときは入る前の距離・角度へ戻す。
// - 印（ClawMarks）：鋏の先（右 = 橙・左 = 水色）・鋏の下の面の影と高さの線・いま閉じると挟む物の点（挟んでいる間はつかみ点）。

import { clamp } from '../core/math';
import { ARM_REACH, type GrabSystem, type Prop, type PropSystem } from './AquaGrab';
import type { AquaCamera } from './AquaCamera';
import type { AquariumWorld } from './AquariumWorld';
import type { CrabController } from './CrabController';
import type { CrabRig } from './CrabRig';
import { CLAWS } from './crabModel';
import type { Input } from '../game/Input';

export type FocusScheme = 'surface' | 'ground' | 'screen';
export const FOCUS_SCHEMES: FocusScheme[] = ['surface', 'ground', 'screen'];
export const FOCUS_SCHEME_LABEL: Record<FocusScheme, string> = { surface: '面に沿う', ground: '床に沿う＋高さ', screen: '画面に沿う' };

type V3 = [number, number, number];

/** 鋏 1 本の、このフレームの入力 */
export interface ClawCtl {
  /** スティック（−1..1。x = 右, y = 前（screen では上））。速さ = SPEED × 倒した量 */
  mx: number;
  my: number;
  /** マウスの動き（CSS px。x = 右, y = 下） */
  dx: number;
  dy: number;
  /** 高さ（screen では奥行き）の速さ（−1..1）と、マウスで動かした量（px。上 = −） */
  lift: number;
  liftD: number;
  /** 手首のひねりの速さ（−1..1） */
  roll: number;
  /** 閉じる量（0 = 開く … 1 = 閉じきる。物に触れた後は握る強さ） */
  close: number;
}

export const emptyCtl = (): ClawCtl => ({ mx: 0, my: 0, dx: 0, dy: 0, lift: 0, liftD: 0, roll: 0, close: 0 });

/** スティックを倒しきったときの鋏の速さ（m / 秒）・マウス 1 px あたりの動き（m）・ひねりの速さ（rad / 秒） */
const SPEED = 0.34;
const MOUSE_K = 0.0011;
const ROLL_SPEED = 2.2;
/** 面からの高さ（surface の最低限）・挟んでいる間に目標をつかみ点から離せる距離・鋏どうしの最小の間 */
const HOVER = 0.025;
const LEAD = 0.07;
const CLAW_GAP = 0.075;
/** 集中モードのカメラ（触っていなければ寄せる距離・仰角） */
const CAM_ZOOM = 1.75;
const CAM_PITCH = 0.62;

interface Side {
  key: 'R' | 'L';
  p: V3;
  /** 自動の高さに足した量（surface）・奥行き（screen） */
  lift: number;
  roll: number;
  /** 鋏の下の面の高さ（印に使う） */
  floor: number;
}

export class ClawFocus {
  on = false;
  /** 集中モードへ寄せている割合（0..1） */
  w = 0;
  scheme: FocusScheme = 'surface';
  readonly R: Side = { key: 'R', p: [0, 0, 0], lift: 0, roll: 0, floor: 0 };
  readonly L: Side = { key: 'L', p: [0, 0, 0], lift: 0, roll: 0, floor: 0 };
  /** 入る前のカメラ（戻す先）と、入ってから / 戻ってからの時間・カメラを触ったか */
  private saved: { zoom: number; pitch: number } | null = null;
  private camT = 0;
  private camTouched = false;
  private restore: { zoom: number; pitch: number } | null = null;
  readonly stats = { enters: 0, exits: 0, clampReach: 0, clampSolid: 0, clampLead: 0, pushApart: 0 };

  constructor(
    private readonly world: AquariumWorld,
    private readonly props: PropSystem,
    private readonly rig: CrabRig,
    private readonly crab: CrabController,
    private readonly camera: AquaCamera,
    private readonly grabR: GrabSystem,
    private readonly grabL: GrabSystem,
  ) {}

  /** 集中モードへ入る・戻る（挟んでいる物は手放さない：GrabSystem.setMode） */
  set(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.grabR.setMode(on);
    this.grabL.setMode(on);
    const A = this.camera.adventure;
    if (on) {
      this.stats.enters++;
      // 目標はいまの構え（挟んでいればつかみ点）から始める
      for (const S of [this.R, this.L]) {
        const G = S.key === 'R' ? this.grabR : this.grabL;
        const g = G.gripAt();
        const a = S.key === 'R' ? this.rig.anchor : this.rig.anchorL;
        const src = g ?? a;
        S.p = [src[0], src[1], src[2]];
        S.roll = 0;
        S.lift = 0;
        S.floor = this.floorBelow(S.p, [G.holding]);
        if (this.scheme === 'surface') S.lift = Math.max(0, S.p[1] - (S.floor + this.hover(G)));
        if (this.scheme === 'screen') S.lift = 0;
      }
      this.saved = this.restore ?? { zoom: A.zoom, pitch: A.pitch };
      this.restore = null;
    } else {
      this.stats.exits++;
      this.restore = this.saved;
      this.saved = null;
    }
    this.camT = 0;
    this.camTouched = false;
  }

  toggle() {
    this.set(!this.on);
  }

  cycleScheme(dir = 1): FocusScheme {
    const k = FOCUS_SCHEMES.indexOf(this.scheme);
    this.setScheme(FOCUS_SCHEMES[(k + dir + FOCUS_SCHEMES.length) % FOCUS_SCHEMES.length]);
    return this.scheme;
  }

  /** 方式を変える：目標の位置はそのまま（高さの足し分を、いまの位置に合わせて決め直す） */
  setScheme(s: FocusScheme) {
    if (s === this.scheme) return;
    this.scheme = s;
    for (const S of [this.R, this.L]) {
      const G = S.key === 'R' ? this.grabR : this.grabL;
      S.floor = this.floorBelow(S.p, [G.holding]);
      S.lift = s === 'surface' ? Math.max(0, S.p[1] - (S.floor + this.hover(G))) : 0;
    }
  }

  /** 鋏の下の面の高さ（地形・箱。skip = 挟んでいる物：自分の持つ箱の上へ鋏が上っていかない） */
  private floorBelow(p: readonly number[], skip: (Prop | null)[]): number {
    return this.props.surfaceBelow(p[0], p[1] + 0.05, p[2], skip);
  }

  /** 面からの高さ：挟んでいる物の下の端が面に当たらない高さ（つかみ点から物の下の端まで）+ 少し */
  private hover(G: GrabSystem): number {
    const pr = G.holding;
    if (pr) {
      const g = G.gripAt();
      const low = this.props.lowest(pr);
      return HOVER + (g ? Math.max(0, g[1] - low) : pr.rb);
    }
    if (G.holdingCreature) return HOVER + 0.03;
    return HOVER;
  }

  /**
   * 1 フレーム（カニの姿勢を決めた後・鋏の構えを決める前）。cR / cL = 右 / 左の鋏の入力。
   * input = 視点の操作を触ったかを見る（カメラを寄せるのをやめる）
   */
  update(dt: number, cR: ClawCtl, cL: ClawCtl, input: Input) {
    const target = this.on ? 1 : 0;
    this.w += (target - this.w) * (1 - Math.exp(-dt * 9));
    if (Math.abs(this.w - target) < 1e-3) this.w = target;
    this.updateCamera(dt, input);
    if (this.w <= 0 && !this.on) {
      this.rig.focusR.w = this.rig.focusL.w = 0;
      this.camera.work = null;
      return;
    }
    if (this.on) {
      this.grabR.squeeze = clamp(cR.close, 0, 1);
      this.grabL.squeeze = clamp(cL.close, 0, 1);
      this.move(this.R, cR, dt);
      this.move(this.L, cL, dt);
      this.separate();
    }
    for (const S of [this.R, this.L]) {
      const F = S.key === 'R' ? this.rig.focusR : this.rig.focusL;
      F.w = this.w;
      F.p[0] = S.p[0];
      F.p[1] = S.p[1];
      F.p[2] = S.p[2];
      F.roll = S.roll;
    }
    this.camera.work = this.on ? [(this.R.p[0] + this.L.p[0]) / 2, (this.R.p[1] + this.L.p[1]) / 2, (this.R.p[2] + this.L.p[2]) / 2] : null;
  }

  /** 方式ごとに目標を動かし、届く範囲・体・地形・挟んだ物で止める */
  private move(S: Side, c: ClawCtl, dt: number) {
    const G = S.key === 'R' ? this.grabR : this.grabL;
    const yaw = this.camera.yaw;
    // カメラから見た床の右・前（AquaCamera の向き。入力 (x, y) → 世界は右 = (cos, 0, −sin)、前 = (−sin, 0, −cos)）
    const rx = Math.cos(yaw), rz = -Math.sin(yaw), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const p = S.p;
    const sx = c.mx * SPEED * dt + c.dx * MOUSE_K, sy = c.my * SPEED * dt - c.dy * MOUSE_K;
    const lift = c.lift * SPEED * 0.8 * dt - c.liftD * MOUSE_K;
    S.roll = clamp(S.roll + c.roll * ROLL_SPEED * dt, -1.3, 1.3);
    if (this.scheme === 'screen') {
      // 画面の右・上（カメラの姿勢から）と奥（画面の奥へ水平に）
      const P = this.camera.pose.pos, T = this.camera.pose.target;
      let ex = T[0] - P[0], ey = T[1] - P[1], ez = T[2] - P[2];
      const el = Math.hypot(ex, ey, ez) || 1;
      ex /= el; ey /= el; ez /= el;
      // 右 = 前 × 上（世界の上）、画面の上 = 右 × 前
      let qx = -ez, qz = ex;
      const ql = Math.hypot(qx, qz) || 1;
      qx /= ql; qz /= ql;
      const ux = -qz * ey, uy = qz * ex - qx * ez, uz = qx * ey;
      p[0] += qx * sx + ux * sy + fx * lift;
      p[1] += uy * sy;
      p[2] += qz * sx + uz * sy + fz * lift;
    } else {
      p[0] += rx * sx + fx * sy;
      p[2] += rz * sx + fz * sy;
      if (this.scheme === 'ground') p[1] += lift;
      else S.lift = clamp(S.lift + lift, 0, 0.35);
    }
    // 鋏の下の面（挟んでいる物は除く）
    const floor = this.floorBelow(p, [G.holding, (S.key === 'R' ? this.grabL : this.grabR).holding === G.holding ? G.holding : null]);
    S.floor = floor;
    const hov = this.hover(G);
    if (this.scheme === 'surface') {
      // 面に沿って高さを保つ（段差でも急に跳ばない：上がるのは速く、下がるのはゆっくり）
      const want = floor + hov + S.lift;
      const k = 1 - Math.exp(-dt * (want > p[1] ? 16 : 7));
      p[1] += (want - p[1]) * k;
    }
    // 面より下へは行かない（ground・screen も）
    if (p[1] < floor + hov * 0.6) p[1] = floor + hov * 0.6;
    this.clamp(S, G);
  }

  /** 届く範囲（付け根から腕の長さ）・体の中・地形の中・挟んでいる物のつかみ点から離れすぎ、を止める */
  private clamp(S: Side, G: GrabSystem) {
    const p = S.p, rig = this.rig, c = this.crab;
    const sh = S.key === 'R' ? rig.shoulder : rig.shoulderL;
    const k = S.key === 'R' ? CLAWS.scale.R : CLAWS.scale.L;
    const reach = (ARM_REACH / CLAWS.scale.R) * k * 0.97;
    // 体の座標で、前の半分・体の横の範囲に留める（腕が体の後ろ・反対側へ回り込まない）
    const b = rig.worldToBody(p, [0, 0, 0]);
    const sx = S.key === 'R' ? -1 : 1;
    b[0] = sx < 0 ? Math.min(b[0], 0.1) : Math.max(b[0], -0.1);
    b[2] = Math.max(b[2], 0.12);
    rig.bodyToWorld(b, p);
    // 付け根から腕の長さまで
    let dx = p[0] - sh[0], dy = p[1] - sh[1], dz = p[2] - sh[2], dl = Math.hypot(dx, dy, dz);
    if (dl > reach) {
      const kk = reach / dl;
      p[0] = sh[0] + dx * kk; p[1] = sh[1] + dy * kk; p[2] = sh[2] + dz * kk;
      this.stats.clampReach++;
    }
    // 体（球）の外
    const cy = c.y + c.radius;
    dx = p[0] - c.x; dy = p[1] - cy; dz = p[2] - c.z; dl = Math.hypot(dx, dy, dz);
    const minR = c.radius + 0.02;
    if (dl < minR && dl > 1e-5) {
      const kk = minR / dl;
      p[0] = c.x + dx * kk; p[1] = cy + dy * kk; p[2] = c.z + dz * kk;
    }
    // 地形・ガラス・箱の中には入れない（触れたら止まる）。挟んでいる物は除く
    const skip = G.holding;
    for (let it = 0; it < 3; it++) {
      const d = this.props.solidSkip(p[0], p[1], p[2], skip);
      if (d >= 0.012) break;
      const e = 0.02;
      const gx = this.props.solidSkip(p[0] + e, p[1], p[2], skip) - this.props.solidSkip(p[0] - e, p[1], p[2], skip);
      const gy = this.props.solidSkip(p[0], p[1] + e, p[2], skip) - this.props.solidSkip(p[0], p[1] - e, p[2], skip);
      const gz = this.props.solidSkip(p[0], p[1], p[2] + e, skip) - this.props.solidSkip(p[0], p[1], p[2] - e, skip);
      const gl = Math.hypot(gx, gy, gz) || 1;
      const push = 0.012 - d;
      p[0] += (gx / gl) * push; p[1] += (gy / gl) * push; p[2] += (gz / gl) * push;
      this.stats.clampSolid++;
    }
    // 挟んでいる間：目標をつかみ点から LEAD 以内（物が止まれば鋏も止まる）
    const g = G.gripAt();
    if (g && G.state === 'holding') {
      dx = p[0] - g[0]; dy = p[1] - g[1]; dz = p[2] - g[2]; dl = Math.hypot(dx, dy, dz);
      if (dl > LEAD) {
        const kk = LEAD / dl;
        p[0] = g[0] + dx * kk; p[1] = g[1] + dy * kk; p[2] = g[2] + dz * kk;
        this.stats.clampLead++;
      }
    }
  }

  /** 左右の鋏が同じ所へ来ない（ぶつかったら互いに押し分ける） */
  private separate() {
    const a = this.R.p, b = this.L.p;
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2], dl = Math.hypot(dx, dy, dz);
    if (dl >= CLAW_GAP) return;
    this.stats.pushApart++;
    // 体の右 = 右の鋏の側へ（重なっているときの向き）
    let nx = dx, ny = dy, nz = dz;
    if (dl < 1e-4) {
      const h = this.crab.heading;
      nx = -Math.cos(h); ny = 0; nz = Math.sin(h);
    }
    const nl = Math.hypot(nx, ny, nz) || 1, push = (CLAW_GAP - dl) / 2;
    for (let i = 0; i < 3; i++) {
      const v = [nx, ny, nz][i] / nl;
      a[i] += v * push;
      b[i] -= v * push;
    }
  }

  /**
   * カメラ：入ってから 0.9 秒、触っていなければ近く・少し上からへ寄せる。戻るときは入る前の距離・角度へ（触っていなければ）
   */
  private updateCamera(dt: number, input: Input) {
    const A = this.camera.adventure;
    if (this.camera.mode !== 'adventure') return;
    this.camT += dt;
    if (input.dragDX !== 0 || input.dragDY !== 0 || input.wheel !== 0) this.camTouched = true;
    if (this.camTouched || this.camT > 0.9) {
      if (!this.on) this.restore = null;
      return;
    }
    const k = 1 - Math.exp(-dt * 5);
    const goal = this.on ? { zoom: Math.min(A.zoom, CAM_ZOOM), pitch: Math.max(A.pitch, CAM_PITCH) } : this.restore;
    if (!goal) return;
    A.zoom += (goal.zoom - A.zoom) * k;
    A.pitch += (goal.pitch - A.pitch) * k;
  }

  /** 検証・表示用：いまの目標（右・左） */
  snapshot() {
    const r = (v: number) => +v.toFixed(3);
    return { on: this.on, w: r(this.w), scheme: this.scheme, R: this.R.p.map(r), L: this.L.p.map(r), liftR: r(this.R.lift), liftL: r(this.L.lift), rollR: r(this.R.roll), rollL: r(this.L.roll) };
  }
}

// ---------------- 印（鋏の先・影・挟む物） ----------------

/** 画面の点（null = 画面の外・カメラの後ろ） */
type Project = (x: number, y: number, z: number) => { x: number; y: number } | null;

/**
 * 鋏の印（SVG を画面に重ねる）。通常モード：近くの挟める物・挟む所（右 = 橙、左 = 水色の小さな点と輪）。
 * 集中モード：鋏の先の十字・鋏の下の面の影（楕円）と高さの点線・いま閉じると挟む物の点・挟んでいる所。
 * 印は小さく薄く（設定の「鋏の印」で消せる）
 */
export class ClawMarks {
  readonly root: SVGSVGElement;
  private readonly els: Record<'R' | 'L', { tip: SVGGElement; line: SVGLineElement; shadow: SVGEllipseElement; hint: SVGCircleElement; hold: SVGCircleElement }>;
  on = true;
  /** 自動検証：最後に描いた印の数 */
  drawn = 0;

  constructor() {
    const NS = 'http://www.w3.org/2000/svg';
    this.root = document.createElementNS(NS, 'svg');
    this.root.id = 'claw-marks';
    this.root.setAttribute('aria-hidden', 'true');
    const mk = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>, parent: Element = this.root): SVGElementTagNameMap[K] => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      parent.appendChild(e);
      return e;
    };
    const side = (k: 'R' | 'L') => {
      const cls = k === 'R' ? 'cr' : 'cl';
      const line = mk('line', { class: `${cls} drop` });
      const shadow = mk('ellipse', { class: `${cls} shadow`, rx: '9', ry: '4' });
      const tip = mk('g', { class: `${cls} tip` });
      mk('circle', { r: '5' }, tip);
      mk('path', { d: 'M-9 0h5M4 0h5M0 -9v5M0 4v5' }, tip);
      const hint = mk('circle', { class: `${cls} hint`, r: '6' });
      const hold = mk('circle', { class: `${cls} hold`, r: '4' });
      return { tip, line, shadow, hint, hold };
    };
    this.els = { R: side('R'), L: side('L') };
    document.body.appendChild(this.root);
  }

  /**
   * 描く。focus = 集中モード（w は寄せ具合）。claws = 鋏ごとの、鋏の先・下の面の高さ・案内（挟める所）・挟んでいる所
   */
  draw(project: Project, focusW: number, claws: Record<'R' | 'L', { tip: readonly number[]; floor: number | null; hint: readonly number[] | null; hold: readonly number[] | null; busy: boolean }>) {
    this.root.style.display = this.on ? '' : 'none';
    if (!this.on) return;
    let n = 0;
    const show = (e: Element, v: boolean) => e.classList.toggle('off', !v);
    for (const k of ['R', 'L'] as const) {
      const E = this.els[k], C = claws[k];
      const focus = focusW > 0.5;
      const t = focus ? project(C.tip[0], C.tip[1], C.tip[2]) : null;
      show(E.tip, !!t);
      if (t) {
        E.tip.setAttribute('transform', `translate(${t.x.toFixed(1)} ${t.y.toFixed(1)})`);
        E.tip.classList.toggle('busy', C.busy);
        n++;
      }
      const f = focus && C.floor !== null ? project(C.tip[0], C.floor, C.tip[2]) : null;
      show(E.shadow, !!f && !!t);
      show(E.line, !!f && !!t);
      if (f && t) {
        E.shadow.setAttribute('cx', f.x.toFixed(1));
        E.shadow.setAttribute('cy', f.y.toFixed(1));
        E.line.setAttribute('x1', t.x.toFixed(1));
        E.line.setAttribute('y1', t.y.toFixed(1));
        E.line.setAttribute('x2', f.x.toFixed(1));
        E.line.setAttribute('y2', f.y.toFixed(1));
        n++;
      }
      const h = C.hint ? project(C.hint[0], C.hint[1], C.hint[2]) : null;
      show(E.hint, !!h);
      if (h) {
        E.hint.setAttribute('cx', h.x.toFixed(1));
        E.hint.setAttribute('cy', h.y.toFixed(1));
        n++;
      }
      const g = C.hold ? project(C.hold[0], C.hold[1], C.hold[2]) : null;
      show(E.hold, !!g);
      if (g) {
        E.hold.setAttribute('cx', g.x.toFixed(1));
        E.hold.setAttribute('cy', g.y.toFixed(1));
        n++;
      }
    }
    this.drawn = n;
  }
}

// ---------------- スマホの操作（集中モード） ----------------

/**
 * 集中モードのスマホの操作：左右のスティック（左 = 左の鋏・右 = 右の鋏）と、それぞれのスティックの上の外側に開閉のボタン
 * （親指でスティックを動かしながら、人差し指で押せる所）。スティックの内側（画面の中央寄り）に小さな高さのつまみ（上下に
 * ドラッグ = 鋏の高さ・奥行き）。開閉は押している間閉じる（設定でたたくたびに切り替える方式にもできる）。右上に「通常へ」のボタン。
 * 指は Input.claim で 1 本ずつ持つ（4 本以上を同時に使える。押したまま指が外れても、離すまで同じ操作）
 */
export class FocusTouch {
  readonly root: HTMLElement;
  /** 入力（AquaClawFocus へ渡す）：スティック（x = 右, y = 上）・高さのつまみの速さ・開閉 */
  readonly stick = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };
  readonly lift = { L: 0, R: 0 };
  readonly close = { L: 0, R: 0 };
  /** 開閉の方式（hold = 押している間、toggle = たたくたびに切り替え） */
  mode: 'hold' | 'toggle' = 'hold';
  /** 押している指の数（自動検証） */
  fingers = 0;
  private readonly latch = { L: false, R: false };
  private readonly held = { L: 0, R: 0 };

  constructor(private readonly input: Input, onExit: () => void, onScheme: () => void) {
    this.root = document.createElement('div');
    this.root.id = 'focus-touch';
    this.root.innerHTML = `
      <div class="fstick L" data-k="L"><i class="ring"></i><div class="knob"></div></div>
      <div class="fstick R" data-k="R"><i class="ring"></i><div class="knob"></div></div>
      <div class="flift L" data-k="L"><i></i></div>
      <div class="flift R" data-k="R"><i></i></div>
      <button class="fclose L" type="button" data-k="L" aria-label="左のハサミを閉じる"><span class="face">左</span></button>
      <button class="fclose R" type="button" data-k="R" aria-label="右のハサミを閉じる"><span class="face">右</span></button>
      <button class="fexit" type="button" aria-label="通常のモードへ戻る">通常へ</button>
      <button class="fscheme" type="button" aria-label="腕の動かし方を切り替える">動かし方</button>`;
    document.body.appendChild(this.root);
    for (const k of ['L', 'R'] as const) {
      this.bindStick(this.root.querySelector<HTMLElement>(`.fstick.${k}`)!, k);
      this.bindLift(this.root.querySelector<HTMLElement>(`.flift.${k}`)!, k);
      this.bindClose(this.root.querySelector<HTMLButtonElement>(`.fclose.${k}`)!, k);
    }
    const tap = (sel: string, fn: () => void) => {
      const b = this.root.querySelector<HTMLButtonElement>(sel)!;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    tap('.fexit', onExit);
    tap('.fscheme', onScheme);
    input.onReset(() => this.reset());
  }

  show(on: boolean) {
    this.root.classList.toggle('show', on);
    if (!on) this.reset();
  }

  /** 指をすべて離した状態に（切り替え式で閉じているものは、そのまま） */
  private reset() {
    this.stick.L = { x: 0, y: 0 };
    this.stick.R = { x: 0, y: 0 };
    this.lift.L = this.lift.R = 0;
    this.held.L = this.held.R = 0;
    this.sync();
    for (const k of this.root.querySelectorAll('.knob')) (k as HTMLElement).style.transform = '';
    for (const e of this.root.querySelectorAll('.on')) e.classList.remove('on');
  }

  /** 開閉の方式を変える（切り替え式から戻すときは開く） */
  setMode(m: 'hold' | 'toggle') {
    this.mode = m;
    this.latch.L = this.latch.R = false;
    this.sync();
  }

  /** ゲームの側から開く（滑った・離した：切り替え式のボタンも開く） */
  open(k: 'L' | 'R') {
    if (!this.latch[k]) return;
    this.latch[k] = false;
    this.sync();
  }

  private sync() {
    for (const k of ['L', 'R'] as const) {
      const on = this.mode === 'toggle' ? this.latch[k] : this.held[k] > 0;
      this.close[k] = on ? 1 : 0;
      this.root.querySelector(`.fclose.${k}`)?.classList.toggle('shut', on);
    }
    this.fingers = this.input.activePointers;
  }

  private bindClose(btn: HTMLButtonElement, k: 'L' | 'R') {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(btn, e.pointerId);
      this.held[k]++;
      if (this.mode === 'toggle') this.latch[k] = !this.latch[k];
      btn.classList.add('on');
      this.input.claim(e, {
        end: () => {
          this.held[k] = Math.max(0, this.held[k] - 1);
          if (this.held[k] === 0) btn.classList.remove('on');
          this.sync();
        },
      });
      this.sync();
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private bindStick(base: HTMLElement, k: 'L' | 'R') {
    const knob = base.querySelector<HTMLElement>('.knob')!;
    let id = -1;
    const R = () => base.getBoundingClientRect().width * 0.36;
    const update = (e: PointerEvent) => {
      const r = base.getBoundingClientRect();
      const s = this.input.pointerScale;
      let dx = (e.clientX - (r.left + r.width / 2)) * s, dy = (e.clientY - (r.top + r.height / 2)) * s;
      const len = Math.hypot(dx, dy), rr = R();
      if (!Number.isFinite(len)) return;
      if (len > rr) {
        dx *= rr / len;
        dy *= rr / len;
      }
      knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
      const dead = len / rr < 0.1;
      this.stick[k] = dead ? { x: 0, y: 0 } : { x: dx / rr, y: -dy / rr };
    };
    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (id !== -1) this.input.release(id);
      const mine = e.pointerId;
      id = mine;
      capture(base, mine);
      base.classList.add('on');
      this.input.claim(e, {
        move: (ev) => id === mine && update(ev),
        end: () => {
          if (id !== mine) return;
          id = -1;
          knob.style.transform = '';
          base.classList.remove('on');
          this.stick[k] = { x: 0, y: 0 };
          this.sync();
        },
      });
      update(e);
      this.sync();
    });
    base.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 高さのつまみ：押した所から上下にずらした量 = 高さを変える速さ */
  private bindLift(base: HTMLElement, k: 'L' | 'R') {
    let id = -1, oy = 0;
    const mark = base.querySelector<HTMLElement>('i')!;
    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (id !== -1) this.input.release(id);
      const mine = e.pointerId;
      id = mine;
      oy = e.clientY;
      capture(base, mine);
      base.classList.add('on');
      this.input.claim(e, {
        move: (ev) => {
          if (id !== mine) return;
          const d = clamp(((oy - ev.clientY) * this.input.pointerScale) / 40, -1, 1);
          this.lift[k] = Math.abs(d) < 0.12 ? 0 : d;
          mark.style.transform = `translateY(${(-d * 18).toFixed(1)}px)`;
        },
        end: () => {
          if (id !== mine) return;
          id = -1;
          this.lift[k] = 0;
          mark.style.transform = '';
          base.classList.remove('on');
          this.sync();
        },
      });
      this.sync();
    });
    base.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

function capture(el: Element, id: number) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* 捕捉は必須ではない */
  }
}
