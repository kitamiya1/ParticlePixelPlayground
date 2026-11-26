// ページ自体の拡大（ブラウザのピンチ・ダブルタップによる拡大。visualViewport.scale）を、ゲーム内カメラのズーム
// （2 本指のピンチ → Input.wheel → AquaCamera の zoom）と分けて扱う。
//
// iPhone の実機で分かったこと（2026-11-26）：gesture を止めても拡大が一度は起き（最大 2.17 倍）、知らせの「元に戻す」
// （viewport の設定を一瞬 maximum-scale=1 にする）でも「保存して読み込み直す」でも倍率が戻らなかった。Safari は同じページの
// 読み込み直し（reload）では前の倍率を引き継ぐ（履歴の項目が倍率を覚えている）ので、読み込み直しでは戻らない。
//
// - 防ぐ：CSS の touch-action: none（aquarium.css）に加えて、
//   - iOS Safari（WebKit）のピンチの通知 gesturestart / gesturechange の既定の動作を止める
//   - 2 本以上の指の touchmove：どれかの指がゲームの面の外から始まったら止める（どのブラウザでも）。WebKit のタッチ端末では
//     ゲームの面の上だけの指でも止める（touch-action の領域が古いまま・届かない一瞬の拡大を防ぐ。ポインターの通知は
//     touchmove より先に届くので、カメラのズーム・スティックの指には影響しない）
//   - WebKit のタッチ端末：ボタン・欄の外で素早く 2 回たたいた 2 回目の touchend の既定の動作（ダブルタップの拡大）を止める
//   1 本指のスクロール（説明・セーブの欄）は止めない。ボタン・リンクの上のタップも止めない（押せなくなるので）。
// - 拡大されても見失わない：倍率が 1.02 倍を超えている間は、ゲームの画面（body の中身：Canvas・操作のボタン・HUD・メニュー）
//   を、いま見えている範囲（visual viewport）に拡大を打ち消した大きさで置き直す（ふだんどおりの大きさで遊べる）。
//   指の座標は拡大の分だけ小さく届くので、スティック・視点の回転は Input.pointerScale で直す。
//   知らせ（#zoom-fix）と ?diag の表示は body の外（html の直下）に置き、別に見えている範囲へ合わせる。
// - 知らせ：拡大が指を離しても残ったら出す。「元に戻す」「保存して開き直す」「保存して新しいタブで開く」「進捗を書き出す」
//   「このまま遊ぶ」（知らせを閉じ、上に小さな「拡大中 — 直す」を残す）。
//   - 元に戻す：viewport の設定を一瞬 maximum-scale=1 にする。そのあと 3 回（約 1.2 秒）測って、すべて 1.02 倍以下のときだけ
//     「戻りました」とする。1 回でも拡大が残れば「戻せませんでした（倍率）」と出す（成功したようには出さない）
//   - 保存して開き直す：保存できたときだけ、同じタブで URL を新しく開く（location.replace。reload ではないので前の倍率を
//     引き継がない見込み。iPhone で確かめる）
//   - 保存して新しいタブで開く：押した瞬間に新しいタブを開き（ブラウザがポップアップを止めないように）、保存できたらそこで
//     開く。このタブはそれ以降保存しない（2 つのタブで保存が競合しないように）
//   - 開き直した先では、起動して少し待ってから倍率を測り、戻ったか・まだ拡大されているかを知らせと記録に出す
// - 保存：知らせには実際の保存の状態（保存済み・未保存の変化あり・保存できていない・別のタブと競合・保存しない）と、
//   直前の操作の成否（保存できた・できなかった・開き直す・タブを開けなかった）を出す。保存できない（失敗・競合・?nosave）
//   ときは開き直さず、「進捗を書き出す」を勧め、もう一度押して確かめたときだけ保存せずに開き直す。
// - 端末の回転・裏からの復帰：押している指を終わらせ、少し遅れて大きさを測り直す（iOS は回転の直後に古い大きさを返す
//   ことがある）。ページが横にずれていれば (0, 0) に戻す。
// - 診断：拡大が始まった・終わった・戻す・開き直す・開き直した後の結果を、時刻・倍率・向き・visual / layout / inner の大きさ・
//   直前の指（何本・どの要素の上）と一緒に localStorage（ppp-aquarium:vplog、最大 40 件）に残す（読み込み直し・新しいタブでも
//   見られる）。HUD の「詳細」の欄に出し、コピーできる。?diag は従来どおり画面の左上に細かい値を出す（指は受けない）。
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
/** 「保存して開き直す」で保存を待つ上限（ms） */
const FLUSH_TIMEOUT = 8000;
/** 「元に戻す」の後に倍率を測る時刻（ms。すべて 1.02 倍以下なら戻った） */
const RESET_SAMPLES = [300, 700, 1200];
/** 開き直した先で倍率を測るまで（ms） */
const AFTER_REOPEN_MS = 900;
/** ダブルタップとみなす間隔（ms）と距離（CSS px） */
const DBL_MS = 350;
const DBL_PX = 40;
/** 診断の記録（localStorage） */
export const VPLOG_KEY = 'ppp-aquarium:vplog';
const VPLOG_MAX = 40;
/** 開き直したときに URL に付ける印（開いた時刻 ms） */
const REOPEN_PARAM = 'reopen';

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

/** 知らせの「保存して開き直す」「進捗を書き出す」に使う保存の操作 */
export interface ViewportSave {
  info: () => SaveInfo;
  /** 今すぐ保存する（保存できたら true。失敗・競合・保存しないなら false） */
  flush: () => Promise<boolean>;
  /** いまの進捗をファイルに書き出す（競合中・保存しないときも書き出せる） */
  exportFile: () => void;
  /** このタブからの保存をやめる（新しいタブへ引き継いだ後。閉じる直前の控えも書かない） */
  suspend: () => void;
  /** 同じタブで URL を新しく開く（読み込み直しではない） */
  navigate: (url: string) => void;
}

/** 知らせに出す区分（saved でも変化があれば pending として扱う） */
type NoticeSave = 'saved' | 'pending' | 'error' | 'conflict' | 'off';

/** いまの倍率の測り方：scale = visualViewport.scale、ratio = レイアウトの幅 ÷ 見えている幅 */
interface Measure {
  scale: number;
  ratio: number;
  /** 拡大の判定に使う値（どちらか大きい方。片方だけが正しく報告されない場合に備える） */
  eff: number;
}

/** 診断の記録 1 件 */
interface VpLogEntry {
  at: number;
  ev: string;
  scale: number;
  ratio: number;
  orient: string;
  visual: string;
  layout: string;
  inner: string;
  touch: string;
  note?: string;
}

export interface ViewportGuardDeps {
  input: Input;
  /** Canvas の大きさを測り直す */
  relayout: () => void;
  /** 保存の状態と操作（知らせの説明とボタン） */
  save: ViewportSave;
  /** 短い知らせ（戻った・開き直した結果） */
  toast?: (msg: string) => void;
  /** ?diag の表示に出すカメラの状態 */
  camInfo?: () => string;
  diag?: boolean;
}

type ReopenMode = 'same' | 'tab';

export class ViewportGuard {
  readonly stats = {
    gestureBlocked: 0, touchmoveBlocked: 0, touchmoveSurfaceBlocked: 0, dblTapBlocked: 0, zoomEpisodes: 0, zoomNotices: 0,
    resetTried: 0, resetOk: 0, scrollFixed: 0, relayouts: 0, orientation: 0, maxScale: 1,
    reopenSaved: 0, reopenHeld: 0, reopenUnsaved: 0, tabOpened: 0, tabBlocked: 0, exports: 0, keepPlaying: 0, pinned: 0,
  };
  /** いまの倍率（visualViewport.scale） */
  scale = 1;
  /** 拡大の判定に使う値（Measure.eff） */
  eff = 1;
  /** WebKit のタッチ端末（iPhone・iPad の Safari 等）：ピンチ・ダブルタップを強めに止める */
  readonly webkitTouch: boolean;
  /** 知らせ（大きな方）を出している間（ピンチを止めない） */
  private recovering = false;
  /** 「このまま遊ぶ」で知らせを閉じた（拡大が続く間は小さな「直す」だけを出す） */
  private dismissed = false;
  /** 拡大が続いている（記録の始まり・終わりの区切り） */
  private zoomedSince = 0;
  /** 「元に戻す」で測っている途中（その間は知らせを勝手に消さない） */
  private resetting = false;
  /** 新しいタブへ引き継いだ（このタブはもう保存しない） */
  private handedOff = false;
  private pinnedNow = false;
  private noticeTimer = 0;
  private touchesDown = 0;
  private readonly notice: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly saveEl: HTMLElement;
  private readonly resEl: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly reopenBtn: HTMLButtonElement;
  private readonly tabBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  /** 保存して開き直す途中（保存を待っている） */
  private saving = false;
  /** 保存できない状態で「開き直す」を 1 回押した（その状態のまま、もう一度押すと保存せずに開き直す） */
  private armedFor: NoticeSave | null = null;
  /** 「保存して開き直す」で保存できなかった（開き直さなかった） */
  private heldReason = '';
  private exportedAt = 0;
  private saveTimer = 0;
  private diagEl: HTMLElement | null = null;
  /** ?diag：通知の数と最後の位置 */
  readonly log: string[] = [];
  /** 診断の記録（localStorage と同じ内容） */
  private vplog: VpLogEntry[] = [];
  private readonly counts: Record<string, number> = {};
  private lastPointer = '';
  private lastTouch = '';
  /** 最近の指の始まり（拡大の記録に添える。ふだんから数件だけ覚える） */
  private recentStarts: string[] = [];
  private lastTapEnd = { t: 0, x: 0, y: 0 };

  constructor(private readonly d: ViewportGuardDeps) {
    this.webkitTouch = 'ongesturestart' in window && navigator.maxTouchPoints > 0;
    this.vplog = readLog();

    // ---- 防ぐ ----
    // iOS Safari のピンチの通知（WebKit だけにある）：既定の動作（ページの拡大）を止める
    for (const t of ['gesturestart', 'gesturechange'] as const) {
      document.addEventListener(t, (e) => {
        if (this.recovering) return;
        e.preventDefault();
        this.stats.gestureBlocked++;
      }, { passive: false });
    }
    // 2 本以上の指の動き：どれかの指がゲームの面（Canvas・操作のボタン）の外（説明・セーブの欄など）から始まったら
    // 既定の動作（ピンチでの拡大）を止める。WebKit のタッチ端末では、ゲームの面の上だけの指でも止める。
    // 1 本指（欄の中のスクロール）は止めない。
    // Chromium ではゲームの面の上だけの指は触らない（touch-action: none で既に拡大しない。合成したピンチで touchmove を
    // 止めると pointermove が届かなくなり、カメラのズームが効かなくなった）
    document.addEventListener('touchmove', (e) => {
      if (this.recovering || e.touches.length < 2) return;
      let outside = false;
      for (let k = 0; k < e.touches.length; k++) if (!onGameSurface(e.touches[k].target)) outside = true;
      if (!outside && !this.webkitTouch) return;
      if (e.cancelable) {
        e.preventDefault();
        if (outside) this.stats.touchmoveBlocked++;
        else this.stats.touchmoveSurfaceBlocked++;
      }
    }, { passive: false, capture: true });
    // WebKit のタッチ端末：ボタン・欄の外の素早い 2 回のタップの 2 回目（ダブルタップの拡大）を止める
    if (this.webkitTouch) {
      document.addEventListener('touchend', (e) => {
        if (this.recovering || e.touches.length > 0 || e.changedTouches.length !== 1) return;
        const c = e.changedTouches[0];
        const now = performance.now();
        const L = this.lastTapEnd;
        const quick = now - L.t < DBL_MS && Math.hypot(c.clientX - L.x, c.clientY - L.y) < DBL_PX;
        this.lastTapEnd = { t: now, x: c.clientX, y: c.clientY };
        if (!quick || isInteractive(e.target)) return;
        if (e.cancelable) {
          e.preventDefault();
          this.stats.dblTapBlocked++;
        }
      }, { passive: false, capture: true });
    }
    const onTouchList = (e: TouchEvent) => {
      this.touchesDown = e.touches.length;
      if (e.type === 'touchstart') {
        const c = e.changedTouches[0];
        this.recentStarts.push(`${e.touches.length}本 ${describe(e.target)}${c ? ` (${c.clientX.toFixed(0)},${c.clientY.toFixed(0)})` : ''}`);
        if (this.recentStarts.length > 3) this.recentStarts.shift();
      }
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
    const later = (why: string) => {
      this.d.input.releaseAll();
      for (const ms of [0, 250, 700]) setTimeout(() => this.relayout(), ms);
      // 回転の後も拡大が残っていたら記録する（原因の手がかり）
      setTimeout(() => {
        if (this.eff > ZOOMED) this.record(`${why}の後も拡大`);
      }, 750);
    };
    window.addEventListener('orientationchange', () => {
      this.stats.orientation++;
      later('回転');
    });
    screen.orientation?.addEventListener?.('change', () => later('回転'));
    window.addEventListener('pageshow', () => later('表示'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') later('復帰');
    });

    // ---- 知らせ（body の外に置く：body は拡大中に見えている範囲へ置き直すので） ----
    this.notice = document.createElement('div');
    this.notice.id = 'zoom-fix';
    this.notice.innerHTML = `<div class="card" role="alertdialog" aria-labelledby="zoom-fix-t">
        <div class="t" id="zoom-fix-t">画面が拡大されています</div>
        <div class="m" data-k="msg"></div>
        <div class="btns">
          <button type="button" data-k="reset">元に戻す</button>
          <button type="button" data-k="reopen">保存して開き直す</button>
          <button type="button" data-k="tab">保存して新しいタブで開く</button>
          <button type="button" data-k="export">進捗を書き出す（ファイル）</button>
          <button type="button" data-k="keep" class="quiet">このまま遊ぶ</button>
        </div>
        <div class="res" data-k="res" aria-live="polite"></div>
        <div class="sv" data-k="save"></div>
        <div class="s">戻らないときは、この暗い部分を 2 本指でつまむように縮めても戻せます。</div>
      </div>
      <button type="button" class="chip" data-k="chip">画面が拡大中 — 直す</button>`;
    document.documentElement.appendChild(this.notice);
    const q = <T extends HTMLElement>(k: string) => this.notice.querySelector<T>(`[data-k="${k}"]`)!;
    this.msg = q('msg');
    this.saveEl = q('save');
    this.resEl = q('res');
    this.chip = q('chip');
    this.resetBtn = q<HTMLButtonElement>('reset');
    this.reopenBtn = q<HTMLButtonElement>('reopen');
    this.tabBtn = q<HTMLButtonElement>('tab');
    this.resetBtn.addEventListener('click', () => void this.tryReset());
    this.reopenBtn.addEventListener('click', () => void this.reopen('same'));
    this.tabBtn.addEventListener('click', () => void this.reopen('tab'));
    q('export').addEventListener('click', () => {
      this.d.save.exportFile();
      this.stats.exports++;
      this.exportedAt = Date.now();
      this.renderSave();
    });
    q('keep').addEventListener('click', () => {
      this.stats.keepPlaying++;
      this.dismissed = true;
      this.hideNotice(false);
      this.record('このまま遊ぶ');
    });
    this.chip.addEventListener('click', () => {
      this.dismissed = false;
      this.showNotice();
    });
    // 知らせの上の指はゲームに渡さない
    for (const t of ['pointerdown', 'wheel', 'contextmenu'] as const) this.notice.addEventListener(t, (e) => e.stopPropagation());

    if (d.diag) this.startDiag();
    this.check();
    this.afterReopen();
  }

  // ---------------- 倍率 ----------------

  /** いまの倍率を測る */
  measure(): Measure {
    const vv = window.visualViewport;
    const scale = vv ? vv.scale : 1;
    const lw = document.documentElement.clientWidth;
    const ratio = vv && vv.width > 0 && lw > 0 ? lw / vv.width : 1;
    return { scale, ratio, eff: Math.max(scale, ratio) };
  }

  /** 倍率を調べる（拡大されたままなら知らせ、戻っていれば知らせを消して測り直す） */
  check() {
    const m = this.measure();
    this.scale = m.scale;
    this.eff = m.eff;
    this.stats.maxScale = Math.max(this.stats.maxScale, m.eff);
    const zoomed = m.eff > ZOOMED;
    // 見失わない：拡大されている間は、ゲームの画面を見えている範囲へ置き直す
    this.pin(zoomed);
    if (this.recovering || this.dismissed) this.place();
    if (zoomed) {
      if (!this.zoomedSince) {
        this.zoomedSince = performance.now();
        this.stats.zoomEpisodes++;
        this.record('拡大が始まった');
      }
      if (!this.recovering && !this.dismissed && !this.noticeTimer) {
        this.noticeTimer = window.setTimeout(() => {
          this.noticeTimer = 0;
          // ピンチの途中なら、指が離れたときにもう一度調べる
          if (this.measure().eff > ZOOMED && this.touchesDown === 0 && !this.dismissed) this.showNotice();
        }, NOTICE_DELAY);
      }
      if (this.dismissed) this.chip.textContent = `画面が拡大中（×${m.eff.toFixed(2)}）— 直す`;
      return;
    }
    clearTimeout(this.noticeTimer);
    this.noticeTimer = 0;
    if (this.zoomedSince) {
      const sec = (performance.now() - this.zoomedSince) / 1000;
      this.zoomedSince = 0;
      this.record('拡大が終わった', `${sec.toFixed(1)} 秒続いた${this.resetting ? '（元に戻すの途中）' : this.recovering ? '（知らせの表示中）' : ''}`);
    }
    // 「元に戻す」の途中は、測り終えるまで知らせを消さない（一瞬だけ戻ったのを成功と見ない）
    if ((this.recovering || this.dismissed) && !this.resetting && !this.handedOff) {
      const wasDismissed = this.dismissed;
      this.dismissed = false;
      this.hideNotice(true);
      if (!wasDismissed || this.stats.zoomNotices) this.d.toast?.(`画面の倍率が戻りました（×${m.eff.toFixed(2)}）`);
    }
    // 倍率は 1 なのにページがずれている（回転の直後など）：元に戻す
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
      this.stats.scrollFixed++;
    }
  }

  /**
   * ゲームの画面（body）を、見えている範囲へ拡大を打ち消して置く（on = false で元に戻す）。
   * 指の座標の縮みは Input.pointerScale で直す
   */
  private pin(on: boolean) {
    const b = document.body;
    const vv = window.visualViewport;
    if (on && vv) {
      if (!this.pinnedNow) {
        this.pinnedNow = true;
        this.stats.pinned++;
        document.documentElement.classList.add('aqua-pinned');
      }
      const s = vv.scale;
      b.style.transform = `translate(${vv.offsetLeft.toFixed(1)}px, ${vv.offsetTop.toFixed(1)}px) scale(${(1 / s).toFixed(4)})`;
      this.d.input.pointerScale = s;
      return;
    }
    if (!this.pinnedNow) return;
    this.pinnedNow = false;
    document.documentElement.classList.remove('aqua-pinned');
    b.style.transform = '';
    this.d.input.pointerScale = 1;
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
    this.msg.textContent = 'ブラウザのページ自体が拡大されています（ゲームのカメラのズームとは別です）。ゲームの画面は見えている範囲に合わせて表示しています。';
    document.documentElement.classList.add('aqua-zoomfix');
    this.notice.classList.add('show');
    this.notice.classList.remove('chip-only');
    this.armedFor = null;
    this.heldReason = '';
    this.renderSave();
    // 出している間も保存の状態は変わる（自動保存・失敗・競合）ので、説明を合わせ続ける
    clearInterval(this.saveTimer);
    this.saveTimer = window.setInterval(() => this.renderSave(), 500);
    this.place();
    this.record('知らせを出した');
  }

  /** 知らせを閉じる（all = false なら拡大中の小さな「直す」は残す） */
  private hideNotice(all: boolean) {
    this.recovering = false;
    clearInterval(this.saveTimer);
    this.saveTimer = 0;
    document.documentElement.classList.remove('aqua-zoomfix');
    this.notice.classList.remove('show');
    this.notice.classList.toggle('chip-only', !all);
    if (!all) this.place();
    this.d.relayout();
  }

  /** 知らせを、いま見えている範囲（visual viewport）いっぱいに、拡大の影響を打ち消した大きさで置く */
  private place() {
    pinToVisual(this.notice, true);
  }

  /**
   * viewport の設定を一瞬 maximum-scale=1 にして、倍率を 1 に戻す（戻せない環境もある）。
   * その後 3 回測って、すべて戻っていたときだけ成功とする
   */
  async tryReset(): Promise<boolean> {
    if (this.resetting) return false;
    this.resetting = true;
    this.stats.resetTried++;
    const before = this.measure();
    this.resetBtn.disabled = true;
    this.setRes('元に戻しています…（倍率を測っています）', '');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta) {
      const orig = meta.content;
      meta.content = 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, viewport-fit=cover';
      await wait(150);
      meta.content = orig;
    }
    window.scrollTo(0, 0);
    let worst = 0;
    let t = 150;
    for (const at of RESET_SAMPLES) {
      await wait(Math.max(0, at - t));
      t = at;
      worst = Math.max(worst, this.measure().eff);
    }
    this.resetting = false;
    this.resetBtn.disabled = false;
    const ok = worst <= ZOOMED;
    this.record(ok ? '元に戻す：戻った' : '元に戻す：戻らない', `前 ×${before.eff.toFixed(2)} → 最大 ×${worst.toFixed(2)}（${RESET_SAMPLES.length} 回測定）`);
    if (ok) {
      this.stats.resetOk++;
      this.setRes(`✓ 倍率が戻りました（×${worst.toFixed(2)}。${RESET_SAMPLES.length} 回測って確認）`, 'ok');
      this.check();
    } else {
      this.setRes(`✗ 戻せませんでした（いまの倍率 ×${this.measure().eff.toFixed(2)}）。「保存して開き直す」か「新しいタブで開く」を試してください。`, 'ng');
      this.resetBtn.textContent = 'もう一度 元に戻す';
      this.check();
    }
    return ok;
  }

  private setRes(text: string, kind: '' | 'ok' | 'ng') {
    this.resEl.textContent = text;
    this.resEl.dataset.kind = kind;
  }

  // ---------------- 保存の状態・開き直す ----------------

  /** 知らせに出す保存の区分 */
  private saveKind(i: SaveInfo): NoticeSave {
    if (i.state === 'off' || i.state === 'conflict' || i.state === 'error') return i.state;
    // 'saved' でも、変化があってまだ書いていなければ未保存（AutoSaver は 6 秒たつまで 'saved' のまま）
    if (i.state === 'pending' || i.state === 'saving' || i.unsavedFor >= 0) return 'pending';
    return 'saved';
  }

  /** 知らせの保存の説明と「開き直す」のボタンを、いまの保存の状態に合わせる */
  renderSave() {
    if (this.handedOff) return;
    const i = this.d.save.info();
    const k = this.saveKind(i);
    // 確かめた後に、保存できた（ふつうに保存して開き直せる）・新しく競合になった（このタブの進捗を捨てることになる）：
    // 確かめ直す。書き出しに伴う保存の途中（pending）・その失敗（error）では確かめたままにする
    if (this.armedFor && this.armedFor !== k && (k === 'saved' || k === 'conflict')) {
      this.armedFor = null;
      this.heldReason = '';
    }
    const at = i.lastSavedAt ? `最後の保存 ${new Date(i.lastSavedAt).toLocaleTimeString()}` : 'このタブではまだ保存していません';
    const lost = i.lastSavedAt ? `最後の保存（${new Date(i.lastSavedAt).toLocaleTimeString()}）より後の進捗` : 'このタブを開いてからの進捗';
    let text: string;
    let label: string;
    let tabLabel: string;
    switch (k) {
      case 'saved':
        text = `保存済み（${at}）。`;
        label = '保存して開き直す';
        tabLabel = '保存して新しいタブで開く';
        break;
      case 'pending':
        text = `まだ保存していない変化があります（${at}）。「保存して開き直す」は、保存できたときだけ開き直します。`;
        label = '保存して開き直す';
        tabLabel = '保存して新しいタブで開く';
        break;
      case 'error':
        text = `保存できていません（${i.error || '不明な理由'}）。このまま開き直すと、${lost}が消えるおそれがあります。先に「進捗を書き出す」でファイルに残してください。`;
        label = this.armedFor ? '保存せずに開き直す' : 'もう一度保存して開き直す';
        tabLabel = this.armedFor ? '保存せずに新しいタブで開く' : 'もう一度保存して新しいタブで開く';
        break;
      case 'conflict':
        text = '別のタブ（ウィンドウ）と保存が競合しているため、このタブからは保存していません。開き直すと別のタブの進捗に替わり、このタブの進捗は消えます。残したいときは先に「進捗を書き出す」でファイルに残してください。';
        label = this.armedFor ? 'このタブの進捗を捨てて開き直す' : '開き直す…';
        tabLabel = this.armedFor ? 'このタブの進捗を捨てて新しいタブで開く' : '新しいタブで開く…';
        break;
      default:
        text = i.noSave
          ? 'このタブは保存していません（?nosave で開いています）。開き直すと、このタブの進捗は消えます。'
          : 'このブラウザでは保存できません（保存先が使えません）。開き直すと、このタブの進捗は消えます。残したいときは先に「進捗を書き出す」でファイルに残してください。';
        label = this.armedFor ? '保存せずに開き直す' : '開き直す…';
        tabLabel = this.armedFor ? '保存せずに新しいタブで開く' : '新しいタブで開く…';
    }
    if (this.saving) text = '保存しています…（保存できたら開き直します）';
    else if (this.heldReason) text = `${this.heldReason}${text}`;
    if (this.armedFor) {
      text += ' もう一度押すと、保存せずに開き直します。';
      if (k === 'saved' || k === 'pending') {
        label = '保存せずに開き直す';
        tabLabel = '保存せずに新しいタブで開く';
      }
    }
    if (this.exportedAt) text += `（${new Date(this.exportedAt).toLocaleTimeString()} にファイルへ書き出しました）`;
    this.saveEl.textContent = text;
    this.saveEl.dataset.state = k;
    this.reopenBtn.textContent = label;
    this.tabBtn.textContent = tabLabel;
    this.reopenBtn.classList.toggle('danger', !!this.armedFor);
    this.tabBtn.classList.toggle('danger', !!this.armedFor);
    this.reopenBtn.disabled = this.tabBtn.disabled = this.saving;
  }

  /**
   * 「保存して開き直す」（same：同じタブで URL を新しく開く）・「保存して新しいタブで開く」（tab）：
   * 保存できる状態なら保存し、保存できたときだけ開き直す。保存できない（失敗・競合・保存しない）ときは開き直さず、
   * もう一度押したときだけ保存せずに開き直す
   */
  async reopen(mode: ReopenMode) {
    if (this.saving || this.handedOff) return;
    const s = this.d.save;
    this.renderSave(); // 確かめた後に状態が変わっていれば、ここで確かめ直しになる
    const k = this.saveKind(s.info());
    const go = this.armedFor !== null || k === 'saved' || k === 'pending' || k === 'error';
    // 新しいタブは押した瞬間に開く（保存を待ってから開くと、ブラウザがポップアップとして止める）
    let w: Window | null = null;
    if (mode === 'tab' && go) {
      try {
        w = window.open('', '_blank');
      } catch {
        w = null;
      }
      if (!w) {
        this.stats.tabBlocked++;
        this.setRes('✗ 新しいタブを開けませんでした（ブラウザが止めました）。「保存して開き直す」を使ってください。', 'ng');
        this.record('新しいタブ：開けない');
        return;
      }
    }
    if (this.armedFor) {
      this.stats.reopenUnsaved++;
      this.record(mode === 'tab' ? '保存せずに新しいタブ' : '保存せずに開き直す', `保存の状態 ${k}`);
      this.navigate(mode, w, false);
      return;
    }
    if (go) {
      this.saving = true;
      this.renderSave();
      this.setRes('保存しています…', '');
      // 保存先が応答しないこともある（iOS の IndexedDB が止まる例）：待ちすぎたら保存できなかったとみなす
      const r = await Promise.race([s.flush().catch(() => false), wait(FLUSH_TIMEOUT).then(() => 'timeout' as const)]);
      this.saving = false;
      if (r === true) {
        this.stats.reopenSaved++;
        const t = new Date().toLocaleTimeString();
        this.setRes(`✓ 保存しました（${t}）。${mode === 'tab' ? '新しいタブで開きます…' : '開き直します…'}`, 'ok');
        this.record(mode === 'tab' ? '保存して新しいタブ' : '保存して開き直す', `保存できた ${t}`);
        this.navigate(mode, w, true);
        return;
      }
      // 保存できなかった（失敗・その間に競合になった・終わらない）：開き直さない
      w?.close();
      this.stats.reopenHeld++;
      const now = this.saveKind(s.info());
      this.heldReason = r === 'timeout' ? '保存が終わらないため、開き直していません。' : '保存できなかったため、開き直していません。';
      this.setRes(`✗ ${this.heldReason}`, 'ng');
      this.record('開き直す：保存できず止めた', r === 'timeout' ? '8 秒たっても終わらない' : `保存の状態 ${now}`);
      this.armedFor = now;
      this.renderSave();
      return;
    }
    // 競合・保存しない：保存はできないので、確かめてから
    this.stats.reopenHeld++;
    this.armedFor = k;
    this.setRes(k === 'conflict' ? '別のタブと競合しているため、保存できません。' : 'このタブは保存していません。', 'ng');
    this.renderSave();
  }

  /** 開き直す先の URL：いまの URL に開いた時刻の印を付ける（ほかの指定 ?nosave・?diag はそのまま） */
  reopenUrl(): string {
    const u = new URL(location.href);
    u.searchParams.set(REOPEN_PARAM, String(Date.now()));
    u.hash = '';
    return u.toString();
  }

  private navigate(mode: ReopenMode, w: Window | null, saved: boolean) {
    const url = this.reopenUrl();
    if (mode === 'same') {
      this.d.save.navigate(url);
      return;
    }
    if (!w) return;
    this.stats.tabOpened++;
    // このタブはもう保存しない（新しいタブと保存が競合しないように）
    this.d.save.suspend();
    this.handedOff = true;
    try {
      w.location.href = url;
    } catch {
      /* 開いたタブへ移れない環境 */
    }
    this.notice.classList.add('handed');
    this.msg.textContent = '新しいタブで開きました。続きはそちらで遊んでください。このタブはもう保存しないので、閉じて構いません。';
    this.saveEl.textContent = saved ? '進捗は保存してから引き継ぎました。' : '保存せずに開いたため、このタブの最後の保存より後の進捗は新しいタブにありません（このタブから「進捗を書き出す」でファイルに残せます）。';
    this.saveEl.dataset.state = saved ? 'saved' : 'error';
  }

  /** 開き直した先：少し待って倍率を測り、戻ったか知らせて記録する（URL の印は消す） */
  private afterReopen() {
    const u = new URL(location.href);
    const v = u.searchParams.get(REOPEN_PARAM);
    if (!v) return;
    const sent = Number(v);
    u.searchParams.delete(REOPEN_PARAM);
    try {
      history.replaceState(history.state, '', u.toString());
    } catch {
      /* URL を書き換えられない環境では印が残るだけ */
    }
    setTimeout(() => {
      const m = this.measure();
      const ok = m.eff <= ZOOMED;
      const ago = Number.isFinite(sent) ? `押してから ${((Date.now() - sent) / 1000).toFixed(1)} 秒` : '';
      this.record(ok ? '開き直した後：正常' : '開き直した後：拡大が残る', ago);
      if (ok) this.d.toast?.(`開き直しました：倍率 ×${m.eff.toFixed(2)}（正常）`);
      else {
        this.check();
        this.setRes(`✗ 開き直しても拡大が残っています（×${m.eff.toFixed(2)}）。「新しいタブで開く」を試すか、暗い部分を 2 本指でつまんで縮めてください。`, 'ng');
      }
    }, AFTER_REOPEN_MS);
  }

  // ---------------- 診断の記録 ----------------

  /** 診断の記録に 1 件足す（localStorage にも残す） */
  record(ev: string, note?: string) {
    const vv = window.visualViewport;
    const m = this.measure();
    const de = document.documentElement;
    const e: VpLogEntry = {
      at: Date.now(),
      ev,
      scale: round3(m.scale),
      ratio: round3(m.ratio),
      orient: orientation(),
      visual: vv ? `${vv.width.toFixed(0)}×${vv.height.toFixed(0)}+${vv.offsetLeft.toFixed(0)},${vv.offsetTop.toFixed(0)}` : '-',
      layout: `${de.clientWidth}×${de.clientHeight}`,
      inner: `${innerWidth}×${innerHeight}`,
      touch: this.recentStarts.join(' / '),
    };
    if (note) e.note = note;
    this.vplog.push(e);
    while (this.vplog.length > VPLOG_MAX) this.vplog.shift();
    writeLog(this.vplog);
    this.push(`${ev}${note ? ` ${note}` : ''}`);
  }

  /** 記録を人が読める文にする（新しい順） */
  logText(): string {
    return [...this.vplog].reverse().map((e) => {
      const t = new Date(e.at);
      const ts = `${t.getMonth() + 1}/${t.getDate()} ${t.toLocaleTimeString()}`;
      return `${ts} ${e.ev}${e.note ? `（${e.note}）` : ''}\n  倍率 ${e.scale} 比 ${e.ratio} ${e.orient} visual ${e.visual} layout ${e.layout} inner ${e.inner}${e.touch ? `\n  指 ${e.touch}` : ''}`;
    }).join('\n');
  }

  clearLog() {
    this.vplog = [];
    writeLog(this.vplog);
  }

  /** いまの画面の値（HUD の詳細の欄） */
  viewportText(): string {
    const vv = window.visualViewport;
    const m = this.measure();
    const de = document.documentElement;
    const st = this.stats;
    return [
      `倍率 ${m.scale.toFixed(3)}（比 ${m.ratio.toFixed(3)}、最大 ${st.maxScale.toFixed(2)}）${m.eff > ZOOMED ? ' 拡大中' : ''}`,
      `向き ${orientation()}  visual ${vv ? `${vv.width.toFixed(0)}×${vv.height.toFixed(0)}+${vv.offsetLeft.toFixed(0)},${vv.offsetTop.toFixed(0)}` : '-'}`,
      `layout ${de.clientWidth}×${de.clientHeight}  inner ${innerWidth}×${innerHeight}  dpr ${devicePixelRatio}`,
      `拡大 ${st.zoomEpisodes} 回・知らせ ${st.zoomNotices}・戻す ${st.resetOk}/${st.resetTried}・開き直し ${st.reopenSaved + st.reopenUnsaved}・止めた ${st.reopenHeld}`,
      `止めた操作 gesture ${st.gestureBlocked}・2 本指 ${st.touchmoveBlocked}+${st.touchmoveSurfaceBlocked}・ダブルタップ ${st.dblTapBlocked}${this.webkitTouch ? '（WebKit）' : ''}`,
    ].join('\n');
  }

  // ---------------- ?diag ----------------

  private startDiag() {
    const el = document.createElement('div');
    el.id = 'vp-diag';
    document.documentElement.appendChild(el);
    this.diagEl = el;
    const note = (k: string) => (this.counts[k] = (this.counts[k] ?? 0) + 1);
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      window.addEventListener(t, (e) => {
        note(t);
        this.lastPointer = `${t.replace('pointer', 'p.')} #${e.pointerId} ${e.pointerType} (${e.clientX.toFixed(0)}, ${e.clientY.toFixed(0)}) ${describe(e.target)}`;
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
    const i = this.d.input;
    const n = (k: string) => this.counts[k] ?? 0;
    el.textContent = [
      `倍率 ${vv ? vv.scale.toFixed(3) : '-'}（比 ${this.measure().ratio.toFixed(3)} 最大 ${this.stats.maxScale.toFixed(2)}）知らせ ${this.recovering ? '表示中' : this.dismissed ? '閉じた（直す）' : 'なし'}${this.pinnedNow ? ' 置き直し中' : ''}`,
      `visual ${vv ? `${vv.width.toFixed(0)}×${vv.height.toFixed(0)} offset ${vv.offsetLeft.toFixed(0)},${vv.offsetTop.toFixed(0)} page ${vv.pageLeft.toFixed(0)},${vv.pageTop.toFixed(0)}` : '-'}`,
      `inner ${innerWidth}×${innerHeight} layout ${document.documentElement.clientWidth}×${document.documentElement.clientHeight} scroll ${scrollX.toFixed(0)},${scrollY.toFixed(0)} dpr ${devicePixelRatio}`,
      `向き ${orientation()}`,
      `canvas ${c ? `${c.clientWidth}×${c.clientHeight}` : '-'} 画素 ${c ? `${c.width}×${c.height}` : '-'}`,
      `stick ${r('#touch-ui .stick')}  jump ${r('#touch-ui .jump')}`,
      `dig ${r('#touch-ui .dig')}  cam ${r('#touch-ui .cam')}`,
      `カメラ ${this.d.camInfo?.() ?? '-'}`,
      `指 ポインター ${i.activePointers} 画面 ${i.viewTouchCount} 回収 ${JSON.stringify(i.recovered)} 座標の倍 ${i.pointerScale.toFixed(2)}`,
      `ptr down ${n('pointerdown')} move ${n('pointermove')} up ${n('pointerup')} cancel ${n('pointercancel')} lost ${n('lostpointercapture')}`,
      `touch start ${n('touchstart')} move ${n('touchmove')} end ${n('touchend')} cancel ${n('touchcancel')} gesture ${n('gesturestart')}/${n('gesturechange')}/${n('gestureend')}`,
      `止めた gesture ${this.stats.gestureBlocked} 2本指 ${this.stats.touchmoveBlocked}+${this.stats.touchmoveSurfaceBlocked} 2回タップ ${this.stats.dblTapBlocked} 回転 ${n('orientationchange')} 戻す ${this.stats.resetOk}/${this.stats.resetTried} 拡大 ${this.stats.zoomEpisodes} 回`,
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

/** 押せる物・欄の上か（ダブルタップを止めると押せなくなる所） */
function isInteractive(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest('button, a, input, select, textarea, label, [role="dialog"], [role="alertdialog"], #menu, #save-panel, #save-alert');
}

function describe(t: EventTarget | null): string {
  if (!(t instanceof Element)) return '?';
  return t.id ? `#${t.id}` : `${t.tagName.toLowerCase()}${t.classList.length ? '.' + [...t.classList].join('.') : ''}`;
}

function orientation(): string {
  return screen.orientation?.type ?? String((window as unknown as { orientation?: number }).orientation ?? (innerWidth > innerHeight ? 'landscape' : 'portrait'));
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function readLog(): VpLogEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(VPLOG_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(-VPLOG_MAX) : [];
  } catch {
    return [];
  }
}

function writeLog(v: VpLogEntry[]) {
  try {
    localStorage.setItem(VPLOG_KEY, JSON.stringify(v));
  } catch {
    /* 残せない環境（プライベートブラウズ等）では、このページの間だけの記録 */
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
