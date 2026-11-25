// 最初の仲間：スナモグリ（ゲームロジック側。Three.js に依存しない）。見た目は AquariumRenderer（buildBuddyMesh・巣穴の縁）。
//
// 発見と引っこ抜き（BuddySystem）
// - 砂の広場の端の砂に巣穴がある。カニが近づく（PEEK_R）と、穴から触角と鋏の先が出てきて動く。遠いと引っ込む。
// - 穴のすぐそば（ACT_R）で「調べる」（E / 画面のボタン）→ 引っこ抜けると分かる（progress.flags['burrow.examined']）。
//   調べた後は、押し続けると引っ張る（いったん離してから。調べた押しのままでは引っ張らない）。
// - 引っ張っている間（pulling）：カニは穴へ向き、穴から少し離れた所に踏ん張る（CrabInput.pull）。進み具合 pull は
//   約 PULL_TIME 秒で 1（抵抗：速さが波打つ = 生き物が引き戻す）。途中で離すと抜けかけた体が穴へ戻る（進み具合が減る）。
// - 1 になったら抜ける（popped）：体が宙へ跳び、カニは反動で後ろへ。着地したら仲間（found = true）。
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
import { TANK, type AquariumWorld } from './AquariumWorld';
import type { CrabController } from './CrabController';
import type { BuddyMode, BuddySave } from './AquaSave';

export const BUDDY_ID = 'sunamogri';
export const BUDDY_NAME = 'スナモグリ';
export const BUDDY_DESC = '砂に深い巣穴を掘って暮らすエビのなかま。大きな鋏で砂をかき出す';

/** 引っ張り続けて抜けるまでの時間（秒。過去の試作の手触り） */
export const PULL_TIME = 0.6;
/** 触角が見え始める距離・調べる / 引っ張れる距離（巣穴の中心からカニの体の中心まで、水平） */
const PEEK_R = 4.5;
const ACT_R = 1.15;
/** カニが引っ張るときに立つ距離（穴の中心から体の中心まで） */
export const PULL_STAND = 0.6;
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
  | { kind: 'pullCancel'; progress: number }
  | { kind: 'popped'; x: number; y: number; z: number }
  | { kind: 'joined' }
  | { kind: 'mode'; mode: BuddyMode }
  | { kind: 'warp'; from: [number, number, number]; to: [number, number, number] }
  | { kind: 'land'; x: number; y: number; z: number };

/** 画面の案内（調べる・引っこ抜く。null = 出さない） */
export interface BuddyPrompt {
  label: string;
  /** 長押しの操作か（引っこ抜く） */
  hold: boolean;
  /** 進み具合（0..1。引っ張っている間） */
  progress: number;
  /** 案内を出す位置（巣穴） */
  at: [number, number, number];
}

export interface BuddyInput {
  /** 調べる / 引っ張るボタン（E / 画面のボタン）を押しているか */
  act: boolean;
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
  /** 調べたか（保存する）・触角の出具合（0..1）・引っ張りの進み具合（0..1） */
  examined = false;
  peek = 0;
  pull = 0;
  /** 引っ張っているカニの向き（穴からカニへ。抜ける軸を少しそちらへ倒す） */
  private pullDir: [number, number] = [1, 0];
  private pullClock = 0;
  /** 調べたボタンを離すまで引っ張らない */
  private needRelease = false;
  private actPrev = false;
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
  readonly stats = { warps: 0, blockedSteps: 0, slides: 0, pulls: 0, cancels: 0 };

  constructor(private readonly world: AquariumWorld, burrowXZ: [number, number]) {
    const [bx, bz] = burrowXZ;
    this.burrow = [bx, world.groundAt(bx, bz), bz];
    this.home = [bx, bz];
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

  /** 巣穴の中の位置：抜ける軸に沿って depth（体の中心。地表 = 0、負 = 砂の中） */
  private placeInBurrow(depth = -0.54) {
    const [bx, by, bz] = this.burrow;
    // 軸：上向きから、引っ張るカニの側へ 0.35 rad 倒す（抜ける勢いがカニの方へ向く）
    const lean = 0.35 * clamp(this.pull * 2 + this.peek * 0.3, 0, 1);
    const ax = this.pullDir[0] * Math.sin(lean), az = this.pullDir[1] * Math.sin(lean), ay = Math.cos(lean);
    this.x = bx + ax * depth;
    this.y = by + ay * depth;
    this.z = bz + az * depth;
    this.heading = Math.atan2(this.pullDir[0], this.pullDir[1]);
    this.pitch = Math.PI / 2 - lean;
  }

  // ---------------- 更新 ----------------

  /**
   * カニと入力から 1 フレーム進める。返り値：カニへの引っ張りの指示（引っ張っている間だけ。CrabInput.pull）と、画面の案内
   */
  update(dt: number, crab: CrabController, inp: BuddyInput): { pull: { x: number; z: number; t: number } | null; prompt: BuddyPrompt | null } {
    if (dt <= 0) return { pull: this.state === 'pulling' ? { x: this.burrow[0], z: this.burrow[2], t: this.pull } : null, prompt: null };
    const pressed = inp.act && !this.actPrev;
    this.actPrev = inp.act;
    if (!inp.act) this.needRelease = false;
    this.phase += dt * (this.state === 'walk' || this.state === 'follow' ? 9 : this.state === 'pulling' ? 16 : this.state === 'rest' ? 1.2 : 3);
    if (!this.found) return this.updateBurrow(dt, crab, inp, pressed);
    this.act += ((this.state === 'flying' ? 1 : 0) - this.act) * (1 - Math.exp(-dt * 6));
    if (this.state === 'flying') this.updateFlying(dt);
    else if (this.mode === 'follow') this.updateFollow(dt, crab);
    else this.updateFree(dt, crab);
    return { pull: null, prompt: null };
  }

  private updateBurrow(dt: number, crab: CrabController, inp: BuddyInput, pressed: boolean) {
    const [bx, by, bz] = this.burrow;
    const dx = crab.x - bx, dz = crab.z - bz;
    const dist = Math.hypot(dx, dz);
    const dy = crab.y - by;
    if (dist > 0.05) this.pullDir = [dx / dist, dz / dist];
    // 触角を出す（近いほど・カニが止まっているほど大きく出す）
    const near = crab.region === 'tank' && dist < PEEK_R && Math.abs(dy) < 2.5;
    const peekT = near ? clamp((PEEK_R - dist) / 2, 0.35, 1) * (crab.speed > 1.5 ? 0.6 : 1) : 0;
    this.peek += (peekT - this.peek) * (1 - Math.exp(-dt * 3));
    // 引っ張れる状態：近く・床の上（泳ぎ・壁登り・穴掘り中でない）
    const standing = crab.grounded && !crab.climbing && crab.state !== 'swim' && crab.state !== 'dig' && crab.state !== 'ride';
    const inRange = crab.region === 'tank' && dist < ACT_R && Math.abs(dy) < 0.7;
    let prompt: BuddyPrompt | null = null;

    if (this.state === 'pulling') {
      if (!inp.act || !inRange) {
        // 離した：抜けかけた体が穴へ戻る
        this.state = 'burrow';
        this.stats.cancels++;
        this.events.push({ kind: 'pullCancel', progress: this.pull });
      } else {
        this.pullClock += dt;
        // 抵抗：速さが波打つ（生き物が引き戻す）。平均すると PULL_TIME で抜ける
        const rate = (1 + 0.6 * Math.sin(this.pullClock * Math.PI * 2 * 3.2)) / PULL_TIME;
        this.pull = Math.min(1, this.pull + rate * dt);
        if (this.pull >= 1) {
          this.pop();
          return { pull: null, prompt: null };
        }
      }
    }
    if (this.state === 'burrow') {
      // 戻る：途中まで抜けた体はすぐに引っ込む
      this.pull = Math.max(0, this.pull - dt * 2.2);
      if (inRange && standing) {
        if (!this.examined) {
          prompt = { label: '調べる', hold: false, progress: 0, at: [bx, by, bz] };
          if (pressed) {
            this.examined = true;
            this.needRelease = true;
            this.events.push({ kind: 'examined' });
          }
        } else {
          prompt = { label: '引っこ抜く', hold: true, progress: this.pull, at: [bx, by, bz] };
          if (inp.act && !this.needRelease) {
            this.state = 'pulling';
            this.pullClock = 0;
            this.stats.pulls++;
            this.events.push({ kind: 'pullStart' });
          }
        }
      }
    }
    if (this.state === 'pulling') prompt = { label: '引っこ抜く', hold: true, progress: this.pull, at: [bx, by, bz] };
    // 体：穴の中（触角と鋏の先が出る深さ）→ 引っ張るほど抜けてくる。抜けかけはもがいて左右に揺れる
    const e = this.pull * this.pull * (3 - 2 * this.pull);
    // 体の中心の深さ：-0.54 = 全部砂の中、-0.24 = 触角と鋏の先（体の軸で中心から 0.41〜0.44）が 0.18 ほど出る、
    // 抜ける直前は +0.2（尾の先 -0.3 が地表のすぐ下）
    const depth = -0.54 + 0.3 * this.peek + 0.44 * e;
    this.placeInBurrow(depth);
    this.act = this.state === 'pulling' ? 1 : this.peek * 0.25;
    const wig = this.state === 'pulling' ? 0.25 : 0.06 * this.peek;
    this.roll = Math.sin(this.phase * 1.3) * wig;
    this.heading += Math.sin(this.phase * 0.7) * wig * 0.6;
    return { pull: this.state === 'pulling' ? { x: bx, z: bz, t: this.pull } : null, prompt };
  }

  /** 抜けた：カニの方へ、上へ跳ぶ */
  private pop() {
    const [bx, by, bz] = this.burrow;
    this.state = 'flying';
    this.found = true;
    this.mode = 'free';
    this.pull = 1;
    this.peek = 0;
    this.x = bx;
    this.y = by + 0.05;
    this.z = bz;
    // カニの横へ弧を描いて落ちる（カニの体に隠れず、全身が見える所。約 1 秒）
    const sx = -this.pullDir[1], sz = this.pullDir[0];
    this.vx = sx * 1.1 + this.pullDir[0] * 0.45;
    this.vz = sz * 1.1 + this.pullDir[1] * 0.45;
    this.vy = 2.9;
    this.airborne = true;
    this.events.push({ kind: 'popped', x: bx, y: by, z: bz });
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
