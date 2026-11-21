import './style.css';
import { Game } from './game/Game';
import { MOVE_STATE_LABEL } from './game/CharacterController';
import { GpuTimer } from './render/GpuTimer';
import { SceneRenderer } from './render/SceneRenderer';
import { paletteById } from './render/palettes';
import { Panel } from './ui/Panel';
import { BenchmarkTool, CaptureTool, FlickerTool, GapTool, methodShots, pitchShots, zoomShots, type Tool, type ToolHost } from './ui/CompareTools';
import { METHOD_LETTER, METHOD_NAME, type RenderMethod } from './settings';
import { loadCurrent, saveCurrent } from './ui/presets';
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

  // デバッグ・自動検証用（最後のツール結果も置き、ブラウザ自動操作から読めるようにする）
  const debug: Record<string, unknown> = { lastReport: null };
  let shotRequested = false;
  // 比較・計測ツール（実行中はゲーム更新を止めて同条件で描き比べる）
  let tool: Tool | null = null;
  const host: ToolHost = {
    game,
    view,
    settings,
    canvas,
    report: (html, json) => {
      panel.setReport(html, json);
      debug.lastReport = json ?? null;
    },
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
    onCaptureAB: () => startTool(() => new CaptureTool(host, methodShots(), 'A〜F 同条件スクリーンショット'), '撮影中'),
    onCaptureZoom: () => startTool(() => new CaptureTool(host, zoomShots(game.camera.zoom), 'ズーム 3 段階スクリーンショット'), '撮影中'),
    onCapturePitch: () => startTool(() => new CaptureTool(host, pitchShots(), '見下ろし角 3 段階スクリーンショット'), '撮影中'),
    onGapAnalysis: () => startTool(() => new GapTool(host), '隙間・重ね塗りを解析中'),
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
  const compareTag = document.createElement('div');
  compareTag.id = 'compare-tag';
  document.getElementById('app')!.appendChild(compareTag);
  // 方式 B（Spark）の読み込み状態の表示
  const splatTag = document.createElement('div');
  splatTag.id = 'splat-status';
  splatTag.setAttribute('role', 'status');
  document.body.appendChild(splatTag);
  let splatShown = view.splatStatus;
  let splatLoadT0 = 0;
  const watchSplatLoad = () => {
    const st = view.splatStatus;
    if (st === 'loading') {
      if (splatShown !== 'loading') splatLoadT0 = performance.now();
      const sec = ((performance.now() - splatLoadT0) / 1000).toFixed(1);
      splatTag.textContent = `方式 B（Gaussian Splats）を読み込んでいます… ${sec} 秒　読み込みが終わるまで方式 A で表示します`;
      splatTag.className = 'show';
    } else if (st !== splatShown) {
      splatTag.className = '';
      if (st === 'ready' && splatShown === 'loading') panel.notify(`方式 B を読み込みました（${view.splatLoadMs.toFixed(0)} ms）`);
      if (st === 'error') {
        // 読み込みに失敗したら方式 A に戻し、次に B を選んだときに再試行できるようにする
        if (settings.renderMethod === 'splats') settings.renderMethod = 'points';
        if (settings.viewMode === 'compare' && (settings.compareLeft === 'splats' || settings.compareRight === 'splats')) settings.viewMode = 'particles';
        saveCurrent(settings);
        panel.sync();
        panel.setReport(`<b>方式 B の読み込みに失敗しました</b><br>方式 A で表示を続けています。もう一度 B を選ぶと再試行します（続けて失敗する場合はページを再読み込みしてください）。<div class="small">${escapeHtml(view.splatError)}</div>`);
        panel.notify('方式 B を読み込めませんでした。方式 A で続けます');
        view.resetSplatError();
      }
    }
    splatShown = view.splatStatus;
  };

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
    // debug.freeze（自動撮影用）：ゲームの更新を止め、dt = 0 で描く（キャラの姿勢・カメラ・時刻を撮影スクリプトが決めた値のまま保つ）
    const paused = (tool?.pausesGame ?? false) || debug.freeze === true;
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
      saveScreenshot(canvas, panel, settings.viewMode === 'compare' ? `${METHOD_LETTER[settings.compareLeft]}${METHOD_LETTER[settings.compareRight]}` : METHOD_LETTER[settings.renderMethod]);
    }
    const cpu = performance.now() - t0;
    if (tool && !tool.after({ frameMs: dtRaw * 1000, cpuMs: cpu, gpuMs: g })) {
      tool.finish();
      tool = null;
      document.body.classList.remove('tool-running');
    }
    // ツールが読み込み失敗を先に受け取れるよう、状態の監視（失敗時の A への切り戻し）はツールの後
    watchSplatLoad();

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
      const shown = view.shownMethods(settings);
      const methodLabel = settings.viewMode === 'mesh' ? '簡易メッシュ' : settings.viewMode === 'compare' ? `${METHOD_NAME[settings.compareLeft]} | ${METHOD_NAME[settings.compareRight]}` : METHOD_NAME[settings.renderMethod];
      const sf = view.surfel;
      const vx = view.voxel?.stats;
      const pm = view.pixelMesh?.stats;
      const hy = view.hybrid?.stats;
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
        <div><span>円盤の総数（C）</span><b>${sf ? (sf.worldTotal + sf.charTotal).toLocaleString() : '―'}</b></div>
        <div><span>描画中の円盤数（C）</span><b>${sf ? view.drawnSurfels.toLocaleString() : '―'}</b></div>
        <div><span>表面のボクセル数（D）</span><b>${vx ? (vx.worldSurface + vx.charSurface).toLocaleString() : '―'}</b></div>
        <div><span>描画中の面数（D）</span><b>${vx ? view.drawnVoxelFaces.toLocaleString() : '―'}</b></div>
        <div><span>描画中の三角形数（E）</span><b>${pm ? view.drawnMeshTris.toLocaleString() : '―'}</b></div>
        <div><span>描画中の三角形 / 円盤（F）</span><b>${hy ? `${view.drawnHybridTris.toLocaleString()} / ${view.drawnHybridSurfels.toLocaleString()}` : '―'}</b></div>
        <div><span>GPU 資源（テクスチャ / 形状）</span><b>${mem.textures} / ${mem.geometries}</b></div>
        <div><span>描画解像度</span><b>${settings.viewMode === 'mesh' ? 'ネイティブ' : `${lr.w}×${lr.h}`}</b></div>
        <div><span>パレット</span><b>${pal.colors.length ? `${pal.colors.length}色` : settings.palette === 'levels' ? `${settings.colorLevels ** 3}色` : '制限なし'}</b></div>
        <div><span>キャラクター</span><b>${MOVE_STATE_LABEL[game.character.state]}</b></div>
        <div class="small">${cats}<br>生成時間 ${visuals.buildMs.toFixed(0)} ms<br>B：Spark モジュール ${{ idle: '未読み込み', loading: '読み込み中', ready: `読み込み済み（${view.splatLoadMs.toFixed(0)} ms）`, error: '読み込み失敗' }[view.splatStatus]}${sp ? `<br>B：点群の用意 ${view.splatPrepMs.toFixed(0)} ms / Spark 構築 ${view.splatBuildMs.toFixed(0)} ms（構築 ${view.splatRebuilds} 回目）<br>B：キャラ ${sp.charTotal.toLocaleString()} スプラット（SplatSkinning ${settings.splatSource === 'sdf' ? '2 ボーン重み' : '1 ボーン'}）` : ''}${sf ? `<br>C：構築 ${view.surfelBuildMs.toFixed(0)} ms（構築 ${view.surfelRebuilds} 回目）、Spark 不使用` : ''}${vx ? `<br>D：浮き島 一辺 ${settings.voxelSize} / 占有 ${vx.worldSolid.toLocaleString()} / 表面 ${vx.worldSurface.toLocaleString()} / 面 ${vx.worldFaces.toLocaleString()}（生成 ${vx.worldBuildMs.toFixed(0)} ms、${view.voxelRebuilds} 回目）<br>D：キャラ 一辺 ${settings.voxelCharSize} / 占有 ${vx.charSolid.toLocaleString()} / 面 ${vx.charFaces.toLocaleString()}（生成 ${vx.charBuildMs.toFixed(0)} ms）、面の組 ${view.voxel!.drawnGroups}/6 を描画<br>D の「面」は四角形の数で、A〜C の粒数とは単位が違います` : ''}${pm ? `<br>E：浮き島 格子 ${pm.detail} / ${pm.worldTris.toLocaleString()} 三角形・${pm.worldVerts.toLocaleString()} 頂点 + 草の帯 ${view.pixelMesh!.drawnBlades.toLocaleString()}/${(pm.blades).toLocaleString()} 本 + 花 ${pm.heads.toLocaleString()} 輪（生成 ${pm.worldBuildMs.toFixed(0)} ms、${view.meshRebuilds} 回目）<br>E：キャラ ${pm.charTris.toLocaleString()} 三角形（生成 ${pm.charBuildMs.toFixed(0)} ms）。E の数は三角形で、A〜D とは単位が違います` : ''}${hy ? `<br>F：E 側 ${hy.meshTris.toLocaleString()} 三角形（地形・岩・雲・キャラ${hy.trunk === 'mesh' ? '・幹' : ''}。生成 ${view.hybrid!.mesh.stats?.worldBuildMs.toFixed(0) ?? '―'} ms、${view.hybridRebuilds} 回目）+ C 側 ${hy.surfels.toLocaleString()}/${hy.surfelTotal.toLocaleString()} 円盤（草花・葉${hy.trunk === 'surfel' ? '・幹' : ''}。構築 ${hy.surfelBuildMs.toFixed(0)} ms、${view.hybrid!.surfelRebuilds} 回目）` : ''}</div>`);
      modeTag.textContent = game.camera.viewing ? '鑑賞モード' : '';
      modeTag.style.display = game.camera.viewing ? 'block' : 'none';
      document.body.classList.toggle('split', settings.viewMode === 'split');
      document.body.classList.toggle('compare', settings.viewMode === 'compare');
      // 左右比較の見出し（読み込み中の B は A で代わりに描いていることも示す）
      compareTag.style.display = settings.viewMode === 'compare' ? 'flex' : 'none';
      if (settings.viewMode === 'compare') {
        const label = (want: typeof settings.renderMethod, got: typeof settings.renderMethod) => (want === got ? METHOD_NAME[want] : `${METHOD_NAME[want]}（読み込み中は A）`);
        compareTag.innerHTML = `<span>${label(settings.compareLeft, shown[0])}</span><span>${label(settings.compareRight, shown[1] ?? shown[0])}</span>`;
      }
    }
  };
  loading.remove();
  requestAnimationFrame(loop);

  // デバッグ・自動検証用
  // runTool：比較ツールを方式を絞って起動する（自動計測用。結果は lastReport に入る）
  const runTool = (kind: 'benchmark' | 'flicker' | 'gap', methods?: RenderMethod[]) => {
    debug.lastReport = null;
    const make = kind === 'benchmark' ? () => new BenchmarkTool(host) : kind === 'flicker' ? () => new FlickerTool(host) : () => new GapTool(host);
    startTool(() => (methods ? make().onlyMethods(methods) : make()), '自動計測中');
  };
  (window as unknown as Record<string, unknown>).__ppp = Object.assign(debug, { game, view, settings, runTool });
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function saveScreenshot(canvas: HTMLCanvasElement, panel: Panel, letter: string) {
  // 描画直後（同じタスク内）なら preserveDrawingBuffer なしでも内容を取得できる
  canvas.toBlob((blob) => {
    if (!blob) return panel.notify('スクリーンショットに失敗しました');
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `particle-pixel-${letter}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
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
