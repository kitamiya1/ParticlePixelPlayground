// 水槽探検ゲーム（aquarium.html）の入口。描画方式の比較（index.html）とは別ページで、比較機能には手を入れない。
// 入力は既存の Input / TouchControls、描画は方式 F v2 の部品（PixelPipeline・SurfelRenderer・LIGHTING_CHUNK・
// MeshBuild の Surface Nets）を使う。

import '../style.css';
import './aquarium.css';
import { Input } from '../game/Input';
import { DEFAULT_SETTINGS, type RenderSettings } from '../settings';
import { isTouchDevice, TouchControls } from '../ui/TouchControls';
import { AquaCamera, CAMERA_MODE_LABEL } from './AquaCamera';
import { buildAquariumMeshes, buildAquariumSurfels, buildCrabMesh } from './AquariumBuild';
import { AquariumRenderer } from './AquariumRenderer';
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
  const view = new AquariumRenderer(canvas, world, built.meshes, crabMesh, plants.set, rig);
  const buildMs = performance.now() - t0;

  // ---------------- 画面の表示 ----------------
  const touch = isTouchDevice();
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
    <div class="card"><div class="title">水槽探検</div>
      <div class="row"><span class="tag" id="h-zone">水中</span><span class="tag cam" id="h-cam"></span><span id="h-state"></span></div>
      <div class="row"><span class="sub">遊泳</span><span class="bar"><i id="h-swim"></i></span></div>
      <div class="sub" id="h-perf"></div>
      <div class="sub"><a href="./index.html">描画方式の比較へ</a></div>
    </div>`;
  document.body.appendChild(hud);
  const $ = (id: string) => document.getElementById(id)!;
  const help = document.createElement('div');
  help.id = 'help';
  help.innerHTML = touch
    ? `<b>操作</b><br>左スティック：移動　ダッシュ：押している間<br>ジャンプ：跳ぶ（水中で長押し＝遊泳）<br>画面ドラッグ：視点回転　2 本指：ズーム<br>カメラ：冒険 / 箱庭の切り替え`
    : `<b>操作</b><br><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移動　<kbd>Shift</kbd> 走る<br><kbd>Space</kbd> ジャンプ（水中で長押し＝遊泳）<br>ドラッグ：視点回転　ホイール：ズーム<br><kbd>V</kbd> カメラ切替　<kbd>R</kbd> スタート地点へ　<kbd>H</kbd> 説明を隠す`;
  document.body.appendChild(help);
  if (touch) setTimeout(() => help.classList.add('fade'), 12000);
  const marker = document.createElement('div');
  marker.id = 'crab-marker';
  marker.textContent = 'カニ';
  document.body.appendChild(marker);

  const toggleCamera = () => {
    camera.toggle();
    if (camera.mode === 'adventure') camera.placeBehind(crab);
  };
  input.onPress('KeyV', toggleCamera);
  input.onPress('KeyH', () => help.classList.toggle('fade'));
  input.onPress('KeyR', () => crab.teleport(world.spawn.x, world.spawn.z));
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
    }
    view.render(settings, camera, crab, time, dt);
    input.consume();

    // 箱庭カメラではカニの位置に印を出す
    if (camera.mode === 'diorama') {
      const p = view.project(crab.x, crab.y + 0.7, crab.z);
      marker.style.display = p ? 'block' : 'none';
      if (p) marker.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    } else marker.style.display = 'none';

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
  (window as unknown as Record<string, unknown>).__aqua = Object.assign(debug, { world, crab, rig, camera, view, settings, input, buildMs, buildPhases: built.ms, plantMs: plants.ms, plantCounts: plants.counts });
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
