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
  /** カメラ切り替えボタン（押したときに呼ぶ。onCameraHold があるときは、短く押して離したときに呼ぶ） */
  onCamera?: () => void;
  /** カメラのボタンを長押ししたとき（水槽ゲーム：視点の一覧を開く） */
  onCameraHold?: () => void;
  /**
   * 長押しで onCameraHold を呼んだ後、押したまま指を動かした・離した（水槽ゲーム：指を滑らせて一覧の視点を選ぶ）。
   * x, y = 指の画面の座標（CSS px）、end = 離した
   */
  onCameraDrag?: (x: number, y: number, end: boolean) => void;
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

/** カメラのボタンの長押しの長さ（ms） */
const CAMERA_HOLD_MS = 420;

/** 挟むボタンを押したまま指をずらしたとき、視点の回転に使い始めるずれ（CSS px） */
const GRAB_LOOK_DEAD = 10;

/**
 * 印（24 × 24 の線画。色は文字の色。class="dot" の円は塗る：砂粒など）。
 * 第 6 段階（iPhone の確認から）：抽象的な記号から、動きが分かる絵へ：
 * ジャンプ = 地面から真上へ跳ぶ矢印、ダッシュ = 横へ流れる線と二重の矢印、掘る = 地面のくぼみへ下がる矢印と飛び散る砂粒、
 * 盛る = 砂山へ降り積もる矢印と砂粒、挟む = 開いた / 閉じたカニのハサミ（掌と 2 本の指）、ちぎる = 茎を切る、抜く = 根ごと上へ、
 * カメラ = いまの視点の絵（三人称・肩越し・自由追従・ガラス越し・箱庭・従来）
 */
export const TOUCH_ICONS = {
  jump: '<path d="M3.5 21h17"/><path d="M12 17.5V4.5"/><path d="M7 9.5l5-5 5 5"/><path d="M6.5 18.5L5 17M17.5 18.5L19 17"/>',
  run: '<path d="M2.5 8.5h5M1.5 12h6M2.5 15.5h5"/><path d="M10 6.5l5.5 5.5-5.5 5.5"/><path d="M15 6.5l5.5 5.5-5.5 5.5"/>',
  dig: '<path d="M2 14h4.2c1.4 4.6 10.2 4.6 11.6 0H22"/><path d="M12 3.5v8"/><path d="M8.8 8.6L12 11.8l3.2-3.2"/><circle class="dot" cx="4.6" cy="9.6" r="1.25"/><circle class="dot" cx="19.6" cy="8.4" r="1.25"/><circle class="dot" cx="18.2" cy="11.6" r="0.95"/>',
  fill: '<path d="M2 21h20"/><path d="M4 21c1.6-5 4.4-7.4 8-7.4s6.4 2.4 8 7.4"/><path d="M8.6 18.2h6.8"/><path d="M12 2.5v7"/><path d="M8.9 6.6L12 9.7l3.1-3.1"/><circle class="dot" cx="6.4" cy="9" r="1.1"/><circle class="dot" cx="17.8" cy="7.4" r="1.1"/>',
  cam: '<rect x="3" y="7.5" width="18" height="12" rx="2.5"/><circle cx="12" cy="13.5" r="3.2"/><path d="M8.5 7.5l1.6-2.6h3.8l1.6 2.6"/>',
  // カニのハサミ：掌（楕円）・動かない指（下）・動く指（上）。開くと指の間が空き、閉じると指先が合わさる
  // （塗りのシルエット：小さくしても形が読める。掌は斜め、動かない指は右上へ、動く指は上へ。閉じると指先が合わさる）
  clawOpen: '<ellipse class="dot" cx="8.6" cy="16.2" rx="5.6" ry="4.6" transform="rotate(-24 8.6 16.2)"/><path class="dot" d="M11.6 12.4C15 11.4 18.4 8.8 20.6 4.6c.6 4.8-1.6 9.4-6.6 11.6z"/><path class="dot" d="M6.2 12.2C5.4 8.2 6.8 4.6 10.4 2.2c.6 3.8-.2 7.4-2 10.4z"/><path d="M1.5 22.5l2.6-2.4"/>',
  clawShut: '<ellipse class="dot" cx="8.6" cy="16.2" rx="5.6" ry="4.6" transform="rotate(-24 8.6 16.2)"/><path class="dot" d="M11.6 12.4C15 11.4 18.4 8.8 20.6 4.6c.6 4.8-1.6 9.4-6.6 11.6z"/><path class="dot" d="M5.8 11.4C7.6 6.6 12.6 3.4 19.8 3.6c-2.4 2.6-5.6 4.2-9.6 5.2z"/><path d="M15.4 9.2l.3 1.4M12.6 10.4l.3 1.4"/><path d="M1.5 22.5l2.6-2.4"/>',
  // ちぎる（挟んだ茎を切る）：葉の付いた茎の途中を、左からハサミの指先が挟んで切る（切れ目の右にはじける線）
  snip: '<path d="M12 22v-6.2"/><path d="M12 10.2V5"/><path class="dot" d="M12 7.2c1.4-3 4-4.4 7-3.8-1.2 3-3.8 4.4-7 3.8z"/><path class="dot" d="M2 11.2c3-1.6 6.4-1.6 9.4-.2-3.2.6-6.2.8-9.4.2z"/><path class="dot" d="M2 15c3 1.4 6.4 1.2 9.4-.4-3.2-.4-6.2-.4-9.4.4z"/><path d="M15 11.2l2.2-1.2M15.2 14.6l2.2 1.1M15.6 12.9h2.6"/>',
  // 抜く：根の付いた草と、上への矢印（地面の線は茎の所で切れている）
  uproot: '<path d="M3 17h6M15 17h6"/><path d="M12 15.5V6"/><path d="M12 9.5C9 9.2 7.2 7.4 7 4.6c2.8.2 4.6 2 5 4.9z"/><path d="M12 15.5l-2.6 3.8M12 15.5l2.6 3.8M12 15.5v5"/><path d="M19.5 12V3.5"/><path d="M17 6l2.5-2.5L22 6"/>',
  // 食べる（水槽：挟んだ物を口元へ）：かじった跡のある食べ物を、口（左の開いた扉のような 2 枚）へ運ぶ矢印と、散るかけら
  eat: '<path d="M3 7.5l3.4 2.6v4.2L3 16.8"/><path d="M8.6 6.6v11"/><path class="dot" d="M21.5 12a5.2 5.2 0 0 1-8.4 4.1c1.2-.6 1.6-1.6 1.2-2.6.9-.3 1.4-1 1.3-2-.1-.9-.8-1.5-1.7-1.6.6-1 .5-2-.4-2.7A5.2 5.2 0 0 1 21.5 12z"/><path d="M12.4 3.4l-2 1.6"/><path d="M10.4 3.2v1.8h1.8"/><circle class="dot" cx="11.2" cy="19.8" r="1"/><circle class="dot" cx="14.2" cy="21" r="0.8"/>',
  // 視点：三人称 = 後ろのカメラからカニを見る線
  camTps: '<path class="dot" d="M10 10.6c0-3.4 2.9-5.6 6.5-5.6S23 7.2 23 10.6z"/><path d="M11.2 10.6l-1.8 2.6M21.8 10.6l1.6 2.4M13.6 10.6l-.8 2.8M19.4 10.6l.8 2.8"/><rect class="dot" x="1" y="15.6" width="8" height="5.8" rx="1.4"/><path d="M9.6 15.2l2.6-2" stroke-dasharray="1.4 1.6"/>',
  // 肩越し = 手前に大きくカニの背中と 2 本の眼、その先へ広がる見る範囲
  camClose: '<path class="dot" d="M2 23c0-4.8 4.4-7.8 10-7.8s10 3 10 7.8z"/><path d="M9 15.4v-3.6M15 15.4v-3.6"/><circle class="dot" cx="9" cy="10.4" r="1.7"/><circle class="dot" cx="15" cy="10.4" r="1.7"/><path d="M8 7.6L3.6 2.4M16 7.6l4.4-5.2"/>',
  // 自由追従 = 岩を通り抜けて回る点線の輪
  camFree: '<circle cx="12" cy="12" r="8.2" stroke-dasharray="2.2 2.2"/><rect x="14.5" y="2.5" width="7" height="6.5" rx="1"/><circle class="dot" cx="12" cy="12" r="2.2"/><path d="M3.2 15.4l2.2-1 .5 2.4"/>',
  // ガラス越し = ガラスの板と外から覗く眼
  camObserve: '<rect x="12.5" y="2.5" width="9" height="19" rx="1"/><path d="M15 7l3-3M15 11l5-5"/><path d="M1.5 12c1.4-2.4 3.1-3.6 4.8-3.6S9.7 9.6 11 12c-1.3 2.4-3 3.6-4.7 3.6S2.9 14.4 1.5 12z"/><circle class="dot" cx="6.3" cy="12" r="1.3"/>',
  // 箱庭 = 水槽を斜め上から見た箱
  camDiorama: '<path d="M12 3l8.5 4.6v8.8L12 21l-8.5-4.6V7.6z"/><path d="M3.5 7.6L12 12.2l8.5-4.6"/><path d="M12 12.2V21"/><path d="M5.5 14.4c1.6-.9 3-.9 4.4 0"/>',
  // 従来 = カメラと回り込む矢印
  camClassic: '<rect x="4" y="9" width="16" height="10.5" rx="2.2"/><circle cx="12" cy="14.2" r="2.8"/><path d="M8 9l1.4-2.2h5.2L16 9"/><path d="M3 5.5c2.4-2.6 5.6-3.6 9-3.2"/><path d="M10.2 1l1.8 1.3-1.3 1.8"/>',
} as const;

export type TouchIconName = keyof typeof TOUCH_ICONS;

/** 印の SVG（class は表示の切り替え用） */
export function touchIcon(name: TouchIconName, cls = ''): string {
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
      <button class="tb run" type="button" aria-label="${opts.runLabel ?? '走る'}" data-label="${opts.runLabel ?? '走る'}">${f(touchIcon('run'))}</button>${opts.jump ? `
      <button class="tb jump" type="button" aria-label="ジャンプ" data-label="ジャンプ">${f(touchIcon('jump'))}</button>` : ''}${opts.dig ? `
      <button class="tb dig" type="button" aria-label="掘る" data-label="掘る">${f(`<i class="aim"></i>${touchIcon('dig', 'i-dig')}${touchIcon('fill', 'i-fill')}${touchIcon('snip', 'i-snip')}${touchIcon('uproot', 'i-uproot')}${touchIcon('eat', 'i-eat')}`)}</button>` : ''}${opts.onCamera ? `
      <button class="tb cam" type="button" aria-label="視点の切り替え（長押しで一覧）" data-label="視点">${f(touchIcon('camTps', 'i-view'))}</button>` : ''}${opts.act ? `
      <button class="act" type="button"><i class="ring"></i><span></span></button>` : ''}${opts.grab ? `
      <button class="tb grab" type="button" aria-pressed="false" aria-label="挟む" data-label="挟む">${f(`${touchIcon('clawOpen', 'i-open')}${touchIcon('clawShut', 'i-shut')}`)}</button>` : ''}`;
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
      const fn = opts.onCamera, hold = opts.onCameraHold;
      if (!hold) {
        cam.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          fn();
        });
      } else {
        // 長押し（CAMERA_HOLD_MS）で onCameraHold、それより短く離したら onCamera（離したときに切り替える）。
        // 長押しの後は、押したまま指を動かす・離すを onCameraDrag へ（一覧の視点を指を滑らせて選ぶ）
        const drag = opts.onCameraDrag;
        let id = -1, timer = 0, fired = false, lx = 0, ly = 0;
        cam.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          if (id !== -1) this.input.release(id);
          const mine = e.pointerId;
          id = mine;
          fired = false;
          cam.classList.add('on');
          capture(cam, mine);
          clearTimeout(timer);
          timer = window.setTimeout(() => {
            if (id !== mine) return;
            fired = true;
            cam.classList.add('held');
            hold();
          }, CAMERA_HOLD_MS);
          lx = e.clientX;
          ly = e.clientY;
          this.input.claim(e, {
            move: (ev) => {
              if (id !== mine) return;
              lx = ev.clientX;
              ly = ev.clientY;
              if (fired) drag?.(lx, ly, false);
            },
            end: () => {
              if (id !== mine) return;
              id = -1;
              clearTimeout(timer);
              cam.classList.remove('on', 'held');
              if (!fired) fn();
              else drag?.(lx, ly, true);
            },
          });
        });
        this.input.onReset(() => {
          id = -1;
          clearTimeout(timer);
          cam.classList.remove('on', 'held');
        });
      }
      cam.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    // 押したときの反応：印のボタンは押した瞬間に輪が広がって消える（.tap。押している間の縮み・明るさは .on / .press）
    if (this.icons) {
      this.root.addEventListener('pointerdown', (e) => {
        const b = (e.target as Element | null)?.closest?.('.tb');
        if (!b) return;
        b.classList.remove('tap');
        void (b as HTMLElement).offsetWidth;
        b.classList.add('tap');
        this.taps++;
      }, true);
    }
  }

  /** 押した回数（印のボタン。自動検証用） */
  taps = 0;

  /** ボタン名を印の下に出す（設定の「ボタンの名前」・初回の案内） */
  setLabels(on: boolean) {
    this.root.classList.toggle('labels', on);
  }

  /** ボタンの印と名前を替える（cls = ボタンの class。name = 印、label = 名前・読み上げ） */
  setButton(cls: string, name: TouchIconName | null, label?: string) {
    const b = this.root.querySelector<HTMLElement>(`.tb.${cls}`);
    if (!b) return;
    if (name) {
      const svg = b.querySelector('.i-view');
      if (svg && svg.getAttribute('data-n') !== name) {
        svg.setAttribute('data-n', name);
        svg.innerHTML = TOUCH_ICONS[name];
      }
    }
    if (label !== undefined && b.dataset.label !== label) {
      b.dataset.label = label;
      if (!b.classList.contains('grab')) b.setAttribute('aria-label', label);
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
      if (btn.dataset.label !== label) btn.dataset.label = label;
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
