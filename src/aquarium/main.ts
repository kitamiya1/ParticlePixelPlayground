// 水槽探検ゲーム（aquarium.html）の入口。描画方式の比較（index.html）とは別ページで、比較機能には手を入れない。
// 入力は既存の Input / TouchControls、描画は方式 F v2 の部品（PixelPipeline・SurfelRenderer・LIGHTING_CHUNK・
// MeshBuild の Surface Nets）を使う。

import '../style.css';
import './aquarium.css';
import { Input } from '../game/Input';
import { DEFAULT_SETTINGS, type RenderSettings } from '../settings';
import { isTouchDevice, TouchControls } from '../ui/TouchControls';
import { AquaCamera, CAMERA_MODE_LABEL } from './AquaCamera';
import { AquaLife } from './AquaLife';
import { buildAquariumMeshes, buildAquariumSurfels, buildCrabMesh, buildFindsMesh, buildFishMesh, buildGlowMesh, buildShrimpMesh } from './AquariumBuild';
import { AquariumRenderer } from './AquariumRenderer';
import { buildSpots, DiscoveryTracker, type Spot } from './AquariumSpots';
import { AquariumWorld, TANK } from './AquariumWorld';
import { CRAB_STATE_LABEL, CrabController } from './CrabController';
import { CrabRig } from './CrabRig';

/** 方式 F v2 の既定値を土台に、水槽用のパレット・光の段階を選ぶ */
function gameSettings(): RenderSettings {
  const narrow = Math.min(window.innerWidth, window.innerHeight) < 600;
  return {
    ...DEFAULT_SETTINGS,
    renderMethod: 'hybrid',
    palette: 'aquarium55',
    pixelScale: narrow ? 2 : 3,
    dither: 0.4,
    outline: 0.75,
    outlineThresh: 0.35,
    outlineDarken: 0.55,
    lightSteps: 4,
    ambient: 0.72,
    shadowStrength: 0.7,
    wind: 0.9,
    surfelScale: 1.05,
  };
}

function boot() {
  const t0 = performance.now();
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const settings = gameSettings();

  const world = new AquariumWorld();
  const crab = new CrabController(world);
  const rig = new CrabRig();
  const camera = new AquaCamera(world);
  camera.placeBehind(crab);
  const input = new Input(canvas);

  const built = buildAquariumMeshes(world);
  const plants = buildAquariumSurfels(world, built.light);
  const crabMesh = buildCrabMesh();
  // 探索：名前の付いた場所と発見物、小さな生き物
  const { spots, finds } = buildSpots(world);
  const tracker = new DiscoveryTracker(spots);
  const life = new AquaLife(world);
  const view = new AquariumRenderer(canvas, world, built.meshes, crabMesh, plants.set, rig, {
    finds,
    findsMesh: buildFindsMesh(finds, built.light),
    glowMesh: buildGlowMesh(finds),
    fishMesh: buildFishMesh(),
    shrimpMesh: buildShrimpMesh(),
    life,
  });
  const buildMs = performance.now() - t0;

  // ---------------- 画面の表示 ----------------
  const touch = isTouchDevice();
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
    <div class="card"><div class="title">水槽探検</div>
      <div class="row"><span class="place" id="h-place">—</span></div>
      <div class="row"><span class="tag" id="h-zone">水中</span><span class="tag cam" id="h-cam"></span><span id="h-state"></span></div>
      <div class="row"><span class="sub">発見</span><span id="h-found"></span></div>
      <div class="row"><span class="sub">遊泳</span><span class="bar"><i id="h-swim"></i></span></div>
      <div class="sub" id="h-perf"></div>
      <div class="sub"><a href="./index.html">描画方式の比較へ</a></div>
    </div>`;
  document.body.appendChild(hud);
  const $ = (id: string) => document.getElementById(id)!;
  const help = document.createElement('div');
  help.id = 'help';
  help.innerHTML = touch
    ? `<b>操作</b><br>左スティック：移動　ダッシュ：押している間<br>ジャンプ：跳ぶ（水中で長押し＝遊泳）<br>画面ドラッグ：視点回転　2 本指：ズーム<br>カメラ：冒険 / 箱庭の切り替え<br><span class="hint">光る石・湧く泡をたよりに、隠れた場所を探そう</span>`
    : `<b>操作</b><br><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移動　<kbd>Shift</kbd> 走る<br><kbd>Space</kbd> ジャンプ（水中で長押し＝遊泳）<br>ドラッグ：視点回転　ホイール：ズーム<br><kbd>V</kbd> カメラ切替　<kbd>R</kbd> スタート地点へ　<kbd>H</kbd> 説明を隠す<br><span class="hint">光る石・湧く泡をたよりに、隠れた場所を探そう。見晴らしの良い所で立ち止まると景色を眺めます</span>`;
  document.body.appendChild(help);
  if (touch) setTimeout(() => help.classList.add('fade'), 12000);
  const marker = document.createElement('div');
  marker.id = 'crab-marker';
  marker.textContent = 'カニ';
  document.body.appendChild(marker);

  // 場所の名前の表示（場所が変わったとき）と、初めて訪れた場所の発見の表示
  const banner = document.createElement('div');
  banner.id = 'place-banner';
  banner.innerHTML = `<div class="kicker"></div><div class="name"></div><div class="desc"></div>`;
  document.body.appendChild(banner);
  const vistaTag = document.createElement('div');
  vistaTag.id = 'vista-tag';
  vistaTag.textContent = '見晴らし — 景色を眺めています（動くと戻ります）';
  document.body.appendChild(vistaTag);
  let bannerT = 0;
  const showBanner = (spot: Spot, first: boolean) => {
    const hidden = spot.kind === 'hidden';
    banner.className = `show${first ? ' first' : ''}${hidden ? ' hidden' : ''}`;
    banner.querySelector('.kicker')!.textContent = first ? (hidden ? 'ひみつの場所を発見！' : '新しい場所') : '';
    banner.querySelector('.name')!.textContent = spot.name;
    banner.querySelector('.desc')!.textContent = first ? spot.desc : '';
    bannerT = first ? 4.2 : 2.0;
  };
  // 箱庭カメラ：訪れた場所の名前を水槽の上に並べる（全体を見返す）
  const labelRoot = document.createElement('div');
  labelRoot.id = 'spot-labels';
  document.body.appendChild(labelRoot);
  const labels = new Map<string, HTMLElement>();
  for (const sp of spots) {
    const el = document.createElement('div');
    el.className = `spot-label${sp.kind === 'hidden' ? ' hidden' : ''}`;
    el.textContent = sp.name;
    labelRoot.appendChild(el);
    labels.set(sp.id, el);
  }

  const toggleCamera = () => {
    camera.toggle();
    if (camera.mode === 'adventure') camera.placeBehind(crab);
  };
  input.onPress('KeyV', toggleCamera);
  input.onPress('KeyH', () => help.classList.toggle('fade'));
  input.onPress('KeyR', () => crab.teleport(world.spawn.x, world.spawn.z));
  // 自動検証用：発見の記録を消す
  const resetDiscovery = () => {
    tracker.visited.clear();
    tracker.current = null;
  };
  if (touch) {
    new TouchControls(input, { runLabel: 'ダッシュ', jump: true, onCamera: toggleCamera });
    document.body.classList.add('touch');
  }

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    view.setSize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)));
  };
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---------------- ループ ----------------
  // 自動検証用：freeze = true でゲームの更新を止める。step(n, dt) は通常のループと同じ処理を n 回まわす
  // （ブラウザのタブが裏にあって requestAnimationFrame が間引かれていても、実際の入力の状態で時間を進められる）
  const debug: { freeze: boolean; fps: number; step: (n: number, dt?: number) => void } = { freeze: false, fps: 0, step: () => {} };
  let time = 0;
  let last = performance.now();
  let acc = 0, frames = 0, hudT = 0;
  const tick = (dtRaw: number) => {
    const dt = debug.freeze ? 0 : Math.min(dtRaw, 0.05);
    time += dt;
    if (!debug.freeze) {
      crab.update(dt, { move: input.moveAxis(), run: input.isRunning(), jumpHeld: input.isJumpHeld(), cameraYaw: camera.yaw });
      camera.update(dt, input, crab);
      rig.update(dt, crab);
      life.update(dt, { x: crab.x, y: crab.y + crab.radius, z: crab.z });
      tracker.update(dt, crab.x, crab.y + crab.radius, crab.z);
      for (const e of tracker.drainEvents()) showBanner(e.spot, e.first);
      camera.setVista(tracker.current?.vista ?? null);
    }
    if (bannerT > 0) {
      bannerT -= dtRaw;
      if (bannerT <= 0) banner.classList.remove('show');
    }
    vistaTag.classList.toggle('show', camera.viewing);
    view.render(settings, camera, crab, time, dt);
    input.consume();

    // 箱庭カメラではカニの位置に印を出す
    if (camera.mode === 'diorama') {
      const p = view.project(crab.x, crab.y + 0.7, crab.z);
      marker.style.display = p ? 'block' : 'none';
      if (p) marker.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    } else marker.style.display = 'none';
    labelRoot.classList.toggle('show', camera.mode === 'diorama');
    if (camera.mode === 'diorama') {
      for (const sp of spots) {
        const el = labels.get(sp.id)!;
        const seen = tracker.visited.has(sp.id);
        const q = seen ? view.project(sp.c[0], sp.c[1] + sp.r[1] * 0.6, sp.c[2]) : null;
        el.style.display = q ? 'block' : 'none';
        if (q) el.style.transform = `translate(${q.x}px, ${q.y}px) translate(-50%, -100%)`;
      }
    }

    acc += dtRaw;
    frames++;
    hudT += dtRaw;
    if (acc >= 0.5) {
      debug.fps = frames / acc;
      acc = 0;
      frames = 0;
    }
    if (hudT > 0.15) {
      hudT = 0;
      const under = crab.y + crab.radius < TANK.waterY;
      const zone = $('h-zone');
      zone.textContent = under ? '水中' : '陸上';
      zone.classList.toggle('land', !under);
      $('h-cam').textContent = CAMERA_MODE_LABEL[camera.mode];
      const place = $('h-place');
      place.textContent = tracker.current ? tracker.current.name : '水槽のどこか';
      place.classList.toggle('hidden', tracker.current?.kind === 'hidden');
      $('h-found').textContent = `${tracker.visited.size} / ${tracker.total}　（ひみつ ${tracker.hiddenFound} / ${tracker.hiddenTotal}）`;
      $('h-state').textContent = CRAB_STATE_LABEL[crab.state];
      ($('h-swim') as HTMLElement).style.width = `${Math.round(crab.swimStamina * 100)}%`;
      $('h-perf').textContent = `${debug.fps.toFixed(0)} FPS ・ E ${(view.stats.tris / 1000).toFixed(0)}k 三角形 + C ${(view.stats.surfels / 1000).toFixed(0)}k 円盤`;
    }
  };
  debug.step = (n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) tick(dt);
  };
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dtRaw = (now - last) / 1000;
    last = now;
    tick(dtRaw);
  };
  loading.remove();
  requestAnimationFrame(loop);
  (window as unknown as Record<string, unknown>).__aqua = Object.assign(debug, { world, crab, rig, camera, view, settings, input, spots, finds, tracker, life, resetDiscovery, buildMs, buildPhases: built.ms, plantMs: plants.ms, plantCounts: plants.counts, plantTimes: plants.times });
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
