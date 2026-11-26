// ゲームパッド（ブラウザの Gamepad API）。毎フレーム navigator.getGamepads() を読み、Input の pad* と腕の向き・左右のハサミへ写す。
//
// 割り当て（「standard」の配列。Xbox の名前 / PlayStation の名前）：
//   左スティック ……… 移動
//   右スティック ……… 腕（両方のハサミ）の向き。X / □ で掘っている間は掘る向きの照準。LB / L1 を押している間はカメラを回す（上下でズーム）
//   LT / L2 ………… 左のハサミを閉じる（押している間）      RT / R2 …… 右のハサミを閉じる（押している間）
//   A / × …………… ジャンプ   B / ○ …… ダッシュ（押している間）   X / □ …… 掘る / 盛る（押している間）   Y / △ …… 掘る ↔ 盛る
//   RB / R1 ………… カメラの切り替え   十字キー …… 左右 = カメラを回す・上下 = ズーム   右スティック押し込み …… カメラをカニの後ろへ
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
  toggleBuddy: () => void;
  toggleHelp: () => void;
  toast: (msg: string) => void;
}

export class AquaGamepad {
  /** 左右のハサミを閉じている（トリガー） */
  clawL = false;
  clawR = false;
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
    // 左スティック：移動（上 = 前。Gamepad の y は下が +）
    I.padMove = { x: L.x, y: -L.y };
    I.padJump = B(0);
    I.padRun = B(1);
    I.padDig = B(2);
    // トリガー（ヒステリシス付き）
    const lt = V(6), rt = V(7);
    this.clawL = this.clawL ? lt > TRIGGER_OFF : lt > TRIGGER_ON;
    this.clawR = this.clawR ? rt > TRIGGER_OFF : rt > TRIGGER_ON;
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
    if (pressed(11)) this.act.cameraBehind();
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
