// スマホ・タブレット用の画面上の操作（仮想スティックと走るボタン）。
// 入力値を Input に書き込むだけで、ゲームロジックには関与しない。

import type { Input } from '../game/Input';

const STICK_RADIUS = 48; // ノブが動ける半径（CSS px）

export class TouchControls {
  readonly root: HTMLElement;

  constructor(private readonly input: Input) {
    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.root.innerHTML = `
      <div class="stick"><div class="knob"></div></div>
      <button class="run" type="button">走る</button>`;
    document.body.appendChild(this.root);
    this.bindStick(this.root.querySelector<HTMLElement>('.stick')!);
    this.bindRun(this.root.querySelector<HTMLButtonElement>('.run')!);
  }

  private bindStick(base: HTMLElement) {
    const knob = base.querySelector<HTMLElement>('.knob')!;
    let id = -1;
    const update = (e: PointerEvent) => {
      const r = base.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        dx *= STICK_RADIUS / len;
        dy *= STICK_RADIUS / len;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      // 中心付近の小さなぶれは無視する
      const dead = len / STICK_RADIUS < 0.12;
      this.input.touchMove = dead ? { x: 0, y: 0 } : { x: dx / STICK_RADIUS, y: -dy / STICK_RADIUS };
    };
    const release = () => {
      id = -1;
      knob.style.transform = '';
      base.classList.remove('active');
      this.input.touchMove = { x: 0, y: 0 };
    };
    base.addEventListener('pointerdown', (e) => {
      if (id !== -1) return;
      id = e.pointerId;
      capture(base, id);
      base.classList.add('active');
      update(e);
    });
    base.addEventListener('pointermove', (e) => e.pointerId === id && update(e));
    base.addEventListener('pointerup', (e) => e.pointerId === id && release());
    base.addEventListener('pointercancel', (e) => e.pointerId === id && release());
  }

  private bindRun(btn: HTMLButtonElement) {
    const set = (on: boolean) => {
      this.input.touchRun = on;
      btn.classList.toggle('on', on);
    };
    btn.addEventListener('pointerdown', (e) => {
      capture(btn, e.pointerId);
      set(true);
    });
    btn.addEventListener('pointerup', () => set(false));
    btn.addEventListener('pointercancel', () => set(false));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
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
