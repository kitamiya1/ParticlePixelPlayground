// 水槽探検のセーブ（ゲームロジック側。Three.js に依存しない）。
// - 保存先：IndexedDB（データベース ppp-aquarium・ストア saves）。掘った空洞は Float64Array のまま構造化複製で入れる
//   （空洞 1 個 = 7 個の数、上限 6000 個でも 336 KB。JSON にしないので書き込みも読み込みも軽い。
//   倍精度のままにするのは、ゲーム中の空洞（JavaScript の数 = 倍精度）と同じ値に戻すため：単精度に丸めると
//   砂の膜の境目に近い格子点の符号が変わりうる＝保存前と三角形がずれる）。
//   IndexedDB が開けない・開くのに時間がかかりすぎた起動（古いブラウザのプライベートモード・まれに遅い端末の初回起動）は
//   localStorage（書き出し形式の文字列）、それも使えなければ保存しない（遊べるが、閉じると消える。画面に出す）。
//   localStorage へ保存した進捗は、次に IndexedDB が開けた起動で引き継ぐ（SaveStore.adoptFallback。両方に別の進捗があれば両方残す）。
// - 鍵：current（いまの進捗）・backup（1 つ前の正常なデータ）・corrupt-<時刻>（読めなかったデータの隔離。最大 3 個）・
//   alt-<時刻>（引き継ぎで current にしなかった方の正常な進捗。最大 3 個。メニューで書き出す・切り替える）。
//   書き込みは「current が正常と分かっているときだけ」current を backup へ写してから current を書く（1 つのトランザクション）。
//   読み込みで current が壊れていたら、current は消さずに隔離し、backup を試す。どちらも読めなければ初期状態で始める
//   （壊れたデータは隔離に残るので、自動保存が上書きしても失われない）。
// - 形式：format = 'ppp-aquarium-save'、version（いまは 3。版 1・2 は migrate で 3 へ直して読む）。読み込みは migrate → validate の順で、validate を通った
//   データだけをゲームへ渡す。未知の場所・仲間の id は捨てる（警告）。形が合わない・数が有限でない・範囲外は全体を拒否する。
// - 書き出し・読み込み（ファイル）：JSON。Float64Array は base64（リトルエンディアン）の文字列にする。
// - 拡張：水槽ごとの tanks[id]（dig：掘った空洞と盛った砂を編集の順に 1 つの並びで持つ。food：食べられた生き物（版 3）。植物・繁殖個体は同じ所へ足す）、
//   プレイヤーの栄養（player.nutrition。版 3）、仲間の traits（遺伝的特徴）、
//   progress.flags（イベントの進み具合）。足すときは version を上げて migrate に変換を書く。

export const SAVE_FORMAT = 'ppp-aquarium-save';
/**
 * 版 3（2026-11-28）：栄養（player.nutrition）と、食べられた生き物（tanks[id].food）を足した。
 * 版 4（2026-11-28）：積み木の検証エリアの物の位置・向き（tanks[id].props）を足した
 */
export const SAVE_VERSION = 4;
/** 編集 1 個の数の並び（a.xyz, b.xyz, r, 種類 0 = 掘った / 1 = 盛った）。版 1 は種類なしの 7 個（PRIM_STRIDE_V1） */
export const PRIM_STRIDE = 8;
export const PRIM_STRIDE_V1 = 7;

export type BuddyMode = 'free' | 'follow';
export type SaveCameraMode = 'adventure' | 'observe' | 'diorama';
export type SaveTool = 'dig' | 'fill';

export interface DigSave {
  /**
   * 掘った空洞と盛った砂（PRIM_STRIDE 個ずつ）。編集した順（順序が地形の合成の順序：後の編集が勝つ。
   * 先に掘った穴へ盛った砂・盛った砂を掘った穴が、読み込み直しても同じ形になる）
   */
  prims: Float64Array;
}

/** 食べられたエビ・小魚（AquaLife の番号。left = 残り、gone = 食べ終えて消えた。位置 = 食べかけが横たわっている所） */
export interface CritterSave {
  kind: 'fish' | 'shrimp';
  i: number;
  left: number;
  gone: boolean;
  x: number;
  y: number;
  z: number;
}

/** 水槽の食べ物の状態（版 3。ゴカイの食べかけは buddies[] の traits の eat・left） */
export interface FoodSave {
  critters: CritterSave[];
}

/** 動かせる物（版 4：積み木の検証エリアの箱）の位置と向き（四元数 x, y, z, w） */
export interface PropSave {
  id: string;
  x: number;
  y: number;
  z: number;
  q: [number, number, number, number];
}

/** 水槽 1 つ分の状態（将来：植物 plants・生き物 creatures を足す） */
export interface TankSave {
  dig: DigSave;
  food: FoodSave;
  /** 版 4 から */
  props: PropSave[];
}

/** 栄養（版 3。経験値に相当する蓄積型：合計・種類ごとに得た量・食べ終えた数。時間では減らない） */
export interface NutritionSave {
  total: number;
  byKind: Record<string, number>;
  eaten: Record<string, number>;
}

export interface PlayerSave {
  tank: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  camera: SaveCameraMode;
  /** 手持ちの砂（体積。0〜SaveContext.sandCap）と、いまの道具（版 2 から） */
  sand: number;
  tool: SaveTool;
  /** 栄養（版 3 から） */
  nutrition: NutritionSave;
}

export interface BuddySave {
  id: string;
  species: string;
  /** 引っこ抜いて仲間になった */
  found: boolean;
  mode: BuddyMode;
  tank: string;
  x: number;
  y: number;
  z: number;
  /** 自由生活の住みか（x, z） */
  home: [number, number];
  /** 個体の特徴（将来の繁殖・レア個体。いまは空） */
  traits: Record<string, number | string>;
}

export interface SaveData {
  format: typeof SAVE_FORMAT;
  version: number;
  /** 最初に作った時刻・最後に保存した時刻（ms） */
  created: number;
  savedAt: number;
  /** 遊んだ時間（秒） */
  playTime: number;
  /**
   * 保存の世代（書くたびに 1 増える）と、更新の識別子（書くたびに新しい値）。複数のタブの競合の判定に使う
   * （SaveStore が書くときに付ける。この 2 つが無い古いデータは rev 0・識別子は内容から作る）
   */
  rev: number;
  saveId: string;
  player: PlayerSave;
  progress: {
    /** 訪れた場所の id */
    visited: string[];
    /** イベントの進み具合（調べた等） */
    flags: Record<string, boolean>;
  };
  tanks: Record<string, TankSave>;
  buddies: BuddySave[];
}

/** 検証に使うゲーム側の情報（知っている id・範囲） */
export interface SaveContext {
  spotIds: ReadonlySet<string>;
  buddyIds: ReadonlySet<string>;
  tankIds: ReadonlySet<string>;
  /** 編集（空洞・盛った砂）の上限・半径の上限・手持ちの砂の上限・水槽の範囲（x, y, z の min / max。少し余白を含む） */
  maxPrims: number;
  maxR: number;
  sandCap: number;
  tankBox: { min: [number, number, number]; max: [number, number, number] };
  /** プレイヤーが居てよい範囲（部屋全体） */
  worldBox: { min: [number, number, number]; max: [number, number, number] };
}

export type ValidateResult = { ok: true; data: SaveData; warnings: string[] } | { ok: false; error: string };

// ---------------- 検証 ----------------

class SaveError extends Error {}

function fail(msg: string): never {
  throw new SaveError(msg);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, what: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} が数ではありません`);
  if (v < min || v > max) fail(`${what} が範囲外です（${v}）`);
  return v;
}

function str(v: unknown, what: string, maxLen = 64): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLen) fail(`${what} が文字列ではありません`);
  return v;
}

function inBox(x: number, y: number, z: number, b: { min: number[]; max: number[] }): boolean {
  return x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2];
}

/** 空洞の並び：Float64Array（IndexedDB）か数の配列（古い形・手で作ったファイル）を受け付け、Float64Array にする */
function readPrims(v: unknown, ctx: SaveContext): Float64Array {
  let src: ArrayLike<number>;
  if (v instanceof Float64Array || v instanceof Float32Array) src = v;
  else if (Array.isArray(v)) src = v as number[];
  else fail('掘った穴のデータの形が違います');
  if (src.length % PRIM_STRIDE !== 0) fail('掘った穴のデータの長さが合いません');
  const n = src.length / PRIM_STRIDE;
  if (n > ctx.maxPrims) fail(`掘った穴が多すぎます（${n} > ${ctx.maxPrims}）`);
  const out = new Float64Array(src.length);
  const B = ctx.tankBox;
  for (let i = 0; i < n; i++) {
    const o = i * PRIM_STRIDE;
    for (let k = 0; k < PRIM_STRIDE; k++) {
      const x = src[o + k];
      if (typeof x !== 'number' || !Number.isFinite(x)) fail(`掘った穴 ${i} に数でない値があります`);
      out[o + k] = x;
    }
    if (!inBox(out[o], out[o + 1], out[o + 2], B) || !inBox(out[o + 3], out[o + 4], out[o + 5], B)) fail(`掘った穴 ${i} が水槽の外にあります`);
    const r = out[o + 6];
    if (!(r > 0.01 && r <= ctx.maxR + 1e-4)) fail(`掘った穴 ${i} の太さが範囲外です（${r}）`);
    if (out[o + 7] !== 0 && out[o + 7] !== 1) fail(`掘った穴 ${i} の種類が違います（${out[o + 7]}）`);
  }
  return out;
}

/** 版 1 の空洞の並び（7 個ずつ）を版 2（8 個ずつ・種類 0 = 掘った）へ。形が違えば null（検証で拒否される） */
function primsV1toV2(v: unknown): Float64Array | null {
  let src: ArrayLike<unknown>;
  if (v instanceof Float64Array || v instanceof Float32Array || Array.isArray(v)) src = v as ArrayLike<unknown>;
  else return null;
  if (src.length % PRIM_STRIDE_V1 !== 0) return null;
  const n = src.length / PRIM_STRIDE_V1;
  const out = new Float64Array(n * PRIM_STRIDE);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < PRIM_STRIDE_V1; k++) {
      const x = src[i * PRIM_STRIDE_V1 + k];
      out[i * PRIM_STRIDE + k] = typeof x === 'number' ? x : NaN;
    }
    out[i * PRIM_STRIDE + 7] = 0;
  }
  return out;
}

/**
 * 旧い版のデータを今の版へ変換する（元のデータは書き換えず、変換した写しを返す）。
 * - 版 1 → 2：空洞の並びに種類（0 = 掘った）を足して 8 個ずつにする。プレイヤーに手持ちの砂 0・道具「掘る」を足す。
 *   掘った穴・仲間・訪れた場所・進み具合はそのまま。版 1 には盛った砂が無いので、合成の順序は掘った順のまま（同じ形）
 * - 版 2 → 3：プレイヤーに栄養 0（何も食べていない）、水槽ごとに食べられた生き物の空の一覧を足す。ほかはそのまま
 * 形が違う所は直さずに残す（validateSave が拒否する）
 */
export function migrate(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  let d: Record<string, unknown> = raw;
  if (d.version === 1) {
    const tanks: Record<string, unknown> = {};
    if (isObj(d.tanks)) {
      for (const [id, t] of Object.entries(d.tanks)) {
        tanks[id] = isObj(t) && isObj(t.dig) ? { ...t, dig: { ...t.dig, prims: primsV1toV2(t.dig.prims) } } : t;
      }
    }
    d = { ...d, version: 2, tanks: isObj(d.tanks) ? tanks : d.tanks, player: isObj(d.player) ? { ...d.player, sand: 0, tool: 'dig' } : d.player };
  }
  if (d.version === 2) {
    const tanks: Record<string, unknown> = {};
    if (isObj(d.tanks)) for (const [id, t] of Object.entries(d.tanks)) tanks[id] = isObj(t) ? { ...t, food: { critters: [] } } : t;
    d = { ...d, version: 3, tanks: isObj(d.tanks) ? tanks : d.tanks, player: isObj(d.player) ? { ...d.player, nutrition: { total: 0, byKind: {}, eaten: {} } } : d.player };
  }
  if (d.version === 3) {
    // 版 3 → 4：水槽ごとに動かせる物の空の一覧（積み木は置いた所から始まる）
    const tanks: Record<string, unknown> = {};
    if (isObj(d.tanks)) for (const [id, t] of Object.entries(d.tanks)) tanks[id] = isObj(t) ? { ...t, props: [] } : t;
    d = { ...d, version: 4, tanks: isObj(d.tanks) ? tanks : d.tanks };
  }
  return d;
}

/** 動かせる物の一覧の検証（id は文字列 64 文字まで・重複は拒否・位置は水槽の中・向きは有限で長さ 0 でない。600 個まで） */
function readProps(v: unknown, id: string, ctx: SaveContext): PropSave[] {
  if (!Array.isArray(v)) fail(`水槽 ${id} の物の一覧の形が違います`);
  if (v.length > 600) fail(`水槽 ${id} の物が多すぎます`);
  const out: PropSave[] = [];
  for (const p of v) {
    if (!isObj(p)) fail(`水槽 ${id} の物の形が違います`);
    const pid = str(p.id, 'prop.id');
    if (out.some((q) => q.id === pid)) fail(`物 ${pid} が重複しています`);
    const x = num(p.x, 'prop.x'), y = num(p.y, 'prop.y'), z = num(p.z, 'prop.z');
    if (!inBox(x, y, z, ctx.tankBox)) fail(`物 ${pid} の位置が水槽の外です`);
    if (!Array.isArray(p.q) || p.q.length !== 4) fail(`物 ${pid} の向きの形が違います`);
    const q = p.q.map((c, i) => num(c, `prop.q[${i}]`, -2, 2)) as [number, number, number, number];
    if (Math.hypot(...q) < 0.5) fail(`物 ${pid} の向きが正しくありません`);
    out.push({ id: pid, x, y, z, q });
  }
  return out;
}

/** 栄養の検証（数でない・負は拒否。種類の名前は 32 文字まで・項目は 16 個まで） */
function readNutrition(v: unknown): NutritionSave {
  if (!isObj(v)) fail('栄養の情報がありません');
  const total = num(v.total, 'player.nutrition.total', 0, 1e9);
  const rec = (r: unknown, what: string): Record<string, number> => {
    const out: Record<string, number> = {};
    if (r === undefined) return out;
    if (!isObj(r)) fail(`${what} の形が違います`);
    for (const [k, x] of Object.entries(r).slice(0, 16)) if (k.length <= 32) out[k] = num(x, `${what}.${k}`, 0, 1e9);
    return out;
  };
  return { total, byKind: rec(v.byKind, 'player.nutrition.byKind'), eaten: rec(v.eaten, 'player.nutrition.eaten') };
}

/** 食べられた生き物の一覧の検証（番号は整数 0〜9999・残り 0..1・位置は水槽の中。同じ個体の重複は拒否） */
function readFood(v: unknown, id: string, ctx: SaveContext): FoodSave {
  if (!isObj(v) || !Array.isArray(v.critters)) fail(`水槽 ${id} の食べ物の情報の形が違います`);
  const critters: CritterSave[] = [];
  for (const c of v.critters) {
    if (!isObj(c)) fail(`水槽 ${id} の食べられた生き物の形が違います`);
    const kind = c.kind === 'fish' || c.kind === 'shrimp' ? c.kind : fail(`水槽 ${id} の食べられた生き物の種類が違います`);
    const i = num(c.i, 'critter.i', 0, 9999);
    if (!Number.isInteger(i)) fail('critter.i が整数ではありません');
    if (critters.some((q) => q.kind === kind && q.i === i)) fail(`食べられた生き物 ${kind}${i} が重複しています`);
    const left = num(c.left, 'critter.left', 0, 1);
    if (typeof c.gone !== 'boolean') fail('critter.gone の形が違います');
    const x = num(c.x, 'critter.x'), y = num(c.y, 'critter.y'), z = num(c.z, 'critter.z');
    if (!inBox(x, y, z, ctx.tankBox)) fail(`食べられた生き物 ${kind}${i} の位置が水槽の外です`);
    critters.push({ kind, i, left, gone: c.gone, x, y, z });
  }
  return { critters };
}

/** 保存データを検証して、ゲームへ渡せる形にする（知らない id は捨てて警告にする。形が違えば拒否） */
export function validateSave(input: unknown, ctx: SaveContext): ValidateResult {
  const warnings: string[] = [];
  try {
    const raw = migrate(input);
    if (!isObj(raw)) fail('保存データではありません');
    if (raw.format !== SAVE_FORMAT) fail('別のゲームの保存データです');
    const version = num(raw.version, 'version', 1, 1e6);
    if (version > SAVE_VERSION) fail(`新しい版（${version}）の保存データです。ページを更新してください`);
    if (version !== SAVE_VERSION) fail(`対応していない版（${version}）です`);
    const created = num(raw.created, 'created', 0);
    const savedAt = num(raw.savedAt, 'savedAt', 0);
    const playTime = num(raw.playTime, 'playTime', 0, 1e9);
    const rev = raw.rev === undefined ? 0 : num(raw.rev, 'rev', 0, 1e12);
    const saveId = raw.saveId === undefined ? '' : typeof raw.saveId === 'string' && raw.saveId.length <= 64 ? raw.saveId : fail('saveId の形が違います');

    const P = raw.player;
    if (!isObj(P)) fail('プレイヤーの情報がありません');
    const tank = str(P.tank, 'player.tank');
    if (!ctx.tankIds.has(tank)) fail(`知らない水槽です（${tank}）`);
    const px = num(P.x, 'player.x'), py = num(P.y, 'player.y'), pz = num(P.z, 'player.z');
    if (!inBox(px, py, pz, ctx.worldBox)) fail('プレイヤーの位置が範囲外です');
    const heading = num(P.heading, 'player.heading', -100, 100);
    const camera: SaveCameraMode = P.camera === 'observe' || P.camera === 'diorama' ? P.camera : 'adventure';
    // 手持ちの砂：上限（sandCap。第 10 段階からは持てる量の上限が無いので、水槽の砂より十分大きい検証用の値）を少し超える程度は丸める。負・数でないものは拒否
    const sand = Math.min(num(P.sand, 'player.sand', 0, ctx.sandCap * 4), ctx.sandCap);
    const tool: SaveTool = P.tool === 'fill' ? 'fill' : 'dig';
    const nutrition = readNutrition(P.nutrition);

    const G = raw.progress;
    if (!isObj(G)) fail('進捗の情報がありません');
    if (!Array.isArray(G.visited)) fail('訪れた場所の一覧がありません');
    const visited: string[] = [];
    for (const id of G.visited) {
      if (typeof id !== 'string') fail('訪れた場所の id が文字列ではありません');
      if (ctx.spotIds.has(id)) {
        if (!visited.includes(id)) visited.push(id);
      } else warnings.push(`知らない場所 ${id} を捨てました`);
    }
    const flags: Record<string, boolean> = {};
    if (G.flags !== undefined) {
      if (!isObj(G.flags)) fail('flags の形が違います');
      for (const [k, v] of Object.entries(G.flags)) if (typeof v === 'boolean' && k.length <= 64) flags[k] = v;
    }

    const T = raw.tanks;
    if (!isObj(T)) fail('水槽の情報がありません');
    const tanks: Record<string, TankSave> = {};
    for (const [id, t] of Object.entries(T)) {
      if (!ctx.tankIds.has(id)) {
        warnings.push(`知らない水槽 ${id} を捨てました`);
        continue;
      }
      if (!isObj(t) || !isObj(t.dig)) fail(`水槽 ${id} の情報の形が違います`);
      tanks[id] = { dig: { prims: readPrims(t.dig.prims, ctx) }, food: readFood(t.food, id, ctx), props: readProps(t.props, id, ctx) };
    }

    const buddies: BuddySave[] = [];
    if (!Array.isArray(raw.buddies)) fail('仲間の一覧がありません');
    for (const b of raw.buddies) {
      if (!isObj(b)) fail('仲間の情報の形が違います');
      const id = str(b.id, 'buddy.id');
      if (!ctx.buddyIds.has(id)) {
        warnings.push(`知らない仲間 ${id} を捨てました`);
        continue;
      }
      if (buddies.some((q) => q.id === id)) fail(`仲間 ${id} が重複しています`);
      const btank = str(b.tank, 'buddy.tank');
      if (!ctx.tankIds.has(btank)) fail(`仲間 ${id} の水槽が違います`);
      const bx = num(b.x, 'buddy.x'), by = num(b.y, 'buddy.y'), bz = num(b.z, 'buddy.z');
      if (!inBox(bx, by, bz, ctx.tankBox)) fail(`仲間 ${id} の位置が水槽の外です`);
      if (!Array.isArray(b.home) || b.home.length !== 2) fail(`仲間 ${id} の住みかの形が違います`);
      const home: [number, number] = [num(b.home[0], 'buddy.home.x', ctx.tankBox.min[0], ctx.tankBox.max[0]), num(b.home[1], 'buddy.home.z', ctx.tankBox.min[2], ctx.tankBox.max[2])];
      if (typeof b.found !== 'boolean') fail(`仲間 ${id} の発見の状態が違います`);
      const traits: Record<string, number | string> = {};
      if (isObj(b.traits)) for (const [k, v] of Object.entries(b.traits)) if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 64)) traits[k] = v;
      buddies.push({ id, species: str(b.species, 'buddy.species'), found: b.found, mode: b.mode === 'follow' ? 'follow' : 'free', tank: btank, x: bx, y: by, z: bz, home, traits });
    }

    return { ok: true, warnings, data: { format: SAVE_FORMAT, version, created, savedAt, playTime, rev, saveId, player: { tank, x: px, y: py, z: pz, heading, camera, sand, tool, nutrition }, progress: { visited, flags }, tanks, buddies } };
  } catch (e) {
    if (e instanceof SaveError) return { ok: false, error: e.message };
    return { ok: false, error: `読み込めませんでした（${(e as Error).message}）` };
  }
}

// ---------------- 書き出し・読み込み（ファイル） ----------------

function f64ToBase64(a: Float64Array): string {
  // リトルエンディアンで固定（DataView で書く）
  const buf = new ArrayBuffer(a.length * 8);
  const dv = new DataView(buf);
  for (let i = 0; i < a.length; i++) dv.setFloat64(i * 8, a[i], true);
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToF64(s: string): Float64Array {
  const bin = atob(s);
  if (bin.length % 8 !== 0) fail('掘った穴のデータが壊れています');
  const dv = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
  const out = new Float64Array(bin.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat64(i * 8, true);
  return out;
}

/** 保存データ → 書き出すファイルの文字列（JSON。空洞は base64） */
export function encodeSaveFile(d: SaveData): string {
  const tanks: Record<string, unknown> = {};
  for (const [id, t] of Object.entries(d.tanks)) tanks[id] = { ...t, dig: { prims: { f64: f64ToBase64(t.dig.prims) } } };
  return JSON.stringify({ ...d, tanks });
}

/** ファイルの文字列 → 検証前のデータ（base64 を Float64Array に戻す。形が違うところは validateSave が拒否する） */
export function decodeSaveFile(text: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || !isObj(raw.tanks)) return raw;
  const tanks: Record<string, unknown> = {};
  for (const [id, t] of Object.entries(raw.tanks)) {
    if (isObj(t) && isObj(t.dig) && isObj(t.dig.prims) && typeof t.dig.prims.f64 === 'string') {
      try {
        tanks[id] = { ...t, dig: { ...t.dig, prims: base64ToF64(t.dig.prims.f64) } };
      } catch {
        tanks[id] = { ...t, dig: { prims: null } };
      }
    } else tanks[id] = t;
  }
  return { ...raw, tanks };
}

// ---------------- 保存先 ----------------
//
// 複数のタブ（ウィンドウ）で同時に開いたとき：保存するたびに新しい saveId（更新の識別子）と rev（世代）を付け、
// タブは「最後に読んだ / 書いた current の識別子（knownToken）」を覚えておく。書くときは 1 つのトランザクションの中で
// current を読み、識別子が knownToken と同じときだけ書く（比べて書く = compare-and-swap）。違えば別のタブが先に
// 進めたので、書かずに競合（conflict）を返す。IndexedDB の readwrite のトランザクションは、同じストアに触れるものどうし
// 順番に実行される（他のタブの書き込みが割り込まない）ので、読んだ値と書く判断が食い違わない。
// 初期状態に戻す・ファイルの読み込みは、利用者が明示した置き換えなので比べずに書く（いまの current は backup へ回す）。
// どちらも他のタブへ BroadcastChannel で知らせ、知らされたタブは次に書く前に競合として扱う。

/** current の識別子（比べる値）。無い = null、壊れていて識別子が読めないものは内容から作る（同じ物なら同じ値） */
export function saveToken(raw: unknown): string | null {
  if (raw === undefined || raw === null) return raw === null ? 'bad:null' : null;
  if (isObj(raw)) {
    if (typeof raw.saveId === 'string' && raw.saveId) return raw.saveId;
    return `legacy:${typeof raw.savedAt === 'number' ? raw.savedAt : 'x'}:${typeof raw.version === 'number' ? raw.version : 'x'}`;
  }
  return `bad:${typeof raw}:${String(raw).slice(0, 64)}`;
}

function revOf(raw: unknown): number {
  return isObj(raw) && typeof raw.rev === 'number' && Number.isFinite(raw.rev) ? raw.rev : 0;
}

/** alt の鍵：alt-<時刻（13 桁）>-<乱数>（文字列の並びが時刻の順） */
function altKey(): string {
  return `alt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 比べて書いた結果（conflict = current がほかのタブで変わっていた。書いていない） */
export type CommitResult = { ok: true } | { ok: false; conflict: { token: string | null; rev: number; savedAt: number | null } };

interface CommitOpts {
  /** current の識別子がこれと同じときだけ書く（undefined = 比べない） */
  expect?: string | null;
  /** いまの current を backup へ回すか（current を受け取って決める。正常な保存データのときだけ回す） */
  rotate: (cur: unknown) => boolean;
  /** いまの current を別の鍵にも残す（[鍵, 値]。null なら残さない）。書くのと同じまとまりの中で */
  stash?: (cur: unknown) => [string, unknown] | null;
}

interface Backend {
  readonly kind: 'indexeddb' | 'localStorage' | 'memory';
  get(key: string): Promise<unknown>;
  /** current を比べて書く（value = null なら current を消す）。読む・比べる・backup へ回す・書くは 1 つのまとまり */
  commit(value: SaveData | null, o: CommitOpts): Promise<CommitResult>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const DB_NAME = 'ppp-aquarium';
const STORE = 'saves';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function conflictOf(cur: unknown): CommitResult {
  return { ok: false, conflict: { token: saveToken(cur), rev: revOf(cur), savedAt: isObj(cur) && typeof cur.savedAt === 'number' ? cur.savedAt : null } };
}

class IdbBackend implements Backend {
  readonly kind = 'indexeddb' as const;
  private constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<IdbBackend> {
    return new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('IndexedDB がありません'));
      let r: IDBOpenDBRequest;
      try {
        r = indexedDB.open(DB_NAME, 1);
      } catch (e) {
        return rej(e);
      }
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      let done = false;
      r.onsuccess = () => {
        done = true;
        res(new IdbBackend(r.result));
      };
      r.onerror = () => {
        done = true;
        rej(r.error);
      };
      r.onblocked = () => {
        done = true;
        rej(new Error('IndexedDB が他のタブで使われています'));
      };
      // 開くのに時間がかかりすぎる環境（まれ）は諦めて次の保存先へ。
      // 待った時間は「主スレッドが空いていた時間」で数える：開くのと並行して重い生成（数秒、同期）が走るので、
      // 壁時計の 4 秒で打ち切ると、開けていても成功の知らせが届く前に打ち切りが先に動き、localStorage へ落ちることがある
      // （Edge の新しいプロファイル・アプリ版の初回起動で再現。生成に 4.5〜5 秒かかった）。1 回の刻みで数えるのは最大 0.5 秒
      let waited = 0;
      let last = performance.now();
      const tick = () => {
        if (done) return;
        const now = performance.now();
        waited += Math.min(now - last, 500);
        last = now;
        if (waited >= 4000) {
          done = true;
          rej(new Error('IndexedDB が応答しません'));
        } else setTimeout(tick, 250);
      };
      setTimeout(tick, 250);
    });
  }

  /** 書き込みのトランザクション。durability: 'strict' = 完了の知らせはディスクへ書けてから（対応しないブラウザは無視する） */
  private tx(): IDBTransaction {
    try {
      return this.db.transaction(STORE, 'readwrite', { durability: 'strict' });
    } catch {
      return this.db.transaction(STORE, 'readwrite');
    }
  }

  get(key: string) {
    return req(this.db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  }

  commit(value: SaveData | null, o: CommitOpts): Promise<CommitResult> {
    return new Promise((res, rej) => {
      const tx = this.tx();
      const st = tx.objectStore(STORE);
      let result: CommitResult = { ok: true };
      const g = st.get('current');
      // 読んだ値を見て、同じトランザクションの中で書く（ほかのタブの書き込みはこの間に入らない）
      g.onsuccess = () => {
        const cur = g.result;
        if (o.expect !== undefined && saveToken(cur) !== o.expect) {
          result = conflictOf(cur);
          return; // 何も書かずに終わる
        }
        if (cur !== undefined && o.rotate(cur)) st.put(cur, 'backup');
        const keep = cur !== undefined ? o.stash?.(cur) : null;
        if (keep) st.put(keep[1], keep[0]);
        if (value) st.put(value, 'current');
        else st.delete('current');
      };
      tx.oncomplete = () => res(result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error ?? new Error('保存が中断されました'));
    });
  }

  async put(key: string, value: unknown) {
    const tx = this.tx();
    tx.objectStore(STORE).put(value, key);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async del(key: string) {
    const tx = this.tx();
    tx.objectStore(STORE).delete(key);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async keys() {
    return (await req(this.db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys())).map(String);
  }
}

/** localStorage：書き出し形式の文字列で入れる（同期の API なので、読む・比べる・書くの間にほかのタブの処理は入らない） */
/** localStorage の保存先の鍵の頭（ppp-aquarium:current など。IndexedDB のときの引き継ぎでも読む） */
const LS_PREFIX = 'ppp-aquarium:';

class LocalBackend implements Backend {
  readonly kind = 'localStorage' as const;
  private readonly prefix = LS_PREFIX;

  static open(): LocalBackend {
    const k = 'ppp-aquarium:test';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return new LocalBackend();
  }

  async get(key: string) {
    const s = localStorage.getItem(this.prefix + key);
    return s === null ? undefined : decodeSaveFile(s);
  }

  async commit(value: SaveData | null, o: CommitOpts): Promise<CommitResult> {
    const curText = localStorage.getItem(this.prefix + 'current');
    const cur = curText === null ? undefined : decodeSaveFile(curText);
    if (o.expect !== undefined && saveToken(cur) !== o.expect) return conflictOf(cur);
    const text = value ? encodeSaveFile(value) : null;
    if (curText !== null && o.rotate(cur)) localStorage.setItem(this.prefix + 'backup', curText);
    const keep = curText !== null ? o.stash?.(cur) : null;
    if (keep) localStorage.setItem(this.prefix + keep[0], curText!);
    if (text !== null) localStorage.setItem(this.prefix + 'current', text);
    else localStorage.removeItem(this.prefix + 'current');
    return { ok: true };
  }

  async put(key: string, value: unknown) {
    let s: string;
    if (typeof value === 'string') s = value;
    else {
      // 読み込んだ形（Float64Array 入り）は書き出し形式へ戻す。壊れていて戻せなければそのまま JSON に
      try {
        s = encodeSaveFile(value as SaveData);
      } catch {
        s = JSON.stringify(value);
      }
    }
    localStorage.setItem(this.prefix + key, s);
  }

  async del(key: string) {
    localStorage.removeItem(this.prefix + key);
  }

  async keys() {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(this.prefix) && !k.startsWith(JOURNAL_PREFIX)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }
}

class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private readonly m = new Map<string, unknown>();
  async get(key: string) {
    return this.m.get(key);
  }
  async commit(value: SaveData | null, o: CommitOpts): Promise<CommitResult> {
    const cur = this.m.get('current');
    if (o.expect !== undefined && saveToken(cur) !== o.expect) return conflictOf(cur);
    if (cur !== undefined && o.rotate(cur)) this.m.set('backup', cur);
    const keep = cur !== undefined ? o.stash?.(cur) : null;
    if (keep) this.m.set(keep[0], keep[1]);
    if (value) this.m.set('current', value);
    else this.m.delete('current');
    return { ok: true };
  }
  async put(key: string, value: unknown) {
    this.m.set(key, value);
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async keys() {
    return [...this.m.keys()];
  }
}

// ---------------- 閉じる直前の控え（ジャーナル） ----------------
//
// IndexedDB の書き込みは非同期で、ページが隠れた・閉じられた直後にブラウザがページを止める（iPhone の Safari でアプリを
// 切り替えた・タブを閉じた等）と、書き込みが終わらないことがある。そこで、ページが隠れるときに未保存の変化があれば、
// 同期の API（localStorage）へ「控え」を書いてから IndexedDB へ書く。IndexedDB へ書けたら控えを消す。
// 次に開いたとき、控えが残っていて、current がまだ控えの元にした状態（bases のどれか）なら、控えの方が新しいので使う。
// current がほかのタブで進んでいたら使わず、「使わなかった進捗」として残して書き出せるようにする。
// 控えも、ブラウザがページを止める前に書けることを保証するものではない（同期の書き込みは止められる前に終わりやすい、まで）。

const JOURNAL_PREFIX = 'ppp-aquarium:journal';
/** タブごとの控えの鍵（ppp-aquarium:journal:<タブの id>）。ほかのタブの控えを消さない */
const JOURNAL_TAB = 'ppp-aquarium:journal:';
const ORPHAN_KEY = 'ppp-aquarium:journal-orphan';

function journalKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(JOURNAL_TAB)) out.push(k);
    }
  } catch {
    /* localStorage が使えない */
  }
  return out;
}

interface Journal {
  /** 控えを使ってよい current の識別子（控えを書いたときの current と、書いている途中の保存の識別子） */
  bases: (string | null)[];
  saveId: string;
  rev: number;
  savedAt: number;
  data: string;
}

function readJournal(key: string): Journal | null {
  try {
    const s = localStorage.getItem(key);
    if (!s) return null;
    const j = JSON.parse(s) as Journal;
    return Array.isArray(j.bases) && typeof j.saveId === 'string' && typeof j.data === 'string' ? j : null;
  } catch {
    return null;
  }
}

export type LoadResult =
  /** 保存データが無い（初めて・初期状態に戻した） */
  | { status: 'empty' }
  | { status: 'ok'; data: SaveData; warnings: string[] }
  /** current が読めず、backup から戻した */
  | { status: 'recovered'; data: SaveData; warnings: string[]; error: string }
  /** どちらも読めない（初期状態で始める。壊れたデータは隔離した） */
  | { status: 'corrupt'; error: string };

export interface LoadInfo {
  /** 閉じる直前の控えから戻した（IndexedDB への書き込みが終わっていなかった） */
  fromJournal: boolean;
  /** 控えがあったが、ほかのタブの保存の方が新しかったので使わなかった（書き出せる） */
  orphan: boolean;
  /**
   * この起動で予備の保存先（localStorage）の進捗を引き継いだ（adoptFallback）。無ければ null。
   * imported = IndexedDB に進捗が無かった（読めなかった）ので、localStorage の進捗を current にした。
   * kept = 両方に別の進捗があった：保存した時刻が新しい方（chosen）を current にし、もう一方を alt に残した
   */
  fallback: { result: 'imported' | 'kept'; chosen: 'indexeddb' | 'localStorage' } | null;
  /** 引き継ぎで current にしなかった方の進捗（いちばん新しい alt）。無ければ null */
  alt: { key: string; savedAt: number; playTime: number } | null;
}

export interface SaveConflict {
  /** いま保存先にある current（ほかのタブが書いた）の世代と保存時刻。消されていれば null */
  rev: number;
  savedAt: number | null;
  /** どうして分かったか：書こうとした / ほかのタブからの知らせ / タブへ戻ったときの確認 */
  via: 'write' | 'broadcast' | 'check';
  /** ほかのタブが初期状態に戻した（current が無い） */
  removed: boolean;
}

export type SaveOutcome = 'ok' | 'conflict' | 'error';

/**
 * 保存先（IndexedDB → localStorage → メモリの順に使えるもの）。
 * current が正常と分かっている（読めた・自分で書いた）ときだけ、書くときに backup へ回す。
 * 書くときは、このタブが最後に読んだ / 書いた current の識別子と比べ、違えば書かない（競合）
 */
export class SaveStore {
  /** current が正常なデータか（壊れた current を backup へ回して、正常な backup を消さない） */
  private currentGood = false;
  /** このタブが最後に読んだ / 書いた current の識別子（null = current が無かった）と世代 */
  private knownToken: string | null = null;
  knownRev = 0;
  /** 競合（ほかのタブが current を進めた・消した）。一度なったら、このタブからは書かない */
  conflict: SaveConflict | null = null;
  readonly tabId = newId();
  private ctx: SaveContext | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  /** 書いている途中の保存の識別子（控えの bases に入れる） */
  private inflight: string | null = null;
  /** このタブの控えの鍵・起動時に使った（ほかのタブが残した）控えの鍵（書けたら消す） */
  private get journalKey() {
    return JOURNAL_TAB + this.tabId;
  }
  private consumed: string | null = null;
  private channel: BroadcastChannel | null = null;
  private readonly conflictHooks: ((c: SaveConflict) => void)[] = [];
  readonly info: LoadInfo = { fromJournal: false, orphan: false, fallback: null, alt: null };
  readonly stats = { writes: 0, conflicts: 0, lastWriteMs: 0, maxWriteMs: 0, lastBytes: 0, failures: 0, lastError: '', journals: 0 };

  private constructor(private readonly be: Backend) {
    if (be.kind !== 'memory' && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('ppp-aquarium-save');
        this.channel.onmessage = (e: MessageEvent) => {
          const m = e.data as { tab?: string; token?: string | null; rev?: number; savedAt?: number | null; removed?: boolean };
          if (!m || m.tab === this.tabId || m.token === this.knownToken) return;
          this.setConflict({ rev: m.rev ?? 0, savedAt: m.savedAt ?? null, via: 'broadcast', removed: !!m.removed });
        };
      } catch {
        this.channel = null;
      }
    }
  }

  get kind() {
    return this.be.kind;
  }

  /** 控え（ジャーナル）を使うか：IndexedDB のときだけ（localStorage は同期で書けるので要らない） */
  get journaled(): boolean {
    return this.be.kind === 'indexeddb';
  }

  /** memory = true：保存しない（自動検証で前のページの状態を持ち込まない ?nosave） */
  static async open(opts: { memory?: boolean } = {}): Promise<SaveStore> {
    if (opts.memory) return new SaveStore(new MemoryBackend());
    try {
      return new SaveStore(await IdbBackend.open());
    } catch {
      /* 次へ */
    }
    try {
      return new SaveStore(LocalBackend.open());
    } catch {
      return new SaveStore(new MemoryBackend());
    }
  }

  onConflict(fn: (c: SaveConflict) => void) {
    this.conflictHooks.push(fn);
  }

  private setConflict(c: SaveConflict) {
    if (this.conflict) return;
    this.conflict = c;
    this.stats.conflicts++;
    for (const f of this.conflictHooks) f(c);
  }

  private isGood = (raw: unknown): boolean => (this.ctx ? validateSave(raw, this.ctx).ok : false);

  /** 読めなかったデータを隔離する（古いものから消して最大 3 個） */
  private async quarantine(v: unknown) {
    try {
      const keys = (await this.be.keys()).filter((k) => k.startsWith('corrupt-')).sort();
      while (keys.length >= 3) await this.be.del(keys.shift()!);
      await this.be.put(`corrupt-${Date.now()}`, v);
    } catch {
      /* 隔離できなくても、current を書き換えなければ元のデータは残る */
    }
  }

  /**
   * 予備の保存先（localStorage）に残った進捗の引き継ぎ（IndexedDB のときだけ。load の最初）。
   * IndexedDB を開けなかった起動は localStorage に保存する。その後の起動で IndexedDB が開けたとき、localStorage の進捗を見ないと
   * 進捗が消えたように見える（docs/app-packaging/report.md 5.1）。
   * - 候補は localStorage の current（読めなければ backup）。どちらも検証を通らなければ何もしない（localStorage にも触れない）。
   * - IndexedDB の current と同じ（識別子が同じ）：引き継ぎ済み。localStorage の分を消すだけ。
   * - IndexedDB の current が無い・読めない：候補を current にする（読めない current は隔離してから）。
   * - 両方に別の正常な進捗がある：どちらも上書きしない。保存した時刻が新しい方を current にし、もう一方は alt-<時刻> に残す
   *   （IndexedDB の方を残すときは、current を書き換えるのと同じトランザクションで）。メニューで書き出す・切り替えられる。
   * IndexedDB へ書けてから（トランザクションの完了）localStorage の分を消す。書く前にほかのタブが current を進めていたら
   * （比べて書く）何もせず、localStorage の分も残す（次の起動でもう一度）
   */
  private async adoptFallback(ctx: SaveContext): Promise<void> {
    let curText: string | null, bakText: string | null;
    try {
      curText = localStorage.getItem(LS_PREFIX + 'current');
      bakText = localStorage.getItem(LS_PREFIX + 'backup');
    } catch {
      return; // localStorage が使えない = 引き継ぐものも無い
    }
    let cand: SaveData | null = null;
    let curBad = false;
    for (const t of [curText, bakText]) {
      if (t === null) continue;
      const r = validateSave(decodeSaveFile(t), ctx);
      if (r.ok) {
        cand = r.data;
        break;
      }
      if (t === curText) curBad = true;
    }
    if (!cand) return;
    const idbCur = await this.be.get('current');
    const token = saveToken(idbCur);
    const clearLocal = async () => {
      // 読めなかった localStorage の current も、消す前に IndexedDB の隔離へ写す
      if (curBad && curText !== null) await this.quarantine(curText);
      localStorage.removeItem(LS_PREFIX + 'current');
      localStorage.removeItem(LS_PREFIX + 'backup');
    };
    if (token !== null && token === saveToken(cand)) return clearLocal();
    const idb = idbCur === undefined ? null : validateSave(idbCur, ctx);
    if (!idb || !idb.ok) {
      if (idbCur !== undefined) await this.quarantine(idbCur);
      const r = await this.be.commit(cand, { expect: token, rotate: () => false });
      if (!r.ok) return;
      this.info.fallback = { result: 'imported', chosen: 'localStorage' };
    } else if (cand.savedAt > idb.data.savedAt) {
      const r = await this.be.commit(cand, { expect: token, rotate: () => true, stash: (cur) => [altKey(), cur] });
      if (!r.ok) return;
      this.info.fallback = { result: 'kept', chosen: 'localStorage' };
    } else {
      await this.putAlt(cand);
      this.info.fallback = { result: 'kept', chosen: 'indexeddb' };
    }
    await clearLocal();
  }

  /** alt の鍵（新しい順に並ぶよう時刻を頭に） */
  private async altKeys(): Promise<string[]> {
    return (await this.be.keys()).filter((k) => k.startsWith('alt-')).sort();
  }

  /** 引き継ぎで current にしなかった進捗を残す（同じ識別子のものがあれば足さない。古いものから消して最大 3 個） */
  private async putAlt(d: SaveData) {
    const keys = await this.altKeys();
    for (const k of keys) if (saveToken(await this.be.get(k)) === saveToken(d)) return;
    while (keys.length >= 3) await this.be.del(keys.shift()!);
    await this.be.put(altKey(), d);
  }

  /** いちばん新しい alt を info.alt へ（読めないものは飛ばす） */
  private async refreshAlt() {
    this.info.alt = null;
    if (!this.ctx) return;
    const keys = await this.altKeys().catch(() => [] as string[]);
    for (const key of keys.reverse()) {
      const r = validateSave(await this.be.get(key).catch(() => undefined), this.ctx);
      if (r.ok) {
        this.info.alt = { key, savedAt: r.data.savedAt, playTime: r.data.playTime };
        return;
      }
    }
  }

  /** 残した進捗（info.alt）を書き出す文字列（無ければ null） */
  async altText(): Promise<string | null> {
    if (!this.info.alt || !this.ctx) return null;
    const r = validateSave(await this.be.get(this.info.alt.key), this.ctx);
    return r.ok ? encodeSaveFile(r.data) : null;
  }

  /** 残した進捗を消す（書き出した後） */
  async dropAlt() {
    if (!this.info.alt) return;
    await this.be.del(this.info.alt.key);
    await this.refreshAlt();
  }

  /**
   * 残した進捗（info.alt）へ切り替える（明示した操作）：いまの current は alt に残してから置き換える（どちらも消えない）。
   * 書けたら true（呼んだ側が読み込み直す）
   */
  async swapAlt(): Promise<boolean> {
    if (!this.info.alt || !this.ctx) return false;
    const key = this.info.alt.key;
    const r = validateSave(await this.be.get(key), this.ctx);
    if (!r.ok) return false;
    if (!(await this.replace(r.data, true))) return false;
    await this.be.del(key);
    await this.refreshAlt();
    return true;
  }

  async load(ctx: SaveContext): Promise<LoadResult> {
    this.ctx = ctx;
    if (this.be.kind === 'indexeddb') {
      try {
        await this.adoptFallback(ctx);
      } catch {
        /* 引き継げなくても localStorage の分は消していないので、次の起動でもう一度 */
      }
      await this.refreshAlt();
    }
    let cur: unknown;
    try {
      cur = await this.be.get('current');
    } catch (e) {
      // 読めないまま書くと上書きしてしまうので、このタブからは書かない
      this.knownToken = 'unreadable';
      return { status: 'corrupt', error: `保存先を読めませんでした（${(e as Error).message}）` };
    }
    this.knownToken = saveToken(cur);
    this.knownRev = revOf(cur);
    // 閉じる直前の控え
    if (this.journaled) {
      // タブごとの控え（閉じたタブのものが残っている）。current がまだその元の状態のものを使う（いちばん新しい 1 つ）
      let use: { key: string; j: Journal; data: SaveData; warnings: string[] } | null = null;
      for (const key of journalKeys()) {
        const j = readJournal(key);
        if (!j || j.saveId === this.knownToken) {
          localStorage.removeItem(key); // 壊れている・IndexedDB へ書けていた
          continue;
        }
        // ほかのタブがその後に保存した（current が元の状態でない）：使わずに残す（書き出せる）
        if (!j.bases.includes(this.knownToken)) {
          this.orphanize(key, j);
          continue;
        }
        const r = validateSave(decodeSaveFile(j.data), ctx);
        if (!r.ok) {
          localStorage.removeItem(key);
          continue;
        }
        if (use && use.j.savedAt >= j.savedAt) {
          this.orphanize(key, j);
          continue;
        }
        if (use) this.orphanize(use.key, use.j);
        use = { key, j, data: r.data, warnings: r.warnings };
      }
      this.info.orphan = !!readJournal(ORPHAN_KEY);
      if (use) {
        // current は控えの元にした状態のまま＝控えの方が新しい。current を書き換えるのは次の保存（比べて書く）。
        // 世代は控えより後にする。書けたら控えを消す（consumed）
        this.currentGood = cur !== undefined && validateSave(cur, ctx).ok;
        this.knownRev = Math.max(this.knownRev, use.j.rev);
        this.consumed = use.key;
        this.info.fromJournal = true;
        return { status: 'ok', data: use.data, warnings: use.warnings };
      }
    }
    if (cur === undefined) {
      this.currentGood = false;
      return { status: 'empty' };
    }
    const r = validateSave(cur, ctx);
    if (r.ok) {
      this.currentGood = true;
      return { status: 'ok', data: r.data, warnings: r.warnings };
    }
    this.currentGood = false;
    await this.quarantine(cur);
    let bak: unknown;
    try {
      bak = await this.be.get('backup');
    } catch {
      bak = undefined;
    }
    if (bak !== undefined) {
      const b = validateSave(bak, ctx);
      if (b.ok) {
        this.knownRev = Math.max(this.knownRev, b.data.rev);
        return { status: 'recovered', data: b.data, warnings: b.warnings, error: r.error };
      }
    }
    return { status: 'corrupt', error: r.error };
  }

  /** 次に書く保存に識別子と世代を付ける（控えと IndexedDB への書き込みで同じものを使う） */
  stamp(d: SaveData): SaveData {
    d.saveId = newId();
    d.rev = this.knownRev + 1;
    return d;
  }

  /**
   * 閉じる直前の控えを同期で書く（ページが隠れるとき。stamp 済みの d）。
   * 競合しているタブ・IndexedDB 以外では書かない
   */
  writeJournal(d: SaveData): boolean {
    if (!this.journaled || this.conflict) return false;
    try {
      const j: Journal = { bases: [this.knownToken, this.inflight].filter((v, i, a) => a.indexOf(v) === i), saveId: d.saveId, rev: d.rev, savedAt: d.savedAt, data: encodeSaveFile(d) };
      localStorage.setItem(this.journalKey, JSON.stringify(j));
      this.stats.journals++;
      return true;
    } catch {
      return false;
    }
  }

  private broadcast(removed: boolean) {
    try {
      this.channel?.postMessage({ tab: this.tabId, token: this.knownToken, rev: this.knownRev, savedAt: Date.now(), removed });
    } catch {
      /* 知らせられなくても、書くときに比べるので上書きはしない */
    }
  }

  /** 書く（前の書き込みが終わってから。順番は呼んだ順）。d は stamp 済みでなければ付ける。競合なら書かない */
  save(d: SaveData): Promise<SaveOutcome> {
    if (!d.saveId) this.stamp(d);
    const run = async (): Promise<SaveOutcome> => {
      if (this.conflict) return 'conflict';
      // 前の書き込みの後に stamp したものでなければ世代を進める（識別子はそのまま：控えと同じ値）
      if (d.rev <= this.knownRev) d.rev = this.knownRev + 1;
      const t0 = performance.now();
      this.inflight = d.saveId;
      try {
        const r = await this.be.commit(d, { expect: this.knownToken, rotate: () => this.currentGood });
        if (!r.ok) {
          this.setConflict({ rev: r.conflict.rev, savedAt: r.conflict.savedAt, via: 'write', removed: r.conflict.token === null });
          return 'conflict';
        }
        this.currentGood = true;
        this.knownToken = d.saveId;
        this.knownRev = d.rev;
        // 控えが今書いたもの（かそれより前）なら消す
        if (this.journaled) this.clearJournals(d);
        this.broadcast(false);
        const ms = performance.now() - t0;
        this.stats.writes++;
        this.stats.lastWriteMs = ms;
        this.stats.maxWriteMs = Math.max(this.stats.maxWriteMs, ms);
        let bytes = 512;
        for (const t of Object.values(d.tanks)) bytes += t.dig.prims.byteLength;
        this.stats.lastBytes = bytes;
        return 'ok';
      } catch (e) {
        this.stats.failures++;
        this.stats.lastError = (e as Error)?.message ?? String(e);
        return 'error';
      } finally {
        this.inflight = null;
      }
    };
    const p = this.writing.then(run);
    this.writing = p;
    return p;
  }

  /** タブへ戻ったとき等：current がほかのタブで変わっていないか確かめる（変わっていれば競合にする） */
  async check(): Promise<boolean> {
    if (this.conflict || this.knownToken === 'unreadable') return !!this.conflict;
    await this.writing;
    try {
      const cur = await this.be.get('current');
      const t = saveToken(cur);
      if (t !== this.knownToken) this.setConflict({ rev: revOf(cur), savedAt: isObj(cur) && typeof cur.savedAt === 'number' ? cur.savedAt : null, via: 'check', removed: t === null });
    } catch {
      /* 読めなければ次の書き込みで比べる */
    }
    return !!this.conflict;
  }

  /**
   * 初期状態に戻す（利用者が明示した操作なので比べない）：current を backup へ回して（正常な保存データのときだけ）current を消す。
   * 次に開くと初期状態。backup は 1 つ前として残る。ほかのタブへ知らせる
   */
  async reset(): Promise<void> {
    await this.writing;
    await this.be.commit(null, { rotate: this.isGood });
    this.currentGood = false;
    this.knownToken = null;
    this.broadcast(true);
    if (this.journaled) this.clearJournals(null);
  }

  /**
   * 読み込んだファイル（検証済み）を current にする（明示した操作なので比べない。いまの current は backup へ）。
   * keepCurrent = true：いまの current（正常なとき）を alt にも残す（swapAlt。backup は次の保存で上書きされるので）
   */
  async replace(d: SaveData, keepCurrent = false): Promise<boolean> {
    await this.writing;
    d.rev = Math.max(this.knownRev, d.rev) + 1;
    d.saveId = newId();
    try {
      await this.be.commit(d, { rotate: this.isGood, stash: keepCurrent ? (cur) => (this.isGood(cur) ? [altKey(), cur] : null) : undefined });
    } catch (e) {
      this.stats.lastError = (e as Error)?.message ?? String(e);
      return false;
    }
    this.knownToken = d.saveId;
    this.knownRev = d.rev;
    this.currentGood = true;
    if (this.journaled) this.clearJournals(null);
    this.broadcast(false);
    return true;
  }

  /**
   * 書けたあと：起動時に使った控えと、このタブの控えのうち今書いたもの以前のものを消す（d = null なら両方とも消す）。
   * ほかのタブの控えには触れない
   */
  private clearJournals(d: SaveData | null) {
    try {
      if (this.consumed) {
        localStorage.removeItem(this.consumed);
        this.consumed = null;
      }
      const j = readJournal(this.journalKey);
      if (j && (!d || j.saveId === d.saveId || j.rev <= d.rev)) localStorage.removeItem(this.journalKey);
    } catch {
      /* 消せなくても、次に開いたときに current と比べて捨てる */
    }
  }

  /** 使えない控えを「使わなかった進捗」として残す（いちばん新しい 1 つ）。控えの鍵は消す */
  private orphanize(key: string, j: Journal) {
    try {
      const old = readJournal(ORPHAN_KEY);
      if (!old || old.savedAt <= j.savedAt) localStorage.setItem(ORPHAN_KEY, JSON.stringify(j));
    } catch {
      /* 残せなくても current は守られる */
    }
    localStorage.removeItem(key);
  }

  /** 使わなかった控え（ほかのタブの保存より古かった）。書き出し用の文字列（無ければ null） */
  orphanText(): string | null {
    return readJournal(ORPHAN_KEY)?.data ?? null;
  }

  dropOrphan() {
    localStorage.removeItem(ORPHAN_KEY);
    this.info.orphan = false;
  }
}
