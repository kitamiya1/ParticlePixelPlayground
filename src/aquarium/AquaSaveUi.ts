// セーブの自動保存と、画面の「セーブ」メニュー（今すぐ保存・書き出し・読み込み・初期状態に戻す）と、保存の状態の表示。
// 保存の形式・検証・保存先・競合の判定は AquaSave。ここはいつ保存するか（自動保存）と、ボタン・ファイル・知らせだけ。
// - 自動保存：変化（掘った・場所を見つけた・仲間の状態が変わった）があったら印を付け、変化が落ち着いてから保存する
//   （掘っている間は 1 秒あたり 6 回かき出すので、毎回は書かない：最初の変化から DIRTY_WAIT 秒、前の保存から MIN_GAP 秒）。
//   大事な出来事（仲間になった・初めての場所・仲間のモード）は IMPORTANT_WAIT 秒ですぐ書く。動いただけ（位置）は POS_GAP 秒ごと。
// - ページが隠れる・閉じる（visibilitychange / pagehide）とき：未保存の変化があれば、同期の控え（AquaSave の writeJournal）を
//   書いてから IndexedDB へ書く。非同期の書き込みはブラウザがページを止めると終わらないことがあるので（iPhone で
//   アプリを切り替えた直後など）、控えが次に開いたときの頼り。それでも、ブラウザが控えを書く前に止めた分は残らない。
// - 書けなかったとき：知らせ（同じ失敗が続く間は 1 回）を出し、間を空けて（最大 30 秒）書き直す。ボタンの印が赤くなる。
// - 競合（ほかのタブが新しい進捗を保存した・初期状態に戻した）：このタブからは書かない。画面の上に知らせを出したままにし、
//   「このタブの進捗を書き出す」「最新の進捗を読み込む」を選べるようにする。
// - 書き出し：JSON ファイルをダウンロード。読み込み：検証を通ったら保存先へ書いてからページを読み込み直す。
// - 初期状態に戻す：確認を 2 段（ボタン → 「本当に戻す」）。いまのデータは 1 つ前（backup）として残る。

import { decodeSaveFile, encodeSaveFile, validateSave, type SaveConflict, type SaveContext, type SaveData, type SaveStore } from './AquaSave';

const DIRTY_WAIT = 2.0;
const IMPORTANT_WAIT = 0.3;
const MIN_GAP = 4.0;
const POS_GAP = 15.0;
const RETRY_MAX = 30;
/** 変化があってからこれ以上保存できていなければ「未保存」と出す（秒） */
const UNSAVED_SHOW = 6;

export type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'conflict' | 'off';

export class AutoSaver {
  private dirtyT = -1;
  private wait = DIRTY_WAIT;
  private sinceSave = 0;
  private gap = MIN_GAP;
  private moved = false;
  private busy = false;
  private pending: Promise<boolean> | null = null;
  /** 保存したくない間（読み込み直す直前・初期状態に戻した後・競合） */
  suspended = false;
  lastSavedAt = 0;
  lastOk = true;
  /** 失敗が続いた回数（知らせは 1 回目だけ） */
  private failStreak = 0;
  readonly stats = { saves: 0, gatherMs: 0, maxGatherMs: 0, hiddenFlushes: 0, journals: 0 };
  onSaved?: (ok: boolean) => void;
  onError?: (msg: string) => void;
  onConflict?: (c: SaveConflict) => void;
  onState?: (s: SaveState) => void;
  private stateNow: SaveState = 'saved';

  constructor(readonly store: SaveStore, readonly gather: () => SaveData) {
    store.onConflict((c) => {
      this.suspended = true;
      this.setState('conflict');
      this.onConflict?.(c);
    });
    const hide = () => this.onHide();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') hide();
      // 戻ってきた：その間にほかのタブが進めていないか確かめる
      else void store.check();
    });
    window.addEventListener('pagehide', hide);
    if (store.kind === 'memory') this.stateNow = 'off';
  }

  get state(): SaveState {
    return this.stateNow;
  }

  /** 変化があってから保存できていない秒数（未保存なら 0 以上） */
  get unsavedFor(): number {
    return this.dirtyT;
  }

  private setState(s: SaveState) {
    if (this.store.kind === 'memory') s = 'off';
    if (this.store.conflict) s = 'conflict';
    if (s === this.stateNow) return;
    this.stateNow = s;
    this.onState?.(s);
  }

  /** 進捗が変わった（掘った・見つけた） */
  markDirty() {
    if (this.dirtyT < 0) this.dirtyT = 0;
  }

  /** 大事な出来事（仲間になった・初めての場所・モード）：すぐ書く */
  markImportant() {
    this.markDirty();
    this.wait = IMPORTANT_WAIT;
  }

  /** 位置だけ変わった */
  markMoved() {
    this.moved = true;
  }

  update(dt: number) {
    this.sinceSave += dt;
    if (this.dirtyT >= 0) this.dirtyT += dt;
    const important = this.wait < DIRTY_WAIT && this.dirtyT >= this.wait && this.sinceSave >= Math.min(this.gap, 1);
    const due = important || (this.dirtyT >= this.wait && this.sinceSave >= this.gap) || (this.moved && this.sinceSave >= POS_GAP);
    if (due && !this.busy && !this.suspended) void this.flush();
    if (!this.busy && !this.suspended && this.stateNow !== 'error') this.setState(this.dirtyT >= UNSAVED_SHOW ? 'pending' : 'saved');
  }

  /** ページが隠れる・閉じる：未保存の変化があれば同期の控えを書いてから保存する */
  private onHide() {
    if (this.suspended || this.store.conflict) return;
    const unsaved = this.dirtyT >= 0 || this.moved || !this.lastOk || this.busy;
    if (!unsaved) return;
    this.stats.hiddenFlushes++;
    const d = this.store.stamp(this.gather());
    if (this.store.writeJournal(d)) this.stats.journals++;
    void this.flush(d);
  }

  /** 今すぐ書く（d を渡せばそれを、無ければ今の状態を集めて）。書いている途中なら、終わってからもう一度 */
  async flush(d?: SaveData): Promise<boolean> {
    if (this.suspended) return false;
    while (this.busy && this.pending) await this.pending;
    if (this.suspended) return false;
    const p = this.write(d);
    this.pending = p;
    return p;
  }

  private async write(given?: SaveData): Promise<boolean> {
    this.busy = true;
    this.setState('saving');
    const t0 = performance.now();
    const d = given ?? this.gather();
    const ms = performance.now() - t0;
    this.stats.gatherMs = ms;
    this.stats.maxGatherMs = Math.max(this.stats.maxGatherMs, ms);
    // 書き始めた後の変化は次の保存で
    const dirty0 = this.dirtyT, moved0 = this.moved;
    this.dirtyT = -1;
    this.wait = DIRTY_WAIT;
    this.moved = false;
    this.sinceSave = 0;
    const r = await this.store.save(d);
    this.busy = false;
    this.lastOk = r === 'ok';
    if (r === 'ok') {
      this.stats.saves++;
      this.lastSavedAt = d.savedAt;
      this.failStreak = 0;
      this.gap = MIN_GAP;
      this.setState(this.dirtyT >= 0 ? 'pending' : 'saved');
    } else if (r === 'error') {
      // 書けなかった：変化を戻して、間を空けて書き直す（知らせは続けて失敗している間 1 回）
      this.dirtyT = Math.max(dirty0, 0);
      this.moved = moved0;
      this.gap = Math.min(RETRY_MAX, this.gap * 2);
      this.failStreak++;
      this.setState('error');
      if (this.failStreak === 1) this.onError?.(this.store.stats.lastError || '不明な理由');
    }
    // 競合は store.onConflict で知らせる（このタブからは書かない）
    this.onSaved?.(r === 'ok');
    return r === 'ok';
  }
}

export interface SaveMenuDeps {
  saver: AutoSaver;
  ctx: SaveContext;
  /** 起動時に読み込んだ結果の説明（壊れていた・戻した など。無ければ null） */
  bootNote: string | null;
  toast: (msg: string) => void;
}

const STATE_LABEL: Record<SaveState, string> = {
  saved: '保存済み', pending: '未保存の変化あり', saving: '保存中…', error: '保存できていません', conflict: '別のタブと競合（このタブは保存しません）', off: '保存しません',
};

function downloadText(text: string, name: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.download = name;
  a.href = URL.createObjectURL(blob);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function fileName(t: number, tag = ''): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `aquarium-save${tag}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

/** 画面右上の「セーブ」ボタン（保存の状態の印つき）と、その中のメニュー、競合の知らせ */
export class SaveMenu {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  readonly alert: HTMLElement;
  private confirmT = 0;

  constructor(parent: HTMLElement, private readonly d: SaveMenuDeps) {
    const s = d.saver;
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'menu-btn save';
    this.button.innerHTML = '<i class="dot"></i>セーブ';
    parent.appendChild(this.button);

    const p = (this.panel = document.createElement('div'));
    p.id = 'save-panel';
    p.innerHTML = `
      <div class="head"><b>セーブ</b><button type="button" class="close" aria-label="閉じる">×</button></div>
      <div class="state" data-k="state"></div>
      <div class="status" data-k="status"></div>
      <div class="note" data-k="note"></div>
      <div class="btns">
        <button type="button" data-k="now">今すぐ保存</button>
        <button type="button" data-k="export">書き出す（ファイル）</button>
        <button type="button" data-k="import">読み込む（ファイル）</button>
        <button type="button" data-k="orphan" hidden>使わなかった進捗を書き出す</button>
        <button type="button" data-k="persist" hidden>消されにくくする</button>
        <button type="button" data-k="reset" class="danger">初期状態に戻す…</button>
      </div>
      <div class="confirm" data-k="confirm">
        <div>掘った穴・見つけた場所・仲間がすべて初期状態に戻ります。いまのデータは「1 つ前のデータ」として 1 回分だけ残ります。</div>
        <div class="btns"><button type="button" data-k="yes" class="danger">本当に戻す</button><button type="button" data-k="no">やめる</button></div>
      </div>
      <div class="sub">進捗はこの端末のブラウザの中に自動で保存されます。ただし、保存の直後（数秒以内）にタブを閉じる・アプリを切り替える・電池が切れると、
        最後の数秒の進捗は残らないことがあります。iPhone・iPad の Safari は、しばらく（目安 7 日）開かなかったサイトの保存データを消すことがあり、
        プライベートブラウズでは閉じると消えます。大事な進捗は「書き出す」でファイルに残してください。同じゲームを 2 つのタブで開くと、後から保存しようとした方は保存しません。</div>
      <input type="file" accept="application/json,.json" data-k="file" hidden>`;
    document.body.appendChild(p);

    // 競合の知らせ（画面の上。閉じずに残す）
    const al = (this.alert = document.createElement('div'));
    al.id = 'save-alert';
    al.innerHTML = `<div class="msg" data-k="amsg"></div>
      <div class="btns"><button type="button" data-k="aexport">このタブの進捗を書き出す</button><button type="button" data-k="areload">最新の進捗を読み込む</button></div>`;
    document.body.appendChild(al);

    const q = <T extends HTMLElement>(k: string, root: HTMLElement = p) => root.querySelector<T>(`[data-k="${k}"]`)!;
    const stop = (e: Event) => e.stopPropagation();
    // パネル・知らせの上の指・クリックはゲームの入力へ渡さない
    for (const el of [p, al]) for (const t of ['pointerdown', 'pointerup', 'touchstart', 'wheel', 'keydown'] as const) el.addEventListener(t, stop);
    this.button.addEventListener('pointerdown', stop);
    this.button.addEventListener('click', () => this.toggle());
    p.querySelector('.close')!.addEventListener('click', () => this.toggle(false));
    q('now').addEventListener('click', async () => {
      if (s.store.conflict) return d.toast('別のタブと競合しているため、このタブからは保存しません');
      const ok = await s.flush();
      d.toast(ok ? '保存しました' : s.store.conflict ? '別のタブで新しい進捗が保存されていたため、保存しませんでした' : `保存できませんでした（${s.store.stats.lastError}）`);
      this.refresh();
    });
    q('export').addEventListener('click', () => this.exportFile());
    q('aexport', al).addEventListener('click', () => this.exportFile('-このタブ'));
    q('areload', al).addEventListener('click', () => {
      s.suspended = true;
      location.reload();
    });
    q('orphan').addEventListener('click', () => {
      const t = s.store.orphanText();
      if (t) downloadText(t, fileName(Date.now(), '-使わなかった進捗'));
      s.store.dropOrphan();
      this.refresh();
    });
    const persist = q('persist');
    persist.addEventListener('click', async () => {
      const ok = await navigator.storage?.persist?.().catch(() => false);
      d.toast(ok ? 'ブラウザが保存データを消しにくくしました' : 'ブラウザが受け付けませんでした（書き出しでファイルに残してください）');
      this.refresh();
    });
    const file = q<HTMLInputElement>('file');
    q('import').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) void this.importFile(f);
    });
    q('reset').addEventListener('click', () => {
      q('confirm').classList.add('show');
      this.confirmT = performance.now();
    });
    q('no').addEventListener('click', () => q('confirm').classList.remove('show'));
    q('yes').addEventListener('click', async () => {
      // 押し間違い（確認を出した直後の同じ指のタップ）を避ける
      if (performance.now() - this.confirmT < 350) return;
      s.suspended = true;
      await s.store.reset();
      location.reload();
    });
    s.onSaved = () => {
      if (p.classList.contains('show')) this.refresh();
    };
    s.onState = (st) => {
      this.button.dataset.state = st;
      this.button.title = STATE_LABEL[st];
      if (p.classList.contains('show')) this.refresh();
    };
    s.onError = (msg) => d.toast(`保存できませんでした（${msg}）。少しあとで自動でもう一度保存します`);
    s.onConflict = (c) => this.showConflict(c);
    this.button.dataset.state = s.state;
    this.refresh();
  }

  private showConflict(c: SaveConflict) {
    const when = c.savedAt ? `（${new Date(c.savedAt).toLocaleTimeString()}）` : '';
    const what = c.removed ? '別のタブ（ウィンドウ）で初期状態に戻されました' : `別のタブ（ウィンドウ）で新しい進捗が保存されました${when}`;
    this.alert.querySelector('[data-k="amsg"]')!.textContent = `${what}。このタブの進捗で上書きしないよう、このタブからは保存しません。このタブの進捗を残したいときはファイルに書き出してください。`;
    this.alert.classList.add('show');
    this.d.toast('別のタブと保存が競合しました');
    this.refresh();
  }

  toggle(on = !this.panel.classList.contains('show')) {
    this.panel.classList.toggle('show', on);
    this.panel.querySelector('[data-k="confirm"]')!.classList.remove('show');
    if (on) this.refresh();
  }

  refresh() {
    const s = this.d.saver;
    const st = s.store.stats;
    const where = s.store.kind === 'indexeddb' ? 'ブラウザ（IndexedDB）' : s.store.kind === 'localStorage' ? 'ブラウザ（localStorage）' : '保存しません（このタブを閉じると消えます）';
    const when = s.lastSavedAt ? new Date(s.lastSavedAt).toLocaleTimeString() : 'まだ保存していません';
    const size = st.lastBytes ? `・約 ${Math.ceil(st.lastBytes / 1024)} KB` : '';
    const q = (k: string) => this.panel.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
    const stateEl = q('state');
    stateEl.textContent = STATE_LABEL[s.state];
    stateEl.dataset.state = s.state;
    q('status').textContent = `保存先：${where}　最後の保存：${when}${size}${s.store.knownRev ? `・世代 ${s.store.knownRev}` : ''}${s.state === 'error' ? `　理由：${st.lastError}` : ''}`;
    q('note').textContent = this.d.bootNote ?? '';
    q('now').toggleAttribute('disabled', !!s.store.conflict || s.store.kind === 'memory');
    q('orphan').hidden = !s.store.info.orphan;
    // 消されにくくする：対応していて、まだ頼んでいないときだけ
    const persist = q('persist');
    const sm = navigator.storage as StorageManager | undefined;
    if (sm && typeof sm.persist === 'function' && typeof sm.persisted === 'function' && s.store.kind !== 'memory') {
      void sm.persisted().then((v) => {
        persist.hidden = v;
      });
    } else persist.hidden = true;
  }

  private exportFile(tag = '') {
    // 書き出す前に今の状態を集めて保存（ファイルと保存先を同じ内容にする。競合中は保存せずファイルだけ）
    if (!this.d.saver.store.conflict) void this.d.saver.flush();
    const data = this.d.saver.gather();
    downloadText(encodeSaveFile(data), fileName(data.savedAt, tag));
    this.d.toast('書き出しました');
  }

  private async importFile(f: File) {
    if (f.size > 8 * 1024 * 1024) {
      this.d.toast('ファイルが大きすぎます');
      return;
    }
    const r = validateSave(decodeSaveFile(await f.text()), this.d.ctx);
    if (!r.ok) {
      // 読めないファイルでは今の保存データに触れない
      this.d.toast(`読み込めません：${r.error}`);
      return;
    }
    this.d.saver.suspended = true;
    const ok = await this.d.saver.store.replace(r.data);
    if (!ok) {
      this.d.saver.suspended = !!this.d.saver.store.conflict;
      this.d.toast(`保存先へ書けませんでした（${this.d.saver.store.stats.lastError}）`);
      return;
    }
    location.reload();
  }
}
