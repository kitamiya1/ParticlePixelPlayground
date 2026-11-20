// 描画方式 A/B の比較・計測ツール。実行中はゲームの更新を止め（カメラ・キャラクター・時間を固定し）、
// 設定だけを切り替えて同じ条件で描き比べる。終わったら設定とカメラを元に戻す。

import type { Game } from '../game/Game';
import type { SceneRenderer } from '../render/SceneRenderer';
import { cloneSettings, type RenderMethod, type RenderSettings } from '../settings';

export interface FrameInfo {
  /** 前フレームからの経過（ms） */
  frameMs: number;
  /** 更新 + 描画命令の CPU 時間（ms） */
  cpuMs: number;
  /** GPU 時間（ms。結果は数フレーム遅れて届く。非対応・未取得なら null） */
  gpuMs: number | null;
}

export interface ToolHost {
  game: Game;
  view: SceneRenderer;
  settings: RenderSettings;
  canvas: HTMLCanvasElement;
  /** UI へ結果を出す */
  report(html: string, json?: unknown): void;
  notify(msg: string): void;
  /** 設定を外部から変えたあとに UI を合わせる */
  syncUI(): void;
}

export interface Tool {
  /** true の間はゲームの更新を止める */
  readonly pausesGame: boolean;
  /** 描画の直前（設定・カメラを合わせる） */
  before(): void;
  /** 描画の直後。false を返したら終了 */
  after(info: FrameInfo): boolean;
  /** 中断・終了時の後片付け */
  finish(): void;
}

const METHOD_LABEL: Record<RenderMethod, string> = { points: 'A-points', splats: 'B-splats' };
const METHOD_JA: Record<RenderMethod, string> = { points: 'A：ポイント', splats: 'B：スプラット' };

/** ツールの共通部分：開始時の設定・カメラを保存し、終了時に戻す */
abstract class BaseTool implements Tool {
  readonly pausesGame = true;
  protected readonly saved: RenderSettings;
  private readonly cam: { yaw: number; pitch: number; zoom: number; target: { x: number; y: number; z: number } };

  constructor(protected readonly host: ToolHost) {
    this.saved = cloneSettings(host.settings);
    const c = host.game.camera;
    this.cam = { yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, target: { ...c.target } };
  }

  /** 開始時の設定に上書きを重ねる */
  protected apply(over: Partial<RenderSettings>) {
    Object.assign(this.host.settings, cloneSettings(this.saved), over);
  }

  protected restoreCamera() {
    const c = this.host.game.camera;
    c.yaw = this.cam.yaw;
    c.pitch = this.cam.pitch;
    c.zoom = this.cam.zoom;
    c.target = { ...this.cam.target };
  }

  abstract before(): void;
  abstract after(info: FrameInfo): boolean;

  finish() {
    Object.assign(this.host.settings, this.saved);
    this.restoreCamera();
    this.host.view.releaseAnalysis();
    this.host.syncUI();
  }

  /** 方式 B の並べ替えが落ち着いたか */
  /**
   * 方式 B を描ける状態か。B のモジュール（Spark）は初回に読み込むので、届くまで待つ。
   * 読み込みに失敗したら 'fail'（ツールは結果を出して終了する）
   */
  protected splatReady(method: RenderMethod): 'ok' | 'wait' | 'fail' {
    if (method !== 'splats') return 'ok';
    const v = this.host.view;
    if (v.splat) return 'ok';
    return v.splatStatus === 'error' ? 'fail' : 'wait';
  }

  protected failReport(title: string) {
    this.host.report(`<b>${title}</b><br>方式 B を読み込めなかったため中止しました。`);
  }

  protected settled(frames: number, min: number): boolean {
    const sp = this.host.view.splat;
    return frames >= min && (!sp || !sp.busy || frames > min + 60);
  }
}

// ---------------- スクリーンショット ----------------

interface Shot {
  method: RenderMethod;
  zoom?: number;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 同じカメラ・同じ描画解像度で A と B を順に撮影して保存する */
export class CaptureTool extends BaseTool {
  private i = 0;
  private frames = 0;
  private readonly time = stamp();
  private readonly saved_: string[] = [];

  constructor(host: ToolHost, private readonly shots: Shot[], private readonly title: string) {
    super(host);
  }

  before() {
    const shot = this.shots[this.i];
    this.apply({ renderMethod: shot.method, viewMode: 'particles' });
    if (shot.zoom) this.host.game.camera.zoom = shot.zoom;
  }

  after(): boolean {
    const ready = this.splatReady(this.shots[this.i].method);
    if (ready === 'fail') {
      this.failReport(this.title);
      return false;
    }
    if (ready === 'wait') return true;
    this.frames++;
    // 方式の切り替え直後は Spark の生成・並べ替えが 1〜数フレーム遅れるので待つ
    if (!this.settled(this.frames, 6)) return true;
    const shot = this.shots[this.i];
    const s = this.host.settings;
    const lr = this.host.view.lowResolution;
    const zoom = this.host.game.camera.zoom;
    const name = `ppp-${this.time}-${METHOD_LABEL[shot.method]}-px${s.pixelScale}-${lr.w}x${lr.h}-zoom${zoom.toFixed(1)}.png`;
    this.host.canvas.toBlob((blob) => {
      if (!blob) return this.host.notify('スクリーンショットに失敗しました');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
    this.saved_.push(name);
    this.i++;
    this.frames = 0;
    if (this.i < this.shots.length) return true;
    this.host.report(`<b>${this.title}</b><br>${this.saved_.map((n) => `・${n}`).join('<br>')}`, { files: this.saved_ });
    this.host.notify(`${this.saved_.length} 枚保存しました`);
    return false;
  }
}

export function abShots(): Shot[] {
  return [{ method: 'points' }, { method: 'splats' }];
}

export function zoomShots(currentZoom: number): Shot[] {
  const zs = [Math.max(5, currentZoom * 0.5), currentZoom, Math.min(70, currentZoom * 2.2)];
  const out: Shot[] = [];
  for (const method of ['points', 'splats'] as const) for (const zoom of zs) out.push({ method, zoom });
  return out;
}

// ---------------- ちらつき計測 ----------------

interface FlickerResult {
  method: RenderMethod;
  /** 静止カメラでのフレーム間変化率（%） */
  staticPct: number;
  /** 平行移動中のフレーム間変化率（%、カメラの画素単位の移動を補正した上で） */
  panPct: number;
  panMaxPct: number;
  frames: number;
}

/**
 * カメラを一定速度で平行移動させ、最終的なドット画像（後処理後）のフレーム間変化率を測る。
 * 平行投影 + カメラの画素吸着では、画面は整数画素ずつ平行移動するだけなので、
 * その移動量を差し引いて比べれば「本来変わらないはずの画素」がどれだけ変わったか＝ちらつきが分かる。
 * 風は止めて、カメラ移動による変化だけを測る。
 */
export class FlickerTool extends BaseTool {
  private mi = 0;
  private frame = 0;
  private prev: { w: number; h: number; data: Uint8Array } | null = null;
  private prevSnap = { x: 0, y: 0 };
  private acc = { st: [] as number[], pan: [] as number[] };
  private readonly results: FlickerResult[] = [];
  private readonly methods: RenderMethod[] = ['points', 'splats'];
  private static readonly WARM = 20;
  private static readonly STATIC = 30;
  private static readonly PAN = 90;

  before() {
    this.apply({ renderMethod: this.methods[this.mi], viewMode: 'particles', wind: 0 });
    const ph = this.frame - FlickerTool.WARM - FlickerTool.STATIC;
    if (ph >= 0) {
      // 低解像度画素で毎フレーム横に 0.37 画素ぶん動かす（整数倍にならない速度）。
      // 視線方向の成分を持たせると霞（奥行き依存）が変わるため、画面の横方向だけに動かす
      const c = this.host.game.camera;
      const lr = this.host.view.lowResolution;
      const wpp = c.zoom / Math.max(1, Math.min(lr.w - 4, lr.h - 4));
      c.target.x += Math.cos(c.yaw) * 0.37 * wpp;
      c.target.z += -Math.sin(c.yaw) * 0.37 * wpp;
    }
  }

  after(): boolean {
    const ready = this.splatReady(this.methods[this.mi]);
    if (ready === 'fail') {
      this.failReport('ちらつき計測');
      return false;
    }
    if (ready === 'wait') return true;
    const f = this.frame++;
    const W = FlickerTool.WARM, S = FlickerTool.STATIC, P = FlickerTool.PAN;
    if (f < W) {
      this.prev = null;
      return true;
    }
    const method = this.methods[this.mi];
    const img = this.host.view.readLowRes(this.host.settings, method);
    const snap = { x: this.host.view.snapIndex.x, y: this.host.view.snapIndex.y };
    if (img && this.prev && img.w === this.prev.w && img.h === this.prev.h) {
      const dx = snap.x - this.prevSnap.x, dy = snap.y - this.prevSnap.y;
      const pct = bestShiftDiff(this.prev, img, dx, dy);
      if (f < W + S) this.acc.st.push(pct);
      else this.acc.pan.push(pct);
    }
    this.prev = img;
    this.prevSnap = snap;
    if (f < W + S + P) return true;

    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    this.results.push({ method, staticPct: avg(this.acc.st), panPct: avg(this.acc.pan), panMaxPct: Math.max(0, ...this.acc.pan), frames: this.acc.pan.length });
    this.acc = { st: [], pan: [] };
    this.prev = null;
    this.frame = 0;
    this.restoreCamera();
    this.mi++;
    if (this.mi < this.methods.length) return true;

    const s = this.saved;
    const valid = s.projection === 'ortho' && s.cameraSnap;
    const rows = this.results
      .map((r) => `<tr><td>${METHOD_JA[r.method]}</td><td>${r.staticPct.toFixed(2)}%</td><td>${r.panPct.toFixed(2)}%</td><td>${r.panMaxPct.toFixed(2)}%</td></tr>`)
      .join('');
    this.host.report(
      `<b>ちらつき計測</b>（フレーム間で変化した画素の割合。風は停止）<table><tr><th></th><th>静止</th><th>移動 平均</th><th>移動 最大</th></tr>${rows}</table>` +
        (valid ? '' : '<div class="warn">平行投影 + カメラ画素吸着ではないため、移動の補正は近似です</div>') +
        (s.alphaDither ? '<div class="small">方式 A は「縁をディザで透過させる」が画面に固定された模様なので、移動時の変化の大半はこれによるものです</div>' : ''),
      { test: 'flicker', settings: { pixelScale: s.pixelScale, projection: s.projection, cameraSnap: s.cameraSnap, pointSnap: s.pointSnap, alphaDither: s.alphaDither, dither: s.dither, palette: s.palette, splatCrisp: s.splatCrisp, splatSupersample: s.splatSupersample }, results: this.results },
    );
    return false;
  }
}

/** 想定される平行移動（±dx, ±dy, 0）の中で最も一致するずらし方での変化率（%） */
function bestShiftDiff(a: { w: number; h: number; data: Uint8Array }, b: { w: number; h: number; data: Uint8Array }, dx: number, dy: number): number {
  const cands = new Set<string>(['0,0', `${dx},${dy}`, `${-dx},${dy}`, `${dx},${-dy}`, `${-dx},${-dy}`]);
  let best = 100;
  for (const c of cands) {
    const [sx, sy] = c.split(',').map(Number);
    best = Math.min(best, shiftDiff(a, b, sx, sy));
  }
  return best;
}

function shiftDiff(a: { w: number; h: number; data: Uint8Array }, b: { w: number; h: number; data: Uint8Array }, sx: number, sy: number): number {
  const { w, h } = a;
  const m = 3 + Math.max(Math.abs(sx), Math.abs(sy));
  let diff = 0, total = 0;
  for (let y = m; y < h - m; y++) {
    for (let x = m; x < w - m; x++) {
      const ia = (y * w + x) * 4;
      const ib = ((y + sy) * w + (x + sx)) * 4;
      total++;
      if (Math.abs(a.data[ia] - b.data[ib]) > 10 || Math.abs(a.data[ia + 1] - b.data[ib + 1]) > 10 || Math.abs(a.data[ia + 2] - b.data[ib + 2]) > 10) diff++;
    }
  }
  return total ? (diff / total) * 100 : 0;
}

// ---------------- 性能ベンチマーク ----------------

interface BenchResult {
  method: RenderMethod;
  fps: number;
  frameMs: number;
  p95Ms: number;
  cpuMs: number;
  /** GPU 時間の平均（非対応なら null） */
  gpuMs: number | null;
  count: number;
  frames: number;
}

/** カメラを回しながら A/B それぞれの FPS・フレーム時間を測る */
export class BenchmarkTool extends BaseTool {
  private mi = 0;
  private frame = 0;
  private samples: { f: number[]; c: number[]; g: number[] } = { f: [], c: [], g: [] };
  private readonly results: BenchResult[] = [];
  private readonly methods: RenderMethod[] = ['points', 'splats'];
  private static readonly WARM = 40;
  private static readonly MEASURE = 240;

  before() {
    this.apply({ renderMethod: this.methods[this.mi], viewMode: 'particles' });
    this.host.game.camera.yaw += 0.012; // カメラを回し続ける（並べ替え・再生成の負荷も含めて測る）
  }

  after(info: FrameInfo): boolean {
    const ready = this.splatReady(this.methods[this.mi]);
    if (ready === 'fail') {
      this.failReport('性能ベンチマーク');
      return false;
    }
    if (ready === 'wait') return true;
    const f = this.frame++;
    if (f >= BenchmarkTool.WARM) {
      this.samples.f.push(info.frameMs);
      this.samples.c.push(info.cpuMs);
      if (info.gpuMs !== null) this.samples.g.push(info.gpuMs);
    }
    if (f < BenchmarkTool.WARM + BenchmarkTool.MEASURE) return true;
    const method = this.methods[this.mi];
    const fs = [...this.samples.f].sort((a, b) => a - b);
    const mean = fs.reduce((a, b) => a + b, 0) / fs.length;
    const v = this.host.view;
    this.results.push({
      method,
      fps: 1000 / mean,
      frameMs: mean,
      p95Ms: fs[Math.floor(fs.length * 0.95)],
      cpuMs: this.samples.c.reduce((a, b) => a + b, 0) / this.samples.c.length,
      gpuMs: this.samples.g.length ? this.samples.g.reduce((a, b) => a + b, 0) / this.samples.g.length : null,
      count: method === 'splats' ? v.drawnSplats : v.drawnParticles,
      frames: fs.length,
    });
    this.samples = { f: [], c: [], g: [] };
    this.frame = 0;
    this.restoreCamera();
    this.mi++;
    if (this.mi < this.methods.length) return true;

    const lr = v.lowResolution;
    const env = deviceInfo(this.host.canvas, v);
    const rows = this.results
      .map((r) => `<tr><td>${METHOD_JA[r.method]}</td><td>${r.fps.toFixed(1)}</td><td>${r.frameMs.toFixed(2)}</td><td>${r.p95Ms.toFixed(2)}</td><td>${r.cpuMs.toFixed(2)}</td><td>${r.gpuMs === null ? '―' : r.gpuMs.toFixed(2)}</td><td>${r.count.toLocaleString()}</td></tr>`)
      .join('');
    this.host.report(
      `<b>性能ベンチマーク</b>（カメラ回転中・各 ${BenchmarkTool.MEASURE} フレーム）<table><tr><th></th><th>FPS</th><th>平均ms</th><th>95%ms</th><th>CPUms</th><th>GPUms</th><th>数</th></tr>${rows}</table>` +
        `<div class="small">FPS は画面のリフレッシュレートで頭打ちになります。負荷の差は GPUms（GPU 時間）で比べてください</div>` +
        `<div class="small">${env.gpu}<br>キャンバス ${env.canvas} / 描画解像度 ${lr.w}×${lr.h} / DPR ${env.dpr}</div>`,
      { test: 'benchmark', env, lowRes: lr, settings: { pixelScale: this.saved.pixelScale, density: this.saved.density, splatSupersample: this.saved.splatSupersample }, results: this.results },
    );
    return false;
  }
}

export function deviceInfo(canvas: HTMLCanvasElement, view: SceneRenderer) {
  const gl = view.renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  return {
    gpu,
    userAgent: navigator.userAgent,
    canvas: `${canvas.width}×${canvas.height}`,
    dpr: window.devicePixelRatio || 1,
    touch: navigator.maxTouchPoints > 0,
  };
}
