// 操作の説明の欄。右上の「×」ですぐ閉じ、右上のメニューの「？」でいつでも開き直せる（PC は H キーでも切り替え）。
// - 初めて（閉じたことが無い）：短い案内（brief）を出す（第 6 段階で PC も短い案内に。以前は PC は詳しい説明 full）
// - 一度閉じたら、その端末のブラウザに覚えて（localStorage）、次からは自動で出さない（「？」・H で開ける）
// - 長い説明は欄の中でスクロールする。欄の上の指はゲームに渡さない（ゲームの指は Canvas と操作のボタンだけが受ける。
//   欄の中でのピンチはページの拡大にもしない：AquaViewport と CSS の touch-action: pan-y）

/** 説明を閉じたことの記録（localStorage。保存データとは別：?nosave でも記録する。消すと次から初回の案内に戻る） */
export const HELP_KEY = 'ppp-aquarium:help';

export type HelpState = 'brief' | 'full' | 'closed';

export interface HelpPanelOptions {
  touch: boolean;
  /** 短い案内（スマホの初回） */
  brief: string;
  /** 詳しい説明 */
  full: string;
}

export class HelpPanel {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  private stateNow: HelpState = 'closed';

  constructor(menu: HTMLElement, opts: HelpPanelOptions) {
    const el = document.createElement('div');
    el.id = 'help';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '操作の説明');
    el.innerHTML = `
      <div class="help-head"><b>操作</b><button type="button" class="help-close" aria-label="説明を閉じる" title="閉じる">×</button></div>
      <div class="help-body">
        <div class="help-brief">${opts.brief}<div class="help-btns"><button type="button" class="help-more">詳しい説明を見る</button></div></div>
        <div class="help-full">${opts.full}</div>
      </div>`;
    document.body.appendChild(el);
    this.root = el;
    // 欄の上の指・ホイールは、欄の中だけで使う（ゲームの視点・カメラのズームにしない）
    const stop = (e: Event) => e.stopPropagation();
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'wheel', 'contextmenu'] as const) el.addEventListener(t, stop);
    el.querySelector('.help-close')!.addEventListener('click', () => this.close());
    el.querySelector('.help-more')!.addEventListener('click', () => this.show('full'));

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'menu-btn help-btn';
    this.button.textContent = '？';
    this.button.setAttribute('aria-label', '操作の説明を開く');
    this.button.title = '操作の説明（H）';
    this.button.addEventListener('pointerdown', stop);
    this.button.addEventListener('click', () => this.toggle());
    menu.appendChild(this.button);

    // （第 6 段階：PC も初回は短い案内だけ。詳しい説明は「詳しい説明を見る」・？・H で）
    this.show(readDismissed() ? 'closed' : 'brief');
  }

  get state(): HelpState {
    return this.stateNow;
  }

  show(s: HelpState) {
    this.stateNow = s;
    this.root.classList.remove('brief', 'full', 'closed');
    this.root.classList.add(s);
    this.button.classList.toggle('on', s !== 'closed');
    this.button.setAttribute('aria-expanded', String(s !== 'closed'));
    if (s === 'full') this.root.querySelector('.help-body')!.scrollTop = 0;
  }

  /** 閉じて、次から自動で出さないことを覚える */
  close() {
    this.show('closed');
    writeDismissed();
  }

  /** 「？」・H キー：閉じていれば詳しい説明を開く。開いていれば閉じる */
  toggle() {
    if (this.stateNow === 'closed') this.show('full');
    else this.close();
  }
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(HELP_KEY) === 'closed';
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(HELP_KEY, 'closed');
  } catch {
    /* 覚えられない環境（プライベートブラウズ等）では、次もまた初回の案内が出るだけ */
  }
}
