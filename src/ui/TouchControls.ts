// スマホ・タブレット用の画面上の操作（仮想スティックと走るボタン）。
// 入力値を Input に書き込むだけで、ゲームロジックには関与しない。
// 押した指の管理（動き・離した・取り消し・見失った）は Input.claim に任せる（要素の上で離さなくても・離した通知が
// 失われても、必ず元に戻る）。押している指の番号が終わらないまま同じ操作をもう一度押したら、新しい指に付け替える
// （固まったスティックも、押し直せば直る）。

import { DIG_AIM, digAimFromOffset, type Input } from '../game/Input';

const STICK_RADIUS = 48; // ノブが動ける半径（CSS px）

/** 追加のボタン（水槽ゲーム用。指定しなければ従来どおりスティックと走るボタンだけ） */
export interface TouchControlsOptions {
  /** 走るボタンの表示名（既定「走る」） */
  runLabel?: string;
  /** ジャンプボタン（押している間 Input.touchJump = true） */
  jump?: boolean;
  /** カメラ切り替えボタン（押したときに呼ぶ） */
  onCamera?: () => void;
  /**
   * 掘るボタン（押している間 Input.touchDig = true）。押したまま指をずらすと、押した位置からのずれが掘る向きの照準
   * （Input.touchDigAim：上へずらす = 上を掘る、左右 = 左右、斜めも可。指がボタンの外へ出ても続く）
   */
  dig?: boolean;
  /**
   * その場の操作のボタン（押している間 Input.touchAct = true。水槽ゲームの「調べる / 引っこ抜く」）。
   * ふだんは隠れていて、setAct で文字を入れたときだけ出る
   */
  act?: boolean;
  /**
   * 挟むスイッチ（たたくたびに Input.touchGrabLatch を切り替える。水槽ゲームの「挟む」）。押したまま指をずらすと視点を回せる
   */
  grab?: boolean;
  /**
   * 文字の代わりに簡単な印（アイコン）で出す（水槽ゲーム）。見た目の円（.face）と指の当たる範囲（ボタン自体）を分け、
   * 見た目を小さく・薄くしても押しやすさを保つ。大きさと濃さは setLook で変える
   */
  icons?: boolean;
}

/** 挟むボタンを押したまま指をずらしたとき、視点の回転に使い始めるずれ（CSS px） */
const GRAB_LOOK_DEAD = 10;

/** 印（24 × 24 の線画。色は文字の色） */
export const TOUCH_ICONS = {
  jump: '<path d="M6 14l6-6 6 6"/><path d="M6 19h12"/>',
  run: '<path d="M5 6l6 6-6 6"/><path d="M12 6l6 6-6 6"/>',
  dig: '<path d="M12 3v9"/><path d="M8.5 8.5L12 12l3.5-3.5"/><path d="M3 14.5c2.5 6 15.5 6 18 0"/>',
  fill: '<path d="M12 3v8"/><path d="M8.5 7.5L12 11l3.5-3.5"/><path d="M3 20.5c3-6.5 15-6.5 18 0"/>',
  cam: '<rect x="3" y="7.5" width="18" height="12" rx="2.5"/><circle cx="12" cy="13.5" r="3.2"/><path d="M8.5 7.5l1.6-2.6h3.8l1.6 2.6"/>',
  clawOpen: '<path d="M12 21v-5.5"/><path d="M12 15.5C7.5 15.5 5 12 5.5 4.5"/><path d="M12 15.5c3.8 0 6.2-2.6 6.2-8"/>',
  clawShut: '<path d="M12 21v-5.5"/><path d="M12 15.5c-4 0-6.4-3-5.6-8.4 2.2-2.4 5.2-2 6.1 1.4"/><path d="M12 15.5c4 0 6.4-3 5.6-8.4-2.2-2.4-5.2-2-6.1 1.4"/>',
} as const;

/** 印の SVG（class は表示の切り替え用） */
export function touchIcon(name: keyof typeof TOUCH_ICONS, cls = ''): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${TOUCH_ICONS[name]}</svg>`;
}

/** スティックのノブが動ける半径（見た目の大きさ 1 のとき。setLook の大きさを掛ける） */
const STICK_RADIUS_BASE = STICK_RADIUS;

export class TouchControls {
  readonly root: HTMLElement;
  /** ボタンの見た目の大きさ（1 = 以前の大きさ）と背景の濃さ（0..1） */
  scale = 1;
  alpha = 0.25;
  private stickR = STICK_RADIUS_BASE;
  private readonly icons: boolean;

  constructor(private readonly input: Input, opts: TouchControlsOptions = {}) {
    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.icons = !!opts.icons;
    if (this.icons) {
      // 見た目の円（.face）の中に印。ボタン自体は透明で、円より少し大きく指を受ける
      const f = (inner: string) => `<span class="face">${inner}</span>`;
      this.root.classList.add('icons');
      this.root.innerHTML = `
      <div class="stick"><i class="ring"></i><div class="knob"></div></div>
      <button class="tb run" type="button" aria-label="${opts.runLabel ?? '走る'}">${f(touchIcon('run'))}</button>${opts.jump ? `
      <button class="tb jump" type="button" aria-label="ジャンプ">${f(touchIcon('jump'))}</button>` : ''}${opts.dig ? `
      <button class="tb dig" type="button" aria-label="掘る">${f(`<i class="aim"></i>${touchIcon('dig', 'i-dig')}${touchIcon('fill', 'i-fill')}`)}</button>` : ''}${opts.onCamera ? `
      <button class="tb cam" type="button" aria-label="カメラの切り替え">${f(touchIcon('cam'))}</button>` : ''}${opts.act ? `
      <button class="act" type="button"><i class="ring"></i><span></span></button>` : ''}${opts.grab ? `
      <button class="tb grab" type="button" aria-pressed="false" aria-label="挟む">${f(`${touchIcon('clawOpen', 'i-open')}${touchIcon('clawShut', 'i-shut')}`)}</button>` : ''}`;
    } else {
      this.root.innerHTML = `
      <div class="stick"><div class="knob"></div></div>
      <button class="run" type="button">${opts.runLabel ?? '走る'}</button>${opts.jump ? `
      <button class="jump" type="button">ジャンプ</button>` : ''}${opts.dig ? `
      <button class="dig" type="button"><i class="aim"></i><span>掘る</span></button>` : ''}${opts.onCamera ? `
      <button class="cam" type="button">カメラ</button>` : ''}${opts.act ? `
      <button class="act" type="button"><i class="ring"></i><span></span></button>` : ''}${opts.grab ? `
      <button class="grab" type="button" aria-pressed="false"><i class="lock"></i><span>挟む</span></button>` : ''}`;
    }
    document.body.appendChild(this.root);
    if (this.icons) window.addEventListener('resize', () => this.layout());
    const act = this.root.querySelector<HTMLButtonElement>('.act');
    if (act) this.bindHold(act, (on) => (this.input.touchAct = on));
    this.bindStick(this.root.querySelector<HTMLElement>('.stick')!);
    this.bindHold(this.root.querySelector<HTMLButtonElement>('.run')!, (on) => (this.input.touchRun = on));
    const jump = this.root.querySelector<HTMLButtonElement>('.jump');
    if (jump) this.bindHold(jump, (on) => (this.input.touchJump = on));
    const dig = this.root.querySelector<HTMLButtonElement>('.dig');
    if (dig) this.bindDig(dig);
    const grab = this.root.querySelector<HTMLButtonElement>('.grab');
    if (grab) this.bindGrab(grab);
    const cam = this.root.querySelector<HTMLButtonElement>('.cam');
    if (cam && opts.onCamera) {
      const fn = opts.onCamera;
      cam.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fn();
      });
      cam.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  /**
   * ボタンの見た目の大きさ（scale：1 = 以前の大きさ）と背景の濃さ（alpha：0..1）を変える（印のボタンだけ）。
   * 指の当たる範囲は見た目の円より一回り大きいまま。スティックのノブの動ける半径も大きさに合わせる
   */
  setLook(scale: number, alpha: number) {
    this.scale = scale;
    this.alpha = alpha;
    this.stickR = STICK_RADIUS_BASE * (this.icons ? scale : 1);
    if (!this.icons) return;
    this.root.style.setProperty('--s', scale.toFixed(3));
    this.root.style.setProperty('--a', alpha.toFixed(3));
    this.layout();
  }

  /**
   * 狭い縦長の画面：挟むボタンがスティックと重なる幅なら、掘るボタンの上へ移す（.narrow）。
   * 必要な幅 = スティック（中心 82・半径 64）と挟むボタン（右から中心 253・半径 39）の外側 + 指の当たる余白
   */
  layout() {
    if (!this.icons) return;
    // （位置は max(大きさ, 0.72) 倍：aquarium.css の --ps）
    const ps = Math.max(this.scale, 0.72);
    const need = (82 + 253) * ps + (64 + 39) * this.scale + 36;
    this.root.classList.toggle('narrow', window.innerWidth < need);
  }

  /**
   * その場の操作のボタンを出す・隠す（label = null で隠す）。progress（0..1）は長押しの進み具合の輪。
   * 隠すときは押している指も終わらせる（押したまま隠れたボタンが押しっぱなしにならない）
   */
  setAct(label: string | null, progress = 0) {
    const btn = this.root.querySelector<HTMLButtonElement>('.act');
    if (!btn) return;
    const show = label !== null;
    if (!show && this.input.touchAct) {
      this.input.touchAct = false;
      btn.classList.remove('on');
    }
    btn.classList.toggle('show', show);
    if (show) {
      const span = btn.querySelector('span')!;
      if (span.textContent !== label) span.textContent = label;
      btn.style.setProperty('--p', progress.toFixed(3));
    }
  }

  /** 押している間だけ on になるボタン（複数の指で押していれば、全部離れるまで on） */
  private bindHold(btn: HTMLButtonElement, set: (on: boolean) => void) {
    const ids = new Set<number>();
    const apply = () => {
      const on = ids.size > 0;
      set(on);
      btn.classList.toggle('on', on);
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(btn, e.pointerId);
      const id = e.pointerId;
      this.input.claim(e, {
        end: () => {
          ids.delete(id);
          apply();
        },
      });
      ids.add(id);
      apply();
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    this.input.onReset(() => {
      ids.clear();
      apply();
    });
  }

  /**
   * 掘るボタン：押している間は掘る。押した指の位置からのずれを照準にする（ボタンの中の印がずれの向きへ動く）。
   * 1 本の指だけを使う（2 本目で押し直したら、新しい指に付け替える）。離した・見失ったら照準も 0 に戻る
   */
  private bindDig(btn: HTMLButtonElement) {
    const mark = btn.querySelector<HTMLElement>('.aim');
    let id = -1;
    let ox = 0, oy = 0;
    const show = () => {
      const a = this.input.touchDigAim;
      const m = 22 * (this.icons ? this.scale : 1);
      if (mark) mark.style.transform = id === -1 ? '' : `translate(${(a.x * m).toFixed(1)}px, ${(-a.y * m).toFixed(1)}px)`;
      btn.classList.toggle('on', id !== -1);
      btn.classList.toggle('aiming', id !== -1 && Math.hypot(a.x, a.y) > 0);
    };
    const clear = () => {
      id = -1;
      this.input.touchDig = false;
      this.input.touchDigAim = { x: 0, y: 0 };
      show();
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id !== -1) this.input.release(id);
      const mine = e.pointerId;
      id = mine;
      ox = e.clientX;
      oy = e.clientY;
      capture(btn, mine);
      this.input.claim(e, {
        move: (ev) => {
          if (id !== mine) return;
          const k = this.input.pointerScale;
          this.input.touchDigAim = digAimFromOffset((ev.clientX - ox) * k, (ev.clientY - oy) * k, DIG_AIM.touchRadius);
          show();
        },
        end: () => id === mine && clear(),
      });
      this.input.touchDig = true;
      this.input.touchDigAim = { x: 0, y: 0 };
      show();
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    this.input.onReset(clear);
  }

  /**
   * 挟むボタン（切り替えのスイッチ）：1 回たたくとハサミを閉じ（Input.touchGrabLatch = true）、もう一度たたくと開く。
   * 指を離しても閉じたままなので、同じ指でジャンプ・ダッシュ・カメラを押せる。閉じている間はボタンの色と文字（離す）・
   * 錠の印で示す。押した指をそのままずらすと（GRAB_LOOK_DEAD を越えたら）、その動きで視点を回す。
   * 回転・アプリの切り替え・指の取り消し（Input.releaseAll）では指だけを終わらせ、閉じている / 開いているは変えない
   */
  private bindGrab(btn: HTMLButtonElement) {
    let id = -1;
    let ox = 0, oy = 0, lx = 0, ly = 0, look = false;
    const clear = () => {
      id = -1;
      look = false;
      btn.classList.remove('look', 'press');
      this.showGrab();
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id !== -1) this.input.release(id);
      const mine = e.pointerId;
      id = mine;
      ox = lx = e.clientX;
      oy = ly = e.clientY;
      look = false;
      this.input.touchGrabLatch = !this.input.touchGrabLatch;
      this.grabToggles++;
      btn.classList.add('press');
      capture(btn, mine);
      this.input.claim(e, {
        move: (ev) => {
          if (id !== mine) return;
          const k = this.input.pointerScale;
          if (!look && Math.hypot(ev.clientX - ox, ev.clientY - oy) * k > GRAB_LOOK_DEAD) {
            look = true;
            btn.classList.add('look');
          }
          if (look) {
            this.input.dragDX += (ev.clientX - lx) * k;
            this.input.dragDY += (ev.clientY - ly) * k;
          }
          lx = ev.clientX;
          ly = ev.clientY;
        },
        end: () => id === mine && clear(),
      });
      this.showGrab();
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    this.input.onReset(clear);
  }

  /** 挟むスイッチを切り替えた回数（自動検証用） */
  grabToggles = 0;

  /** 挟むスイッチの見た目を Input.touchGrabLatch に合わせる（閉じている = on・文字「離す」） */
  showGrab() {
    const btn = this.root.querySelector<HTMLButtonElement>('.grab');
    if (!btn) return;
    const on = this.input.touchGrabLatch;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    const label = on ? '離す' : '挟む';
    // 印のボタンは閉じた / 開いたハサミの印を CSS で切り替える（文字は読み上げ用の名前だけ）
    if (this.icons) {
      if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
      return;
    }
    const span = btn.querySelector('span');
    if (span && span.textContent !== label) span.textContent = label;
  }

  /** ゲームの側から挟むスイッチを開く・閉じる（滑った・抜けた・瞬間移動などでハサミが開いたとき） */
  setGrabLatched(on: boolean) {
    this.input.touchGrabLatch = on;
    this.showGrab();
  }

  /** 挟むボタンに「届く物がある」印を付ける（押す前の案内） */
  setGrabReady(ready: boolean) {
    this.root.querySelector('.grab')?.classList.toggle('ready', ready);
  }

  private bindStick(base: HTMLElement) {
    const knob = base.querySelector<HTMLElement>('.knob')!;
    let id = -1;
    const update = (e: PointerEvent) => {
      const r = base.getBoundingClientRect();
      // （ページが拡大されたまま画面を置き直している間は、指のずれが小さく届くので pointerScale で戻す）
      const k = this.input.pointerScale;
      let dx = (e.clientX - (r.left + r.width / 2)) * k;
      let dy = (e.clientY - (r.top + r.height / 2)) * k;
      const len = Math.hypot(dx, dy);
      if (!Number.isFinite(len)) return;
      const R = this.stickR;
      if (len > R) {
        dx *= R / len;
        dy *= R / len;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      // 中心付近の小さなぶれは無視する
      const dead = len / R < 0.12;
      this.input.touchMove = dead ? { x: 0, y: 0 } : { x: dx / R, y: -dy / R };
    };
    const clear = () => {
      id = -1;
      knob.style.transform = '';
      base.classList.remove('active');
      this.input.touchMove = { x: 0, y: 0 };
    };
    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // 前の指がまだ終わっていない（離した通知が失われた）なら、終わらせて新しい指に付け替える
      if (id !== -1) this.input.release(id);
      const mine = e.pointerId;
      id = mine;
      capture(base, mine);
      this.input.claim(e, {
        move: (ev) => id === mine && update(ev),
        end: () => id === mine && clear(),
      });
      base.classList.add('active');
      update(e);
    });
    base.addEventListener('contextmenu', (e) => e.preventDefault());
    this.input.onReset(clear);
  }
}

/** タッチ操作の端末か（指で操作する画面を持つ） */
export function isTouchDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

/** ポインターを要素に捕捉する（捕捉できない環境でも入力処理は止めない） */
function capture(el: Element, id: number) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* 捕捉は必須ではない */
  }
}
