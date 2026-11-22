// キーボード・マウス・タッチ入力の集約。描画には依存しない。

export class Input {
  private keys = new Set<string>();
  dragDX = 0;
  dragDY = 0;
  panDX = 0;
  panDY = 0;
  wheel = 0;
  private dragging: 0 | 1 | 2 = 0;
  private lastX = 0;
  private lastY = 0;
  private actions = new Map<string, () => void>();
  /** 画面上の仮想スティック（x: 右, y: 前、長さ 0〜1） */
  touchMove = { x: 0, y: 0 };
  /** 画面上の走るボタン */
  touchRun = false;
  /** 画面上のジャンプボタン（水槽ゲーム用。押している間 true） */
  touchJump = false;
  // 画面に触れている指（2 本でピンチ・平行移動）
  private touches = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private pinchMid = { x: 0, y: 0 };

  constructor(private readonly surface: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      this.keys.add(e.code);
      if (!e.repeat) this.actions.get(e.code)?.();
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    surface.addEventListener('pointerdown', (e) => {
      capture(surface, e.pointerId);
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size === 2) this.resetPinch();
        return;
      }
      this.dragging = e.button === 0 && !e.ctrlKey ? 1 : 2;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    surface.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        const t = this.touches.get(e.pointerId);
        if (!t) return;
        const dx = e.clientX - t.x, dy = e.clientY - t.y;
        t.x = e.clientX;
        t.y = e.clientY;
        if (this.touches.size === 1) {
          // 1 本指：カメラ回転
          this.dragDX += dx;
          this.dragDY += dy;
        } else if (this.touches.size === 2) {
          // 2 本指：ピンチでズーム、中点の移動で視点移動
          const [a, b] = [...this.touches.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (this.pinchDist > 0 && dist > 0) this.wheel += Math.log(this.pinchDist / dist) / Math.log(1.12);
          this.panDX += mid.x - this.pinchMid.x;
          this.panDY += mid.y - this.pinchMid.y;
          this.pinchDist = dist;
          this.pinchMid = mid;
        }
        return;
      }
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.dragging === 1) {
        this.dragDX += dx;
        this.dragDY += dy;
      } else {
        this.panDX += dx;
        this.panDY += dy;
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        this.touches.delete(e.pointerId);
        if (this.touches.size === 2) this.resetPinch();
      } else {
        this.dragging = 0;
      }
      if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
    };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);
    surface.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100 + 0.5);
      },
      { passive: false },
    );
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** 単発キー操作の登録 */
  onPress(code: string, fn: () => void) {
    this.actions.set(code, fn);
  }

  /** 走る入力（Shift または画面の走るボタン） */
  isRunning(): boolean {
    return this.touchRun || this.isDown('ShiftLeft') || this.isDown('ShiftRight');
  }

  /** ジャンプ入力を押し続けているか（Space または画面のジャンプボタン） */
  isJumpHeld(): boolean {
    return this.touchJump || this.isDown('Space');
  }

  /** 移動入力（x: 右, y: 前）。キーが押されていなければ仮想スティックの値 */
  moveAxis(): { x: number; y: number } {
    let x = 0, y = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) y += 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) y -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) x += 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 0) return { x: x / len, y: y / len };
    return { x: this.touchMove.x, y: this.touchMove.y };
  }

  private resetPinch() {
    const [a, b] = [...this.touches.values()];
    this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  consume() {
    this.dragDX = this.dragDY = this.panDX = this.panDY = this.wheel = 0;
  }
}

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

/** ポインターを要素に捕捉する（捕捉できない環境でも入力処理は止めない） */
function capture(el: Element, id: number) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* 捕捉は必須ではない */
  }
}
