import './style.css';
import { Game } from './game/Game';
import { MOVE_STATE_LABEL } from './game/CharacterController';
import { GpuTimer } from './render/GpuTimer';
import { SceneRenderer } from './render/SceneRenderer';
import { paletteById } from './render/palettes';
import { Panel } from './ui/Panel';
import { BenchmarkTool, CaptureTool, FlickerTool, abShots, zoomShots, type Tool, type ToolHost } from './ui/CompareTools';
import { loadCurrent } from './ui/presets';
import { isTouchDevice, TouchControls } from './ui/TouchControls';
import { buildWorldVisuals } from './visual/WorldVisualBuilder';

function boot() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const settings = loadCurrent();

  // ゲームロジック（描画非依存）
  const game = new Game(canvas);
  // 見た目（粒とメッシュ）の生成
  const visuals = buildWorldVisuals(game.layout);
  const view = new SceneRenderer(canvas, visuals);

  let shotRequested = false;
  // 比較・計測ツール（実行中はゲーム更新を止めて同条件で描き比べる）
  let tool: Tool | null = null;
  const host: ToolHost = {
    game,
    view,
    settings,
    canvas,
    report: (html, json) => panel.setReport(html, json),
    notify: (m) => panel.notify(m),
    syncUI: () => panel.sync(),
  };
  const startTool = (make: () => Tool, msg: string) => {
    if (tool) return panel.notify('計測中です。終わるまでお待ちください');
    tool = make();
    panel.setReport(`${msg}…`);
    document.body.classList.add('tool-running');
  };
  const panel = new Panel(settings, {
    onScreenshot: () => (shotRequested = true),
    onToggleViewing: () => game.toggleViewing(),
    onToggleAutoRotate: () => (game.camera.autoRotate = !game.camera.autoRotate),
    onCaptureAB: () => startTool(() => new CaptureTool(host, abShots(), 'A/B 同条件スクリーンショット'), '撮影中'),
    onCaptureZoom: () => startTool(() => new CaptureTool(host, zoomShots(game.camera.zoom), 'ズーム 3 段階スクリーンショット'), '撮影中'),
    onFlickerTest: () => startTool(() => new FlickerTool(host), 'ちらつき計測中（約 5 秒）'),
    onBenchmark: () => startTool(() => new BenchmarkTool(host), 'ベンチマーク中（約 10 秒）'),
  });
  game.input.onPress('KeyV', () => panel.setViewingLabel(game.toggleViewing()));
  game.input.onPress('KeyH', () => panel.toggle());
  game.input.onPress('KeyP', () => (shotRequested = true));

  const touch = isTouchDevice();
  if (touch) {
    new TouchControls(game.input);
    document.body.classList.add('touch');
  }
  const help = document.createElement('div');
  help.id = 'help';
  help.innerHTML = touch
    ? `
    <b>操作</b><br>
    左下スティック：移動　走る：押している間走る<br>
    1本指ドラッグ：カメラ回転　2本指：ズーム・視点移動<br>
    右上「設定」：パネル表示`
    : `
    <b>操作</b><br>
    WASD：移動　Shift：走る<br>
    左ドラッグ：カメラ回転　ホイール：ズーム<br>
    V：鑑賞モード（WASD / 右ドラッグで視点移動）<br>
    P：スクリーンショット　H：パネル表示切替`;
  document.body.appendChild(help);
  // タッチ端末では画面が狭いので、操作説明はしばらくしたら消す
  if (touch) setTimeout(() => help.classList.add('fade'), 9000);
  const modeTag = document.createElement('div');
  modeTag.id = 'mode-tag';
  document.body.appendChild(modeTag);

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    view.setSize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)));
  };
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(canvas);
  resize();

  const cats = [...visuals.categories.entries()].map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' / ');
  let last = performance.now();
  let acc = 0, frames = 0, cpuAcc = 0, fps = 0, frameMs = 0, cpuMs = 0, statT = 0;
  const gpu = new GpuTimer(view.renderer.getContext() as WebGL2RenderingContext);
  let gpuAcc = 0, gpuN = 0, gpuMs = -1;

  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dtRaw = (now - last) / 1000;
    last = now;
    const dt = Math.min(dtRaw, 0.05);
    const t0 = performance.now();
    const paused = tool?.pausesGame ?? false;
    if (!paused) game.update(dt);
    else game.input.consume(); // 計測中の入力は捨てる（カメラを動かさない）
    tool?.before();
    gpu.begin();
    view.render(game, settings, paused ? 0 : dt);
    gpu.end();
    const g = gpu.poll();
    if (g !== null) {
      gpuAcc += g;
      gpuN++;
    }
    if (shotRequested) {
      shotRequested = false;
      saveScreenshot(canvas, panel, settings.renderMethod);
    }
    const cpu = performance.now() - t0;
    if (tool && !tool.after({ frameMs: dtRaw * 1000, cpuMs: cpu, gpuMs: g })) {
      tool.finish();
      tool = null;
      document.body.classList.remove('tool-running');
    }

    acc += dtRaw;
    cpuAcc += cpu;
    frames++;
    statT += dtRaw;
    if (acc >= 0.5) {
      fps = frames / acc;
      frameMs = (acc / frames) * 1000;
      cpuMs = cpuAcc / frames;
      gpuMs = gpuN ? gpuAcc / gpuN : -1;
      gpuAcc = 0;
      gpuN = 0;
      acc = 0; frames = 0; cpuAcc = 0;
    }
    if (statT > 0.25) {
      statT = 0;
      const lr = view.lowResolution;
      const pal = paletteById(settings.palette);
      const sp = view.splat;
      const mem = view.renderer.info.memory;
      const methodLabel = settings.viewMode === 'mesh' ? '簡易メッシュ' : settings.viewMode === 'compare' ? 'A/B 左右比較' : settings.renderMethod === 'splats' ? 'B：Gaussian Splats' : 'A：ポイント描画';
      panel.setStats(`
        <div class="big"><span>描画方式</span><b class="method">${methodLabel}</b></div>
        <div class="big"><span>FPS</span><b>${fps.toFixed(1)}</b></div>
        <div class="big"><span>フレーム時間</span><b>${frameMs.toFixed(2)} ms</b></div>
        <div><span>CPU処理（更新+描画命令）</span><b>${cpuMs.toFixed(2)} ms</b></div>
        <div><span>GPU処理時間</span><b>${gpu.supported ? (gpuMs >= 0 ? `${gpuMs.toFixed(2)} ms` : '計測中') : '非対応'}</b></div>
        <div><span>粒の総数（A）</span><b>${(view.worldTotal + view.charTotal).toLocaleString()}</b></div>
        <div><span>描画中の粒数（A）</span><b>${view.drawnParticles.toLocaleString()}</b></div>
        <div><span>スプラットの総数（B）</span><b>${sp ? (sp.worldTotal + sp.charTotal).toLocaleString() : '―'}</b></div>
        <div><span>描画中のスプラット数（B）</span><b>${sp ? view.drawnSplats.toLocaleString() : '―'}</b></div>
        <div><span>GPU 資源（テクスチャ / 形状）</span><b>${mem.textures} / ${mem.geometries}</b></div>
        <div><span>描画解像度</span><b>${settings.viewMode === 'mesh' ? 'ネイティブ' : `${lr.w}×${lr.h}`}</b></div>
        <div><span>パレット</span><b>${pal.colors.length ? `${pal.colors.length}色` : settings.palette === 'levels' ? `${settings.colorLevels ** 3}色` : '制限なし'}</b></div>
        <div><span>キャラクター</span><b>${MOVE_STATE_LABEL[game.character.state]}</b></div>
        <div class="small">${cats}<br>生成時間 ${visuals.buildMs.toFixed(0)} ms${sp ? `<br>B：点群の用意 ${view.splatPrepMs.toFixed(0)} ms / Spark 構築 ${view.splatBuildMs.toFixed(0)} ms（構築 ${view.splatRebuilds} 回目）<br>B：キャラ ${sp.charTotal.toLocaleString()} スプラット（SplatSkinning ${settings.splatSource === 'sdf' ? '2 ボーン重み' : '1 ボーン'}）` : ''}</div>`);
      modeTag.textContent = game.camera.viewing ? '鑑賞モード' : '';
      modeTag.style.display = game.camera.viewing ? 'block' : 'none';
      document.body.classList.toggle('split', settings.viewMode === 'split');
      document.body.classList.toggle('compare', settings.viewMode === 'compare');
    }
  };
  loading.remove();
  requestAnimationFrame(loop);

  // デバッグ・自動検証用
  (window as unknown as Record<string, unknown>).__ppp = { game, view, settings };
}

function saveScreenshot(canvas: HTMLCanvasElement, panel: Panel, method: string) {
  // 描画直後（同じタスク内）なら preserveDrawingBuffer なしでも内容を取得できる
  canvas.toBlob((blob) => {
    if (!blob) return panel.notify('スクリーンショットに失敗しました');
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `particle-pixel-${method === 'splats' ? 'B' : 'A'}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    panel.notify('スクリーンショットを保存しました');
  }, 'image/png');
}

// 読み込み表示を先に描画させてから重い生成処理に入る
setTimeout(() => {
  try {
    boot();
  } catch (e) {
    const l = document.getElementById('loading');
    if (l) l.textContent = `初期化に失敗しました：${(e as Error).message}`;
    throw e;
  }
}, 50);
