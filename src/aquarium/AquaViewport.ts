// ページ自体の拡大（ブラウザのピンチ・ダブルタップによる拡大。visualViewport.scale）を、ゲーム内カメラのズーム
// （2 本指のピンチ → Input.wheel → AquaCamera の zoom）と分けて扱う。
//
// - 防ぐ：CSS の touch-action: none（aquarium.css）に加えて、iOS Safari（WebKit）のピンチの通知 gesturestart /
//   gesturechange と、2 本以上の指の touchmove の既定の動作を止める。touch-action は「中でスクロールする要素」で
//   区切られる（WebKit・Chromium とも、スクロールする要素の中では先祖の none が効かない）ため、スクロールする欄の
//   中から始めたピンチでもページが拡大しないようにする。1 本指のスクロール（説明・セーブの欄）は止めない。
//   ポインターの通知（pointerdown / move / up）は止めないので、スティック・掘る・視点の同時操作はそのまま。
// - 気づく：visualViewport の大きさ・位置が変わるたびに倍率を調べ、1 より大きいまま（指を離して少し待っても）なら
//   画面に知らせを出す（知らせは拡大されていても見える大きさ・位置に出す）。
// - 戻す：知らせの「元に戻す」で、viewport の設定を一瞬だけ maximum-scale=1 にして戻す（Chromium では倍率が 1 に
//   戻る。iOS Safari で戻るかは実機で確かめる）。戻らなければ、知らせの暗い部分を 2 本指でつまんで縮めてもらう
//   （知らせを出している間はピンチを止めない）か、保存してから読み込み直す。
// - 保存：知らせには実際の保存の状態（保存済み・未保存の変化あり・保存できていない・別のタブと競合・保存しない）を出す。
//   「保存して読み込み直す」は保存できたときだけ読み込み直す。保存できない（失敗した・競合・?nosave）ときは読み込み直さず、
//   「進捗を書き出す（ファイル）」を勧め、もう一度押して確かめたときだけ保存せずに読み込み直す。
// - 端末の回転・裏からの復帰：押している指を終わらせ、少し遅れて大きさを測り直す（iOS は回転の直後に古い大きさを返す
//   ことがある）。ページが横にずれていれば (0, 0) に戻す。
// - ?diag：倍率・visualViewport・innerWidth/Height・Canvas の実寸・ボタンの位置・カメラのズーム・指の座標と通知を
//   画面に出す（実機で原因を確かめる用。指の操作は受けない）。
//
// アクセシビリティ：viewport に user-scalable=no / maximum-scale は付けない（ふだんは）。端末の「ズーム機能」
// （画面全体の拡大鏡）や Safari の「ページの拡大／縮小（aA）」は止めない（どちらもページの倍率とは別で、操作もずれない）。
// 止めるのは、ゲームの操作（2 本指 = カメラのズーム）と取り合いになるページのピンチ・ダブルタップだけ。

import type { Input } from '../game/Input';
import type { SaveState } from './AquaSaveUi';

/** これより大きい倍率を「ページが拡大されている」とみなす（端数のずれは無視） */
const ZOOMED = 1.02;
/** 拡大に気づいてから知らせを出すまで（ms。ピンチの途中の一瞬の変化では出さない） */
const NOTICE_DELAY = 500;
/** 「保存して読み込み直す」で保存を待つ上限（ms） */
const FLUSH_TIMEOUT = 8000;

/** 知らせに出す保存の状態（AutoSaver・SaveStore から） */
export interface SaveInfo {
  state: SaveState;
  /** このタブで最後に保存できた時刻（0 = このタブではまだ保存していない） */
  lastSavedAt: number;
  /** 変化があってから保存できていない秒数（変化が無ければ負） */
  unsavedFor: number;
  /** 最後に保存できなかった理由 */
  error: string;
  /** ?nosave で開いた（保存しないのは意図どおり） */
  noSave: boolean;
}

/** 知らせの「保存して読み込み直す」「進捗を書き出す」に使う保存の操作 */
export interface ViewportSave {
  info: () => SaveInfo;
  /** 今すぐ保存する（保存できたら true。失敗・競合・保存しないなら false） */
  flush: () => Promise<boolean>;
  /** いまの進捗をファイルに書き出す（競合中・保存しないときも書き出せる） */
  exportFile: () => void;
  /** ページを読み込み直す */
  reload: () => void;
}

/** 知らせに出す区分（saved でも変化があれば pending として扱う） */
type NoticeSave = 'saved' | 'pending' | 'error' | 'conflict' | 'off';

export interface ViewportGuardDeps {
  input: Input;
  /** Canvas の大きさを測り直す */
  relayout: () => void;
  /** 保存の状態と操作（知らせの説明とボタン） */
  save: ViewportSave;
  /** ?diag の表示に出すカメラの状態 */
  camInfo?: () => string;
  diag?: boolean;
}

export class ViewportGuard {
  readonly stats = { gestureBlocked: 0, touchmoveBlocked: 0, zoomNotices: 0, resetTried: 0, resetOk: 0, scrollFixed: 0, relayouts: 0, orientation: 0, maxScale: 1, reloadSaved: 0, reloadHeld: 0, reloadUnsaved: 0, exports: 0 };
  /** いまの倍率（visualViewport.scale） */
  scale = 1;
  /** 知らせを出している間（ピンチを止めない） */
  private recovering = false;
  private noticeTimer = 0;
  private touchesDown = 0;
  private readonly notice: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly saveEl: HTMLElement;
  private readonly reloadBtn: HTMLButtonElement;
  /** 保存して読み込み直す途中（保存を待っている） */
  private saving = false;
  /** 保存できない状態で「読み込み直す」を 1 回押した（その状態のまま、もう一度押すと保存せずに読み込み直す） */
  private armedFor: NoticeSave | null = null;
  /** 「保存して読み込み直す」で保存できなかった（読み込み直さなかった） */
  private heldReason = '';
  private exportedAt = 0;
  private saveTimer = 0;
  private diagEl: HTMLElement | null = null;
  /** ?diag：通知の数と最後の位置 */
  readonly log: string[] = [];
  private readonly counts: Record<string, number> = {};
  private lastPointer = '';
  private lastTouch = '';

  constructor(private readonly d: ViewportGuardDeps) {
    // ---- 防ぐ ----
    // iOS Safari のピンチの通知（WebKit だけにある）：既定の動作（ページの拡大）を止める
    for (const t of ['gesturestart', 'gesturechange'] as const) {
      document.addEventListener(t, (e) => {
        if (this.recovering) return;
        e.preventDefault();
        this.stats.gestureBlocked++;
      }, { passive: false });
    }
    // 2 本以上の指の動きで、どれかの指がゲームの面（Canvas・操作のボタン）の外（説明・セーブの欄など）から始まった：
    // 既定の動作（ピンチでの拡大）を止める。1 本指（欄の中のスクロール）は止めない。
    // ゲームの面の上だけの指は touch-action: none で既に拡大しないので、ここでは触らない（Chromium では touchmove を
    // 止めると、合成したピンチの pointermove が届かなくなり、カメラのズームが効かなくなった）
    document.addEventListener('touchmove', (e) => {
      if (this.recovering || e.touches.length < 2) return;
      let outside = false;
      for (let k = 0; k < e.touches.length; k++) if (!onGameSurface(e.touches[k].target)) outside = true;
      if (!outside) return;
      if (e.cancelable) {
        e.preventDefault();
        this.stats.touchmoveBlocked++;
      }
    }, { passive: false, capture: true });
    const onTouchList = (e: TouchEvent) => {
      this.touchesDown = e.touches.length;
      // 指が全部離れたら、拡大されたままか確かめる
      if (this.touchesDown === 0) this.check();
    };
    for (const t of ['touchstart', 'touchend', 'touchcancel'] as const) document.addEventListener(t, onTouchList, { capture: true, passive: true });

    // ---- 気づく・測り直す ----
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', () => this.check());
      vv.addEventListener('scroll', () => this.check());
    }
    window.addEventListener('resize', () => this.check());
    const later = () => {
      this.d.input.releaseAll();
      for (const ms of [0, 250, 700]) setTimeout(() => this.relayout(), ms);
    };
    window.addEventListener('orientationchange', () => {
      this.stats.orientation++;
      later();
    });
    screen.orientation?.addEventListener?.('change', () => later());
    window.addEventListener('pageshow', () => later());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') later();
    });

    // ---- 知らせ ----
    this.notice = document.createElement('div');
    this.notice.id = 'zoom-fix';
    this.notice.innerHTML = `<div class="card" role="alertdialog" aria-labelledby="zoom-fix-t">
        <div class="t" id="zoom-fix-t">画面が拡大されています</div>
        <div class="m" data-k="msg"></div>
        <div class="btns"><button type="button" data-k="reset">元に戻す</button><button type="button" data-k="reload">保存して読み込み直す</button><button type="button" data-k="export">進捗を書き出す（ファイル）</button></div>
        <div class="sv" data-k="save"></div>
        <div class="s">戻らないときは、この暗い部分を 2 本指でつまむように縮めてください。</div>
      </div>`;
    document.body.appendChild(this.notice);
    this.msg = this.notice.querySelector<HTMLElement>('[data-k="msg"]')!;
    this.saveEl = this.notice.querySelector<HTMLElement>('[data-k="save"]')!;
    this.reloadBtn = this.notice.querySelector<HTMLButtonElement>('[data-k="reload"]')!;
    this.notice.querySelector('[data-k="reset"]')!.addEventListener('click', () => void this.tryReset());
    this.reloadBtn.addEventListener('click', () => void this.reload());
    this.notice.querySelector('[data-k="export"]')!.addEventListener('click', () => {
      this.d.save.exportFile();
      this.stats.exports++;
      this.exportedAt = Date.now();
      this.renderSave();
    });

    if (d.diag) this.startDiag();
    this.check();
  }

  /** 倍率を調べる（拡大されたままなら知らせ、戻っていれば知らせを消して測り直す） */
  check() {
    const vv = window.visualViewport;
    const s = vv ? vv.scale : 1;
    this.scale = s;
    this.stats.maxScale = Math.max(this.stats.maxScale, s);
    if (this.recovering) this.place();
    if (s > ZOOMED) {
      if (!this.recovering && !this.noticeTimer) {
        this.noticeTimer = window.setTimeout(() => {
          this.noticeTimer = 0;
          const now = window.visualViewport?.scale ?? 1;
          // ピンチの途中なら、指が離れたときにもう一度調べる
          if (now > ZOOMED && this.touchesDown === 0) this.showNotice();
        }, NOTICE_DELAY);
      }
      return;
    }
    clearTimeout(this.noticeTimer);
    this.noticeTimer = 0;
    if (this.recovering) this.hideNotice();
    // 倍率は 1 なのにページがずれている（回転の直後など）：元に戻す
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
      this.stats.scrollFixed++;
    }
  }

  private relayout() {
    this.stats.relayouts++;
    this.check();
    this.d.relayout();
  }

  private showNotice() {
    this.recovering = true;
    this.stats.zoomNotices++;
    // 押している物を離す（拡大でずれた指のまま動き続けない）
    this.d.input.releaseAll();
    this.msg.textContent = 'ブラウザのページ自体が拡大され、ボタンが画面の外に出たり、指の位置がずれたりしています（ゲームのカメラのズームとは別です）。';
    document.documentElement.classList.add('aqua-zoomfix');
    this.notice.classList.add('show');
    this.armedFor = null;
    this.heldReason = '';
    this.renderSave();
    // 出している間も保存の状態は変わる（自動保存・失敗・競合）ので、説明を合わせ続ける
    clearInterval(this.saveTimer);
    this.saveTimer = window.setInterval(() => this.renderSave(), 500);
    this.place();
  }

  private hideNotice() {
    this.recovering = false;
    clearInterval(this.saveTimer);
    this.saveTimer = 0;
    document.documentElement.classList.remove('aqua-zoomfix');
    this.notice.classList.remove('show');
    this.d.relayout();
  }

  /** 知らせを、いま見えている範囲（visual viewport）いっぱいに、拡大の影響を打ち消した大きさで置く */
  private place() {
    pinToVisual(this.notice, true);
  }

  /** viewport の設定を一瞬 maximum-scale=1 にして、倍率を 1 に戻す（戻せない環境もある） */
  async tryReset(): Promise<boolean> {
    this.stats.resetTried++;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta) {
      const orig = meta.content;
      meta.content = 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, viewport-fit=cover';
      await wait(150);
      meta.content = orig;
    }
    window.scrollTo(0, 0);
    await wait(450);
    this.check();
    const ok = (window.visualViewport?.scale ?? 1) <= ZOOMED;
    if (ok) this.stats.resetOk++;
    else this.msg.textContent = '自動では戻せませんでした。この暗い部分を 2 本指でつまむように縮めるか、下の保存の状態を確かめてから読み込み直してください。';
    return ok;
  }

  // ---------------- 保存の状態・読み込み直す ----------------

  /** 知らせに出す保存の区分 */
  private saveKind(i: SaveInfo): NoticeSave {
    if (i.state === 'off' || i.state === 'conflict' || i.state === 'error') return i.state;
    // 'saved' でも、変化があってまだ書いていなければ未保存（AutoSaver は 6 秒たつまで 'saved' のまま）
    if (i.state === 'pending' || i.state === 'saving' || i.unsavedFor >= 0) return 'pending';
    return 'saved';
  }

  /** 知らせの保存の説明と「読み込み直す」のボタンを、いまの保存の状態に合わせる */
  renderSave() {
    const i = this.d.save.info();
    const k = this.saveKind(i);
    // 確かめた後に、保存できた（ふつうに保存して読み込み直せる）・新しく競合になった（このタブの進捗を捨てることになる）：
    // 確かめ直す。書き出しに伴う保存の途中（pending）・その失敗（error）では確かめたままにする
    if (this.armedFor && this.armedFor !== k && (k === 'saved' || k === 'conflict')) {
      this.armedFor = null;
      this.heldReason = '';
    }
    const at = i.lastSavedAt ? `最後の保存 ${new Date(i.lastSavedAt).toLocaleTimeString()}` : 'このタブではまだ保存していません';
    const lost = i.lastSavedAt ? `最後の保存（${new Date(i.lastSavedAt).toLocaleTimeString()}）より後の進捗` : 'このタブを開いてからの進捗';
    let text: string;
    let label: string;
    switch (k) {
      case 'saved':
        text = `保存済み（${at}）。`;
        label = '保存して読み込み直す';
        break;
      case 'pending':
        text = `まだ保存していない変化があります（${at}）。「保存して読み込み直す」は、保存できたときだけ読み込み直します。`;
        label = '保存して読み込み直す';
        break;
      case 'error':
        text = `保存できていません（${i.error || '不明な理由'}）。このまま読み込み直すと、${lost}が消えるおそれがあります。先に「進捗を書き出す」でファイルに残してください。`;
        label = this.armedFor ? '保存せずに読み込み直す' : 'もう一度保存して読み込み直す';
        break;
      case 'conflict':
        text = '別のタブ（ウィンドウ）と保存が競合しているため、このタブからは保存していません。読み込み直すと別のタブの進捗に替わり、このタブの進捗は消えます。残したいときは先に「進捗を書き出す」でファイルに残してください。';
        label = this.armedFor ? 'このタブの進捗を捨てて読み込み直す' : '読み込み直す…';
        break;
      default:
        text = i.noSave
          ? 'このタブは保存していません（?nosave で開いています）。読み込み直すと、このタブの進捗は消えます。'
          : 'このブラウザでは保存できません（保存先が使えません）。読み込み直すと、このタブの進捗は消えます。残したいときは先に「進捗を書き出す」でファイルに残してください。';
        label = this.armedFor ? '保存せずに読み込み直す' : '読み込み直す…';
    }
    if (this.saving) text = '保存しています…（保存できたら読み込み直します）';
    else if (this.heldReason) text = `${this.heldReason}${text}`;
    if (this.armedFor) {
      text += ' もう一度押すと、保存せずに読み込み直します。';
      if (k === 'saved' || k === 'pending') label = '保存せずに読み込み直す';
    }
    if (this.exportedAt) text += `（${new Date(this.exportedAt).toLocaleTimeString()} にファイルへ書き出しました）`;
    this.saveEl.textContent = text;
    this.saveEl.dataset.state = k;
    this.reloadBtn.textContent = label;
    this.reloadBtn.classList.toggle('danger', !!this.armedFor);
    this.reloadBtn.disabled = this.saving;
  }

  /**
   * 「保存して読み込み直す」：保存できる状態なら保存し、保存できたときだけ読み込み直す。
   * 保存できない（失敗した・競合・保存しない）ときは読み込み直さず、もう一度押したときだけ保存せずに読み込み直す
   */
  async reload() {
    if (this.saving) return;
    const s = this.d.save;
    this.renderSave(); // 確かめた後に状態が変わっていれば、ここで確かめ直しになる
    const k = this.saveKind(s.info());
    if (this.armedFor) {
      this.stats.reloadUnsaved++;
      s.reload();
      return;
    }
    if (k === 'saved' || k === 'pending' || k === 'error') {
      this.saving = true;
      this.renderSave();
      // 保存先が応答しないこともある（iOS の IndexedDB が止まる例）：待ちすぎたら保存できなかったとみなす
      const r = await Promise.race([s.flush().catch(() => false), wait(FLUSH_TIMEOUT).then(() => 'timeout' as const)]);
      this.saving = false;
      if (r === true) {
        this.stats.reloadSaved++;
        s.reload();
        return;
      }
      // 保存できなかった（失敗・その間に競合になった・終わらない）：読み込み直さない
      this.stats.reloadHeld++;
      const now = this.saveKind(s.info());
      this.heldReason = r === 'timeout' ? '保存が終わらないため、読み込み直していません。' : '保存できなかったため、読み込み直していません。';
      this.armedFor = now;
      this.renderSave();
      return;
    }
    // 競合・保存しない：保存はできないので、確かめてから
    this.stats.reloadHeld++;
    this.armedFor = k;
    this.renderSave();
  }

  // ---------------- ?diag ----------------

  private startDiag() {
    const el = document.createElement('div');
    el.id = 'vp-diag';
    document.body.appendChild(el);
    this.diagEl = el;
    const note = (k: string) => (this.counts[k] = (this.counts[k] ?? 0) + 1);
    const tgt = (t: EventTarget | null) => {
      if (!(t instanceof Element)) return '?';
      return t.id ? `#${t.id}` : `${t.tagName.toLowerCase()}${t.classList.length ? '.' + [...t.classList].join('.') : ''}`;
    };
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      window.addEventListener(t, (e) => {
        note(t);
        this.lastPointer = `${t.replace('pointer', 'p.')} #${e.pointerId} ${e.pointerType} (${e.clientX.toFixed(0)}, ${e.clientY.toFixed(0)}) ${tgt(e.target)}`;
        if (t !== 'pointermove') this.push(this.lastPointer);
      }, { capture: true, passive: true });
    }
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      document.addEventListener(t, (e) => {
        note(t);
        const c = e.changedTouches[0];
        this.lastTouch = `${t} 指 ${e.touches.length} 本${c ? ` (${c.clientX.toFixed(0)}, ${c.clientY.toFixed(0)})` : ''}`;
        if (t !== 'touchmove') this.push(this.lastTouch);
      }, { capture: true, passive: true });
    }
    for (const t of ['gesturestart', 'gesturechange', 'gestureend', 'orientationchange', 'pageshow', 'pagehide'] as const) {
      window.addEventListener(t, () => {
        note(t);
        this.push(t);
      }, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => this.push(`visibility ${document.visibilityState}`));
    setInterval(() => this.drawDiag(), 200);
  }

  private push(s: string) {
    const t = (performance.now() / 1000).toFixed(2);
    this.log.push(`${t} ${s}`);
    if (this.log.length > 8) this.log.shift();
  }

  private drawDiag() {
    const el = this.diagEl;
    if (!el) return;
    const vv = window.visualViewport;
    const r = (sel: string) => {
      const e = document.querySelector(sel);
      if (!e) return '-';
      const b = e.getBoundingClientRect();
      return b.width ? `${b.left.toFixed(0)},${b.top.toFixed(0)} ${b.width.toFixed(0)}×${b.height.toFixed(0)}` : '隠';
    };
    const c = document.getElementById('view') as HTMLCanvasElement | null;
    const cb = c?.getBoundingClientRect();
    const i = this.d.input;
    const n = (k: string) => this.counts[k] ?? 0;
    el.textContent = [
      `倍率 ${vv ? vv.scale.toFixed(3) : '-'}（最大 ${this.stats.maxScale.toFixed(2)}）知らせ ${this.recovering ? '表示中' : 'なし'}`,
      `visual ${vv ? `${vv.width.toFixed(0)}×${vv.height.toFixed(0)} offset ${vv.offsetLeft.toFixed(0)},${vv.offsetTop.toFixed(0)} page ${vv.pageLeft.toFixed(0)},${vv.pageTop.toFixed(0)}` : '-'}`,
      `inner ${innerWidth}×${innerHeight} layout ${document.documentElement.clientWidth}×${document.documentElement.clientHeight} scroll ${scrollX.toFixed(0)},${scrollY.toFixed(0)} dpr ${devicePixelRatio}`,
      `向き ${screen.orientation?.type ?? (window as unknown as { orientation?: number }).orientation ?? '-'}`,
      `canvas ${cb ? `${cb.width.toFixed(0)}×${cb.height.toFixed(0)}` : '-'} 画素 ${c ? `${c.width}×${c.height}` : '-'}`,
      `stick ${r('#touch-ui .stick')}  jump ${r('#touch-ui .jump')}`,
      `dig ${r('#touch-ui .dig')}  cam ${r('#touch-ui .cam')}`,
      `カメラ ${this.d.camInfo?.() ?? '-'}`,
      `指 ポインター ${i.activePointers} 画面 ${i.viewTouchCount} 回収 ${JSON.stringify(i.recovered)}`,
      `ptr down ${n('pointerdown')} move ${n('pointermove')} up ${n('pointerup')} cancel ${n('pointercancel')} lost ${n('lostpointercapture')}`,
      `touch start ${n('touchstart')} move ${n('touchmove')} end ${n('touchend')} cancel ${n('touchcancel')} gesture ${n('gesturestart')}/${n('gesturechange')}/${n('gestureend')}`,
      `止めた gesture ${this.stats.gestureBlocked} touchmove ${this.stats.touchmoveBlocked} 回転 ${n('orientationchange')} 戻す ${this.stats.resetOk}/${this.stats.resetTried}`,
      `最後 ${this.lastPointer}`,
      `最後 ${this.lastTouch}`,
      ...this.log,
    ].join('\n');
    pinToVisual(el, false);
  }
}

/**
 * 要素を、いま見えている範囲（visual viewport）の左上に、ページの拡大を打ち消した大きさで置く
 * （fill = true なら見えている範囲いっぱい）。要素は position: fixed; left: 0; top: 0; transform-origin: 0 0
 */
function pinToVisual(el: HTMLElement, fill: boolean) {
  const vv = window.visualViewport;
  const s = vv ? vv.scale : 1;
  const ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
  if (fill) {
    const w = vv ? vv.width : window.innerWidth, h = vv ? vv.height : window.innerHeight;
    el.style.width = `${(w * s).toFixed(1)}px`;
    el.style.height = `${(h * s).toFixed(1)}px`;
  }
  el.style.transform = s > ZOOMED || ox || oy ? `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px) scale(${(1 / s).toFixed(4)})` : '';
}

/** 指がゲームの面（Canvas・画面の操作のボタン）の上から始まったか */
function onGameSurface(t: EventTarget | null): boolean {
  return t instanceof Element && (t.id === 'view' || !!t.closest('#touch-ui'));
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
