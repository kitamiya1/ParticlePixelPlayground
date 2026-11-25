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
// - 端末の回転・裏からの復帰：押している指を終わらせ、少し遅れて大きさを測り直す（iOS は回転の直後に古い大きさを返す
//   ことがある）。ページが横にずれていれば (0, 0) に戻す。
// - ?diag：倍率・visualViewport・innerWidth/Height・Canvas の実寸・ボタンの位置・カメラのズーム・指の座標と通知を
//   画面に出す（実機で原因を確かめる用。指の操作は受けない）。
//
// アクセシビリティ：viewport に user-scalable=no / maximum-scale は付けない（ふだんは）。端末の「ズーム機能」
// （画面全体の拡大鏡）や Safari の「ページの拡大／縮小（aA）」は止めない（どちらもページの倍率とは別で、操作もずれない）。
// 止めるのは、ゲームの操作（2 本指 = カメラのズーム）と取り合いになるページのピンチ・ダブルタップだけ。

import type { Input } from '../game/Input';

/** これより大きい倍率を「ページが拡大されている」とみなす（端数のずれは無視） */
const ZOOMED = 1.02;
/** 拡大に気づいてから知らせを出すまで（ms。ピンチの途中の一瞬の変化では出さない） */
const NOTICE_DELAY = 500;

export interface ViewportGuardDeps {
  input: Input;
  /** Canvas の大きさを測り直す */
  relayout: () => void;
  /** 進捗を保存してから読み込み直す */
  saveAndReload: () => Promise<void>;
  /** ?diag の表示に出すカメラの状態 */
  camInfo?: () => string;
  diag?: boolean;
}

export class ViewportGuard {
  readonly stats = { gestureBlocked: 0, touchmoveBlocked: 0, zoomNotices: 0, resetTried: 0, resetOk: 0, scrollFixed: 0, relayouts: 0, orientation: 0, maxScale: 1 };
  /** いまの倍率（visualViewport.scale） */
  scale = 1;
  /** 知らせを出している間（ピンチを止めない） */
  private recovering = false;
  private noticeTimer = 0;
  private touchesDown = 0;
  private readonly notice: HTMLElement;
  private readonly msg: HTMLElement;
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
        <div class="btns"><button type="button" data-k="reset">元に戻す</button><button type="button" data-k="reload">保存して読み込み直す</button></div>
        <div class="s">進捗は自動で保存されています。戻らないときは、この暗い部分を 2 本指でつまむように縮めてください。</div>
      </div>`;
    document.body.appendChild(this.notice);
    this.msg = this.notice.querySelector<HTMLElement>('[data-k="msg"]')!;
    this.notice.querySelector('[data-k="reset"]')!.addEventListener('click', () => void this.tryReset());
    this.notice.querySelector('[data-k="reload"]')!.addEventListener('click', () => {
      this.msg.textContent = '保存しています…';
      void this.d.saveAndReload();
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
    this.place();
  }

  private hideNotice() {
    this.recovering = false;
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
    else this.msg.textContent = '自動では戻せませんでした。この暗い部分を 2 本指でつまむように縮めるか、「保存して読み込み直す」を押してください。';
    return ok;
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
