// 視点の切り替え（第 6 段階：iPhone の確認から。「いまどのカメラか・どう切り替わるのか分からない」への対応）。
// 冒険カメラの方式（三人称・肩越し・自由追従・従来）と、カメラの種類（ガラス越し・箱庭）を、1 列の「視点」にまとめる
// （AquaCamera.view / setView）。
// - 短く押す（カメラのボタン・V キー・ゲームパッドの RB / R1）：次の視点（VIEW_CYCLE の順。従来は一覧からだけ選ぶ）
// - 長く押す（カメラのボタン・V キーの長押し）：視点の一覧を開く。いまの視点に印。指を滑らせて離す・たたく・数字キーで選ぶ。
//   一覧の外をたたく・Esc で閉じる
// - 切り替えたときだけ、画面の上の方に視点の絵と名前を短く出す（ViewToast。ふだんは名前を出さない）
// - C キー・ゲームパッドの左スティック押し込み：肩越し ↔ 三人称（以前どおり）
// カメラのボタンの印は、いまの視点の絵に替わる（TouchControls.setButton）。

import { touchIcon, type TouchIconName } from '../ui/TouchControls';
import type { CamView } from './AquaCamera';

export const VIEW_LABEL: Record<CamView, string> = {
  tps: '三人称',
  close: '肩越し',
  free: '自由追従',
  observe: 'ガラス越し',
  diorama: '箱庭',
  classic: '従来',
};
/** 一覧の説明（短く） */
export const VIEW_DESC: Record<CamView, string> = {
  tps: 'カニの後ろから（標準）',
  close: '頭の後ろから前を見る',
  free: '地形を通り抜けて追う',
  observe: '水槽の外からガラス越し',
  diorama: '水槽全体を見渡す',
  classic: '以前の三人称',
};
export const VIEW_ICON: Record<CamView, TouchIconName> = {
  tps: 'camTps',
  close: 'camClose',
  free: 'camFree',
  observe: 'camObserve',
  diorama: 'camDiorama',
  classic: 'camClassic',
};
/** 短く押したときの順（三人称が標準。従来は一覧からだけ） */
export const VIEW_CYCLE: CamView[] = ['tps', 'close', 'free', 'observe', 'diorama'];
/** 一覧の並び（数字キー 1〜6 の順） */
export const VIEW_LIST: CamView[] = ['tps', 'close', 'free', 'observe', 'diorama', 'classic'];

/** 次の視点（従来は三人称の位置にいるとみなす） */
export function nextView(v: CamView, dir = 1): CamView {
  const i = VIEW_CYCLE.indexOf(v === 'classic' ? 'tps' : v);
  return VIEW_CYCLE[(i + dir + VIEW_CYCLE.length) % VIEW_CYCLE.length];
}

/** 切り替えたときに短く出す、視点の絵と名前 */
export class ViewToast {
  readonly el: HTMLElement;
  private timer = 0;
  /** 出した回数（はじめの数回だけ切り替え方の一言を添える） */
  shown = 0;

  constructor(private readonly hint: string) {
    this.el = document.createElement('div');
    this.el.id = 'view-toast';
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.el);
  }

  show(v: CamView) {
    this.shown++;
    const tip = this.shown <= 3 ? `<small>${this.hint}</small>` : '';
    this.el.innerHTML = `${touchIcon(VIEW_ICON[v])}<b>${VIEW_LABEL[v]}</b>${tip}`;
    this.el.classList.remove('show');
    void this.el.offsetWidth;
    this.el.classList.add('show');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('show'), this.shown <= 3 ? 2000 : 1300);
  }
}

/** 視点の一覧（長押しで開く） */
export class ViewPicker {
  readonly el: HTMLElement;
  private openNow = false;
  private hot: CamView | null = null;
  /** 選んだ回数・開いた回数（自動検証用） */
  readonly stats = { opens: 0, picks: 0 };

  constructor(private readonly current: () => CamView, private readonly pick: (v: CamView) => void, touch: boolean) {
    const el = (this.el = document.createElement('div'));
    el.id = 'view-picker';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', '視点を選ぶ');
    el.classList.toggle('touch', touch);
    el.innerHTML = `<div class="vp-head">視点を選ぶ</div>${VIEW_LIST.map(
      (v, i) => `<button type="button" role="menuitemradio" data-v="${v}">${touchIcon(VIEW_ICON[v])}<span class="nm">${VIEW_LABEL[v]}</span><span class="ds">${VIEW_DESC[v]}</span>${touch ? '' : `<kbd>${i + 1}</kbd>`}</button>`,
    ).join('')}`;
    document.body.appendChild(el);
    // 一覧の上の指・クリックはゲームに渡さない
    const stop = (e: Event) => e.stopPropagation();
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'wheel', 'contextmenu'] as const) el.addEventListener(t, stop);
    for (const b of el.querySelectorAll<HTMLButtonElement>('button')) b.addEventListener('click', () => this.choose(b.dataset.v as CamView));
    // 一覧の外をたたいたら閉じる
    window.addEventListener('pointerdown', (e) => {
      if (this.openNow && !el.contains(e.target as Node) && !(e.target as Element | null)?.closest?.('.tb.cam')) this.close();
    }, true);
  }

  get isOpen(): boolean {
    return this.openNow;
  }

  open() {
    this.openNow = true;
    this.stats.opens++;
    this.hot = null;
    this.render();
    this.el.classList.add('show');
  }

  close() {
    this.openNow = false;
    this.hot = null;
    this.el.classList.remove('show');
  }

  toggle() {
    if (this.openNow) this.close();
    else this.open();
  }

  /** いまの視点の印（開いている間に視点が変わったときも） */
  render() {
    const cur = this.current();
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button')) {
      const v = b.dataset.v as CamView;
      b.classList.toggle('on', v === cur);
      b.setAttribute('aria-checked', String(v === cur));
      b.classList.toggle('hot', v === this.hot);
    }
  }

  choose(v: CamView) {
    this.stats.picks++;
    this.pick(v);
    this.close();
  }

  /** 数字キー（1〜6） */
  chooseIndex(i: number) {
    const v = VIEW_LIST[i];
    if (v && this.openNow) this.choose(v);
  }

  /** 長押しのまま指を滑らせている（x, y = 画面の座標）。離した所が項目の上なら、それを選ぶ（外なら開いたまま：たたいて選べる） */
  drag(x: number, y: number, end: boolean) {
    if (!this.openNow) return;
    const t = document.elementFromPoint(x, y)?.closest?.('#view-picker button') as HTMLButtonElement | null;
    const v = t ? (t.dataset.v as CamView) : null;
    if (end) {
      if (v) this.choose(v);
      else this.render();
      return;
    }
    if (v !== this.hot) {
      this.hot = v;
      this.render();
    }
  }
}
