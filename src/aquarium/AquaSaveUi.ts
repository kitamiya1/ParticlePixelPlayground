// セーブの自動保存と、画面の「セーブ」メニュー（今すぐ保存・書き出し・読み込み・初期状態に戻す）。
// 保存の形式・検証・保存先は AquaSave。ここはいつ保存するか（自動保存）と、ボタン・ファイルのやり取りだけ。
// - 自動保存：変化（掘った・場所を見つけた・仲間の状態が変わった）があったら印を付け、変化が落ち着いてから保存する
//   （掘っている間は 1 秒あたり 6 回かき出すので、毎回は書かない：最初の変化から DIRTY_WAIT 秒、前の保存から MIN_GAP 秒）。
//   動いただけ（位置）は POS_GAP 秒ごと。ページが隠れる・閉じる（visibilitychange / pagehide）ときはすぐ書く。
// - 書き出し：JSON ファイルをダウンロード（スマホでもファイルとして保存できる）。読み込み：ファイルを選び、検証を通ったら
//   保存先へ書いてからページを読み込み直す（起動時と同じ復元の道を通す。区画の作り直しと当たり判定が必ず揃う）。
// - 初期状態に戻す：確認を 2 段（ボタン → 「本当に戻す」）。いまのデータは 1 つ前（backup）として残る。

import { decodeSaveFile, encodeSaveFile, validateSave, type SaveContext, type SaveData, type SaveStore } from './AquaSave';

const DIRTY_WAIT = 2.0;
const MIN_GAP = 4.0;
const POS_GAP = 15.0;

export class AutoSaver {
  private dirtyT = -1;
  private sinceSave = 0;
  private moved = false;
  private busy = false;
  /** 保存したくない間（読み込み直す直前・初期状態に戻した後） */
  suspended = false;
  lastSavedAt = 0;
  lastOk = true;
  readonly stats = { saves: 0, gatherMs: 0, maxGatherMs: 0 };
  onSaved?: (ok: boolean) => void;

  constructor(readonly store: SaveStore, readonly gather: () => SaveData) {
    const now = () => void this.flush();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') now();
    });
    window.addEventListener('pagehide', now);
  }

  /** 進捗が変わった（掘った・見つけた・仲間） */
  markDirty() {
    if (this.dirtyT < 0) this.dirtyT = 0;
  }

  /** 位置だけ変わった */
  markMoved() {
    this.moved = true;
  }

  update(dt: number) {
    this.sinceSave += dt;
    if (this.dirtyT >= 0) this.dirtyT += dt;
    const due = (this.dirtyT >= DIRTY_WAIT && this.sinceSave >= MIN_GAP) || (this.moved && this.sinceSave >= POS_GAP);
    if (due && !this.busy) void this.flush();
  }

  async flush(): Promise<boolean> {
    if (this.suspended) return false;
    // 書いている途中なら、終わってから今の状態でもう一度書く（呼んだ時点より古い内容で終わらせない）
    while (this.busy && this.pending) await this.pending;
    if (this.suspended) return false;
    const p = this.write();
    this.pending = p;
    return p;
  }

  private pending: Promise<boolean> | null = null;

  private async write(): Promise<boolean> {
    this.busy = true;
    const t0 = performance.now();
    const d = this.gather();
    const ms = performance.now() - t0;
    this.stats.gatherMs = ms;
    this.stats.maxGatherMs = Math.max(this.stats.maxGatherMs, ms);
    // 書き始めた後の変化は次の保存で
    this.dirtyT = -1;
    this.moved = false;
    this.sinceSave = 0;
    const ok = await this.store.save(d);
    this.busy = false;
    this.lastOk = ok;
    if (ok) {
      this.stats.saves++;
      this.lastSavedAt = d.savedAt;
    } else this.markDirty();
    this.onSaved?.(ok);
    return ok;
  }
}

export interface SaveMenuDeps {
  saver: AutoSaver;
  ctx: SaveContext;
  /** 起動時に読み込んだ結果の説明（壊れていた・戻した など。無ければ null） */
  bootNote: string | null;
  toast: (msg: string) => void;
}

/** 画面右上の「セーブ」ボタンと、その中のメニュー */
export class SaveMenu {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  private confirmT = 0;

  constructor(parent: HTMLElement, private readonly d: SaveMenuDeps) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'menu-btn save';
    this.button.textContent = 'セーブ';
    parent.appendChild(this.button);

    const p = (this.panel = document.createElement('div'));
    p.id = 'save-panel';
    p.innerHTML = `
      <div class="head"><b>セーブ</b><button type="button" class="close" aria-label="閉じる">×</button></div>
      <div class="status" data-k="status"></div>
      <div class="note" data-k="note"></div>
      <div class="btns">
        <button type="button" data-k="now">今すぐ保存</button>
        <button type="button" data-k="export">書き出す（ファイル）</button>
        <button type="button" data-k="import">読み込む（ファイル）</button>
        <button type="button" data-k="reset" class="danger">初期状態に戻す…</button>
      </div>
      <div class="confirm" data-k="confirm">
        <div>掘った穴・見つけた場所・仲間がすべて初期状態に戻ります。いまのデータは「1 つ前のデータ」として 1 回分だけ残ります。</div>
        <div class="btns"><button type="button" data-k="yes" class="danger">本当に戻す</button><button type="button" data-k="no">やめる</button></div>
      </div>
      <div class="sub">進捗は自動で保存されます（この端末のブラウザの中）。別の端末へ移すときは書き出したファイルを読み込みます。</div>
      <input type="file" accept="application/json,.json" data-k="file" hidden>`;
    document.body.appendChild(p);
    const q = <T extends HTMLElement>(k: string) => p.querySelector<T>(`[data-k="${k}"]`)!;
    const stop = (e: Event) => e.stopPropagation();
    // パネルの上の指・クリックはゲームの入力へ渡さない
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'wheel', 'keydown'] as const) p.addEventListener(t, stop);
    this.button.addEventListener('pointerdown', stop);
    this.button.addEventListener('click', () => this.toggle());
    p.querySelector('.close')!.addEventListener('click', () => this.toggle(false));
    q('now').addEventListener('click', async () => {
      const ok = await d.saver.flush();
      d.toast(ok ? '保存しました' : '保存できませんでした');
      this.refresh();
    });
    q('export').addEventListener('click', () => this.exportFile());
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
      d.saver.suspended = true;
      await d.saver.store.reset();
      location.reload();
    });
    d.saver.onSaved = () => {
      if (p.classList.contains('show')) this.refresh();
    };
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
    const where = s.store.kind === 'indexeddb' ? 'ブラウザ（IndexedDB）' : s.store.kind === 'localStorage' ? 'ブラウザ（localStorage）' : '保存できません（このタブを閉じると消えます）';
    const when = s.lastSavedAt ? new Date(s.lastSavedAt).toLocaleTimeString() : 'まだ保存していません';
    const size = st.lastBytes ? `・約 ${Math.ceil(st.lastBytes / 1024)} KB` : '';
    this.panel.querySelector('[data-k="status"]')!.textContent = `保存先：${where}　最後の保存：${when}${size}${s.lastOk ? '' : '（失敗しました）'}`;
    this.panel.querySelector('[data-k="note"]')!.textContent = this.d.bootNote ?? '';
  }

  private exportFile() {
    // 書き出す前に今の状態を集めて保存（ファイルと保存先を同じ内容にする）
    void this.d.saver.flush();
    const data = this.d.saver.gather();
    const blob = new Blob([encodeSaveFile(data)], { type: 'application/json' });
    const a = document.createElement('a');
    const t = new Date(data.savedAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    a.download = `aquarium-save-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}.json`;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
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
      this.d.saver.suspended = false;
      this.d.toast('保存先へ書けませんでした');
      return;
    }
    location.reload();
  }
}
