// 水槽探検のセーブ（ゲームロジック側。Three.js に依存しない）。
// - 保存先：IndexedDB（データベース ppp-aquarium・ストア saves）。掘った空洞は Float64Array のまま構造化複製で入れる
//   （空洞 1 個 = 7 個の数、上限 6000 個でも 336 KB。JSON にしないので書き込みも読み込みも軽い。
//   倍精度のままにするのは、ゲーム中の空洞（JavaScript の数 = 倍精度）と同じ値に戻すため：単精度に丸めると
//   砂の膜の境目に近い格子点の符号が変わりうる＝保存前と三角形がずれる）。
//   IndexedDB が使えない環境（古いブラウザのプライベートモード等）は localStorage（書き出し形式の文字列）、
//   それも使えなければ保存しない（遊べるが、閉じると消える。画面に出す）。
// - 鍵：current（いまの進捗）・backup（1 つ前の正常なデータ）・corrupt-<時刻>（読めなかったデータの隔離。最大 3 個）。
//   書き込みは「current が正常と分かっているときだけ」current を backup へ写してから current を書く（1 つのトランザクション）。
//   読み込みで current が壊れていたら、current は消さずに隔離し、backup を試す。どちらも読めなければ初期状態で始める
//   （壊れたデータは隔離に残るので、自動保存が上書きしても失われない）。
// - 形式：format = 'ppp-aquarium-save'、version（いまは 1）。読み込みは migrate → validate の順で、validate を通った
//   データだけをゲームへ渡す。未知の場所・仲間の id は捨てる（警告）。形が合わない・数が有限でない・範囲外は全体を拒否する。
// - 書き出し・読み込み（ファイル）：JSON。Float64Array は base64（リトルエンディアン）の文字列にする。
// - 拡張：水槽ごとの tanks[id]（いまは dig だけ。砂の山・植物・繁殖個体は同じ所へ足す）、仲間の traits（遺伝的特徴）、
//   progress.flags（イベントの進み具合）。足すときは version を上げて migrate に変換を書く。

export const SAVE_FORMAT = 'ppp-aquarium-save';
export const SAVE_VERSION = 1;
/** 掘った空洞 1 個の数の並び（a.xyz, b.xyz, r） */
export const PRIM_STRIDE = 7;

export type BuddyMode = 'free' | 'follow';
export type SaveCameraMode = 'adventure' | 'observe' | 'diorama';

export interface DigSave {
  /** 空洞（PRIM_STRIDE 個ずつ）。掘った順 */
  prims: Float64Array;
}

/** 水槽 1 つ分の状態（将来：砂の山 sand・植物 plants・生き物 creatures を足す） */
export interface TankSave {
  dig: DigSave;
}

export interface PlayerSave {
  tank: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  camera: SaveCameraMode;
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
  /** 空洞の上限・半径の上限・水槽の範囲（x, y, z の min / max。少し余白を含む） */
  maxPrims: number;
  maxR: number;
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
  }
  return out;
}

/** 旧い版のデータを今の版へ変換する（いまは版 1 だけ。版を上げたらここに変換を足す） */
export function migrate(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const v = raw.version;
  if (v === SAVE_VERSION) return raw;
  return raw;
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

    const P = raw.player;
    if (!isObj(P)) fail('プレイヤーの情報がありません');
    const tank = str(P.tank, 'player.tank');
    if (!ctx.tankIds.has(tank)) fail(`知らない水槽です（${tank}）`);
    const px = num(P.x, 'player.x'), py = num(P.y, 'player.y'), pz = num(P.z, 'player.z');
    if (!inBox(px, py, pz, ctx.worldBox)) fail('プレイヤーの位置が範囲外です');
    const heading = num(P.heading, 'player.heading', -100, 100);
    const camera: SaveCameraMode = P.camera === 'observe' || P.camera === 'diorama' ? P.camera : 'adventure';

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
      tanks[id] = { dig: { prims: readPrims(t.dig.prims, ctx) } };
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

    return { ok: true, warnings, data: { format: SAVE_FORMAT, version, created, savedAt, playTime, player: { tank, x: px, y: py, z: pz, heading, camera }, progress: { visited, flags }, tanks, buddies } };
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
  for (const [id, t] of Object.entries(d.tanks)) tanks[id] = { dig: { prims: { f64: f64ToBase64(t.dig.prims) } } };
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

interface Backend {
  readonly kind: 'indexeddb' | 'localStorage' | 'memory';
  get(key: string): Promise<unknown>;
  /** current を backup へ写してから（rotate のとき）current を書く */
  write(value: SaveData, rotate: boolean): Promise<void>;
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
      r.onsuccess = () => res(new IdbBackend(r.result));
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('IndexedDB が他のタブで使われています'));
      // 開くのに時間がかかりすぎる環境（まれ）は諦めて次の保存先へ
      setTimeout(() => rej(new Error('IndexedDB が応答しません')), 4000);
    });
  }

  get(key: string) {
    return req(this.db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  }

  write(value: SaveData, rotate: boolean): Promise<void> {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      if (rotate) {
        const g = st.get('current');
        g.onsuccess = () => {
          if (g.result !== undefined) st.put(g.result, 'backup');
          st.put(value, 'current');
        };
      } else st.put(value, 'current');
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error ?? new Error('保存が中断されました'));
    });
  }

  async put(key: string, value: unknown) {
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async del(key: string) {
    const tx = this.db.transaction(STORE, 'readwrite');
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

/** localStorage：書き出し形式の文字列で入れる */
class LocalBackend implements Backend {
  readonly kind = 'localStorage' as const;
  private readonly prefix = 'ppp-aquarium:';

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

  async write(value: SaveData, rotate: boolean) {
    const cur = localStorage.getItem(this.prefix + 'current');
    const text = encodeSaveFile(value);
    if (rotate && cur !== null) localStorage.setItem(this.prefix + 'backup', cur);
    localStorage.setItem(this.prefix + 'current', text);
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
      if (k?.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
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
  async write(value: SaveData, rotate: boolean) {
    if (rotate && this.m.has('current')) this.m.set('backup', this.m.get('current'));
    this.m.set('current', value);
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

export type LoadResult =
  /** 保存データが無い（初めて・初期状態に戻した） */
  | { status: 'empty' }
  | { status: 'ok'; data: SaveData; warnings: string[] }
  /** current が読めず、backup から戻した */
  | { status: 'recovered'; data: SaveData; warnings: string[]; error: string }
  /** どちらも読めない（初期状態で始める。壊れたデータは隔離した） */
  | { status: 'corrupt'; error: string };

/**
 * 保存先（IndexedDB → localStorage → メモリの順に使えるもの）。
 * current が正常と分かっている（読めた・自分で書いた）ときだけ、書くときに backup へ回す
 */
export class SaveStore {
  /** current が正常なデータか（壊れた current を backup へ回して、正常な backup を消さない） */
  private currentGood = false;
  private writing: Promise<void> = Promise.resolve();
  readonly stats = { writes: 0, lastWriteMs: 0, maxWriteMs: 0, lastBytes: 0, failures: 0, lastError: '' };

  private constructor(private readonly be: Backend) {}

  get kind() {
    return this.be.kind;
  }

  static async open(): Promise<SaveStore> {
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

  async load(ctx: SaveContext): Promise<LoadResult> {
    let cur: unknown;
    try {
      cur = await this.be.get('current');
    } catch (e) {
      return { status: 'corrupt', error: `保存先を読めませんでした（${(e as Error).message}）` };
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
      if (b.ok) return { status: 'recovered', data: b.data, warnings: b.warnings, error: r.error };
    }
    return { status: 'corrupt', error: r.error };
  }

  /** 書く（前の書き込みが終わってから。順番は呼んだ順） */
  save(d: SaveData): Promise<boolean> {
    const run = async () => {
      const t0 = performance.now();
      try {
        await this.be.write(d, this.currentGood);
        this.currentGood = true;
        const ms = performance.now() - t0;
        this.stats.writes++;
        this.stats.lastWriteMs = ms;
        this.stats.maxWriteMs = Math.max(this.stats.maxWriteMs, ms);
        let bytes = 512;
        for (const t of Object.values(d.tanks)) bytes += t.dig.prims.byteLength;
        this.stats.lastBytes = bytes;
        return true;
      } catch (e) {
        this.stats.failures++;
        this.stats.lastError = (e as Error)?.message ?? String(e);
        return false;
      }
    };
    const p = this.writing.then(run);
    this.writing = p.then(() => undefined);
    return p;
  }

  /** 初期状態に戻す：current を backup へ回して current を消す（次に開くと初期状態。backup は 1 つ前として残る） */
  async reset(): Promise<void> {
    await this.writing;
    const cur = await this.be.get('current');
    if (cur !== undefined && this.currentGood) await this.be.put('backup', cur);
    await this.be.del('current');
    this.currentGood = false;
  }

  /** 読み込んだファイル（検証済み）を current にする */
  async replace(d: SaveData): Promise<boolean> {
    await this.writing;
    return this.save(d);
  }
}
