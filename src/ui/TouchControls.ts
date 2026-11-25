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
}

export class TouchControls {
  readonly root: HTMLElement;

  constructor(private readonly input: Input, opts: TouchControlsOptions = {}) {
    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.root.innerHTML = `
      <div class="stick"><div class="knob"></div></div>
      <button class="run" type="button">${opts.runLabel ?? '走る'}</button>${opts.jump ? `
      <button class="jump" type="button">ジャンプ</button>` : ''}${opts.dig ? `
      <button class="dig" type="button"><i class="aim"></i><span>掘る</span></button>` : ''}${opts.onCamera ? `
      <button class="cam" type="button">カメラ</button>` : ''}${opts.act ? `
      <button class="act" type="button"><i class="ring"></i><span></span></button>` : ''}`;
    document.body.appendChild(this.root);
    const act = this.root.querySelector<HTMLButtonElement>('.act');
    if (act) this.bindHold(act, (on) => (this.input.touchAct = on));
    this.bindStick(this.root.querySelector<HTMLElement>('.stick')!);
    this.bindHold(this.root.querySelector<HTMLButtonElement>('.run')!, (on) => (this.input.touchRun = on));
    const jump = this.root.querySelector<HTMLButtonElement>('.jump');
    if (jump) this.bindHold(jump, (on) => (this.input.touchJump = on));
    const dig = this.root.querySelector<HTMLButtonElement>('.dig');
    if (dig) this.bindDig(dig);
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
      if (mark) mark.style.transform = id === -1 ? '' : `translate(${(a.x * 22).toFixed(1)}px, ${(-a.y * 22).toFixed(1)}px)`;
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
          this.input.touchDigAim = digAimFromOffset(ev.clientX - ox, ev.clientY - oy, DIG_AIM.touchRadius);
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

  private bindStick(base: HTMLElement) {
    const knob = base.querySelector<HTMLElement>('.knob')!;
    let id = -1;
    const update = (e: PointerEvent) => {
      const r = base.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (!Number.isFinite(len)) return;
      if (len > STICK_RADIUS) {
        dx *= STICK_RADIUS / len;
        dy *= STICK_RADIUS / len;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      // 中心付近の小さなぶれは無視する
      const dead = len / STICK_RADIUS < 0.12;
      this.input.touchMove = dead ? { x: 0, y: 0 } : { x: dx / STICK_RADIUS, y: -dy / STICK_RADIUS };
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
