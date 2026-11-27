// 描画（WebGL）の喪失と復旧。GPU 処理が止められた（iOS の WebKit の「応答なし」・GPU のリセット・メモリ不足など）とき、
// ゲームの状態（掘った地形・仲間・手持ちの砂・位置）は CPU 側にあるので失われない。失うのは GPU 側の資源だけ。
// - 喪失（webglcontextlost）：既定の動作を止め（= 復旧を求める）、描画とゲームの更新を止め、画面に知らせを出す。
//   念のため、すぐ保存する（同期の控え + 保存先へ書く。GPU が無くても書ける）。
// - 復旧（webglcontextrestored）：three.js が GL の資源を作り直す（形・テクスチャは CPU 側の配列から次の描画で上げ直す）。
//   ここではシェーダーを 1 つずつ作り直してから（AquariumRenderer.prepare）描画を再開する。
// - 復旧の知らせが RESTORE_WAIT 秒来ない：保存できたら、ページを読み込み直す（保存データから元に戻る。普通の再起動と同じ道）。
// - 繰り返しの防止：自動の読み込み直しは RELOAD_WINDOW 秒に 1 回まで（sessionStorage に記録。読み込み直しても残る）。
//   喪失が LOOP_WINDOW 秒に LOOP_MAX 回を超えたら、自動ではもう何もしない。どちらも画面のボタン（保存して読み込み直す）に任せる。
// 記録（diag）：起動の記録と同じ道（AquaPlatform.diag）へ 1 行ずつ出す。

import { diag } from './AquaPlatform';

const RESTORE_WAIT = 8;
const RELOAD_WINDOW = 300;
const LOOP_WINDOW = 120;
const LOOP_MAX = 3;
const RELOAD_KEY = 'aqua.gpuReloads';

export type GpuState = 'preparing' | 'ready' | 'lost' | 'failed';

export interface GpuSave {
  /** すぐ保存する（控え + 保存先）。保存できた・保存しない設定なら true */
  flush: () => Promise<boolean>;
}

export interface PrepareResult {
  programs: number;
  ms: number;
  slowest: { label: string; ms: number }[];
  lost: boolean;
}

export class GpuGuard {
  state: GpuState = 'preparing';
  readonly stats = { lost: 0, restored: 0, prepares: 0, lastPrepareMs: 0, autoReloads: 0, reloadedForGpu: false };
  private save: GpuSave | null = null;
  private toast: (msg: string) => void = () => {};
  private restoreTimer = 0;
  private readonly lostTimes: number[] = [];
  private readonly el: HTMLDivElement;
  private readonly msg: HTMLDivElement;
  private readonly btn: HTMLButtonElement;
  private readonly btn2: HTMLButtonElement;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext | WebGL2RenderingContext,
    private readonly prepareFn: () => Promise<PrepareResult>,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'gpu-overlay';
    this.el.innerHTML = `<div class="box"><div class="msg"></div><div class="btns"><button type="button" class="b1"></button><button type="button" class="b2"></button></div></div>`;
    this.msg = this.el.querySelector('.msg')!;
    this.btn = this.el.querySelector('.b1')!;
    this.btn2 = this.el.querySelector('.b2')!;
    this.btn.textContent = '保存して読み込み直す';
    this.btn2.textContent = '保存せずに読み込み直す';
    this.btn.addEventListener('click', () => void this.manualReload(false));
    this.btn2.addEventListener('click', () => void this.manualReload(true));
    for (const b of [this.btn, this.btn2]) b.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.body.appendChild(this.el);
    canvas.addEventListener('webglcontextlost', (e) => this.onLost(e), false);
    canvas.addEventListener('webglcontextrestored', () => void this.onRestored(), false);
    // 前のページが描画の喪失で読み込み直した（知らせを出す・記録に残す）
    const rl = this.reloads();
    const last = rl[rl.length - 1];
    if (last && Date.now() - last < 60_000) {
      this.stats.reloadedForGpu = true;
      diag(`gpu: this page was reloaded ${((Date.now() - last) / 1000).toFixed(1)}s ago to recover rendering`);
    }
  }

  /** 保存の道と知らせ（保存が用意できた後で付ける。それまでの喪失では、保存データに無い変化はまだ無い） */
  attach(save: GpuSave, toast: (msg: string) => void) {
    this.save = save;
    this.toast = toast;
    if (this.stats.reloadedForGpu) setTimeout(() => toast('描画を立て直すため読み込み直しました（進捗は保存してあります）'), 800);
  }

  /** 描画してよいか */
  get canRender(): boolean {
    return this.state === 'ready';
  }

  /** 最初の準備（起動時）。失ったら、復旧の知らせを待つ（起動はそのまま進める：ループは描画を止めて待つ） */
  async start(): Promise<PrepareResult | null> {
    return this.runPrepare('boot');
  }

  private async runPrepare(why: string): Promise<PrepareResult | null> {
    this.state = 'preparing';
    this.stats.prepares++;
    diag(`gpu: prepare (${why}) start`);
    let r: PrepareResult;
    try {
      r = await this.prepareFn();
    } catch (e) {
      diag(`gpu: prepare (${why}) threw ${(e as Error).message}`);
      if (this.gl.isContextLost()) return null;
      throw e;
    }
    this.stats.lastPrepareMs = r.ms;
    diag(`gpu: prepare (${why}) ${r.lost ? 'LOST' : 'done'} programs=${r.programs} ms=${r.ms.toFixed(0)} slowest=${r.slowest.map((s) => `${s.label}:${s.ms.toFixed(0)}`).join(' ')}`);
    if (r.lost || this.gl.isContextLost()) {
      // 喪失の知らせ（onLost）が状態を lost にする。まだ来ていなければ待つ
      if (this.state === 'preparing') this.state = 'lost';
      return r;
    }
    this.state = 'ready';
    return r;
  }

  private onLost(e: Event) {
    e.preventDefault();
    const now = performance.now() / 1000;
    this.stats.lost++;
    this.lostTimes.push(now);
    while (this.lostTimes.length && now - this.lostTimes[0] > LOOP_WINDOW) this.lostTimes.shift();
    diag(`gpu: webglcontextlost #${this.stats.lost} (state was ${this.state}, ${this.lostTimes.length} in ${LOOP_WINDOW}s)`);
    this.state = 'lost';
    this.show('描画が中断されました。立て直しています…（進捗は保存しています）', false);
    // GPU が無くても保存はできる：先に書いておく（復旧できず読み込み直すときも、この保存から戻る）
    void this.flush('lost');
    clearTimeout(this.restoreTimer);
    if (this.lostTimes.length > LOOP_MAX) {
      this.fail(`描画が何度も中断されました（${LOOP_WINDOW / 60} 分に ${this.lostTimes.length} 回）。自動での立て直しを止めました。`);
      return;
    }
    this.restoreTimer = window.setTimeout(() => void this.autoReload('restore-timeout'), RESTORE_WAIT * 1000);
  }

  private async onRestored() {
    clearTimeout(this.restoreTimer);
    this.stats.restored++;
    diag(`gpu: webglcontextrestored #${this.stats.restored} (state was ${this.state})`);
    // 自動の読み込み直しを止めた後でも、遅れて復旧が来たらその場で立て直す（喪失を繰り返しているときだけは止めたまま）
    if (this.state === 'failed' && this.lostTimes.length > LOOP_MAX) return;
    this.show('描画を準備しています…', false);
    const r = await this.runPrepare('restore');
    if (r && !r.lost && this.state === 'ready') {
      this.hide();
      this.toast('描画を立て直しました');
    }
  }

  private async flush(why: string): Promise<boolean> {
    if (!this.save) return true;
    try {
      const ok = await this.save.flush();
      diag(`gpu: save flush (${why}) ${ok ? 'ok' : 'FAILED'}`);
      return ok;
    } catch (e) {
      diag(`gpu: save flush (${why}) threw ${(e as Error).message}`);
      return false;
    }
  }

  private reloads(): number[] {
    try {
      const v = JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
    } catch {
      return [];
    }
  }

  private reload(why: string) {
    const rl = this.reloads().filter((t) => Date.now() - t < 3_600_000);
    rl.push(Date.now());
    try {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify(rl));
    } catch {
      /* 記録できなくても読み込み直す（手動のときだけここへ来る場合もある） */
    }
    diag(`gpu: reload (${why})`);
    location.replace(location.href);
  }

  /** 復旧の知らせが来ない：保存できたら読み込み直す（RELOAD_WINDOW 秒に 1 回まで） */
  private async autoReload(why: string) {
    if (this.state !== 'lost') return;
    const recent = this.reloads().filter((t) => Date.now() - t < RELOAD_WINDOW * 1000);
    if (recent.length) {
      this.fail('描画を立て直せませんでした（少し前にも読み込み直しています）。');
      return;
    }
    const ok = await this.flush('before-reload');
    if (!ok) {
      this.fail('描画を立て直せず、保存もできませんでした。セーブのメニューから書き出してから読み込み直してください。', true);
      return;
    }
    this.stats.autoReloads++;
    this.reload(why);
  }

  private async manualReload(skipSave: boolean) {
    if (!skipSave) {
      const ok = await this.flush('manual');
      if (!ok) {
        this.fail('保存できませんでした。セーブのメニューから書き出すか、保存せずに読み込み直してください。', true);
        return;
      }
    }
    this.reload(skipSave ? 'manual-nosave' : 'manual');
  }

  private fail(text: string, allowNoSave = false) {
    clearTimeout(this.restoreTimer);
    this.state = 'failed';
    diag(`gpu: failed — ${text}`);
    this.show(text, true, allowNoSave);
  }

  private show(text: string, buttons: boolean, noSaveBtn = false) {
    this.msg.textContent = text;
    this.btn.style.display = buttons ? '' : 'none';
    this.btn2.style.display = buttons && noSaveBtn ? '' : 'none';
    this.el.classList.add('show');
  }

  private hide() {
    this.el.classList.remove('show');
  }
}
