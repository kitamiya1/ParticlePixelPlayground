// ゲームパッド（ブラウザの Gamepad API）。毎フレーム navigator.getGamepads() を読み、Input の pad* と腕の向き・左右のハサミへ写す。
//
// 割り当て（「standard」の配列。Xbox の名前 / PlayStation の名前）：
//   左スティック ……… 移動
//   右スティック ……… 腕（両方のハサミ）の向き。X / □ で掘っている間は掘る向きの照準。LB / L1 を押している間はカメラを回す（上下でズーム）
//   LT / L2 ………… 左のハサミを閉じる（押している間）      RT / R2 …… 右のハサミを閉じる（押している間）
//   A / × …………… ジャンプ   B / ○ …… ダッシュ（押している間）   X / □ …… 掘る / 盛る（押している間）   Y / △ …… 掘る ↔ 盛る
//   RB / R1 ………… カメラの切り替え   十字キー …… 左右 = カメラを回す・上下 = ズーム   右スティック押し込み …… カメラをカニの後ろへ
//   左スティック押し込み …… 肩越し・一人称のカメラ ↔ 三人称（第 2 段階）
//   Back / Share … 仲間を呼ぶ / 自由に暮らす   Start / Options … 操作の説明
// - 遊び（デッドゾーン）：スティックは半径 0.18 を除いて 0〜1 へ広げ直す（円形）。トリガーは 0.35 で閉じ、0.2 で開く（ちらつかない）
// - 標準でない配列（mapping が "standard" でない）は同じ番号で読むが、位置が違うことがあるので知らせる
// - 接続・切断の知らせ。切断・裏へ回ったときは押している物をすべて離す。複数つないだときは、最後に操作したものを使う

import type { Input } from '../game/Input';

const DEAD = 0.18;
const TRIGGER_ON = 0.35;
const TRIGGER_OFF = 0.2;

export interface PadActions {
  toggleTool: () => void;
  toggleCamera: () => void;
  cameraBehind: () => void;
  /** 肩越し・一人称 ↔ 三人称 */
  toggleClose?: () => void;
  toggleBuddy: () => void;
  toggleHelp: () => void;
  toast: (msg: string) => void;
  /** 通常 ↔ ハサミ集中モード（左右のスティックの押し込みを同時に） */
  toggleFocus?: () => void;
  /** 集中モード：腕の動かし方を次へ（Y / △） */
  cycleScheme?: () => void;
}

/** ハサミ集中モードでのパッドの値（AquaClawFocus が読む） */
export interface PadFocus {
  /** 左右のスティック（x = 右, y = 上。遊びを除いた値） */
  l: { x: number; y: number };
  r: { x: number; y: number };
  /** 左右のトリガーの押し込み（0..1） */
  lt: number;
  rt: number;
  /** 左右のバンパー（押している間、そちらのスティックは高さ・手首のひねり） */
  lb: boolean;
  rb: boolean;
}

export class AquaGamepad {
  /** 左右のハサミを閉じている（トリガー） */
  clawL = false;
  clawR = false;
  /** 左右のトリガーの押し込み（0..1。アナログでないパッドは 0 か 1） */
  clawLv = 0;
  clawRv = 0;
  /** トリガーが途中の値を返した（アナログのトリガー） */
  analog = false;
  /** ハサミ集中モード：スティック・バンパーを集中モードの割り当てで読む（main が書く） */
  focus = false;
  readonly pf: PadFocus = { l: { x: 0, y: 0 }, r: { x: 0, y: 0 }, lt: 0, rt: 0, lb: false, rb: false };
  /** スティックの押し込み：同時に押した（集中モードの切り替え）・押してから離すまでにもう片方を押したか */
  private l3Combo = false;
  private r3Combo = false;
  /** 使っているパッドの番号・名前・配列 */
  index = -1;
  id = '';
  standard = true;
  readonly stats = { connects: 0, disconnects: 0, polls: 0 };
  private prev: boolean[] = [];
  private lastActive = new Map<number, number>();

  constructor(private readonly input: Input, private readonly act: PadActions) {
    window.addEventListener('gamepadconnected', (e) => {
      this.stats.connects++;
      const g = (e as GamepadEvent).gamepad;
      this.act.toast(`コントローラーをつなぎました${g.mapping === 'standard' ? '' : '（ボタンの位置が違うことがあります）'}`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      this.stats.disconnects++;
      if ((e as GamepadEvent).gamepad.index === this.index) {
        this.clear();
        this.index = -1;
        this.act.toast('コントローラーが外れました');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.clear();
    });
  }

  get connected(): boolean {
    return this.index >= 0;
  }

  /** 押している物をすべて離す */
  clear() {
    const I = this.input;
    I.padMove = { x: 0, y: 0 };
    I.padRun = I.padJump = I.padDig = false;
    I.padDigAim = { x: 0, y: 0 };
    I.armAimExtra = null;
    this.clawL = this.clawR = false;
    this.clawLv = this.clawRv = 0;
    const F = this.pf;
    F.l = { x: 0, y: 0 };
    F.r = { x: 0, y: 0 };
    F.lt = F.rt = 0;
    F.lb = F.rb = false;
    this.prev = [];
  }

  /** 毎フレーム：いちばん最近操作したパッドを読む */
  poll(dt: number) {
    const list = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    let best = -1;
    for (const g of list) {
      if (!g || !g.connected) continue;
      // 何か押している・倒しているパッドを「最近操作した」とする
      const active = g.buttons.some((b) => b.pressed || b.value > 0.3) || g.axes.some((a) => Math.abs(a) > 0.4);
      if (active) this.lastActive.set(g.index, performance.now());
      const t = this.lastActive.get(g.index) ?? 0;
      if (t > best || (best < 0 && pad === null)) {
        best = t;
        pad = g;
      }
    }
    if (!pad) {
      if (this.index >= 0) this.clear();
      this.index = -1;
      return;
    }
    this.stats.polls++;
    if (pad.index !== this.index) {
      this.clear();
      this.index = pad.index;
      this.id = pad.id;
      this.standard = pad.mapping === 'standard';
    }
    const I = this.input;
    const B = (i: number) => !!pad!.buttons[i]?.pressed;
    const V = (i: number) => pad!.buttons[i]?.value ?? 0;
    const pressed = (i: number) => B(i) && !this.prev[i];
    const ax = (i: number) => pad!.axes[i] ?? 0;
    const L = radial(ax(0), ax(1)), R = radial(ax(2), ax(3));
    // トリガー（ヒステリシス付き）。押し込みの量（アナログ）：ボタンの value。押しているだけの値（0 / 1）しか返さないパッドは
    // pressed を 1 として読む
    const tv = (i: number) => {
      const b = pad!.buttons[i];
      if (!b) return 0;
      const v = Number.isFinite(b.value) ? b.value : 0;
      if (v > 0.02 && v < 0.98) this.analog = true;
      return b.pressed ? Math.max(v, this.analog ? v : 1) : v;
    };
    const lt = tv(6), rt = tv(7);
    this.clawLv = lt;
    this.clawRv = rt;
    this.clawL = this.clawL ? lt > TRIGGER_OFF : lt > TRIGGER_ON;
    this.clawR = this.clawR ? rt > TRIGGER_OFF : rt > TRIGGER_ON;
    // 左右のスティックの押し込み：同時に押したら集中モードの切り替え。1 本だけなら離したときに従来の操作
    // （肩越し ↔ 三人称・カメラを後ろへ。同時押しの途中で従来の操作が動かないように、離したときにする）
    const l3 = B(10), r3 = B(11);
    if (l3 && r3 && !(this.prev[10] && this.prev[11])) {
      if (!this.l3Combo && !this.r3Combo) this.act.toggleFocus?.();
      this.l3Combo = this.r3Combo = true;
    }
    if (!l3 && this.prev[10]) {
      if (!this.l3Combo) this.act.toggleClose?.();
      this.l3Combo = false;
    }
    if (!r3 && this.prev[11]) {
      if (!this.r3Combo) this.act.cameraBehind();
      this.r3Combo = false;
    }
    if (this.focus) {
      // ハサミ集中モード：左スティック = 左の鋏・右スティック = 右の鋏（x = 右, y = 上）・トリガー = 開閉・バンパー = 高さとひねり。
      // カニは歩かない（移動・ジャンプ・ダッシュ・掘る向き・腕の向きは使わない）。十字キーはカメラのまま。X / □ は食べる
      const F = this.pf;
      F.l = { x: L.x, y: -L.y };
      F.r = { x: R.x, y: -R.y };
      F.lt = lt;
      F.rt = rt;
      F.lb = B(4);
      F.rb = B(5);
      I.padMove = { x: 0, y: 0 };
      I.padJump = I.padRun = false;
      I.padDig = B(2);
      I.padDigAim = { x: 0, y: 0 };
      I.armAimExtra = null;
      if (B(14)) I.dragDX -= 600 * dt;
      if (B(15)) I.dragDX += 600 * dt;
      if (B(12)) I.wheel -= 4 * dt;
      if (B(13)) I.wheel += 4 * dt;
      // B / ○ で通常へ戻る・Y / △ で腕の動かし方を次へ
      if (pressed(1)) this.act.toggleFocus?.();
      if (pressed(3)) this.act.cycleScheme?.();
      if (pressed(8)) this.act.toggleBuddy();
      if (pressed(9)) this.act.toggleHelp();
      this.prev = pad.buttons.map((b) => b.pressed);
      return;
    }
    // 左スティック：移動（上 = 前。Gamepad の y は下が +）
    I.padMove = { x: L.x, y: -L.y };
    I.padJump = B(0);
    I.padRun = B(1);
    I.padDig = B(2);
    // 右スティック：LB を押している間はカメラ、掘っている間は掘る向き、それ以外は腕の向き
    const camMode = B(4);
    if (camMode) {
      I.dragDX += R.x * 700 * dt;
      I.dragDY += R.y * 400 * dt;
      I.armAimExtra = null;
      I.padDigAim = { x: 0, y: 0 };
    } else if (I.padDig) {
      I.padDigAim = { x: R.x, y: -R.y };
      I.armAimExtra = null;
    } else {
      I.armAimExtra = { x: R.x, y: -R.y };
      I.padDigAim = { x: 0, y: 0 };
    }
    // 十字キー：カメラ（左右 = 回す、上下 = ズーム）
    if (B(14)) I.dragDX -= 600 * dt;
    if (B(15)) I.dragDX += 600 * dt;
    if (B(12)) I.wheel -= 4 * dt;
    if (B(13)) I.wheel += 4 * dt;
    if (pressed(3)) this.act.toggleTool();
    if (pressed(5)) this.act.toggleCamera();
    if (pressed(8)) this.act.toggleBuddy();
    if (pressed(9)) this.act.toggleHelp();
    this.prev = pad.buttons.map((b) => b.pressed);
  }

  /** 詳細の欄の表示 */
  describe(): string {
    if (this.index < 0) return 'コントローラー：つながっていません';
    return `コントローラー：${this.id.slice(0, 40)}${this.standard ? '' : '（標準でない配列）'} 左ハサミ ${this.clawL ? '閉' : '開'} 右ハサミ ${this.clawR ? '閉' : '開'}`;
  }
}

/** 円形の遊び：半径 DEAD 以下は 0、その外を 0〜1 へ広げ直す（向きは保つ） */
export function radial(x: number, y: number): { x: number; y: number } {
  const l = Math.hypot(x, y);
  if (!Number.isFinite(l) || l < DEAD) return { x: 0, y: 0 };
  const k = Math.min(1, (l - DEAD) / (1 - DEAD)) / l;
  return { x: x * k, y: y * k };
}
