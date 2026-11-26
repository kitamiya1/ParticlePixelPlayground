// 左上の表示（HUD）。ふだんは小さな 1〜2 行だけ（いまいる場所・手持ちの砂・必要なときだけの操作の状態と警告）。
// 区画・カメラ・カニの状態・発見の数・遊泳・FPS・三角形の数・区画の作り直しの時間・画面（ページの倍率）の診断は、
// 「詳細」で開く欄（#hud-detail）へ移した。
// - 詳細の欄は右上の「×」・もう一度「詳細」・PC の I キーで閉じる。開いているかは localStorage（ppp-aquarium:hud）に覚える
//   （読み込み直しても同じ。?diag で開いたときは覚えない）
// - 欄は中でスクロールする（pan-y）。欄の上の指はゲームに渡さない（視点・カメラのズームにならない）
// - 縦・横の画面の大きさに合わせて欄の高さを決める（操作のボタンの上に掛からない：aquarium.css）

/** 詳細の欄を開いているかの記録（保存データとは別） */
export const HUD_KEY = 'ppp-aquarium:hud';

/** 毎回の表示に使う値（main.ts が集める） */
export interface HudInfo {
  place: string;
  placeHidden: boolean;
  /** 手持ちの砂（0..1）と杯の数 */
  sand: number;
  cups: number;
  capCups: number;
  /** 盛るのとき true（ふだんの「掘る」は小さな表示に出さない） */
  fill: boolean;
  /** 遊泳の体力（0..1）。泳いでいる・減っているときだけ小さな表示に出す */
  swim: number;
  swimShow: boolean;
  /** 掘る・盛るの照準の先（null = 出さない）。ng = 掘れない / 盛れない */
  dig: { text: string; ng: boolean } | null;
  /** 挟む（null = 出さない） */
  grab: { text: string; heavy: boolean } | null;
  /** 案内を出す設定（false なら照準・挟む物の文字は詳細の欄だけ） */
  guides: boolean;
  /** 警告（保存できていない等。null = 出さない） */
  warn: string | null;
  // ---- 詳細の欄 ----
  zone: string;
  land: boolean;
  cam: string;
  state: string;
  found: string;
  perf: string;
  frame: string;
  digPerf: string;
  viewport: string;
  /** ゲームパッド・音の状態 */
  device: string;
}

export class AquaHud {
  readonly root: HTMLElement;
  readonly detail: HTMLElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly el: Record<string, HTMLElement> = {};
  /** 詳細の欄に出す拡大の記録（AquaViewport から） */
  logText: () => string = () => '';
  onClearLog: () => void = () => {};

  constructor(opts: { forceDetail?: boolean } = {}) {
    const root = document.createElement('div');
    root.id = 'hud';
    root.innerHTML = `
      <div class="line"><span class="place" id="h-place">—</span><span class="sandc" title="手持ちの砂"><span class="lbl">砂</span><span class="bar sand"><i id="h-sand"></i></span><span class="sandn" id="h-sandn"></span></span><span class="tag tool off" id="h-tool"></span><button type="button" class="hud-more" aria-expanded="false" aria-controls="hud-detail" title="詳しい表示（I）">詳細</button></div>
      <div class="line st"><span class="tag swim off" id="h-swimc"><span class="lbl">遊泳</span><span class="bar"><i id="h-swim"></i></span></span><span class="tag dig off" id="h-dig"></span><span class="tag grab off" id="h-grab"></span><span class="tag warn off" id="h-warn"></span></div>`;
    document.body.appendChild(root);
    this.root = root;

    const d = document.createElement('div');
    d.id = 'hud-detail';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', '詳しい表示');
    d.innerHTML = `
      <div class="hd-head"><b>水槽探検 — 詳しい表示</b><button type="button" class="hd-close" aria-label="詳しい表示を閉じる" title="閉じる（I）">×</button></div>
      <div class="hd-body">
        <div class="row"><span class="k">区画</span><span class="tag" id="h-zone">水中</span><span class="tag cam" id="h-cam"></span><span id="h-state"></span></div>
        <div class="row"><span class="k">発見</span><span id="h-found"></span></div>
        <div class="row"><span class="k">照準</span><span id="h-digd">—</span></div>
        <div class="row"><span class="k">ハサミ</span><span id="h-grabd">—</span></div>
        <div class="row"><span class="k">遊泳</span><span class="bar"><i id="h-swimd"></i></span></div>
        <div class="sec">性能</div>
        <div class="sub" id="h-perf"></div>
        <div class="sub" id="h-frame"></div>
        <div class="sub" id="h-digperf"></div>
        <div class="sec">入力・音</div>
        <div class="sub" id="h-dev"></div>
        <div class="sec">画面（ページの倍率の診断）</div>
        <div class="sub pre" id="h-vp"></div>
        <div class="sub pre log" id="h-vplog"></div>
        <div class="btns"><button type="button" data-k="copy">記録をコピー</button><button type="button" data-k="clear">記録を消す</button><span class="res" data-k="res"></span></div>
        <div class="sub"><a href="./index.html">描画方式の比較へ</a></div>
      </div>`;
    document.body.appendChild(d);
    this.detail = d;
    for (const id of ['h-place', 'h-sand', 'h-sandn', 'h-tool', 'h-swimc', 'h-swim', 'h-dig', 'h-grab', 'h-warn', 'h-zone', 'h-cam', 'h-state', 'h-found', 'h-digd', 'h-grabd', 'h-swimd', 'h-perf', 'h-frame', 'h-digperf', 'h-dev', 'h-vp', 'h-vplog']) {
      this.el[id] = document.getElementById(id)!;
    }
    // 欄・ボタンの上の指・ホイールはゲームに渡さない
    const stop = (e: Event) => e.stopPropagation();
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'wheel', 'contextmenu'] as const) {
      d.addEventListener(t, stop);
    }
    this.moreBtn = root.querySelector<HTMLButtonElement>('.hud-more')!;
    this.moreBtn.addEventListener('pointerdown', stop);
    this.moreBtn.addEventListener('click', () => this.toggle());
    d.querySelector('.hd-close')!.addEventListener('click', () => this.setOpen(false));
    const res = d.querySelector<HTMLElement>('[data-k="res"]')!;
    d.querySelector('[data-k="copy"]')!.addEventListener('click', () => {
      const text = this.logText();
      const done = (ok: boolean) => (res.textContent = ok ? 'コピーしました' : 'コピーできませんでした（下の記録を長押しで選んでください）');
      try {
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
        else done(false);
      } catch {
        done(false);
      }
    });
    d.querySelector('[data-k="clear"]')!.addEventListener('click', () => {
      this.onClearLog();
      res.textContent = '記録を消しました';
    });
    this.setOpen(opts.forceDetail || readOpen(), !opts.forceDetail);
  }

  get open(): boolean {
    return this.detail.classList.contains('show');
  }

  setOpen(on: boolean, remember = true) {
    this.detail.classList.toggle('show', on);
    this.moreBtn.classList.toggle('on', on);
    this.moreBtn.setAttribute('aria-expanded', String(on));
    if (remember) writeOpen(on);
  }

  toggle() {
    this.setOpen(!this.open);
  }

  update(h: HudInfo) {
    const e = this.el;
    setText(e['h-place'], h.place);
    e['h-place'].classList.toggle('hidden', h.placeHidden);
    e['h-sand'].style.width = `${Math.round(h.sand * 100)}%`;
    setText(e['h-sandn'], `${h.cups}/${h.capCups}${h.cups >= h.capCups ? ' 満杯' : ''}`);
    e['h-tool'].classList.toggle('off', !h.fill);
    setText(e['h-tool'], h.fill ? '盛る' : '');
    e['h-tool'].classList.toggle('fill', h.fill);
    e['h-swimc'].classList.toggle('off', !h.swimShow);
    e['h-swim'].style.width = `${Math.round(h.swim * 100)}%`;
    // 照準の先の物・挟んでいる物の名前は、案内を出す設定のときだけ（ふだんは物の動き・音で分かるようにする）
    const dig = h.guides ? h.dig : null, grab = h.guides ? h.grab : null;
    chip(e['h-dig'], dig?.text ?? null, 'ng', !!dig?.ng);
    chip(e['h-grab'], grab?.text ?? null, 'heavy', !!grab?.heavy);
    chip(e['h-warn'], h.warn, '', false);
    // 2 行目（状態）が空なら隠す（ふだんは 1 行だけ）
    this.root.classList.toggle('has-st', h.swimShow || !!dig || !!grab || !!h.warn);
    if (!this.open) return;
    setText(e['h-zone'], h.zone);
    e['h-zone'].classList.toggle('land', h.land);
    setText(e['h-cam'], h.cam);
    setText(e['h-state'], h.state);
    setText(e['h-found'], h.found);
    setText(e['h-digd'], h.dig?.text ?? '—');
    setText(e['h-grabd'], h.grab?.text ?? '—');
    e['h-swimd'].style.width = `${Math.round(h.swim * 100)}%`;
    setText(e['h-perf'], h.perf);
    setText(e['h-frame'], h.frame);
    setText(e['h-digperf'], h.digPerf);
    setText(e['h-dev'], h.device);
    setText(e['h-vp'], h.viewport);
    setText(e['h-vplog'], this.logText() || '拡大の記録はありません');
  }
}

function setText(el: HTMLElement, s: string) {
  if (el.textContent !== s) el.textContent = s;
}

function chip(el: HTMLElement, text: string | null, cls: string, on: boolean) {
  el.classList.toggle('off', text === null);
  if (text !== null) setText(el, text);
  if (cls) el.classList.toggle(cls, on);
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(HUD_KEY) === 'detail';
  } catch {
    return false;
  }
}

function writeOpen(on: boolean) {
  try {
    localStorage.setItem(HUD_KEY, on ? 'detail' : 'compact');
  } catch {
    /* 覚えられない環境では、次もまた小さな表示で始まるだけ */
  }
}
