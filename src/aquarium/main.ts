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
import { buildAquariumMeshes, buildAquariumSurfels, buildBuddyMesh, buildBurrowMesh, buildCrabMesh, buildFindsMesh, buildFishMesh, buildGlowMesh, buildShrimpMesh } from './AquariumBuild';
import { BUDDY_DESC, BUDDY_ID, BUDDY_NAME, BuddySystem, type BuddyPrompt } from './AquaBuddy';
import { AquariumRenderer } from './AquariumRenderer';
import { buildSpots, DiscoveryTracker, type Spot } from './AquariumSpots';
import { AquariumWorld } from './AquariumWorld';
import { REGION_LABEL, SUMP } from './AquariumStand';
import { CRAB_STATE_LABEL, CrabController } from './CrabController';
import { DIG, DIG_MATERIAL_LABEL, diggable } from './AquariumDig';
import { CrabRig } from './CrabRig';
import { ROOM } from './AquariumStand';
import { TANK } from './aquaConst';
import { SAVE_FORMAT, SAVE_VERSION, SaveStore, type LoadResult, type SaveContext, type SaveData } from './AquaSave';
import { AutoSaver, SaveMenu } from './AquaSaveUi';

/** いまの水槽の id（保存データの tanks の鍵。将来の隣の水槽は別の id） */
const HOME_TANK = 'home';
/**
 * スナモグリの巣穴（砂の広場の手前の砂。スタート地点から西へ約 6、手前のガラスから 1.6。水中の砂。
 * 排水管の縦の管（x −6.5, z 5.6）・エビの住みかから離す）
 */
const BURROW_XZ: [number, number] = [-9.4, 8.4];
/** 調べたかの印（progress.flags） */
const FLAG_EXAMINED = 'burrow.examined';

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

async function boot() {
  const t0 = performance.now();
  // 保存先は重い生成と並行して開く（IndexedDB を開くのは非同期）
  // ?nosave：保存せず、保存データも読まない（自動検証が同じブラウザの中で前のページの穴を持ち込まないように）
  const noSave = new URLSearchParams(location.search).has('nosave');
  const storeP = SaveStore.open({ memory: noSave });
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const settings = gameSettings();

  const world = new AquariumWorld();
  const crab = new CrabController(world);
  const rig = new CrabRig();
  const camera = new AquaCamera(world);
  camera.placeBehind(crab);
  const input = new Input(canvas);
  // マウスの右ボタン：押したままずらして掘る（照準）
  input.mouseDig = true;

  const built = buildAquariumMeshes(world);
  const plants = buildAquariumSurfels(world, built.light);
  const crabMesh = buildCrabMesh();
  // 探索：名前の付いた場所と発見物、小さな生き物
  const { spots, finds } = buildSpots(world);
  // 発見物（貝殻・光る石・泡の湧く所）のまわりは掘らない（掘ると宙に浮くので）
  for (const f of finds) world.dig.protectPoint(f.pos[0], f.pos[1], f.pos[2], 0.45 + 0.25 * f.scale);
  const tracker = new DiscoveryTracker(spots);
  const life = new AquaLife(world);
  // 最初の仲間：砂の広場の端の巣穴に隠れているスナモグリ（巣穴のまわりは掘らない：掘ると穴ごと崩れるので）
  const buddy = new BuddySystem(world, BURROW_XZ);
  world.dig.protectPoint(buddy.burrow[0], buddy.burrow[1], buddy.burrow[2], 0.75);
  const view = new AquariumRenderer(canvas, world, built.meshes, crabMesh, plants.set, rig, {
    finds,
    findsMesh: buildFindsMesh(finds, built.light),
    glowMesh: buildGlowMesh(finds),
    fishMesh: buildFishMesh(),
    shrimpMesh: buildShrimpMesh(),
    life,
    buddy: { sys: buddy, mesh: buildBuddyMesh(), burrowMesh: buildBurrowMesh(world, built.light, BURROW_XZ[0], BURROW_XZ[1]) },
  }, { light: built.light, plantAnchors: plants.anchors });
  const buildMs = performance.now() - t0;

  // ---------------- 画面の表示 ----------------
  const touch = isTouchDevice();
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
    <div class="card"><div class="title">水槽探検</div>
      <div class="row"><span class="place" id="h-place">—</span></div>
      <div class="row"><span class="tag" id="h-zone">水中</span><span class="tag cam" id="h-cam"></span><span id="h-state"></span><span class="tag dig off" id="h-dig"></span></div>
      <div class="row"><span class="sub">発見</span><span id="h-found"></span></div>
      <div class="row"><span class="sub">遊泳</span><span class="bar"><i id="h-swim"></i></span></div>
      <div class="sub" id="h-perf"></div>
      <div class="sub" id="h-digperf"></div>
      <div class="sub"><a href="./index.html">描画方式の比較へ</a></div>
    </div>`;
  document.body.appendChild(hud);
  const $ = (id: string) => document.getElementById(id)!;
  const help = document.createElement('div');
  help.id = 'help';
  help.innerHTML = touch
    ? `<b>操作</b><br>左スティック：移動　ダッシュ：押している間<br>ジャンプ：跳ぶ（水中で長押し＝遊泳。壁では離れる）<br>壁登り：岩・流木・土の壁へスティックを倒し続けると張り付く（壁へ＝上、手前＝下、左右＝横。離すとその場で止まる）<br>掘る：押している間 前の砂を掘る。押したまま指をずらすと、その向き（上・下・左右・斜め）を掘る。掘りながらスティックで好きな向きへ動ける<br>画面ドラッグ：視点回転　2 本指：ズーム<br>カメラ：冒険 / ガラス越し（水槽の外から地下の穴を観察）/ 箱庭の切り替え<br>調べる / 引っこ抜く：穴のそばで出るボタン（引っこ抜くは長押し。離すとやめる）<br>仲間：右上のボタンで「呼ぶ（同行）/ 自由に暮らす」を切り替え<br>右上の「セーブ」：進捗は自動で保存（書き出し・読み込み・初期状態に戻す）<br><span class="hint">光る石・湧く泡をたよりに、隠れた場所を探そう。水面の丸い穴は、水槽の下へ続いている。岸辺の斜面の砂は深く、トンネルを掘れる</span>`
    : `<b>操作</b><br><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移動　<kbd>Shift</kbd> 走る<br><kbd>Space</kbd> ジャンプ（水中で長押し＝遊泳。壁では離れる）<br>壁登り：岩・流木・土の壁へ押し続けると張り付く（壁へ＝上、手前＝下、左右＝横。離すとその場で止まる）<br><kbd>F</kbd> 長押し：掘る（押したままマウスを動かすと上下左右・斜めを狙う。掘りながら <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> で好きな向きへ動ける）<br>右ボタンを押したままドラッグ：その向きを掘る<br>ドラッグ：視点回転　ホイール：ズーム<br><kbd>V</kbd> カメラ切替（冒険 / ガラス越し / 箱庭。ガラス越しはガラス際まで掘った穴を外から観察）<kbd>R</kbd> スタート地点へ　<kbd>H</kbd> 説明を隠す<br><kbd>E</kbd> 調べる（穴のそばで）・長押しで引っこ抜く（離すとやめる）　<kbd>Q</kbd> 仲間を呼ぶ / 自由に暮らす（右上のボタンでも）<br>右上の「セーブ」：進捗は自動で保存（書き出し・読み込み・初期状態に戻す）<br><span class="hint">光る石・湧く泡をたよりに、隠れた場所を探そう。見晴らしの良い所で立ち止まると景色を眺めます。水面の丸い穴は、水槽の下へ続いている。岸辺の斜面の砂は深く、トンネルを掘れる</span>`;
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
  const showBanner = (spot: Spot, first: boolean, parentFirst?: Spot) => {
    const hidden = spot.kind === 'hidden';
    banner.className = `show${first ? ' first' : ''}${hidden ? ' hidden' : ''}`;
    // 親の場所（濾過槽）を初めて訪れたときは、親の名前も添える
    const kick = first ? (hidden ? 'ひみつの場所を発見！' : '新しい場所') : '';
    banner.querySelector('.kicker')!.textContent = parentFirst ? `${kick}（${parentFirst.name}）` : kick;
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
    camera.toggle(crab);
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
  // 自動検証用：名前の付いた地点へ移す（x, z, 探し始める高さ）
  const S = world.stand;
  const places: Record<string, [number, number, number]> = {
    spawn: [world.spawn.x, world.spawn.z, 13],
    mouth: [S.drainAxis[0] + 1.4, S.drainAxis[1], 5.2],
    sumpDrop: [-7.5, 2.0, -8.0],
    sumpMedia: [3.2, 4.4, -7.9],
    basketTop: [3.2, 6.2, -7.0],
    pump: [6.6, -2.4, -8.6],
    stand: [12, 9.5, -6],
    room: [8, 16, -11],
    lookUp: [-3, 38, -11],
    log: [(world.landmarks.logA[0] + world.landmarks.logB[0]) / 2, (world.landmarks.logA[2] + world.landmarks.logB[2]) / 2, world.landmarks.logA[1]],
    burrow: [BURROW_XZ[0] + 0.6, BURROW_XZ[1], 6],
  };
  const goto = (name: string) => {
    const p = places[name];
    if (p) crab.teleport(p[0], p[1], world.contactSurfaceBelow(p[0], p[2], p[1]) + 0.02);
    return crab.region;
  };
  let touchUi: TouchControls | null = null;
  if (touch) {
    touchUi = new TouchControls(input, { runLabel: 'ダッシュ', jump: true, dig: true, onCamera: toggleCamera, act: true });
    document.body.classList.add('touch');
  }

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    view.setSize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)));
  };
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---------------- セーブ（読み込み・復元・自動保存） ----------------
  // 右上のメニュー（セーブ・仲間）と、短い知らせ
  const menu = document.createElement('div');
  menu.id = 'menu';
  document.body.appendChild(menu);
  const toastEl = document.createElement('div');
  toastEl.id = 'aqua-toast';
  document.body.appendChild(toastEl);
  let toastTimer = 0;
  const toast = (msg: string) => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
  };
  const M = 1.5;
  const saveCtx: SaveContext = {
    spotIds: new Set(spots.map((s) => s.id)),
    buddyIds: new Set([BUDDY_ID]),
    tankIds: new Set([HOME_TANK]),
    maxPrims: DIG.maxPrims,
    maxR: DIG.rMax,
    tankBox: { min: [TANK.minX - M, TANK.floorY - M, TANK.minZ - M], max: [TANK.maxX + M, TANK.topY + M, TANK.maxZ + M] },
    worldBox: { min: [ROOM.minX, ROOM.floorY - 1, ROOM.minZ], max: [ROOM.maxX, ROOM.ceilY, ROOM.maxZ] },
  };
  loading.textContent = '保存データを読み込んでいます…';
  const store = await storeP;
  const tLoad = performance.now();
  let loaded: LoadResult;
  try {
    loaded = await store.load(saveCtx);
  } catch (e) {
    loaded = { status: 'corrupt', error: (e as Error).message };
  }
  const loadMs = performance.now() - tLoad;
  let created = Date.now();
  let playTime = 0;
  const flags: Record<string, boolean> = {};
  const restoreInfo = { status: loaded.status, prims: 0, restoreMs: 0, flushMs: 0, loadMs, playerFallback: false };
  if (loaded.status === 'ok' || loaded.status === 'recovered') {
    const d = loaded.data;
    created = d.created;
    playTime = d.playTime;
    Object.assign(flags, d.progress.flags);
    // 掘った穴：空洞を戻し、最初のフレームより前に区画をすべて作り直して当たり判定へ入れる（見た目と同時）
    const tr = performance.now();
    const tank = d.tanks[HOME_TANK];
    if (tank) restoreInfo.prims = world.dig.restore(tank.dig.prims);
    const tf = performance.now();
    await view.digFx.flushAllAsync((done, total) => (loading.textContent = `掘った穴を復元しています… ${done} / ${total} 区画`));
    restoreInfo.flushMs = performance.now() - tf;
    restoreInfo.restoreMs = performance.now() - tr;
    for (const id of d.progress.visited) tracker.visited.add(id);
    // 仲間：見つけた・自由 / 同行・位置（調べたかは flags）。仲間になる前なら巣穴の中のまま
    const bs = d.buddies.find((b) => b.id === BUDDY_ID);
    if (bs) buddy.restore(bs, !!flags[FLAG_EXAMINED]);
    else buddy.examined = !!flags[FLAG_EXAMINED];
    // プレイヤー：保存した位置が固体の中なら（あり得ないが）スタート地点へ
    const P = d.player;
    if (world.contactSolid(P.x, P.y + crab.radius, P.z) > crab.radius * 0.5) {
      crab.teleport(P.x, P.z, P.y);
      crab.heading = P.heading;
    } else {
      restoreInfo.playerFallback = true;
      crab.teleport(world.spawn.x, world.spawn.z);
    }
    camera.placeBehind(crab);
    for (let i = 0; i < 3 && camera.mode !== P.camera; i++) camera.toggle(crab);
  }
  const bootNote =
    loaded.status === 'recovered' ? `保存データが壊れていたため、1 つ前のデータから再開しました（${loaded.error}）。壊れたデータは別に残しています。`
    : loaded.status === 'corrupt' ? `保存データを読み込めなかったため、初期状態で始めました（${loaded.error}）。読めなかったデータは別に残しています。`
    : store.info.fromJournal ? '前回は閉じる・読み込み直す直前の保存が終わらなかったため、その直前の控えから再開しました（進捗は失われていません）。'
    : store.info.orphan ? '前回閉じる直前の進捗（控え）は、別のタブの保存の方が新しかったため使いませんでした。「使わなかった進捗を書き出す」でファイルに残せます。'
    : noSave ? '自動検証のため保存しません（?nosave）。'
    : null;
  // 知らせは利用者が気にすべきときだけ（控えから戻したのは、再読み込み・タブを閉じたときのふつうの流れなので出さない）
  const bootToast = loaded.status === 'recovered' ? '保存データを 1 つ前から復元しました' : loaded.status === 'corrupt' ? '保存データを読めず、初期状態で始めました' : store.info.orphan ? '使わなかった進捗があります（セーブのメニュー）' : null;
  if (bootToast && !noSave) setTimeout(() => toast(bootToast), 600);
  const gather = (): SaveData => ({
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    created,
    savedAt: Date.now(),
    playTime,
    // 世代と識別子は SaveStore が書くときに付ける
    rev: 0,
    saveId: '',
    player: { tank: HOME_TANK, x: crab.x, y: crab.y, z: crab.z, heading: crab.heading, camera: camera.mode },
    progress: { visited: [...tracker.visited], flags: { ...flags, [FLAG_EXAMINED]: buddy.examined } },
    tanks: { [HOME_TANK]: { dig: { prims: world.dig.exportPrims() } } },
    buddies: [buddy.toSave()],
  });
  const saver = new AutoSaver(store, gather);
  const saveMenu = new SaveMenu(menu, { saver, ctx: saveCtx, bootNote, toast });
  // 控えから戻したときは、すぐ保存先（IndexedDB）へ書く
  if (store.info.fromJournal) saver.markImportant();
  // ---------------- 仲間（スナモグリ） ----------------
  // 右上の「仲間」ボタン（見つけた後だけ出る）：押すと自由生活 ↔ 同行。PC は Q キーでも
  const buddyBtn = document.createElement('button');
  buddyBtn.type = 'button';
  buddyBtn.className = 'menu-btn buddy';
  menu.insertBefore(buddyBtn, menu.firstChild);
  const showBuddyBtn = () => {
    buddyBtn.style.display = buddy.found ? '' : 'none';
    // 縦長の画面では名前の代わりに「仲間」と短く出す（CSS で切り替え）
    buddyBtn.innerHTML = `<span class="nm">${BUDDY_NAME}</span><span class="nm2">仲間</span>：${buddy.mode === 'follow' ? '同行中' : '自由'}`;
    buddyBtn.classList.toggle('on', buddy.mode === 'follow');
  };
  const toggleBuddy = () => {
    const m = buddy.toggleMode();
    if (!m) return;
    toast(m === 'follow' ? `${BUDDY_NAME}がついてきます` : `${BUDDY_NAME}はこの辺りで自由に暮らします`);
    showBuddyBtn();
  };
  buddyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  buddyBtn.addEventListener('click', toggleBuddy);
  input.onPress('KeyQ', toggleBuddy);
  showBuddyBtn();
  // 巣穴の案内（近くで出る：調べる / 長押しで引っこ抜く。引っ張っている間は進み具合）
  const prompt = document.createElement('div');
  prompt.id = 'act-prompt';
  prompt.innerHTML = `<div class="who"></div><div class="what"></div><div class="bar"><i></i></div>`;
  document.body.appendChild(prompt);
  const showPrompt = (p: BuddyPrompt | null) => {
    const q = p ? view.project(p.at[0], p.at[1] + 0.55, p.at[2]) : null;
    prompt.classList.toggle('show', !!q);
    touchUi?.setAct(p ? p.label : null, p?.progress ?? 0);
    if (!p || !q) return;
    prompt.style.transform = `translate(${q.x}px, ${q.y}px) translate(-50%, -100%)`;
    prompt.querySelector('.who')!.textContent = p.hold ? '？？？' : '穴の中で何かが動いている…';
    const key = touch ? '' : p.hold ? '<kbd>E</kbd> 長押し：' : '<kbd>E</kbd> ';
    const what = p.hold ? '引っこ抜く' : '調べる';
    const el = prompt.querySelector('.what')!;
    const html = `${key}${what}`;
    if (el.innerHTML !== html) el.innerHTML = html;
    prompt.classList.toggle('hold', p.hold);
    (prompt.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(p.progress * 100)}%`;
  };
  const onBuddyEvents = () => {
    for (const e of buddy.drainEvents()) {
      if (e.kind === 'examined') {
        toast('触角をつかめば、引っこ抜けそうだ！');
        saver.markImportant();
      } else if (e.kind === 'popped') {
        // 抜けた瞬間：砂煙と泡、カニは反動で後ろへ尻もち
        view.puff(e.x, e.y, e.z, true);
        const dx = crab.x - e.x, dz = crab.z - e.z, l = Math.hypot(dx, dz) || 1;
        crab.vx = (dx / l) * 2.4;
        crab.vz = (dz / l) * 2.4;
        crab.vy = 2.6;
        crab.grounded = false;
        crab.landImpact = 1;
      } else if (e.kind === 'land') view.puff(e.x, e.y, e.z, false);
      else if (e.kind === 'joined') {
        banner.className = 'show first hidden buddy';
        banner.querySelector('.kicker')!.textContent = '仲間になった！';
        banner.querySelector('.name')!.textContent = BUDDY_NAME;
        banner.querySelector('.desc')!.textContent = `${BUDDY_DESC}。${touch ? '右上のボタン' : 'Q キー・右上のボタン'}で呼ぶと、ついてくる`;
        bannerT = 5.5;
        showBuddyBtn();
        saver.markImportant();
      } else if (e.kind === 'mode') saver.markImportant();
      else if (e.kind === 'warp') {
        view.puff(e.from[0], e.from[1], e.from[2], false);
        view.puff(e.to[0], e.to[1], e.to[2], false);
      }
    }
  };

  // 自動保存の印：掘った（かき出しの回数）・初めての場所・動いた
  let lastCarves = world.dig.stats.carves;
  let lastPos = { x: crab.x, y: crab.y, z: crab.z };

  // ---------------- ループ ----------------
  // 自動検証用：freeze = true でゲームの更新を止める。step(n, dt) は通常のループと同じ処理を n 回まわす
  // （ブラウザのタブが裏にあって requestAnimationFrame が間引かれていても、実際の入力の状態で時間を進められる）
  // dig = true で掘るボタンを押したことにする。digAim = { x, y } で照準を決める（null = 実際の入力。自動検証用）
  // act = true で「調べる / 引っこ抜く」を押したことにする（自動検証用）
  const debug: { freeze: boolean; fps: number; dig: boolean; act: boolean; digAim: { x: number; y: number } | null; step: (n: number, dt?: number) => void } = { freeze: false, fps: 0, dig: false, act: false, digAim: null, step: () => {} };
  let time = 0;
  let last = performance.now();
  let acc = 0, frames = 0, hudT = 0;
  const tick = (dtRaw: number) => {
    const dt = debug.freeze ? 0 : Math.min(dtRaw, 0.05);
    time += dt;
    if (!debug.freeze) {
      // 仲間・巣穴（調べる / 引っ張る。引っ張っている間はカニの入力を穴に合わせる）
      const br = buddy.update(dt, crab, { act: input.isActHeld() || debug.act });
      showPrompt(br.prompt);
      onBuddyEvents();
      crab.update(dt, { move: input.moveAxis(), run: input.isRunning(), jumpHeld: input.isJumpHeld(), cameraYaw: camera.yaw, dig: input.isDigHeld() || debug.dig, digAim: debug.digAim ?? input.digAim(), pull: br.pull });
      camera.update(dt, input, crab);
      rig.update(dt, crab);
      life.update(dt, { x: crab.x, y: crab.y + crab.radius, z: crab.z });
      tracker.update(dt, crab.x, crab.y + crab.radius, crab.z);
      for (const e of tracker.drainEvents()) {
        showBanner(e.spot, e.first, e.parentFirst);
        if (e.first) saver.markImportant();
      }
      camera.setVista(tracker.current?.vista ?? null);
      playTime += dt;
      if (world.dig.stats.carves !== lastCarves) {
        lastCarves = world.dig.stats.carves;
        saver.markDirty();
      }
      if (Math.hypot(crab.x - lastPos.x, crab.y - lastPos.y, crab.z - lastPos.z) > 0.5) {
        lastPos = { x: crab.x, y: crab.y, z: crab.z };
        saver.markMoved();
      }
      saver.update(dt);
    }
    if (bannerT > 0) {
      bannerT -= dtRaw;
      if (bannerT <= 0) banner.classList.remove('show');
    }
    vistaTag.classList.toggle('show', camera.viewing);
    view.render(settings, camera, crab, time, dt);
    input.consume();

    // 箱庭カメラ・ガラス越しで砂に隠れているときは、カニの位置に印を出す
    if (camera.mode === 'diorama' || (camera.mode === 'observe' && camera.crabHidden)) {
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
      const under = crab.submerged > 0.5;
      const region = crab.region;
      const zone = $('h-zone');
      // 区画（水槽・濾過槽は水中 / 陸上も）
      zone.textContent = region === 'tank' ? (under ? '水中' : '陸上') : region === 'sump' ? `濾過槽・${under ? '水中' : '陸上'}` : REGION_LABEL[region];
      zone.classList.toggle('land', !under);
      $('h-cam').textContent = CAMERA_MODE_LABEL[camera.mode];
      const place = $('h-place');
      place.textContent = tracker.current ? tracker.current.name : `${REGION_LABEL[crab.region]}のどこか`;
      place.classList.toggle('hidden', tracker.current?.kind === 'hidden');
      $('h-found').textContent = `${tracker.visited.size} / ${tracker.total}　（ひみつ ${tracker.hiddenFound} / ${tracker.hiddenTotal}）`;
      $('h-state').textContent = CRAB_STATE_LABEL[crab.state];
      ($('h-swim') as HTMLElement).style.width = `${Math.round(crab.swimStamina * 100)}%`;
      $('h-perf').textContent = `${debug.fps.toFixed(0)} FPS ・ E ${(view.stats.tris / 1000).toFixed(0)}k 三角形 + C ${(view.stats.surfels / 1000).toFixed(0)}k 円盤`;
      // 穴掘り：照準の先の物（掘れる / 掘れない）と、掘った量・作り直しの時間
      // （照準の先に何も無いときは文字を出さない。カニが空振りする動きで分かる）
      const A = crab.digAim, dg = $('h-dig');
      dg.classList.toggle('off', !A.active || !A.face);
      if (A.active && A.face) {
        dg.textContent = diggable(A.material) ? `掘れる：${DIG_MATERIAL_LABEL[A.material]}` : `掘れない：${DIG_MATERIAL_LABEL[A.material]}`;
        dg.classList.toggle('ng', !diggable(A.material));
      }
      const fs = view.digFx.stats;
      $('h-digperf').textContent = world.dig.count ? `穴 ${world.dig.count} 個 ・ 区画 ${fs.chunks} ・ 作り直し ${fs.lastMs.toFixed(1)} ms（最大 ${fs.maxMs.toFixed(1)}）・ 待ち ${fs.pending}` : '';
    }
  };
  debug.step = (n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) tick(dt);
  };
  // 前のフレームからの時間。requestAnimationFrame の時刻は「フレームの始まり」なので、重い初期化の直後や
  // 裏から戻った直後には直前の performance.now() より過去になることがある（負の時間差）。負の時間で進めると
  // カメラの追従（1 − exp(−dt × k)）が発散して視点が戻らなくなるので、負は 0、大きすぎる値は 0.25 秒で止める
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dtRaw = Math.min(Math.max((now - last) / 1000, 0), 0.25);
    last = Math.max(last, now);
    tick(dtRaw);
  };
  loading.remove();
  /** 起動から最初のフレームまで（生成 + 保存データの読み込み・復元） */
  const bootMs = performance.now() - t0;
  requestAnimationFrame(loop);
  (window as unknown as Record<string, unknown>).__aqua = Object.assign(debug, { world, crab, rig, camera, view, settings, input, spots, finds, tracker, life, resetDiscovery, goto, places, sump: SUMP, save: { store, saver, menu: saveMenu, ctx: saveCtx, gather, restore: restoreInfo, loaded }, buddy, toggleBuddy, buildMs, bootMs, buildPhases: built.ms, plantMs: plants.ms, plantCounts: plants.counts, plantTimes: plants.times });
}

// 読み込み表示を先に描画させてから重い生成処理に入る
setTimeout(() => {
  boot().catch((e) => {
    const l = document.getElementById('loading');
    if (l) l.textContent = `初期化に失敗しました：${(e as Error).message}`;
    throw e;
  });
}, 50);
