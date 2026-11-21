// 描画方式 A/B/C/D/E/F の比較・計測ツール。実行中はゲームの更新を止め（カメラ・キャラクター・時間を固定し）、
// 設定だけを切り替えて同じ条件で描き比べる。終わったら設定とカメラを元に戻す。

import type { Game } from '../game/Game';
import type { SceneRenderer } from '../render/SceneRenderer';
import { RENDER_METHODS, cloneSettings, type RenderMethod, type RenderSettings } from '../settings';

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

const METHOD_LABEL: Record<RenderMethod, string> = { points: 'A-points', splats: 'B-splats', surfels: 'C-surfels', voxels: 'D-voxels', pixelmesh: 'E-pixelmesh', hybrid: 'F-hybrid' };
const METHOD_JA: Record<RenderMethod, string> = { points: 'A：ポイント', splats: 'B：スプラット', surfels: 'C：サーフェル', voxels: 'D：ボクセル', pixelmesh: 'E：メッシュ', hybrid: 'F：E+C' };
/**
 * 描いた数の単位。A・B・C は「点 1 つ = 描画単位 1 つ」だが、D は描画単位が「面」（四角形）で、
 * 1 個のボクセルは 0〜6 枚の面になるため、数をそのまま比べられない（D はボクセル数も別に出す）。
 * E は三角形の数（地形・樹木・岩・雲・キャラクターの三角形 + 草の帯 5 枚 / 本 + 花の頭 10 枚 / 輪）。
 * F は E 側の三角形と C 側の円盤の合計（内訳は hybrid に別に出す）。
 */
const COUNT_UNIT: Record<RenderMethod, string> = { points: '粒', splats: 'スプラット', surfels: '円盤', voxels: '面', pixelmesh: '三角形', hybrid: '三角形+円盤' };

/** 描いた数（粒・スプラット・円盤・面） */
function drawnCount(v: SceneRenderer, m: RenderMethod): number {
  return m === 'splats' ? v.drawnSplats : m === 'surfels' ? v.drawnSurfels : m === 'voxels' ? v.drawnVoxelFaces : m === 'pixelmesh' ? v.drawnMeshTris : m === 'hybrid' ? v.drawnHybridTris + v.drawnHybridSurfels : v.drawnParticles;
}

/** 方式 F の内訳（E 側の三角形 / C 側の円盤。F 以外は null） */
function hybridCounts(v: SceneRenderer, m: RenderMethod) {
  const h = m === 'hybrid' ? v.hybrid : null;
  const br = h?.mesh.breakdown;
  return h && br ? { tris: v.drawnHybridTris, surfels: v.drawnHybridSurfels, surfelTotal: h.surfel?.worldTotal ?? 0, terrainTris: br.terrain, rockTris: br.objects, trunkTris: br.trunks, cloudTris: br.clouds, trunk: h.mesh.trunksVisible ? 'mesh' : 'surfel' } : null;
}

/** 方式 E のメッシュの内訳（E 以外は null） */
function meshCounts(v: SceneRenderer, m: RenderMethod) {
  const st = m === 'pixelmesh' ? v.pixelMesh?.stats : null;
  const br = m === 'pixelmesh' ? v.pixelMesh?.breakdown : null;
  return st && br ? { worldTris: st.worldTris, worldVerts: st.worldVerts, terrainTris: br.terrain, objectTris: br.objects, cloudTris: br.clouds, blades: v.pixelMesh!.drawnBlades, heads: st.heads, charTris: st.charTris, charVerts: st.charVerts } : null;
}

/** 方式 D のボクセル数（D 以外は null） */
function voxelCounts(v: SceneRenderer, m: RenderMethod) {
  const st = m === 'voxels' ? v.voxel?.stats : null;
  return st ? { solid: st.worldSolid + st.charSolid, surface: st.worldSurface + st.charSurface, faces: st.worldFaces + st.charFaces, groups: v.voxel!.drawnGroups } : null;
}

/** ツールの共通部分：開始時の設定・カメラを保存し、終了時に戻す */
abstract class BaseTool implements Tool {
  readonly pausesGame = true;
  protected readonly saved: RenderSettings;
  private readonly cam: { yaw: number; pitch: number; zoom: number; target: { x: number; y: number; z: number } };
  /** 比べる方式（A〜F すべて） */
  protected readonly methods: RenderMethod[] = [...RENDER_METHODS];

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
  /** 見下ろし角（ラジアン） */
  pitch?: number;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 同じカメラ・同じ描画解像度で A〜F を順に撮影して保存する */
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
    if (shot.pitch) this.host.game.camera.pitch = shot.pitch;
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
    const pitch = Math.round((this.host.game.camera.pitch * 180) / Math.PI);
    const name = `ppp-${this.time}-${METHOD_LABEL[shot.method]}-px${s.pixelScale}-${lr.w}x${lr.h}-zoom${zoom.toFixed(1)}-pitch${pitch}.png`;
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

export function methodShots(): Shot[] {
  return RENDER_METHODS.map((method) => ({ method }));
}

export function zoomShots(currentZoom: number): Shot[] {
  const zs = [Math.max(5, currentZoom * 0.5), currentZoom, Math.min(70, currentZoom * 2.2)];
  const out: Shot[] = [];
  for (const method of RENDER_METHODS) for (const zoom of zs) out.push({ method, zoom });
  return out;
}

/** 見下ろし角 3 段階（浅い角度では面の向きに沿った円盤が細くなり、隙間が出やすい） */
export function pitchShots(): Shot[] {
  const ps = [0.3, 0.7, 1.25];
  const out: Shot[] = [];
  for (const method of RENDER_METHODS) for (const pitch of ps) out.push({ method, pitch });
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
  /** 描いた数（単位は countUnit。方式ごとに異なる） */
  count: number;
  countUnit: string;
  /** 方式 D のボクセル数（占有 / 空気に面したもの / 面の総数 / 描いた向きの組） */
  voxels: { solid: number; surface: number; faces: number; groups: number } | null;
  /** 方式 E の三角形・頂点の内訳 */
  mesh: ReturnType<typeof meshCounts>;
  /** 方式 F の三角形・円盤の内訳 */
  hybrid: ReturnType<typeof hybridCounts>;
  frames: number;
}

/** カメラを回しながら A〜F それぞれの FPS・フレーム時間を測る */
export class BenchmarkTool extends BaseTool {
  private mi = 0;
  private frame = 0;
  private samples: { f: number[]; c: number[]; g: number[] } = { f: [], c: [], g: [] };
  private readonly results: BenchResult[] = [];
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
      count: drawnCount(v, method),
      countUnit: COUNT_UNIT[method],
      voxels: voxelCounts(v, method),
      mesh: meshCounts(v, method),
      hybrid: hybridCounts(v, method),
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
      .map((r) => `<tr><td>${METHOD_JA[r.method]}</td><td>${r.fps.toFixed(1)}</td><td>${r.frameMs.toFixed(2)}</td><td>${r.p95Ms.toFixed(2)}</td><td>${r.cpuMs.toFixed(2)}</td><td>${r.gpuMs === null ? '―' : r.gpuMs.toFixed(2)}</td><td>${r.count.toLocaleString()} ${r.countUnit}</td></tr>`)
      .join('');
    const vox = this.results.find((r) => r.voxels)?.voxels;
    const msh = this.results.find((r) => r.mesh)?.mesh;
    const hyb = this.results.find((r) => r.hybrid)?.hybrid;
    this.host.report(
      `<b>性能ベンチマーク</b>（カメラ回転中・各 ${BenchmarkTool.MEASURE} フレーム）<table><tr><th></th><th>FPS</th><th>平均ms</th><th>95%ms</th><th>CPUms</th><th>GPUms</th><th>数</th></tr>${rows}</table>` +
        `<div class="small">FPS は画面のリフレッシュレートで頭打ちになります。負荷の差は GPUms（GPU 時間）で比べてください</div>` +
        (vox ? `<div class="small">D の「数」は描いた面（四角形）の数で、粒・スプラット・円盤の数とは単位が違います（1 ボクセル = 0〜6 面）。D のボクセル：占有 ${vox.solid.toLocaleString()} / 表面 ${vox.surface.toLocaleString()} / 面の総数 ${vox.faces.toLocaleString()}</div>` : '') +
        (msh ? `<div class="small">E の「数」は三角形の数です。E のメッシュ：浮き島 ${msh.worldTris.toLocaleString()} 三角形（頂点 ${msh.worldVerts.toLocaleString()}）+ 草の帯 ${msh.blades.toLocaleString()} 本 + 花 ${msh.heads.toLocaleString()} 輪、キャラ ${msh.charTris.toLocaleString()} 三角形</div>` : '') +
        (hyb ? `<div class="small">F の「数」は E 側の三角形 ${hyb.tris.toLocaleString()}（地形 ${hyb.terrainTris.toLocaleString()} / 岩 ${hyb.rockTris.toLocaleString()} / 幹 ${hyb.trunk === 'mesh' ? hyb.trunkTris.toLocaleString() : '0（C 側）'} / 雲 ${hyb.cloudTris.toLocaleString()} / キャラ）+ C 側の円盤 ${hyb.surfels.toLocaleString()}（草花・葉${hyb.trunk === 'surfel' ? '・幹' : ''}）の合計です</div>` : '') +
        `<div class="small">${env.gpu}<br>キャンバス ${env.canvas} / 描画解像度 ${lr.w}×${lr.h} / DPR ${env.dpr}</div>`,
      { test: 'benchmark', env, lowRes: lr, settings: { pixelScale: this.saved.pixelScale, density: this.saved.density, splatSupersample: this.saved.splatSupersample, voxelSize: this.saved.voxelSize, voxelCharSize: this.saved.voxelCharSize, voxelDecor: this.saved.voxelDecor, voxelFlowers: this.saved.voxelFlowers, voxelCull: this.saved.voxelCull, meshDetail: this.saved.meshDetail, meshFlat: this.saved.meshFlat, meshGrass: this.saved.meshGrass, surfelScale: this.saved.surfelScale, hybridTrunk: this.saved.hybridTrunk }, results: this.results },
    );
    return false;
  }
}

// ---------------- 隙間・重ね塗り解析 ----------------

interface GapResult {
  method: RenderMethod;
  /** 基準シルエット（縮めたもの）の内側で、背景が見えている画素の割合（%） */
  gapPct: number;
  /** 基準シルエットの内側で、基準形状の表面より奥（DEPTH_GAP 以上）が見えている画素の割合（%）。深度の無い B は null */
  throughPct: number | null;
  /** 方式が物体として塗った画素の割合（画面全体に対する %） */
  coverPct: number;
  /** 画面 1 画素あたりのラスタライズされた断片数 / 色を書いた断片数 */
  rasterPerPx: number;
  writtenPerPx: number;
  /** 何かが描かれた画素 1 つあたりのラスタライズ断片数（深さ方向の重なり） */
  rasterPerCovered: number | null;
  /** 'measured' = GPU で実測 / 'estimated' = CPU で推定 */
  kind: 'measured' | 'estimated';
  drawn: number;
  drawnUnit: string;
}

/** 2 値画像を半径 r（4 近傍で r 回）だけ縮める */
function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        next[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w] ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * 隙間と重ね塗りの解析（静止状態で A〜F を順に描いて比べる）。
 * - 隙間：基準形状（簡易メッシュ）のシルエットを同じカメラ・描画解像度で描き、2 画素縮めた内側で、
 *   各方式が背景（空）になっている画素の割合。縮めるのは、簡易メッシュと粒の形の差（縁のずれ）を数えないため。
 * - 重ね塗り：A・C・D は計測用シェーダーで GPU 上の断片数を実測。B は Spark 内部のシェーダーなので推定。
 *   推定の確かさは、同じ推定式で A を計算して実測と比べた誤差で示す。
 */
export class GapTool extends BaseTool {
  private mi = 0;
  private frames = 0;
  private ref: Uint8Array | null = null;
  private refW = 0;
  private refH = 0;
  private aEstimate: { rasterized: number; pixels: number } | null = null;
  private refDepth: Float32Array | null = null;
  private readonly results: GapResult[] = [];
  private static readonly ERODE = 2;
  /** 基準形状より奥が見えていると判定する奥行きの差（ワールド単位）。簡易メッシュと粒の形の差より大きくとる */
  private static readonly DEPTH_GAP = 0.6;

  before() {
    this.apply({ renderMethod: this.methods[this.mi], viewMode: 'particles', wind: 0 });
  }

  after(): boolean {
    const method = this.methods[this.mi];
    const ready = this.splatReady(method);
    if (ready === 'fail') {
      this.failReport('隙間・重ね塗り解析');
      return false;
    }
    if (ready === 'wait') return true;
    this.frames++;
    if (!this.settled(this.frames, 8)) return true;
    const v = this.host.view, s = this.host.settings;
    if (!this.ref) {
      const r = v.readReferenceMask();
      if (!r) return true;
      const m = new Uint8Array(r.w * r.h);
      for (let i = 0; i < m.length; i++) m[i] = r.data[i * 4] > 127 ? 1 : 0;
      this.ref = erode(m, r.w, r.h, GapTool.ERODE);
      this.refW = r.w;
      this.refH = r.h;
      this.refDepth = v.readDepth('reference')?.depth ?? null;
    }
    const img = v.readLowRes(s, method, true);
    if (!img || img.w !== this.refW || img.h !== this.refH) return true;
    let inside = 0, gaps = 0, cover = 0;
    for (let i = 0; i < img.w * img.h; i++) {
      const obj = img.data[i * 4] > 127;
      if (obj) cover++;
      if (this.ref[i]) {
        inside++;
        if (!obj) gaps++;
      }
    }
    // 円盤・粒の隙間から奥の面が見えている画素（深度を書く A・C だけ）
    let throughPct: number | null = null;
    if (method !== 'splats' && this.refDepth) {
      const md = v.readDepth(method)?.depth;
      if (md && md.length === this.refDepth.length) {
        let inside2 = 0, through = 0;
        for (let i = 0; i < md.length; i++) {
          if (!this.ref[i] || !Number.isFinite(this.refDepth[i])) continue;
          inside2++;
          if (md[i] - this.refDepth[i] > GapTool.DEPTH_GAP) through++;
        }
        throughPct = inside2 ? (through / inside2) * 100 : 0;
      }
    }
    let raster = 0, written = 0, perCovered: number | null = null, kind: 'measured' | 'estimated' = 'measured', pixels = img.w * img.h;
    if (method === 'splats') {
      const e = v.estimateSplatFragments(s);
      if (e) {
        raster = e.rasterized;
        written = e.written;
        pixels = e.pixels;
      }
      kind = 'estimated';
    } else {
      const m = v.measureFragments(method);
      if (m) {
        raster = m.rasterized;
        written = m.written;
        pixels = m.pixels;
        perCovered = m.coveredPixels ? m.rasterized / m.coveredPixels : null;
      }
      if (method === 'points') this.aEstimate = v.estimatePointFragments(s);
    }
    this.results.push({
      method,
      gapPct: inside ? (gaps / inside) * 100 : 0,
      throughPct,
      coverPct: (cover / (img.w * img.h)) * 100,
      rasterPerPx: raster / pixels,
      writtenPerPx: written / pixels,
      rasterPerCovered: perCovered,
      kind,
      drawn: drawnCount(v, method),
      drawnUnit: COUNT_UNIT[method],
    });
    this.mi++;
    this.frames = 0;
    if (this.mi < this.methods.length) return true;

    const a = this.results.find((r) => r.method === 'points');
    const aErr = a && this.aEstimate ? ((this.aEstimate.rasterized / this.aEstimate.pixels - a.rasterPerPx) / a.rasterPerPx) * 100 : null;
    const rows = this.results
      .map((r) => `<tr><td>${METHOD_JA[r.method]}</td><td>${r.gapPct.toFixed(2)}%</td><td>${r.throughPct === null ? '―' : `${r.throughPct.toFixed(2)}%`}</td><td>${r.coverPct.toFixed(1)}%</td><td>${r.rasterPerPx.toFixed(2)}${r.kind === 'estimated' ? '*' : ''}</td><td>${r.writtenPerPx.toFixed(2)}${r.kind === 'estimated' ? '*' : ''}</td></tr>`)
      .join('');
    this.host.report(
      `<b>隙間・重ね塗り解析</b>（静止・風なし、描画解像度 ${this.refW}×${this.refH}）` +
        `<table><tr><th></th><th>空が見える</th><th>奥が見える</th><th>被覆</th><th>断片/画素</th><th>書込/画素</th></tr>${rows}</table>` +
        `<div class="small">空が見える：簡易メッシュのシルエットを ${GapTool.ERODE} 画素縮めた内側で、背景（空）が見えた画素の割合。<br>` +
        `奥が見える：同じ範囲で、見えている面が簡易メッシュの表面より ${GapTool.DEPTH_GAP} 以上奥にある画素の割合（隙間から奥の面が透けている）。` +
        `簡易メッシュは形の近似なので、隙間が無くても少し数えられる（方式 A の値が目安）。深度を書かない B は測れない（―）。<br>` +
        `断片/画素：画面 1 画素あたりのラスタライズされた断片数（深度テスト・破棄の前）。書込/画素：円・楕円の内側など実際に色を書く断片数。<br>` +
        `A・C・D・E・F は GPU で実測（F は E 側と C 側の断片の合計）。* は推定値（B は Spark 内部のため、投影した共分散から CPU で算出）。` +
        (aErr !== null ? `同じ推定式を A に当てた誤差は ${aErr >= 0 ? '+' : ''}${aErr.toFixed(1)}%。` : '') +
        `</div>`,
      { test: 'gap-overdraw', erodePx: GapTool.ERODE, depthGap: GapTool.DEPTH_GAP, zoom: this.host.game.camera.zoom, pitch: this.host.game.camera.pitch, lowRes: { w: this.refW, h: this.refH }, aEstimateErrorPct: aErr, results: this.results },
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
