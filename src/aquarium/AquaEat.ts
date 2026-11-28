// 食事と栄養（ゲームロジック側。Three.js に依存しない）。
// - 食べる：ハサミ（左右どちらでも）で挟んだ食べ物を、挟んだまま「掘る」ボタン（PC：F・マウスの右ボタン、スマホ：「掘る」
//   ボタン（食べるの絵になる）、ゲームパッド：X / □）を押している間、口元へ運んで少しずつ食べる。離すと中断し、ハサミは
//   食べかけを挟んだまま構えへ戻る（もう一度押せば続きから）。挟むボタンを離せば食べかけを落とす（拾い直せる）。
//   （挟んでいる間は掘れない（掘るのもハサミを使う）ので、掘るボタンは空いている。根の付いた水草を挟んでいる間は従来どおり
//   ちぎる・抜く）
// - 動き（実際のカニの食べ方）：ハサミで食べ物を口元へ運ぶ（bring）→ 第 3 顎脚（口の前の扉のような 1 対の付属肢）を開いて
//   食べ物を押し込み、閉じて噛み取る → ハサミで少し引き離しながらひねってちぎる、を繰り返す（chew。1 口ごとに少し減る）。
//   空いている方のハサミは食べ物をつまんで口へ運ぶ手伝いをする（CrabRig・main）。食べられない物（小石・貝殻）は口元へ運んで
//   顎脚で確かめ、押し戻す（taste）。仲間・まだ隙間に踏ん張っている生き物・根の付いた物は口へ運ばない（顎脚が動くだけ）。
// - 栄養：経験値に相当する蓄積型の資源。食べた量（部分的に食べても、その割合の分）だけ増え、時間では減らない。
//   食べ物の種類・大きさで、栄養と食べ終わるまでの時間が違う。将来の脱皮（能力の成長）へ渡す目安の段階 GROWTH を持つ。
// 見た目（口元へ運ぶ・顎脚・手伝う鋏）は CrabRig、食べ物の縮み・消え方は各食べ物（AquaCatch・AquaLife・AquaWorm）、
// 音とかけらは main が出来事（EatEvent）から出す。

import { clamp, smoothstep } from '../core/math';

export type FoodKind = 'algae' | 'plant' | 'shrimp' | 'fish' | 'worm';
export const FOOD_KINDS: FoodKind[] = ['algae', 'plant', 'shrimp', 'fish', 'worm'];

/** 噛む音の種類（AquaAudio.munch） */
export type MunchKind = 'leaf' | 'crunch' | 'soft' | 'squish';

export interface FoodKindSpec {
  name: string;
  /** 大きさ 1 の 1 個を食べ切ったときの栄養 */
  nutrition: number;
  /** 大きさ 1 の 1 個を食べ切るまでの時間（秒。1 口の間隔 bite ごとに少しずつ減る） */
  time: number;
  /** 1 口の間隔（秒）：押し込む → 噛み取る → ちぎる */
  bite: number;
  sound: MunchKind;
  /** 噛んだときに散るかけらの色 */
  crumbs: string[];
}

/**
 * 食べ物の種類ごとの値。大きさ（Food.size）で栄養は比例、時間は size^0.7 で増える（大きいほど 1 口が大きい）。
 * 藻（大きさ = むしった量）・水草（かけらの重さ）・エビ・小魚・ゴカイ（体長 × 太さ）
 */
export const FOOD_KIND: Record<FoodKind, FoodKindSpec> = {
  algae: { name: '藻', nutrition: 2, time: 2.4, bite: 0.48, sound: 'leaf', crumbs: ['#2f5a2a', '#4f7d38', '#3d6b30'] },
  plant: { name: '水草', nutrition: 5, time: 4.0, bite: 0.52, sound: 'leaf', crumbs: ['#4f8a36', '#6a9e3e', '#3e6e2c'] },
  shrimp: { name: 'エビ', nutrition: 12, time: 6.0, bite: 0.6, sound: 'crunch', crumbs: ['#d9a78a', '#c98a6a', '#efd2bc'] },
  fish: { name: '小魚', nutrition: 15, time: 7.0, bite: 0.6, sound: 'soft', crumbs: ['#c9d3d6', '#9fb0b8', '#e6ecee'] },
  worm: { name: 'ゴカイ', nutrition: 20, time: 8.0, bite: 0.55, sound: 'squish', crumbs: ['#b0584a', '#d58a7c', '#8e3f36'] },
};

/** 食べ切るまでの時間（秒） */
export function foodTime(kind: FoodKind, size: number): number {
  return FOOD_KIND[kind].time * Math.pow(Math.max(0.2, size), 0.7);
}

/** 食べ切ったときの栄養 */
export function foodNutrition(kind: FoodKind, size: number): number {
  return FOOD_KIND[kind].nutrition * Math.max(0.2, size);
}

/**
 * 将来の脱皮（能力の成長）の目安：栄養の合計がこの値に届くと、その段階の脱皮ができる（脱皮はまだ作っていない。
 * いまは表示の目盛りだけ：次の段階までの割合）
 */
export const GROWTH = { moltAt: [40, 100, 180, 300, 460] } as const;

/** 挟んでいる物から作る、食べ物の窓口（main の resolve が物・生き物ごとに作り、同じ物には同じ窓口を返す） */
export interface Food {
  /** 同じ物かの判定（物・個体の id） */
  readonly id: string;
  readonly kind: FoodKind;
  readonly name: string;
  /** 大きさ（栄養・時間の倍率） */
  readonly size: number;
  /** 残り（0..1） */
  readonly left: number;
  /** 1 口目の直前：生き物は動かなくなる（暴れない・逃げない） */
  begin(): void;
  /** 残りを書く（見た目が縮む・短くなる） */
  setLeft(v: number): void;
  /** 食べ終えた：世界から消す（挟んでいた鋏は空になる） */
  finish(): void;
  /** かけら・泡を出す所（世界） */
  at(): readonly number[];
}

/** 食べない理由：仲間・食べられない物・根の付いた物・まだ隙間（巣穴）に踏ん張っている・つまむ物が無い（藻の無い岩） */
export type EatRefuse = 'companion' | 'inedible' | 'rooted' | 'anchored' | 'nothing';

export type EatTarget =
  | { kind: 'food'; food: Food }
  /** 岩・流木をつかんでいる：藻をむしり取って食べ物にする（無ければ null） */
  | { kind: 'scrape'; scrape: () => Food | null }
  /** 食べない。bring = 口元へ運んで確かめる（食べられない物）・運ばない（仲間・踏ん張っている生き物・岩） */
  | { kind: 'refuse'; why: EatRefuse; bring: boolean; name: string };

export type EatSide = 'R' | 'L';

/** 鋏 1 本の、いま挟んでいる物（null = 食べる操作の対象外：何も挟んでいない・根の付いた水草） */
export interface EatClaw {
  side: EatSide;
  target: EatTarget | null;
}

export type EatEvent =
  | { kind: 'start'; side: EatSide; food: Food; resume: boolean }
  /** 1 口：amount = 減った割合、gain = 得た栄養 */
  | { kind: 'bite'; side: EatSide; food: Food; amount: number; gain: number; left: number; first: boolean }
  | { kind: 'finish'; side: EatSide; food: Food }
  /** 中断した（ボタンを離した・落とした・滑った） */
  | { kind: 'stop'; side: EatSide; food: Food; left: number; why: 'release' | 'lost' }
  | { kind: 'refuse'; side: EatSide; why: EatRefuse; name: string; bring: boolean }
  /** 確かめて押し戻した瞬間（口元へ運んだ物）・顎脚が動いた（運ばない物） */
  | { kind: 'spit'; side: EatSide; bring: boolean };

export type EatPhase = 'idle' | 'bring' | 'chew' | 'taste' | 'back';

/** 口元へ運ぶ・戻す速さ（秒）、確かめる長さ（運ぶ / 運ばない） */
const BRING_T = 0.38;
const BACK_T = 0.3;
const TASTE_T = 1.05;
const TASTE_T_STILL = 0.6;
/** 1 口の中の、噛み取る瞬間（位相） */
const BITE_AT = 0.5;

/** 栄養（経験値に相当する蓄積型。時間では減らない） */
export class Nutrition {
  total = 0;
  /** 種類ごとに得た栄養・食べ終えた数 */
  readonly byKind: Record<FoodKind, number> = { algae: 0, plant: 0, shrimp: 0, fish: 0, worm: 0 };
  readonly eaten: Record<FoodKind, number> = { algae: 0, plant: 0, shrimp: 0, fish: 0, worm: 0 };

  add(kind: FoodKind, v: number) {
    if (!(v > 0)) return;
    this.total += v;
    this.byKind[kind] += v;
  }

  /** 届いた脱皮の段階の数（0 = まだ） */
  get stage(): number {
    let s = 0;
    for (const t of GROWTH.moltAt) if (this.total >= t) s++;
    return s;
  }

  /** 次の段階の値（null = 最後まで届いた） */
  get next(): number | null {
    return GROWTH.moltAt.find((t) => this.total < t) ?? null;
  }

  /** 次の段階までの割合（0..1。最後まで届いたら 1） */
  get progress(): number {
    const s = this.stage, n = this.next;
    if (n === null) return 1;
    const prev = s > 0 ? GROWTH.moltAt[s - 1] : 0;
    return clamp((this.total - prev) / (n - prev), 0, 1);
  }

  toSave(): { total: number; byKind: Record<string, number>; eaten: Record<string, number> } {
    return { total: this.total, byKind: { ...this.byKind }, eaten: { ...this.eaten } };
  }

  restore(s: { total: number; byKind: Record<string, number>; eaten: Record<string, number> }) {
    this.total = Math.max(0, s.total);
    for (const k of FOOD_KINDS) {
      this.byKind[k] = Math.max(0, s.byKind[k] ?? 0);
      this.eaten[k] = Math.max(0, Math.round(s.eaten[k] ?? 0));
    }
  }
}

/**
 * 食べる動きの状態。毎フレーム update に「食べるボタンを押している」と左右の鋏の対象を渡す。
 * 口元へ運ぶ重み（feedW）・顎脚の開き（mouth）・小顎の震え（palp）・鋏の押し込み（push）・ひねり（twist）を CrabRig へ渡す
 */
export class EatSystem {
  phase: EatPhase = 'idle';
  /** 食べている・確かめている鋏 */
  side: EatSide | null = null;
  food: Food | null = null;
  /** 口元へ運ぶ重み（0..1） */
  feedW = 0;
  /** 1 口の位相（0..1） */
  bitePh = 0;
  /** 顎脚の開き（0..1）・小顎の震え（0..1）・鋏の押し込み（−1..1）・ひねり（−1..1） */
  mouth = 0;
  palp = 0;
  push = 0;
  twist = 0;
  /** 空いている方の鋏で手伝う重み（0..1）と、その位相（つまむ → 口へ） */
  assist = 0;
  assistPh = 0;
  /** 確かめている間の経過・運ぶか・理由 */
  private tasteT = 0;
  private tasteBring = false;
  private spat = false;
  /** 押したまま（確かめ終えた・食べ終えた後）：一度離すまで次を始めない */
  private latched = false;
  private chewT = 0;
  readonly events: EatEvent[] = [];
  readonly stats = { starts: 0, bites: 0, finished: 0, stops: 0, refused: 0, resumes: 0, eatT: 0 };
  readonly nutrition = new Nutrition();

  /** 食べている（口元へ運んでいる・噛んでいる） */
  get eating(): boolean {
    return this.phase === 'bring' || this.phase === 'chew';
  }

  /** 歩く速さに掛ける割合（口元へ運んでいる間はゆっくり） */
  get slow(): number {
    return 1 - 0.45 * this.feedW;
  }

  update(dt: number, want: boolean, claws: readonly EatClaw[]) {
    if (dt <= 0) return;
    if (!want) this.latched = false;
    const claw = (s: EatSide | null) => claws.find((c) => c.side === s) ?? null;
    // いま食べている物を、その鋏がまだ挟んでいるか
    const stillHeld = () => {
      const t = claw(this.side)?.target;
      return !!this.food && t?.kind === 'food' && t.food.id === this.food.id;
    };
    // 始める（止まっている・戻している間）
    if ((this.phase === 'idle' || this.phase === 'back') && want && !this.latched) {
      const back = this.phase === 'back' && this.food && stillHeld() ? claw(this.side) : null;
      const pick = back ?? claws.find((c) => c.target?.kind === 'food') ?? claws.find((c) => c.target?.kind === 'scrape') ?? claws.find((c) => c.target?.kind === 'refuse') ?? null;
      const t = pick?.target ?? null;
      if (pick && t) {
        if (t.kind === 'food') this.start(pick.side, t.food);
        else if (t.kind === 'scrape') {
          const f = t.scrape();
          if (f) this.start(pick.side, f);
          else this.taste(pick.side, 'nothing', false, '岩');
        } else this.taste(pick.side, t.why, t.bring, t.name);
      }
    }
    switch (this.phase) {
      case 'bring':
      case 'chew': {
        if (!stillHeld()) {
          this.stop('lost');
          break;
        }
        if (!want) {
          this.stop('release');
          break;
        }
        this.feedW = Math.min(1, this.feedW + dt / BRING_T);
        if (this.phase === 'bring') {
          this.mouth += (0.35 - this.mouth) * (1 - Math.exp(-dt * 8));
          this.palp += (0.5 - this.palp) * (1 - Math.exp(-dt * 6));
          this.push = smoothstep(0, 1, this.feedW) * 0.2;
          this.twist *= Math.exp(-dt * 6);
          if (this.feedW >= 0.92) {
            this.phase = 'chew';
            this.bitePh = 0;
          }
          break;
        }
        this.chewOne(dt);
        break;
      }
      case 'taste': {
        this.tasteT += dt;
        const T = this.tasteBring ? TASTE_T : TASTE_T_STILL;
        const u = this.tasteT / T;
        // 運ぶ物：口元へ（0.4）→ 顎脚でさわって確かめる → 押し戻す（0.62 で吐き出す）→ 戻す
        this.feedW = this.tasteBring ? (u < 0.4 ? smoothstep(0, 0.4, u) * 0.85 : u < 0.62 ? 0.85 : 0.85 * (1 - smoothstep(0.62, 1, u))) : 0;
        this.mouth = u < 0.62 ? 0.25 + 0.25 * Math.max(0, Math.sin(this.tasteT * 26)) : 0.6 * (1 - smoothstep(0.62, 0.9, u));
        this.palp = u < 0.8 ? 1 : 1 - smoothstep(0.8, 1, u);
        this.push = this.tasteBring && u > 0.62 && u < 0.8 ? -0.8 : 0;
        this.twist = this.tasteBring ? Math.sin(this.tasteT * 9) * 0.3 * (u < 0.62 ? 1 : 0) : 0;
        if (!this.spat && u >= 0.62) {
          this.spat = true;
          this.events.push({ kind: 'spit', side: this.side!, bring: this.tasteBring });
        }
        if (u >= 1) {
          this.phase = 'idle';
          this.side = null;
          this.feedW = 0;
        }
        break;
      }
      case 'back':
      case 'idle':
        this.feedW = Math.max(0, this.feedW - dt / BACK_T);
        this.mouth *= Math.exp(-dt * 6);
        this.palp *= Math.exp(-dt * 5);
        this.push *= Math.exp(-dt * 8);
        this.twist *= Math.exp(-dt * 8);
        if (this.phase === 'back' && this.feedW <= 0) {
          this.phase = 'idle';
          this.side = null;
          this.food = null;
        }
        break;
    }
    // 空いている方の鋏の手伝い：噛んでいる間、食べ物をつまんでは口へ運ぶ（1 口と同じ周期で、半周ずらす）
    const helper = this.phase === 'chew' ? claws.find((c) => c.side !== this.side && c.target === null) : null;
    this.assist += ((helper ? 1 : 0) - this.assist) * (1 - Math.exp(-dt * 5));
    if (this.phase === 'chew') this.assistPh = (this.bitePh + 0.5) % 1;
    if (this.eating) this.stats.eatT += dt;
  }

  /** 1 口：押し込む（顎脚が開く）→ 噛み取る（閉じる）→ 引き離してちぎる */
  private chewOne(dt: number) {
    const f = this.food!;
    const S = FOOD_KIND[f.kind];
    const prev = this.bitePh;
    this.bitePh += dt / S.bite;
    this.chewT += dt;
    const ph = this.bitePh % 1;
    if (ph < 0.45) {
      this.push = 0.2 + 0.8 * smoothstep(0, 0.45, ph);
      this.mouth += (0.25 + 0.75 * smoothstep(0.05, 0.4, ph) - this.mouth) * (1 - Math.exp(-dt * 18));
    } else if (ph < 0.58) {
      this.push = 1;
      this.mouth += (0.08 - this.mouth) * (1 - Math.exp(-dt * 40));
    } else {
      const u = smoothstep(0.58, 1, ph);
      this.push = 1 - 1.5 * Math.sin(u * Math.PI) * 0.9 - 0.8 * u;
      this.mouth += (0.22 - this.mouth) * (1 - Math.exp(-dt * 10));
    }
    this.twist = ph > 0.55 ? Math.sin(((ph - 0.55) / 0.45) * Math.PI) * (this.bitePh % 2 < 1 ? 1 : -1) : 0;
    this.palp = 0.65 + 0.35 * Math.abs(Math.sin(this.chewT * 7));
    // 噛み取る瞬間（位相 BITE_AT を越えた）
    const crossed = Math.floor(prev - BITE_AT) !== Math.floor(this.bitePh - BITE_AT);
    if (crossed) {
      const total = foodTime(f.kind, f.size);
      const frac = Math.min(f.left, S.bite / total);
      const first = f.left >= 0.999;
      if (first) f.begin();
      const left = Math.max(0, f.left - frac);
      const gain = frac * foodNutrition(f.kind, f.size);
      this.nutrition.add(f.kind, gain);
      this.stats.bites++;
      const done = left <= 1e-4;
      f.setLeft(done ? 0 : left);
      this.events.push({ kind: 'bite', side: this.side!, food: f, amount: frac, gain, left: done ? 0 : left, first });
      if (done) {
        this.nutrition.eaten[f.kind]++;
        this.stats.finished++;
        this.events.push({ kind: 'finish', side: this.side!, food: f });
        f.finish();
        this.phase = 'back';
        this.food = null;
        // 押したままでも、次の物は一度離してから
        this.latched = true;
      }
    }
  }

  private start(side: EatSide, food: Food) {
    const resume = this.phase === 'back' && this.food?.id === food.id;
    // 運んでいる途中から再開するときは、いまの重みから続ける
    this.phase = this.feedW >= 0.92 ? 'chew' : 'bring';
    this.side = side;
    this.food = food;
    this.bitePh = 0;
    this.chewT = 0;
    this.stats.starts++;
    if (resume || food.left < 0.999) this.stats.resumes++;
    this.events.push({ kind: 'start', side, food, resume: resume || food.left < 0.999 });
  }

  private stop(why: 'release' | 'lost') {
    const f = this.food;
    if (f) {
      this.stats.stops++;
      this.events.push({ kind: 'stop', side: this.side!, food: f, left: f.left, why });
    }
    this.phase = 'back';
    if (why === 'lost') this.food = null;
  }

  private taste(side: EatSide, why: EatRefuse, bring: boolean, name: string) {
    this.phase = 'taste';
    this.side = side;
    this.food = null;
    this.tasteT = 0;
    this.tasteBring = bring;
    this.spat = false;
    this.latched = true;
    this.stats.refused++;
    this.events.push({ kind: 'refuse', side, why, name, bring });
  }

  /** すぐやめる（瞬間移動・挟んでいた物が消えた） */
  reset() {
    this.phase = 'idle';
    this.side = null;
    this.food = null;
    this.feedW = this.mouth = this.palp = this.push = this.twist = this.assist = 0;
  }

  drainEvents(): EatEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
