// 水槽探検ゲーム（aquarium.html）の入口。描画方式の比較（index.html）とは別ページで、比較機能には手を入れない。
// 入力は既存の Input / TouchControls、描画は方式 F v2 の部品（PixelPipeline・SurfelRenderer・LIGHTING_CHUNK・
// MeshBuild の Surface Nets）を使う。

import '../style.css';
import './aquarium.css';
import { clamp } from '../core/math';
import { Input } from '../game/Input';
import { DEFAULT_SETTINGS, type RenderSettings } from '../settings';
import { isTouchDevice, TouchControls } from '../ui/TouchControls';
import { AquaCamera, CAMERA_MODE_LABEL } from './AquaCamera';
import { AquaLife } from './AquaLife';
import { buildAquariumMeshes, buildAquariumSurfels, buildBuddyMesh, buildBurrowMesh, buildCrabMesh, buildFindsMesh, buildFishMesh, buildGlowMesh, buildPropMeshes, buildShrimpMesh } from './AquariumBuild';
import { BUDDY_DESC, BUDDY_ID, BUDDY_NAME, BuddySystem, type BuddyPrompt } from './AquaBuddy';
import { GrabSystem, PropSystem, type PropKind } from './AquaGrab';
import { AquariumRenderer } from './AquariumRenderer';
import { buildSpots, DiscoveryTracker, type Spot } from './AquariumSpots';
import { AquariumWorld } from './AquariumWorld';
import { REGION_LABEL, SUMP } from './AquariumStand';
import { CRAB_STATE_LABEL, CrabController, FILL_BLOCK_LABEL } from './CrabController';
import { DIG, DIG_MATERIAL_LABEL, diggable, SAND } from './AquariumDig';
import { CrabRig } from './CrabRig';
import { ROOM } from './AquariumStand';
import { TANK } from './aquaConst';
import { SAVE_FORMAT, SAVE_VERSION, SaveStore, type LoadResult, type SaveContext, type SaveData } from './AquaSave';
import { AutoSaver, SaveMenu } from './AquaSaveUi';
import { HelpPanel } from './AquaHelp';
import { ViewportGuard } from './AquaViewport';
import { AquaHud } from './AquaHud';

/** いまの水槽の id（保存データの tanks の鍵。将来の隣の水槽は別の id） */
const HOME_TANK = 'home';
/**
 * スナモグリの巣穴（砂の広場の手前の砂。スタート地点から西へ約 6、手前のガラスから 1.6。水中の砂。
 * 排水管の縦の管（x −6.5, z 5.6）・エビの住みかから離す）
 */
const BURROW_XZ: [number, number] = [-9.4, 8.4];
/** 調べたかの印（progress.flags） */
const FLAG_EXAMINED = 'burrow.examined';
/**
 * 挟める物（x, z, 種類, 大きさ, 向き）：スタート地点（−4, 5）のまわりの砂の上と、砂の広場。
 * 排水管の縦の管（−6.5, 5.6）・巣穴・発見物から離す。保存はしない（読み込み直すと置いた所に戻る）
 */
const PROPS: [number, number, PropKind, number, number][] = [
  [-3.1, 5.5, 'shell', 1.0, 0.4],
  [-4.9, 6.3, 'shell', 0.85, 2.1],
  [-3.3, 4.2, 'pebble', 0.9, 0.0],
  [-4.4, 3.9, 'pebble', 1.15, 1.2],
  [-2.5, 6.5, 'pebble', 1.0, 2.6],
  [-5.4, 4.6, 'stone', 1.0, 0.7],
  [-7.6, 7.3, 'shell', 1.1, 1.0],
  [-8.4, 6.0, 'pebble', 1.05, 0.3],
];

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
  // 挟める物（小石・貝殻・重い石）と、右の大きな鋏で挟む操作
  const props = new PropSystem(world);
  PROPS.forEach(([x, z, kind, s, yaw], i) => props.add(`${kind}${i}`, kind, x, z, 6, s, yaw));
  const grab = new GrabSystem(world, props);
  // 巣穴から見えているスナモグリの触角・鋏の付け根も、同じ鋏で挟める（引っこ抜き。抜けた後は挟めない）
  grab.creatures.push(buddy.tug);
  const view = new AquariumRenderer(canvas, world, built.meshes, crabMesh, plants.set, rig, {
    finds,
    findsMesh: buildFindsMesh(finds, built.light),
    glowMesh: buildGlowMesh(finds),
    fishMesh: buildFishMesh(),
    shrimpMesh: buildShrimpMesh(),
    life,
    buddy: { sys: buddy, mesh: buildBuddyMesh(), burrowMesh: buildBurrowMesh(world, built.light, BURROW_XZ[0], BURROW_XZ[1]) },
    props: { sys: props, meshes: buildPropMeshes() },
  }, { light: built.light, plantAnchors: plants.anchors });
  const buildMs = performance.now() - t0;

  // ---------------- 画面の表示 ----------------
  const touch = isTouchDevice();
  const diagMode = new URLSearchParams(location.search).has('diag');
  // 左上の表示：ふだんは小さく（場所・砂・必要なときの状態）。FPS などは「詳細」の欄（?diag では開いた状態で始める）
  const hud = new AquaHud({ forceDetail: diagMode });
  // 操作の説明（右上の「？」で開く。初回だけ自動で出し、「×」で閉じたら次からは出さない）。欄は右上のメニューを作った後に作る
  const helpBrief = touch
    ? `<p>左のスティックで移動、右の「ジャンプ」で跳ぶ・「掘る」で砂を掘る・「挟む」を押している間 ハサミで小石や貝殻を挟む。画面をドラッグで視点を回し、2 本指でズーム。</p><p class="hint">詳しい操作は、右上の「？」でいつでも見られます。</p>`
    : `<p><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> で移動、<kbd>Space</kbd> で跳ぶ、<kbd>F</kbd> で砂を掘る、<kbd>E</kbd> を押している間 ハサミで小石や貝殻を挟む。ドラッグで視点を回し、ホイールでズーム。</p><p class="hint">詳しい操作は、右上の「？」でいつでも見られます。</p>`;
  const helpFull = touch
    ? `<ul><li>左スティック：移動。ダッシュ：押している間</li><li>ジャンプ：跳ぶ（水中で長押し＝遊泳。壁では離れる）</li><li>壁登り：岩・流木・土の壁へスティックを倒し続けると張り付く（壁へ＝上、手前＝下、左右＝横。離すとその場で止まる）。そのまま張り出し・岩や流木の裏・トンネルの天井まで逆さで歩ける（跳んで・泳いで天井に触れても張り付く。ジャンプで離れる）</li><li>掘る：押している間 前の砂を掘る。押したまま指をずらすと、その向き（上・下・左右・斜め）を掘る。掘りながらスティックで好きな向きへ動ける</li><li>盛る：「掘る」ボタンの上の切り替えで「盛る」にすると、同じボタンで手持ちの砂を置ける（押している間 少しずつ積もる。黄緑の輪 = 置ける所、赤 = 置けない）。砂は掘ると集まる（左上の「砂」。上限あり）</li><li>画面ドラッグ：視点の回転。2 本指：カメラのズーム</li><li>カメラ：冒険 / ガラス越し（水槽の外から地下の穴を観察）/ 箱庭の切り替え</li><li>挟む：押している間、右の大きなハサミを閉じて、届く所の小石・貝殻を挟む（離すと放す）。挟んだまま歩く・泳ぐと引っ張られてついてくる。重い石は持ち上がらず引きずる（陸の上では動かない）。押したまま指をずらすと視点を回せる。ボタンの縁が明るいときは届く物がある</li><li>引っこ抜く：巣穴から見えている触角を「挟む」で挟み、挟んだままスティックで後ろへ下がって引っ張る（押しているだけでは抜けない）。暴れているときに引きすぎるとハサミが滑る（震えたら少しゆるめる）。力が抜けた隙に引くと出てくる。離すと穴へ戻っていく</li><li>仲間：右上のボタンで「呼ぶ（同行）/ 自由に暮らす」を切り替え</li><li>右上の「セーブ」：進捗は自動で保存（書き出し・読み込み・初期状態に戻す）</li><li>右上の「？」：この説明</li><li>左上の「詳細」：区画・発見の数・FPS・画面の倍率の記録など（× で閉じる）</li></ul><p class="hint">光る石・湧く泡をたよりに、隠れた場所を探そう。水面の丸い穴は、水槽の下へ続いている。岸辺の斜面の砂は深く、トンネルを掘れる</p>`
    : `<ul><li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移動　<kbd>Shift</kbd> 走る</li><li><kbd>Space</kbd> ジャンプ（水中で長押し＝遊泳。壁では離れる）</li><li>壁登り：岩・流木・土の壁へ押し続けると張り付く（壁へ＝上、手前＝下、左右＝横。離すとその場で止まる）。そのまま張り出し・岩や流木の裏・トンネルの天井まで逆さで歩ける（跳んで・泳いで天井に触れても張り付く。<kbd>Space</kbd> で離れる）</li><li><kbd>F</kbd> 長押し：掘る（押したままマウスを動かすと上下左右・斜めを狙う。掘りながら <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> で好きな向きへ動ける）</li><li>右ボタンを押したままドラッグ：その向きを掘る</li><li><kbd>G</kbd> 掘る ↔ 盛る の切り替え。盛るのときは <kbd>F</kbd> 長押しで手持ちの砂を置く（少しずつ積もる。黄緑の輪 = 置ける所、赤 = 置けない）。砂は掘ると集まる（左上の「砂」。上限あり）</li><li>ドラッグ：視点回転　ホイール：ズーム</li><li><kbd>V</kbd> カメラ切替（冒険 / ガラス越し / 箱庭。ガラス越しはガラス際まで掘った穴を外から観察）　<kbd>R</kbd> スタート地点へ</li><li><kbd>E</kbd> 押している間：右の大きなハサミを閉じて、届く所の小石・貝殻を挟む（離すと放す）。挟んだまま歩く・泳ぐと引っ張られてついてくる。重い石は持ち上がらず引きずる（陸の上では動かない）。挟んだままマウスのドラッグで見回せる</li><li>引っこ抜く：巣穴から見えている触角を <kbd>E</kbd> で挟み、押したまま <kbd>S</kbd> などで後ろへ下がって引っ張る（押しているだけでは抜けない）。暴れているときに引きすぎる（<kbd>Shift</kbd> で急に引く等）とハサミが滑る（震えたら少しゆるめる）。力が抜けた隙に引くと出てくる。離すと穴へ戻っていく　<kbd>Q</kbd> 仲間を呼ぶ / 自由に暮らす（右上のボタンでも）</li><li>右上の「セーブ」：進捗は自動で保存（書き出し・読み込み・初期状態に戻す）</li><li><kbd>H</kbd> または右上の「？」：この説明の表示 / 非表示</li><li><kbd>I</kbd> または左上の「詳細」：区画・発見の数・FPS・画面の倍率の記録などの表示 / 非表示</li></ul><p class="hint">光る石・湧く泡をたよりに、隠れた場所を探そう。見晴らしの良い所で立ち止まると景色を眺めます。水面の丸い穴は、水槽の下へ続いている。岸辺の斜面の砂は深く、トンネルを掘れる</p>`;
  let help: HelpPanel | null = null;
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
  input.onPress('KeyH', () => help?.toggle());
  input.onPress('KeyI', () => hud.toggle());
  input.onPress('KeyR', () => {
    grab.release();
    crab.teleport(world.spawn.x, world.spawn.z);
  });
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
    if (p) grab.release();
    if (p) crab.teleport(p[0], p[1], world.contactSurfaceBelow(p[0], p[2], p[1]) + 0.02);
    return crab.region;
  };
  let touchUi: TouchControls | null = null;
  if (touch) {
    // （巣穴の生き物も「挟む」で挟んで引っ張る。以前の「調べる / 引っこ抜く」ボタンは使わない）
    touchUi = new TouchControls(input, { runLabel: 'ダッシュ', jump: true, dig: true, onCamera: toggleCamera, grab: true });
    document.body.classList.add('touch');
  }
  // 掘る ↔ 盛る：PC は G キー、スマホは掘るボタンの上の小さな切り替え（掘るボタン・F キーはどちらでも共用）
  const toolBtn = document.createElement('button');
  toolBtn.type = 'button';
  toolBtn.className = 'tool';
  const showTool = () => {
    const fill = crab.tool === 'fill';
    toolBtn.innerHTML = `<b class="${fill ? '' : 'on'}">掘る</b><b class="${fill ? 'on' : ''}">盛る</b>`;
    toolBtn.classList.toggle('fill', fill);
    const dl = touchUi?.root.querySelector<HTMLElement>('.dig span');
    if (dl) dl.textContent = fill ? '盛る' : '掘る';
    touchUi?.root.querySelector('.dig')?.classList.toggle('fill', fill);
    document.body.classList.toggle('tool-fill', fill);
  };
  const toggleTool = () => {
    crab.toggleTool();
    showTool();
    toast(crab.tool === 'fill' ? `盛る：手持ちの砂を置く（${touch ? '「盛る」ボタン' : 'F キー'}を押している間）` : '掘る：砂を掘って集める');
  };
  if (touchUi) {
    touchUi.root.appendChild(toolBtn);
    toolBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTool();
    });
    toolBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  input.onPress('KeyG', () => toggleTool());
  // 盛った砂で仲間を埋めない（仲間の体のまわりには盛らない）
  // 挟める物も埋めない（盛った砂の中に閉じ込めない）
  crab.fillBlockers = () => [
    ...(buddy.found || buddy.examined ? [{ x: buddy.x, y: buddy.y + 0.15, z: buddy.z, r: 0.3 }] : []),
    ...props.props.map((p) => ({ x: p.p[0], y: p.p[1], z: p.p[2], r: p.rb + 0.04 })),
  ];

  // （レイアウトの大きさで測る：ページが拡大されたまま画面を見えている範囲へ置き直している間も、描画の大きさは変えない）
  const resize = () => {
    view.setSize(Math.max(1, Math.floor(canvas.clientWidth)), Math.max(1, Math.floor(canvas.clientHeight)));
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
    sandCap: SAND.capacity,
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
    // 手持ちの砂と道具（版 1 のデータは migrate で 0・掘る）
    crab.sandHeld = d.player.sand;
    crab.tool = d.player.tool;
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
  showTool();
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
  // 掘った・盛った砂の量を測っている途中なら測り終えてから集める（保存する地形と手持ちの砂が食い違わない）
  const gather = (): SaveData => (world.dig.measureStep(Infinity), {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    created,
    savedAt: Date.now(),
    playTime,
    // 世代と識別子は SaveStore が書くときに付ける
    rev: 0,
    saveId: '',
    player: { tank: HOME_TANK, x: crab.x, y: crab.y, z: crab.z, heading: crab.heading, camera: camera.mode, sand: crab.sandHeld, tool: crab.tool },
    progress: { visited: [...tracker.visited], flags: { ...flags, [FLAG_EXAMINED]: buddy.examined } },
    tanks: { [HOME_TANK]: { dig: { prims: world.dig.exportPrims() } } },
    buddies: [buddy.toSave()],
  });
  const saver = new AutoSaver(store, gather);
  const saveMenu = new SaveMenu(menu, { saver, ctx: saveCtx, bootNote, toast });
  // 右上の「？」（セーブの後ろ）と説明の欄
  help = new HelpPanel(menu, { touch, brief: helpBrief, full: helpFull });
  // ページ自体の拡大を防ぐ・気づいて戻す（ゲーム内カメラのズームとは別）。?diag で倍率・指の座標などを画面に出す
  const viewport = new ViewportGuard({
    input,
    relayout: resize,
    // 「保存して開き直す」は保存できたときだけ開き直す（失敗・競合・?nosave では開き直さず、書き出しを勧める）。
    // 同じページの読み込み直し（reload）は Safari が前の倍率を引き継ぐので、URL を新しく開く（location.replace）
    save: {
      info: () => ({ state: saver.state, lastSavedAt: saver.lastSavedAt, unsavedFor: saver.unsavedFor, error: saver.store.stats.lastError, noSave }),
      flush: () => saver.flush(),
      exportFile: () => saveMenu.exportFile(saver.store.conflict ? '-このタブ' : ''),
      suspend: () => (saver.suspended = true),
      navigate: (url) => location.replace(url),
    },
    toast,
    diag: diagMode,
    camInfo: () => `${camera.mode} zoom ${camera[camera.mode].zoom.toFixed(2)}`,
  });
  hud.logText = () => viewport.logText();
  hud.onClearLog = () => viewport.clearLog();
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
  // 巣穴の案内（近くで触角が見えているとき：挟めること。引っ張っている間は出さない = 手応えの印 tugCue に任せる）
  const prompt = document.createElement('div');
  prompt.id = 'act-prompt';
  prompt.innerHTML = `<div class="who"></div><div class="what"></div>`;
  document.body.appendChild(prompt);
  // 引っ張っている間の手応えの印：つかんだ所の輪（張りの強さで色と大きさが変わる）・引く向きの矢印・短い言葉
  // （進み具合のゲージは出さない：体の伸び・砂・カニの踏ん張りで分かるようにする）
  const tugCue = document.createElement('div');
  tugCue.id = 'tug-cue';
  tugCue.innerHTML = `<i class="ring"></i><i class="arrow"></i><span class="say"></span>`;
  document.body.appendChild(tugCue);
  // 挟む：届く物の案内（PC：物の上に「E 挟む」。スマホ：挟むボタンの縁を明るくする）
  const grabHint = document.createElement('div');
  grabHint.id = 'grab-hint';
  document.body.appendChild(grabHint);
  const showGrabHint = () => {
    const pr = grab.hint;
    touchUi?.setGrabReady(!!pr);
    // 巣穴の触角は巣穴の案内（act-prompt）が出すので、ここでは出さない
    const q = pr && !touch && pr !== buddy.tug ? view.project(pr.p[0], pr.p[1] + pr.rb + 0.12, pr.p[2]) : null;
    grabHint.classList.toggle('show', !!q);
    if (!pr || !q) return;
    const html = `<kbd>E</kbd> 挟む：${pr.name}`;
    if (grabHint.innerHTML !== html) grabHint.innerHTML = html;
    grabHint.style.transform = `translate(${q.x}px, ${q.y}px) translate(-50%, -100%)`;
  };
  const onGrabEvents = () => {
    for (const e of grab.drainEvents()) {
      if (e.kind === 'slip' && e.prop === buddy.tug) {
        toast('ハサミが滑った！ 強く引きすぎ（暴れている間は少しゆるめる）');
        vibrate(40);
      } else if (e.kind === 'slip') toast(`${e.prop?.name ?? '物'}がハサミから滑り落ちた`);
      else if (e.kind === 'heavy') toast(crab.submerged > 0.5 ? `${e.prop?.name ?? '物'}は重くて、なかなか動かない…` : `${e.prop?.name ?? '物'}は重くて動かない（水の中なら少し軽くなる）`);
    }
  };
  /** スマホの振動（対応している端末だけ。iPhone の Safari は対応していない） */
  const vibrate = (ms: number | number[]) => {
    // （画面に一度も触れていないうちは呼ばない：ブラウザが拒んで警告を出す）
    if (touch && typeof navigator.vibrate === 'function' && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate(ms);
  };
  const showPrompt = (p: BuddyPrompt | null) => {
    const q = p && p.kind === 'peek' ? view.project(p.at[0], p.at[1] + 0.55, p.at[2]) : null;
    prompt.classList.toggle('show', !!q);
    if (!p || !q) return;
    prompt.style.transform = `translate(${q.x}px, ${q.y}px) translate(-50%, -100%)`;
    prompt.querySelector('.who')!.textContent = p.examined ? '？？？' : '穴の中で何かが動いている…';
    // ハサミが届くとき（挟む判定と同じ GrabSystem.hint）だけ「挟む」。届かなければ近づくよう促す
    const reach = grab.hint === buddy.tug;
    prompt.classList.toggle('ready', reach);
    const html = !reach ? 'もっと近づいて、ハサミで触角を挟む' : touch ? '「挟む」で触角を挟む' : '<kbd>E</kbd> 挟む：見えている触角';
    const el = prompt.querySelector('.what')!;
    if (el.innerHTML !== html) el.innerHTML = html;
  };
  /**
   * 引っ張っている間の手応え（毎フレーム）：つかんだ所の輪・引く向きの矢印・短い言葉と、砂粒・泡・カニの踏ん張りの砂・
   * カメラの揺れを、生き物の段階・引き戻し・張力に合わせて出す
   */
  const T = buddy.tug;
  let fxCrumble = 0, fxKick = 0, slackT = 0, sayT = 0, say = '';
  const updateTug = (dt: number) => {
    const held = grab.holdingCreature === T;
    tugCue.classList.toggle('show', held);
    rig.tugShake = held ? T.env : 0;
    camera.focus = held ? [T.p[0], T.p[1], T.p[2]] : null;
    if (!held) {
      slackT = 0;
      // 次に挟んだとき前の言葉が残らない
      if (say) tugCue.querySelector('.say')!.textContent = say = '';
      return;
    }
    const [bx, by, bz] = buddy.burrow;
    const cdx = crab.x - bx, cdz = crab.z - bz, cl = Math.hypot(cdx, cdz) || 1;
    const away: [number, number] = [cdx / cl, cdz / cl];
    // 砂：終盤は激しく崩れる。滑り出ている間・横に引いて縁にこすれている間もこぼれる
    const rate = (T.stage === 'late' ? 9 : T.stage === 'give' ? 14 : 0) + Math.max(0, T.extV) * 40 + T.rub * 0.8 + T.env * 4;
    fxCrumble += dt * rate;
    while (fxCrumble >= 1) {
      fxCrumble -= 1;
      view.tugFx('crumble', bx, by, bz, T.stage === 'late' || T.stage === 'give' ? 3 : 2, T.rub > 1.5 ? away : null);
    }
    // カニの足もとの砂：強く張って下がっている間
    if (crab.pullT > 0.75 && crab.grounded && crab.speed > 0.05) {
      fxKick += dt * 3.5;
      if (fxKick >= 1) {
        fxKick = 0;
        view.tugFx('kick', crab.x + away[0] * 0.05, crab.y, crab.z + away[1] * 0.05, 1 + T.env * 2, away);
      }
    } else fxKick = Math.min(fxKick, 0.5);
    // 輪・矢印・言葉
    const g = T.p;
    const q = view.project(g[0], g[1], g[2]);
    const q2 = view.project(g[0] + away[0] * 0.45, g[1] + 0.12, g[2] + away[1] * 0.45);
    if (!q || !q2) return;
    const warn = grab.warn;
    const level = warn > 0.25 ? 'danger' : T.load > 1 ? 'move' : T.load > 0.55 ? 'hold' : 'slack';
    tugCue.dataset.level = level;
    tugCue.style.transform = `translate(${q.x}px, ${q.y}px)`;
    tugCue.style.setProperty('--k', clamp(grab.load, 0, 1).toFixed(3));
    tugCue.style.setProperty('--w', warn.toFixed(3));
    const ang = Math.atan2(q2.y - q.y, q2.x - q.x);
    (tugCue.querySelector('.arrow') as HTMLElement).style.transform = `rotate(${ang.toFixed(3)}rad)`;
    // 張っていない時間（下がっていない）：案内を出す
    slackT = grab.load < 0.3 && crab.speed < 0.2 ? slackT + dt : 0;
    let next = '';
    if (warn > 0.3) next = '引きすぎ！ ゆるめて';
    else if (T.env > 0.5) next = T.stage === 'early' ? 'ぐいっ' : '暴れている！';
    else if (T.restT > 0) next = '力が抜けた！';
    else if (T.stage === 'give') next = 'もう少し！';
    else if (T.extV > 0.05) next = '出てきた';
    else if (slackT > 1.0) next = touch ? 'スティックで後ろへ下がる' : '後ろへ下がって引っ張る';
    else if (T.stage === 'late') next = '踏ん張っている…';
    // 言葉はすぐには切り替えない（読める間は残す）
    sayT -= dt;
    if (next !== say && (sayT <= 0 || next === '引きすぎ！ ゆるめて')) {
      say = next;
      sayT = 0.6;
      tugCue.querySelector('.say')!.textContent = say;
    }
  };
  const onBuddyEvents = () => {
    for (const e of buddy.drainEvents()) {
      if (e.kind === 'examined') {
        toast('何かの触角を挟んだ！ 後ろへ下がって引っ張ろう');
        saver.markImportant();
      } else if (e.kind === 'popped') {
        // 抜けた瞬間：抵抗が急に消え、砂煙と泡が舞い、カニは勢い余って後ろへ転ぶ。カメラも少し揺れる
        view.puff(e.x, e.y, e.z, true);
        view.tugFx('crumble', e.x, e.y, e.z, 12, null);
        crab.tumble(e.dir[0], e.dir[1], e.power);
        camera.kick(e.dir[0] * 0.9 * e.power, 0.5, e.dir[1] * 0.9 * e.power);
        vibrate([30, 40, 60]);
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
      } else if (e.kind === 'tug') {
        const t = e.e;
        const [bx, by, bz] = buddy.burrow;
        if (t.kind === 'tug') {
          // 引き戻した：穴の口から泡、カメラが穴の方へ少し引かれる
          view.tugFx('bubble', bx, by, bz, t.stage === 'early' ? 2 : 5);
          const dx = bx - crab.x, dz = bz - crab.z, l = Math.hypot(dx, dz) || 1;
          const k = t.stage === 'early' ? 0.12 : t.stage === 'mid' ? 0.22 : 0.3;
          camera.kick((dx / l) * k, -0.05, (dz / l) * k);
          if (t.stage !== 'early') vibrate(18);
        } else if (t.kind === 'stage' && t.stage === 'late') view.tugFx('crumble', bx, by, bz, 8, null);
        else if (t.kind === 'grab') view.tugFx('bubble', bx, by, bz, 3);
      }
    }
  };

  // 自動保存の印：掘った（かき出しの回数）・初めての場所・動いた
  let lastCarves = world.dig.stats.carves + world.dig.stats.fills;
  let lastPos = { x: crab.x, y: crab.y, z: crab.z };

  // ---------------- ループ ----------------
  // 自動検証用：freeze = true でゲームの更新を止める。step(n, dt) は通常のループと同じ処理を n 回まわす
  // （ブラウザのタブが裏にあって requestAnimationFrame が間引かれていても、実際の入力の状態で時間を進められる）
  // dig = true で掘るボタンを押したことにする。digAim = { x, y } で照準を決める（null = 実際の入力。自動検証用）
  // hold = true で「挟む」を押したことにする（自動検証用。巣穴の触角も挟める）
  const debug: { freeze: boolean; fps: number; dig: boolean; hold: boolean; digAim: { x: number; y: number } | null; step: (n: number, dt?: number) => void } = { freeze: false, fps: 0, dig: false, hold: false, digAim: null, step: () => {} };
  let time = 0;
  let last = performance.now();
  let acc = 0, frames = 0, hudT = 0, frameMax = 0, frameMaxShown = 0;
  const tick = (dtRaw: number) => {
    const dt = debug.freeze ? 0 : Math.min(dtRaw, 0.05);
    time += dt;
    if (!debug.freeze) {
      // 挟む：PC は E、スマホは「挟む」ボタン。小石・貝殻・重い石も、巣穴から見えている触角も同じ操作
      const grabHeld = input.touchGrab || input.isDown('KeyE') || debug.hold;
      // 仲間・巣穴（触角の出具合・引っ張っている間の体。引っ張っている間はカニを穴へ向け、穴の上に乗せない）
      const br = buddy.update(dt, crab);
      showPrompt(grab.busy && !grab.holdingCreature ? null : br.prompt);
      onBuddyEvents();
      // 巣穴のそばで「挟む」を押している（まだ挟んでいない）間は、鋏の側を穴へ向け直す（横歩きで横を向いていても届く）
      const [bx, , bz] = buddy.burrow;
      const face = grabHeld && !grab.held && br.prompt?.kind === 'peek' && Math.hypot(crab.x - bx, crab.z - bz) < 0.9 ? { x: bx, z: bz } : null;
      // 鋏が挟む方に使われている間は掘れない（掘るのも鋏を使うので）
      crab.update(dt, { move: input.moveAxis(), run: input.isRunning(), jumpHeld: input.isJumpHeld(), cameraYaw: camera.yaw, dig: (input.isDigHeld() || debug.dig) && !grab.busy, digAim: debug.digAim ?? input.digAim(), pull: br.pull, face, tow: grab.tow });
      camera.update(dt, input, crab);
      // 挟む：鋏の構え → 体と鋏の姿勢 → 物・生き物を進める（ばね）→ 動いた物へ鋏を伸ばし直す・生き物の体を置き直す
      Object.assign(rig.grip, grab.rigGrip());
      rig.update(dt, crab);
      grab.update(dt, grabHeld, crab, rig);
      Object.assign(rig.grip, grab.rigGrip());
      rig.reaimGrip();
      buddy.placeInBurrow();
      updateTug(dt);
      showGrabHint();
      onGrabEvents();
      life.update(dt, { x: crab.x, y: crab.y + crab.radius, z: crab.z });
      tracker.update(dt, crab.x, crab.y + crab.radius, crab.z);
      for (const e of tracker.drainEvents()) {
        showBanner(e.spot, e.first, e.parentFirst);
        if (e.first) saver.markImportant();
      }
      camera.setVista(tracker.current?.vista ?? null);
      playTime += dt;
      if (world.dig.stats.carves + world.dig.stats.fills !== lastCarves) {
        lastCarves = world.dig.stats.carves + world.dig.stats.fills;
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
    frameMax = Math.max(frameMax, dtRaw);
    if (acc >= 0.5) {
      debug.fps = frames / acc;
      acc = 0;
      frames = 0;
      frameMaxShown = frameMax;
      frameMax = 0;
    }
    if (hudT > 0.15) {
      hudT = 0;
      const under = crab.submerged > 0.5;
      const region = crab.region;
      // 穴掘り：照準の先の物（掘れる / 掘れない）。盛るときは届かない・砂が足りないも出す（盛れない理由が分かるように）
      // （照準の先に何も無いときは文字を出さない。カニが空振りする動きで分かる）
      const A = crab.digAim;
      const showFill = A.active && A.tool === 'fill' && (A.face || A.fillWhy === 'empty');
      const dig = showFill
        ? { text: A.fillOk ? `盛れる：${DIG_MATERIAL_LABEL[A.material]}の上` : `盛れない：${FILL_BLOCK_LABEL[A.fillWhy ?? 'other']}`, ng: !A.fillOk }
        : A.active && A.face ? { text: diggable(A.material) ? `掘れる：${DIG_MATERIAL_LABEL[A.material]}` : `掘れない：${DIG_MATERIAL_LABEL[A.material]}`, ng: !diggable(A.material) } : null;
      // 挟む：挟んでいる物（重さで引っ張られているときは「重い」）・空振り
      const held = grab.held, strain = grab.strain;
      const grabChip = grab.state === 'idle' ? null : {
        text: held ? `挟む：${held.name}${strain > 0.8 ? '（重い！）' : strain > 0.45 ? '（ずっしり）' : ''}` : grab.state === 'closing' ? '挟む…' : '挟む：空振り',
        heavy: !!held && strain > 0.45,
      };
      // 手持ちの砂（1 杯 = SAND.unit）
      const cups = Math.floor(crab.sandHeld / SAND.unit + 1e-6), capCups = Math.round(SAND.capacity / SAND.unit);
      const st = saver.state;
      const fs = view.digFx.stats;
      const nf = world.dig.fillCount;
      hud.update({
        place: tracker.current ? tracker.current.name : `${REGION_LABEL[crab.region]}のどこか`,
        placeHidden: tracker.current?.kind === 'hidden',
        sand: crab.sandHeld / SAND.capacity,
        cups,
        capCups,
        fill: crab.tool === 'fill',
        swim: crab.swimStamina,
        // 遊泳の体力は、泳いでいる・減っている間だけ小さな表示に出す
        swimShow: crab.state === 'swim' || crab.swimStamina < 0.98,
        dig,
        grab: grabChip,
        // 警告：保存できていない・別のタブと競合（ふだんはセーブのボタンの印だけ）
        warn: st === 'error' ? '保存できていません（セーブ）' : st === 'conflict' ? '別のタブと競合中（保存していません）' : null,
        // 区画（水槽・濾過槽は水中 / 陸上も）
        zone: region === 'tank' ? (under ? '水中' : '陸上') : region === 'sump' ? `濾過槽・${under ? '水中' : '陸上'}` : REGION_LABEL[region],
        land: !under,
        cam: CAMERA_MODE_LABEL[camera.mode],
        state: CRAB_STATE_LABEL[crab.state],
        found: `${tracker.visited.size} / ${tracker.total}　（ひみつ ${tracker.hiddenFound} / ${tracker.hiddenTotal}）`,
        perf: `${debug.fps.toFixed(0)} FPS ・ E ${(view.stats.tris / 1000).toFixed(0)}k 三角形 + C ${(view.stats.surfels / 1000).toFixed(0)}k 円盤`,
        frame: `フレーム ${debug.fps > 0 ? (1000 / debug.fps).toFixed(1) : '-'} ms（0.5 秒の最大 ${(frameMaxShown * 1000).toFixed(1)} ms）`,
        digPerf: world.dig.count ? `穴 ${world.dig.count - nf} 個${nf ? `・砂山 ${nf} 個` : ''} ・ 区画 ${fs.chunks} ・ 作り直し ${fs.lastMs.toFixed(1)} ms（最大 ${fs.maxMs.toFixed(1)}）・ 待ち ${fs.pending}` : '地形の作り直し：まだ掘っていません',
        viewport: viewport.viewportText(),
      });
      toolBtn.style.setProperty('--sand', (crab.sandHeld / SAND.capacity).toFixed(3));
      // 道具がほかの道（保存データの復元・自動検証）で変わったときも、切り替えとボタンの文字を合わせる
      if (toolBtn.classList.contains('fill') !== (crab.tool === 'fill')) showTool();
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
  (window as unknown as Record<string, unknown>).__aqua = Object.assign(debug, { world, crab, rig, camera, view, settings, input, spots, finds, tracker, life, resetDiscovery, goto, places, sump: SUMP, save: { store, saver, menu: saveMenu, ctx: saveCtx, gather, restore: restoreInfo, loaded }, help, viewport, buddy, toggleBuddy, grab, props, buildMs, bootMs, buildPhases: built.ms, plantMs: plants.ms, plantCounts: plants.counts, plantTimes: plants.times });
}

// 読み込み表示を先に描画させてから重い生成処理に入る
setTimeout(() => {
  boot().catch((e) => {
    const l = document.getElementById('loading');
    if (l) l.textContent = `初期化に失敗しました：${(e as Error).message}`;
    throw e;
  });
}, 50);
