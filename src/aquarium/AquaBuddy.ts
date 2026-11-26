// 最初の仲間：スナモグリ（ゲームロジック側。Three.js に依存しない）。見た目は AquariumRenderer（buildBuddyMesh・巣穴の縁）。
//
// 発見と引っこ抜き（BuddySystem。引っこ抜き 2.0：鋏で直接挟んで引っ張る）
// - 砂の広場の端の砂に巣穴がある。カニが近づく（PEEK_R）と、穴から触角と鋏の先が出てきて動く。遠いと引っ込む。
// - 見えている部分（触角・鋏の付け根）は、小石と同じく右の大きな鋏で挟める（AquaGrab.GrabSystem の creatures に
//   BurrowTug を入れる。PC：E、スマホ：「挟む」）。初めて挟んだら「調べた」ことになる（progress.flags['burrow.examined']）。
// - 挟んだまま（pulling）カニが動くと引っ張る。引き出し・抵抗・体の伸び・滑りは AquaTug.BurrowTug と GrabSystem が決める
//   （押しているだけでは抜けない：引いた距離・向き・張力で進む）。離すと抜けかけた体が穴へ戻る。
// - 抜けた（GrabSystem が 'pop' で離す）：体が宙へ跳び、カニは反動で後ろへ転ぶ。着地したら仲間（found = true）。
// - 体の見た目：体の線は穴の口を通る。穴の外の部分は引く向きへ傾き、穴の中の部分は真下へ曲げる（bendZ・bendA）。
//   伸びは節の間（stretch）で表す（描画 AquariumRenderer の BUDDY）。
//
// 仲間になった後（Buddy）
// - 自由生活（free）：住みか（home）のまわり FREE_RANGE を歩いては止まり、ときどき休む（rest）。カニが近くで止まっていると向く。
// - 同行（follow）：カニの斜め後ろの点へ歩く（遠いほど速い）。近づいたら止まってカニを向く。
// - 歩き方：底を歩く（AquariumWorld.surfaceBelow = 掘った穴も含む砂・岩・流木の上面）。一歩ごとに canStep で
//   上り（急な段・壁）・天井（頭の上の隙間）・下り（自由生活では掘った穴などの深い所へ落ちない）・水の外・ガラス際・縦の管を調べ、
//   進めなければ左右へずらした向きを試す。それでも進めない時間が続く・離れすぎたら、カニのそばの安全な所へ移る
//   （砂に潜って追いかけた、という見た目：消えた所と現れた所に砂煙）。
// - カニが水槽の外・水の外・遠くの壁の上などにいるときは、追えるところで待つ（wait）。

import { clamp, mulberry32, type Rng } from '../core/math';
import { BurrowTug, SUNAMOGURI_TUG, type TugEvent } from './AquaTug';
import { TANK, type AquariumWorld } from './AquariumWorld';
import type { CrabController } from './CrabController';
import type { BuddyMode, BuddySave } from './AquaSave';

export const BUDDY_ID = 'sunamogri';
export const BUDDY_NAME = 'スナモグリ';
export const BUDDY_DESC = '砂に深い巣穴を掘って暮らすエビのなかま。大きな鋏で砂をかき出す';

/** 触角が見え始める距離・案内を出す距離（巣穴の中心からカニの体の中心まで、水平） */
const PEEK_R = 4.5;
const ACT_R = 1.3;
/** 体の中心からつかみ点（鋏の付け根・触角の根元。buildBuddyMesh の体の座標の z）まで */
const GRIP_Z = 0.33;
/** 引っ張っている間、カニの体の中心が穴の口へ近づけない距離（水平） */
export const PULL_KEEP = 0.4;
/** 体の当たり（地形からの余白）・ガラスからの余白・自由生活の範囲 */
const BODY_R = 0.1;
const GLASS_GAP = 0.3;
const FREE_RANGE = 1.8;
const WALK = 0.55;
const FOLLOW_MAX = 3.6;
/** 同行で離れすぎたら移る距離・進めない時間の上限 */
const FAR = 9;
const STUCK_T = 1.8;

export type BuddyState = 'burrow' | 'pulling' | 'flying' | 'idle' | 'walk' | 'rest' | 'follow' | 'wait';

export type BuddyEvent =
  | { kind: 'examined' }
  | { kind: 'pullStart' }
  | { kind: 'pullCancel'; progress: number; why: 'release' | 'slip' }
  | { kind: 'popped'; x: number; y: number; z: number; power: number; dir: [number, number] }
  | { kind: 'joined' }
  | { kind: 'mode'; mode: BuddyMode }
  | { kind: 'warp'; from: [number, number, number]; to: [number, number, number] }
  | { kind: 'land'; x: number; y: number; z: number }
  | { kind: 'tug'; e: TugEvent };

/** 画面の案内（巣穴のそば。null = 出さない）。peek = 見えていて挟める、tug = 挟んで引っ張っている */
export interface BuddyPrompt {
  kind: 'peek' | 'tug';
  /** 調べた（一度挟んだ）ことがあるか */
  examined: boolean;
  /** 案内を出す位置（巣穴） */
  at: [number, number, number];
}

export class BuddySystem {
  // ---- 体（描画が読む） ----
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  /** 体の軸の上下の傾き（正 = 頭が上）・横の傾き */
  pitch = 0;
  roll = 0;
  /** 脚・触角の動きの位相・暴れる強さ（0..1。尾を打つ） */
  phase = 0;
  act = 0;
  state: BuddyState = 'burrow';
  found = false;
  mode: BuddyMode = 'free';
  home: [number, number];
  /** 巣穴（地表の点）と、穴の向き（体が抜けてくる軸。上向き + カニの側へ少し） */
  readonly burrow: [number, number, number];
  /** 調べたか（保存する）・触角の出具合（0..1）・引き出した量（0..1。表示・自動検証用） */
  examined = false;
  peek = 0;
  pull = 0;
  /** 鋏で挟んで引っ張る（体の引き出し・抵抗・伸び。GrabSystem.creatures に入れる） */
  readonly tug: BurrowTug;
  /** 見た目：節の間の伸び（体の座標の長さ）・穴の口の位置（体の座標の z）と、そこから後ろを真下へ曲げる角 */
  stretch = 0;
  bendZ = -1;
  bendA = 0;
  /** 穴からカニの向き（水平。抜けて跳ぶ向き） */
  private pullDir: [number, number] = [1, 0];
  // ---- 歩き ----
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private airborne = false;
  private timer = 1;
  private tx = 0;
  private tz = 0;
  private stuckT = 0;
  /** 回り込む側（1 / -1。前に回り込めた側） */
  private side = 1;
  private readonly rng: Rng = mulberry32(4242);
  readonly events: BuddyEvent[] = [];
  readonly stats = { warps: 0, blockedSteps: 0, slides: 0, pulls: 0, cancels: 0, slips: 0 };

  constructor(private readonly world: AquariumWorld, burrowXZ: [number, number]) {
    const [bx, bz] = burrowXZ;
    this.burrow = [bx, world.groundAt(bx, bz), bz];
    this.home = [bx, bz];
    this.tug = new BurrowTug(this.burrow, SUNAMOGURI_TUG, mulberry32(777));
    this.placeInBurrow();
  }

  /** 保存用 */
  toSave(): BuddySave {
    return { id: BUDDY_ID, species: BUDDY_ID, found: this.found, mode: this.mode, tank: 'home', x: this.x, y: this.y, z: this.z, home: [...this.home], traits: {} };
  }

  /** 保存データから戻す（検証済み）。位置が固体の中・水の外なら巣穴のそばへ */
  restore(s: BuddySave, examined: boolean) {
    this.examined = examined || s.found;
    if (!s.found) return;
    this.found = true;
    this.mode = s.mode;
    this.home = this.safeHome(s.home[0], s.home[1]);
    if (this.canStand(s.x, s.y, s.z)) {
      this.x = s.x;
      this.z = s.z;
      this.y = this.world.surfaceBelow(s.x, s.y + 0.3, s.z);
    } else {
      this.x = this.home[0];
      this.z = this.home[1];
      this.y = this.world.surfaceBelow(this.x, this.burrow[1] + 0.5, this.z);
    }
    this.pitch = 0;
    this.tug.popped = true;
    this.stretch = 0;
    this.bendZ = -1;
    this.state = this.mode === 'follow' ? 'follow' : 'idle';
  }

  /** 自由生活 ↔ 同行（仲間になる前は何もしない） */
  toggleMode(): BuddyMode | null {
    if (!this.found || this.state === 'flying') return null;
    this.mode = this.mode === 'free' ? 'follow' : 'free';
    if (this.mode === 'free') {
      // 同行を解いた所を新しい住みかにする（その辺りで暮らす）
      this.home = this.safeHome(this.x, this.z);
      this.state = 'idle';
      this.timer = 0.6;
    } else this.state = 'follow';
    this.stuckT = 0;
    this.events.push({ kind: 'mode', mode: this.mode });
    return this.mode;
  }

  drainEvents(): BuddyEvent[] {
    return this.events.splice(0, this.events.length);
  }

  // ---------------- 地形の判定 ----------------

  private wet(y: number): boolean {
    return y < TANK.waterY - 0.25;
  }

  /** その場所に体を置けるか（固体の中でない・水の中・水槽の中） */
  private canStand(x: number, y: number, z: number): boolean {
    const w = this.world;
    return w.insideTank(x, z, GLASS_GAP) && this.wet(y) && w.contactSolid(x, y + BODY_R + 0.02, z) > BODY_R * 0.6 && w.pipeClear(x, z) > 0.12;
  }

  /** 住みか：水の中の底なら x, z のまま。そうでなければ巣穴 */
  private safeHome(x: number, z: number): [number, number] {
    const w = this.world;
    if (w.insideTank(x, z, GLASS_GAP + 0.3) && this.wet(w.groundAt(x, z))) return [x, z];
    return [this.burrow[0], this.burrow[2]];
  }

  /**
   * (x, y, z) から (nx, nz) へ 1 歩進めるか。進めるなら着く床の高さ、進めなければ null。
   * allowDrop = 下りてよい高さ（自由生活は小さく：掘った穴へ落ちない）
   */
  private canStep(nx: number, nz: number, allowDrop: number, stepLen: number): number | null {
    const w = this.world;
    if (!w.insideTank(nx, nz, GLASS_GAP) || w.pipeClear(nx, nz) < 0.12) return null;
    const fy = w.surfaceBelow(nx, this.y + 0.3, nz);
    const rise = fy - this.y;
    // 急な上り（約 56° より急・壁）
    if (rise > stepLen * 1.5 + 0.02) return null;
    if (this.y - fy > allowDrop) return null;
    if (!this.wet(fy)) return null;
    // 頭の上の隙間（トンネルの天井・岩の張り出し・ガラス）
    if (w.contactSolid(nx, fy + BODY_R + 0.04, nz) < BODY_R * 0.8) return null;
    return fy;
  }

  // ---------------- 巣穴 ----------------

  /**
   * 巣穴の中の体の見た目（BurrowTug の状態から）：体の線は穴の口を通り、つかみ点（体の座標の z = GRIP_Z + 伸び）が
   * tug.p に来る。穴の外の部分は体の向き（tug.dir）へ傾け、穴の口より後ろ（穴の中）は真下へ曲げる（描画が bendZ・bendA で曲げる）。
   * もがく強さで体の軸のまわりに揺れる（軸は動かさない：挟んでいる鋏とずれない）。
   * 物を動かした後（GrabSystem.update の後）にも呼ぶ（鋏と体が 1 フレームずれない）
   */
  placeInBurrow() {
    if (this.found) return;
    const T = this.tug, d = T.dir, g = T.p;
    const s = T.stretch;
    this.stretch = s;
    this.x = g[0] - d[0] * (GRIP_Z + s);
    this.y = g[1] - d[1] * (GRIP_Z + s);
    this.z = g[2] - d[2] * (GRIP_Z + s);
    const h = Math.hypot(d[0], d[2]);
    this.heading = h > 0.05 ? Math.atan2(d[0], d[2]) : Math.atan2(this.pullDir[0], this.pullDir[1]);
    this.pitch = Math.atan2(d[1], h);
    // 穴の口の位置（体の座標の z。節を伸ばした後の座標）と、そこから後ろを真下へ曲げる角
    this.bendZ = GRIP_Z + s - T.u;
    this.bendA = Math.PI / 2 - this.pitch;
    // もがく：挟まれている間は引き戻すたびに大きく、終盤は激しく
    const wig = T.held ? 0.08 + 0.24 * T.env + (T.stage === 'late' ? 0.12 : 0) : 0.06 * this.peek;
    this.roll = Math.sin(this.phase * 1.3) * wig;
    if (!T.held) this.heading += Math.sin(this.phase * 0.7) * wig * 0.6;
  }

  // ---------------- 更新 ----------------

  /**
   * カニから 1 フレーム進める。返り値：画面の案内と、引っ張っている間のカニへの指示（CrabInput.pull：穴へ向く・
   * 穴に近づきすぎない。t = 張力 / 踏ん張り）
   */
  update(dt: number, crab: CrabController): { pull: { x: number; z: number; t: number } | null; prompt: BuddyPrompt | null } {
    if (dt <= 0) return { pull: this.tug.held ? { x: this.burrow[0], z: this.burrow[2], t: clamp(this.tug.load, 0, 1) } : null, prompt: null };
    this.phase += dt * (this.state === 'walk' || this.state === 'follow' ? 9 : this.state === 'pulling' ? 10 + 10 * this.tug.env : this.state === 'rest' ? 1.2 : 3);
    if (!this.found) return this.updateBurrow(dt, crab);
    this.act += ((this.state === 'flying' ? 1 : 0) - this.act) * (1 - Math.exp(-dt * 6));
    if (this.state === 'flying') this.updateFlying(dt);
    else if (this.mode === 'follow') this.updateFollow(dt, crab);
    else this.updateFree(dt, crab);
    return { pull: null, prompt: null };
  }

  private updateBurrow(dt: number, crab: CrabController) {
    const [bx, by, bz] = this.burrow;
    const T = this.tug;
    const dx = crab.x - bx, dz = crab.z - bz;
    const dist = Math.hypot(dx, dz);
    const dy = crab.y - by;
    if (dist > 0.05) this.pullDir = [dx / dist, dz / dist];
    // 触角を出す（近いほど・カニが止まっているほど大きく出す）
    const near = crab.region === 'tank' && dist < PEEK_R && Math.abs(dy) < 2.5;
    const peekT = near ? clamp((PEEK_R - dist) / 2, 0.35, 1) * (crab.speed > 1.5 ? 0.6 : 1) : 0;
    // 挟んだ・離した・滑った・抜けた（GrabSystem が前のフレームで決めた）
    for (const e of T.drainEvents()) {
      if (e.kind === 'grab') {
        this.stats.pulls++;
        if (!this.examined) {
          this.examined = true;
          this.events.push({ kind: 'examined' });
        }
        this.events.push({ kind: 'pullStart' });
      } else if (e.kind === 'release') {
        if (e.why === 'pop') {
          this.pop(e.tension);
          return { pull: null, prompt: null };
        }
        if (e.why === 'slip') this.stats.slips++;
        else this.stats.cancels++;
        this.events.push({ kind: 'pullCancel', progress: clamp(e.ext, 0, 1), why: e.why });
      }
      this.events.push({ kind: 'tug', e });
    }
    if (!T.held) T.stepFree(dt, [crab.x, crab.y + crab.radius, crab.z], peekT);
    this.peek = T.peek;
    this.pull = clamp(T.ext, 0, 1);
    this.state = T.held ? 'pulling' : 'burrow';
    // 案内：挟んでいる間・見えていて近い間
    const inRange = crab.region === 'tank' && dist < ACT_R && Math.abs(dy) < 0.7;
    const prompt: BuddyPrompt | null = T.held || (inRange && T.grabbable()) ? { kind: T.held ? 'tug' : 'peek', examined: this.examined, at: [bx, by, bz] } : null;
    this.act = T.held ? 0.45 + 0.55 * T.env : this.peek * 0.25;
    this.placeInBurrow();
    return { pull: T.held ? { x: bx, z: bz, t: clamp(T.load, 0, 1) } : null, prompt };
  }

  /** 抜けた：いまの体の所から、カニの横へ・上へ跳ぶ（張っていた力が強いほど勢いよく） */
  private pop(tension: number) {
    const [bx, by, bz] = this.burrow;
    const power = clamp(tension / this.tug.grip, 0.35, 1);
    this.state = 'flying';
    this.found = true;
    this.mode = 'free';
    this.pull = 1;
    this.peek = 0;
    this.stretch = 0;
    this.bendZ = -1;
    this.y = Math.max(this.y, by + 0.05);
    // 体がまだ穴の上なら、口の真上から（固体の中から始めない）
    if (this.world.contactSolid(this.x, this.y + BODY_R, this.z) < BODY_R) {
      this.x = bx;
      this.y = by + 0.08;
      this.z = bz;
    }
    // カニの横へ弧を描いて落ちる（カニの体に隠れず、全身が見える所。約 1 秒）
    const sx = -this.pullDir[1], sz = this.pullDir[0];
    this.vx = sx * 1.1 + this.pullDir[0] * (0.45 + 0.5 * power);
    this.vz = sz * 1.1 + this.pullDir[1] * (0.45 + 0.5 * power);
    this.vy = 2.6 + 0.6 * power;
    this.airborne = true;
    this.events.push({ kind: 'popped', x: bx, y: by, z: bz, power, dir: [this.pullDir[0], this.pullDir[1]] });
  }

  private updateFlying(dt: number) {
    const w = this.world;
    // 宙で回る（頭が上 → 前へ倒れて水平に）
    this.pitch += (0 - this.pitch) * (1 - Math.exp(-dt * 3));
    this.roll = Math.sin(this.phase * 0.9) * 0.4;
    this.vy -= 5 * dt;
    this.vx *= Math.exp(-dt * 0.8);
    this.vz *= Math.exp(-dt * 0.8);
    let nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
    if (!w.insideTank(nx, nz, GLASS_GAP)) {
      nx = this.x;
      nz = this.z;
      this.vx = this.vz = 0;
    }
    // 壁（岩・流木）に当たったら水平に止まる
    if (w.contactSolid(nx, this.y + BODY_R, nz) < BODY_R) {
      nx = this.x;
      nz = this.z;
      this.vx = this.vz = 0;
    }
    this.x = nx;
    this.z = nz;
    this.y += this.vy * dt;
    const fy = w.surfaceBelow(this.x, Math.max(this.y, this.burrow[1]) + 0.3, this.z);
    if (this.vy < 0 && this.y <= fy) {
      this.y = fy;
      this.vy = 0;
      this.airborne = false;
      this.roll = 0;
      this.pitch = 0;
      this.state = 'idle';
      this.timer = 1.2;
      this.home = this.safeHome(this.x, this.z);
      this.events.push({ kind: 'land', x: this.x, y: this.y, z: this.z });
      this.events.push({ kind: 'joined' });
    }
  }

  /** 向きを (dx, dz) へなめらかに */
  private face(dx: number, dz: number, dt: number, k = 6) {
    if (Math.hypot(dx, dz) < 1e-4) return;
    const h = Math.atan2(dx, dz);
    this.heading = wrap(this.heading + wrap(h - this.heading) * (1 - Math.exp(-dt * k)));
  }

  /**
   * (tx, tz) の向きへ speed で 1 フレーム歩く。進めなければ左右にずらした向きを試す。
   * 返り値：進めたか
   */
  private walkToward(tx: number, tz: number, speed: number, dt: number, allowDrop: number): boolean {
    const dx = tx - this.x, dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return true;
    const step = Math.min(speed * dt, d);
    const base = Math.atan2(dx, dz);
    // まっすぐ → 左右へずらす。前に回り込めた側を先に試す（縦の管・岩の柱のような丸い物を同じ側から回り込み、左右に迷わない）
    const s = this.side;
    for (const off of [0, s * 0.6, -s * 0.6, s * 1.2, -s * 1.2, s * 1.8, -s * 1.8]) {
      const a = base + off;
      const nx = this.x + Math.sin(a) * step, nz = this.z + Math.cos(a) * step;
      const fy = this.canStep(nx, nz, allowDrop, step);
      if (fy === null) {
        this.stats.blockedSteps++;
        continue;
      }
      if (off !== 0) {
        this.stats.slides++;
        this.side = off > 0 ? 1 : -1;
      }
      this.x = nx;
      this.z = nz;
      // 下りが大きいときは落ちる（重力）。小さいときは床へ寄せる
      if (this.y - fy > 0.08) {
        this.airborne = true;
      } else this.y += (fy - this.y) * (1 - Math.exp(-dt * 20));
      this.face(Math.sin(a), Math.cos(a), dt, 7);
      // 坂の傾き（頭の側の床の高さから）
      const ahead = this.world.surfaceBelow(this.x + Math.sin(a) * 0.15, this.y + 0.3, this.z + Math.cos(a) * 0.15);
      this.pitch += (clamp(Math.atan2(ahead - this.y, 0.15), -0.6, 0.6) - this.pitch) * (1 - Math.exp(-dt * 8));
      return true;
    }
    return false;
  }

  /** 落ちている間（掘った穴へ下りた等）・床へ寄せる */
  private settle(dt: number) {
    const fy = this.world.surfaceBelow(this.x, this.y + 0.3, this.z);
    if (this.airborne || this.y > fy + 0.08) {
      this.airborne = true;
      this.vy -= 3.2 * dt;
      this.vy = Math.max(this.vy, -2.5);
      this.y += this.vy * dt;
      if (this.y <= fy) {
        this.y = fy;
        this.vy = 0;
        this.airborne = false;
      }
    } else {
      this.vy = 0;
      this.y += (fy - this.y) * (1 - Math.exp(-dt * 20));
    }
    // 万一、固体の中に入った（足元の砂を掘られた等で床が上がった）ら上へ出す
    if (this.world.contactSolid(this.x, this.y + BODY_R, this.z) < 0) this.y = this.world.surfaceBelow(this.x, this.y + 1.2, this.z);
  }

  private updateFree(dt: number, crab: CrabController) {
    const r = this.rng;
    this.timer -= dt;
    const cdx = crab.x - this.x, cdz = crab.z - this.z;
    const cd = Math.hypot(cdx, cdz);
    if (this.state === 'walk') {
      const moved = this.walkToward(this.tx, this.tz, WALK, dt, 0.35);
      if (!moved) this.stuckT += dt;
      if (Math.hypot(this.tx - this.x, this.tz - this.z) < 0.08 || this.timer <= 0 || this.stuckT > 0.8) {
        this.state = r() < 0.3 ? 'rest' : 'idle';
        this.timer = this.state === 'rest' ? 5 + r() * 5 : 0.8 + r() * 2.2;
        this.stuckT = 0;
      }
    } else {
      // 止まっている：カニが近くにいれば向く（休んでいるときは向かない）
      if (this.state === 'idle' && cd < 1.6 && crab.region === 'tank') this.face(cdx, cdz, dt, 3);
      this.pitch *= Math.exp(-dt * 4);
      if (this.timer <= 0) {
        const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * FREE_RANGE;
        this.tx = this.home[0] + Math.cos(a) * rr;
        this.tz = this.home[1] + Math.sin(a) * rr;
        this.state = 'walk';
        this.timer = 6;
        this.stuckT = 0;
      }
    }
    // カニと重ならない
    if (cd < 0.4 && crab.region === 'tank' && Math.abs(crab.y - this.y) < 0.5) this.walkToward(this.x - cdx, this.z - cdz, 0.8, dt, 0.35);
    this.settle(dt);
  }

  private updateFollow(dt: number, crab: CrabController) {
    const w = this.world;
    // カニが追える所にいるか：水槽の中・水の中（体の中心）。壁の上・泳いでいる間は、その真下の床を目指す
    const crabFloor = w.surfaceBelow(crab.x, crab.y + crab.radius, crab.z);
    // （ガラス際のカニも追う：目標の点がガラスに近すぎれば canStep が止める）
    const reachable = crab.region === 'tank' && this.wet(crabFloor) && w.insideTank(crab.x, crab.z);
    // 目標：カニの斜め後ろ（体の向きの後ろから 40° 外側、0.85 離れた所）
    const back = crab.heading + Math.PI + 0.7;
    const gx = crab.x + Math.sin(back) * 0.85, gz = crab.z + Math.cos(back) * 0.85;
    const dx = gx - this.x, dz = gz - this.z;
    const d = Math.hypot(dx, dz);
    const cd = Math.hypot(crab.x - this.x, crab.z - this.z);
    if (!reachable) {
      // 追えない所：その場で待ち、カニの方を向く
      this.state = 'wait';
      this.face(crab.x - this.x, crab.z - this.z, dt, 3);
      this.stuckT = 0;
      this.settle(dt);
      return;
    }
    // 離れすぎ（カニが管を通って戻ってきた・スタート地点へ戻った等）
    if (cd > FAR) {
      this.warpNear(crab, crabFloor);
      return;
    }
    if (d > 0.25 && cd > 0.75) {
      this.state = 'follow';
      const speed = clamp(0.8 + d * 1.1, 0.8, FOLLOW_MAX);
      const ox = this.x, oz = this.z;
      const moved = this.walkToward(gx, gz, speed, dt, 3.0);
      // 進めない・目標の向きへほとんど進めていない（壁の向こう・段の上で左右にずれるだけ）時間を数える。
      // カニとの距離の変化では測らない（走るカニを追っている間は距離が縮まらないが、詰まってはいない）
      const along = ((this.x - ox) * dx + (this.z - oz) * dz) / d;
      if (!moved || along < speed * dt * 0.25) this.stuckT += dt;
      else this.stuckT = Math.max(0, this.stuckT - dt * 0.5);
      if (this.stuckT > STUCK_T && cd > 2.2) this.warpNear(crab, crabFloor);
    } else {
      this.state = 'idle';
      this.face(crab.x - this.x, crab.z - this.z, dt, 4);
      this.pitch *= Math.exp(-dt * 4);
      this.stuckT = 0;
    }
    this.settle(dt);
  }

  /** カニのそばの安全な所へ移る（見つからなければ何もしない：次のフレームでまた試す） */
  private warpNear(crab: CrabController, crabFloor: number) {
    const w = this.world;
    const from: [number, number, number] = [this.x, this.y, this.z];
    for (const rad of [0.9, 0.7, 1.2, 0.5, 1.6]) {
      for (let k = 0; k < 10; k++) {
        const a = crab.heading + Math.PI + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.55;
        const x = crab.x + Math.sin(a) * rad, z = crab.z + Math.cos(a) * rad;
        if (!w.insideTank(x, z, GLASS_GAP) || w.pipeClear(x, z) < 0.12) continue;
        const fy = w.surfaceBelow(x, crabFloor + 0.4, z);
        // カニの床と同じくらいの高さ（壁の向こう・穴の底・段の上でない）
        if (Math.abs(fy - crabFloor) > 0.45 || !this.canStand(x, fy, z)) continue;
        this.x = x;
        this.y = fy;
        this.z = z;
        this.vy = 0;
        this.airborne = false;
        this.stuckT = 0;
        this.face(crab.x - x, crab.z - z, 1, 50);
        this.stats.warps++;
        this.events.push({ kind: 'warp', from, to: [x, fy, z] });
        return;
      }
    }
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
