// キーボード・マウス・タッチ入力の集約。描画には依存しない。
//
// 押している指・マウス（ポインター）は、押した要素ではなくこのクラスが「持ち主」ごとに一か所で管理する（claim）。
// - 動き・離した・取り消しは window で受ける（捕捉 setPointerCapture が外れても、指が別の要素の上へ出ても届く）。
// - 指を離した通知（pointerup / pointercancel）が届かないことがある（iOS の WebKit で、複数の指・システムの
//   ジェスチャー・画面の端で起きる）。タッチの一覧（TouchEvent.touches）は正しいので、タッチの開始・終了のたびに
//   一覧と照らし合わせ、一覧に無い指を終わらせる（reconcileTouches）。画面から指がすべて離れたら全部終わらせる。
// - マウスはボタンを離した状態（buttons = 0）で動いたら終わらせる（ウィンドウの外で離した等）。
// - ページが隠れる・フォーカスを失う（visibilitychange / pagehide / blur）と、押している物をすべて終わらせる。
// - 同じ番号の指が終わらないまま押された・順番が入れ替わった通知は、古い持ち主を終わらせてから新しく持たせる。
// 終わらせるときは持ち主の end を必ず呼ぶので、仮想スティック・ボタン・視点のドラッグ・ピンチは必ず元に戻る。
//
// 掘る向きの照準（水槽ゲーム用。digAim()：x = 右, y = 上、長さ 0〜1）：押した位置からの指・マウスのずれ。
// - 画面の「掘る」ボタン：押したまま指をずらす（TouchControls が touchDigAim に書く。指がボタンの外へ出ても続く）
// - マウスの右ボタン（mouseDig = true のときだけ。比較ページの右ドラッグ = 平行移動は変えない）：押したままずらす
// - F キー：押したときのマウスの位置からのずれ（ボタンを押さずに動かした分。左ドラッグは視点の回転のまま）
// 離したとき・すべて終わらせたときは 0 に戻る。

/** 照準のずれ（CSS px）→ 0〜1：これより小さいずれは無視し、これで最大 */
export const DIG_AIM = { touchRadius: 60, mouseRadius: 150, dead: 0.1 } as const;

/** 押した位置からのずれ (dx, dy)（CSS px、画面の下が +y）を照準（x = 右, y = 上、長さ ≤ 1）にする */
export function digAimFromOffset(dx: number, dy: number, radius: number): { x: number; y: number } {
  const x = dx / radius, y = -dy / radius;
  const len = Math.hypot(x, y);
  if (!Number.isFinite(len) || len < DIG_AIM.dead) return { x: 0, y: 0 };
  // 遊びの分を引いて 0 から始まるようにし、長さ 1 で止める（それ以上ずらしても角度は増えない）
  const k = Math.min(1, (len - DIG_AIM.dead) / (1 - DIG_AIM.dead)) / len;
  return { x: x * k, y: y * k };
}

/** ポインター 1 本の持ち主（仮想スティック・ボタン・視点のドラッグ） */
export interface PointerClaim {
  /** 動いた（window で受ける） */
  move?: (e: PointerEvent) => void;
  /** 終わった（離した・取り消した・見失った・ページが隠れた）。1 回だけ呼ばれる */
  end: () => void;
}

interface ActivePointer {
  claim: PointerClaim;
  type: string;
  x: number;
  y: number;
}

/** 指を離した通知を待ってから、タッチの一覧と照らし合わせるまでの時間（ms） */
const RECONCILE_MS = 80;

export class Input {
  private keys = new Set<string>();
  dragDX = 0;
  dragDY = 0;
  panDX = 0;
  panDY = 0;
  wheel = 0;
  private actions = new Map<string, () => void>();
  /** 画面上の仮想スティック（x: 右, y: 前、長さ 0〜1） */
  touchMove = { x: 0, y: 0 };
  /** 画面上の走るボタン */
  touchRun = false;
  /** 画面上のジャンプボタン（水槽ゲーム用。押している間 true） */
  touchJump = false;
  /** 画面上の掘るボタン（水槽ゲーム用。押している間 true） */
  touchDig = false;
  /** 画面の掘るボタンを押したままずらした照準（x = 右, y = 上、長さ 0〜1） */
  touchDigAim = { x: 0, y: 0 };
  /** マウスの右ボタンで掘る（水槽ゲームだけ true。false なら右ドラッグは従来どおり平行移動） */
  mouseDig = false;
  /** マウスの右ボタンで掘っている間・その照準 */
  private mouseDigOn = false;
  private mouseDigAim = { x: 0, y: 0 };
  /** マウスの最後の位置と、F キーを押したときの位置（F の照準の基準） */
  private mouse = { x: 0, y: 0 };
  private fOrigin: { x: number; y: number } | null = null;
  // 画面に触れている指（2 本でピンチ・平行移動）
  private touches = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private pinchMid = { x: 0, y: 0 };
  /** 押しているポインター（番号 → 持ち主） */
  private readonly pointers = new Map<number, ActivePointer>();
  private reconcileTimer = 0;
  private lastTouches: { x: number; y: number }[] = [];
  /** 見失って終わらせた数（自動検証・表示用） */
  readonly recovered = { reconcile: 0, hidden: 0, mouseUp: 0, reused: 0 };
  /** すべて終わらせたときに呼ぶ（TouchControls の見た目を戻す等） */
  private readonly resetHooks: (() => void)[] = [];

  constructor(private readonly surface: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      this.keys.add(e.code);
      if (!e.repeat) this.actions.get(e.code)?.();
      // F を押したときのマウスの位置を、照準の基準にする
      if (e.code === 'KeyF' && !this.fOrigin) this.fOrigin = { ...this.mouse };
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyF') this.fOrigin = null;
    });
    // マウスの位置（ボタンを押していなくても追う。F の照準に使う）
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    }, true);

    // ポインターの動き・終わり：window の捕捉段階で受ける（要素が通知を受け損ねても、ここには届く）
    window.addEventListener('pointermove', (e) => this.onPointerMove(e), true);
    window.addEventListener('pointerup', (e) => this.release(e.pointerId), true);
    window.addEventListener('pointercancel', (e) => this.release(e.pointerId), true);
    // 捕捉が外れても指は続いている（動き・終わりは window で受け続ける）。マウスはボタンが離れていれば終わり
    window.addEventListener('lostpointercapture', (e) => {
      if (e.pointerType !== 'touch' && e.buttons === 0) this.release(e.pointerId);
    }, true);
    // タッチの一覧で照らし合わせる（指を離した通知が失われた指を終わらせる）
    const onTouchList = (e: TouchEvent) => this.scheduleReconcile(e.touches);
    for (const t of ['touchstart', 'touchend', 'touchcancel'] as const) document.addEventListener(t, onTouchList, { capture: true, passive: true });
    // ページが隠れる・フォーカスを失う：押している物をすべて終わらせる
    const lost = () => {
      if (this.pointers.size) this.recovered.hidden++;
      this.releaseAll();
    };
    window.addEventListener('blur', lost);
    window.addEventListener('pagehide', lost);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') lost();
    });

    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    surface.addEventListener('pointerdown', (e) => {
      capture(surface, e.pointerId);
      if (e.pointerType === 'touch') {
        const id = e.pointerId;
        this.claim(e, {
          move: (ev) => this.touchMoved(id, ev),
          end: () => {
            this.touches.delete(id);
            if (this.touches.size >= 2) this.resetPinch();
          },
        });
        this.touches.set(id, { x: e.clientX, y: e.clientY });
        if (this.touches.size >= 2) this.resetPinch();
        return;
      }
      // 右ボタンで掘る（押したままずらすと照準。指で掘るボタンを押したときと同じ）
      if (this.mouseDig && e.button === 2) {
        const ox = e.clientX, oy = e.clientY;
        this.claim(e, {
          move: (ev) => {
            this.mouseDigAim = digAimFromOffset(ev.clientX - ox, ev.clientY - oy, DIG_AIM.mouseRadius);
          },
          end: () => {
            this.mouseDigOn = false;
            this.mouseDigAim = { x: 0, y: 0 };
          },
        });
        this.mouseDigOn = true;
        this.mouseDigAim = { x: 0, y: 0 };
        return;
      }
      const mode: 1 | 2 = e.button === 0 && !e.ctrlKey ? 1 : 2;
      let lastX = e.clientX, lastY = e.clientY;
      this.claim(e, {
        move: (ev) => {
          const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
          lastX = ev.clientX;
          lastY = ev.clientY;
          if (mode === 1) {
            this.dragDX += dx;
            this.dragDY += dy;
          } else {
            this.panDX += dx;
            this.panDY += dy;
          }
        },
        end: () => {},
      });
    });
    surface.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100 + 0.5);
      },
      { passive: false },
    );
  }

  // ---------------- ポインターの持ち主 ----------------

  /**
   * 押されたポインターに持ち主を付ける。同じ番号がまだ終わっていなければ（終わりの通知が失われた・順番が入れ替わった）、
   * 古い持ち主を終わらせてから付け替える
   */
  claim(e: PointerEvent, c: PointerClaim) {
    if (this.pointers.has(e.pointerId)) {
      this.recovered.reused++;
      this.release(e.pointerId);
    }
    this.pointers.set(e.pointerId, { claim: c, type: e.pointerType, x: e.clientX, y: e.clientY });
  }

  /** ポインターを終わらせる（持ち主の end を 1 回だけ呼ぶ）。知らない番号なら何もしない */
  release(id: number) {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    p.claim.end();
  }

  /** 押している物をすべて終わらせ、画面上の入力・キーを離した状態に戻す */
  releaseAll() {
    for (const id of [...this.pointers.keys()]) this.release(id);
    this.keys.clear();
    this.touches.clear();
    this.touchMove = { x: 0, y: 0 };
    this.touchRun = this.touchJump = this.touchDig = false;
    this.touchDigAim = { x: 0, y: 0 };
    this.mouseDigOn = false;
    this.mouseDigAim = { x: 0, y: 0 };
    this.fOrigin = null;
    this.pinchDist = 0;
    for (const f of this.resetHooks) f();
  }

  /** releaseAll のときに呼ぶ処理を足す */
  onReset(fn: () => void) {
    this.resetHooks.push(fn);
  }

  /** 押しているポインターの数（自動検証・表示用） */
  get activePointers(): number {
    return this.pointers.size;
  }

  /** 画面（視点の操作）に触れている指の数（自動検証用） */
  get viewTouchCount(): number {
    return this.touches.size;
  }

  private onPointerMove(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    // マウス：ボタンを離した通知が届かなかった（ウィンドウの外で離した等）
    if (p.type !== 'touch' && e.buttons === 0) {
      this.recovered.mouseUp++;
      this.release(e.pointerId);
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    p.claim.move?.(e);
  }

  /** タッチの開始・終了のあと、少し待って（離した通知が先に届く分を待って）一覧と照らし合わせる */
  private scheduleReconcile(list: TouchList) {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < list.length; i++) pts.push({ x: list[i].clientX, y: list[i].clientY });
    this.lastTouches = pts;
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = window.setTimeout(() => this.reconcileTouches(this.lastTouches), RECONCILE_MS);
  }

  /**
   * 画面に触れている指の一覧（位置）と、押しているタッチのポインターを照らし合わせる。ポインターの方が多ければ、
   * 一覧のどの指からも遠いものから順に終わらせる（番号はタッチとポインターで違うので、位置で対応を取る）
   */
  reconcileTouches(list: { x: number; y: number }[]) {
    const touchIds = [...this.pointers.entries()].filter(([, p]) => p.type === 'touch');
    let extra = touchIds.length - list.length;
    if (extra <= 0) return;
    const far = touchIds
      .map(([id, p]) => ({ id, d: list.reduce((m, q) => Math.min(m, Math.hypot(q.x - p.x, q.y - p.y)), Infinity) }))
      .sort((a, b) => b.d - a.d);
    for (const f of far) {
      if (extra-- <= 0) break;
      this.recovered.reconcile++;
      this.release(f.id);
    }
  }

  // ---------------- 画面の指（視点の回転・ピンチ） ----------------

  private touchMoved(id: number, e: PointerEvent) {
    const t = this.touches.get(id);
    if (!t) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    t.x = e.clientX;
    t.y = e.clientY;
    if (this.touches.size === 1) {
      // 1 本指：カメラ回転
      this.dragDX += dx;
      this.dragDY += dy;
    } else {
      // 2 本指（3 本目以降は使わない）：ピンチでズーム、中点の移動で視点移動
      const [a, b] = [...this.touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.pinchDist > 0 && dist > 0) this.wheel += Math.log(this.pinchDist / dist) / Math.log(1.12);
      this.panDX += mid.x - this.pinchMid.x;
      this.panDY += mid.y - this.pinchMid.y;
      this.pinchDist = dist;
      this.pinchMid = mid;
    }
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

  /** 掘る入力を押し続けているか（F または画面の掘るボタン。水槽ゲーム用） */
  isDigHeld(): boolean {
    return this.touchDig || this.mouseDigOn || this.isDown('KeyF');
  }

  /**
   * 掘る向きの照準（x = 右, y = 上、長さ 0〜1。0 = カニの正面）。画面のボタン → マウスの右ボタン → F キーの順に、
   * いま押している物のずれを使う（どれも押していなければ 0）
   */
  digAim(): { x: number; y: number } {
    if (this.touchDig) return { ...this.touchDigAim };
    if (this.mouseDigOn) return { ...this.mouseDigAim };
    if (this.fOrigin && this.isDown('KeyF')) return digAimFromOffset(this.mouse.x - this.fOrigin.x, this.mouse.y - this.fOrigin.y, DIG_AIM.mouseRadius);
    return { x: 0, y: 0 };
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
