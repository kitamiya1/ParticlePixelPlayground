// スマホ・タブレット用の画面上の操作（仮想スティックと走るボタン）。
// 入力値を Input に書き込むだけで、ゲームロジックには関与しない。
// 押した指の管理（動き・離した・取り消し・見失った）は Input.claim に任せる（要素の上で離さなくても・離した通知が
// 失われても、必ず元に戻る）。押している指の番号が終わらないまま同じ操作をもう一度押したら、新しい指に付け替える
// （固まったスティックも、押し直せば直る）。

import type { Input } from '../game/Input';

const STICK_RADIUS = 48; // ノブが動ける半径（CSS px）

/** 追加のボタン（水槽ゲーム用。指定しなければ従来どおりスティックと走るボタンだけ） */
export interface TouchControlsOptions {
  /** 走るボタンの表示名（既定「走る」） */
  runLabel?: string;
  /** ジャンプボタン（押している間 Input.touchJump = true） */
  jump?: boolean;
  /** カメラ切り替えボタン（押したときに呼ぶ） */
  onCamera?: () => void;
  /** 掘るボタン（押している間 Input.touchDig = true） */
  dig?: boolean;
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
      <button class="dig" type="button">掘る</button>` : ''}${opts.onCamera ? `
      <button class="cam" type="button">カメラ</button>` : ''}`;
    document.body.appendChild(this.root);
    this.bindStick(this.root.querySelector<HTMLElement>('.stick')!);
    this.bindHold(this.root.querySelector<HTMLButtonElement>('.run')!, (on) => (this.input.touchRun = on));
    const jump = this.root.querySelector<HTMLButtonElement>('.jump');
    if (jump) this.bindHold(jump, (on) => (this.input.touchJump = on));
    const dig = this.root.querySelector<HTMLButtonElement>('.dig');
    if (dig) this.bindHold(dig, (on) => (this.input.touchDig = on));
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
