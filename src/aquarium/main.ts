// 水槽探検ゲーム（aquarium.html）の入口。描画方式の比較（index.html）とは別ページで、比較機能には手を入れない。
// 入力は既存の Input / TouchControls、描画は方式 F v2 の部品（PixelPipeline・SurfelRenderer・LIGHTING_CHUNK・
// MeshBuild の Surface Nets）を使う。

import '../style.css';
import './aquarium.css';
import { clamp, hex } from '../core/math';
import { Input } from '../game/Input';
import { DEFAULT_SETTINGS, type RenderSettings } from '../settings';
import { isTouchDevice, TouchControls, touchIcon } from '../ui/TouchControls';
import { AquaCamera, type CamView } from './AquaCamera';
import { nextView, VIEW_ICON, VIEW_LABEL, ViewPicker, ViewToast } from './AquaCamPicker';
import { AquaLife } from './AquaLife';
import { buildAquariumMeshes, buildAquariumSurfels, buildBuddyMesh, buildBurrowMesh, buildCrabMesh, buildFindsMesh, buildFishMesh, buildGlowMesh, buildPropMeshes, buildShrimpMesh } from './AquariumBuild';
import { BUDDY_DESC, BUDDY_ID, BUDDY_NAME, BuddySystem, type BuddyPrompt } from './AquaBuddy';
import { ARM_REACH, GrabSystem, PROP_KIND, PropSystem, type GrabCreature, type GrabSystem as GS, type Prop, type PropKind, type Tow } from './AquaGrab';
import { EatSystem, FOOD_KIND, foodNutrition, GROWTH, type EatClaw, type EatTarget, type Food } from './AquaEat';
import type { Fish, Shrimp } from './AquaLife';
import { AquaAudio, AudioMenu } from './AquaAudio';
import { AquaGamepad } from './AquaGamepad';
import { CLAWS } from './crabModel';
import { DecorProps, type DecorItemDef } from './AquaDecor';
import type { PebbleInfo } from './AquariumBuild';
import type { Find } from './AquariumSpots';
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
import { HELP_KEY, HelpPanel } from './AquaHelp';
import { ViewportGuard } from './AquaViewport';
import { AquaHud } from './AquaHud';
import { mountUiPrefs, UiPrefStore } from './AquaUiPrefs';
import { PlantField, type Pusher } from './AquaPlants';
import { FootDiag } from './AquaFootDiag';
import { AlgaeBeds, LifeGrab, PlantGrab, WeedPieces, type Detach, type TwistResult } from './AquaCatch';
import { diag, diagLog, IS_APP, selftestMode } from './AquaPlatform';
import { GpuGuard } from './AquaGpuGuard';
import { WORM_DESC, WORM_NAME, WormSystem, type Worm } from './AquaWorm';
import { ClawFocus, ClawMarks, emptyCtl, FocusTouch, FOCUS_SCHEME_LABEL, type ClawCtl } from './AquaClawFocus';
import { addBlocks, blocksToSave, floorRect, resetBlocks, restoreBlocks } from './AquaBlocks';

/** いまの水槽の id（保存データの tanks の鍵。将来の隣の水槽は別の id） */
const HOME_TANK = 'home';
/** 積み木・物理パズルの検証エリアの中心（x, z）：砂の広場の西、ガラス際の手前のほぼ平らな砂（傾き 15 cm / 2 m。石の床を置く） */
const BLOCKS_XZ: [number, number] = [-11.75, 2.75];
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

/**
 * 景色の小石 1 個 → 挟める物の影（楕円体の半径・向き・重さ・名前）。頂点は y 軸まわりに −rot 回してあるので向きは −rot。
 * 重さは体積で決める（小石の種類の体積に対する比）。大きいほど重く、持ち上がらない・動かない
 */
function pebbleDecor(p: PebbleInfo): DecorItemDef {
  const S = PROP_KIND.pebble.semi;
  const mass = PROP_KIND.pebble.mass * (p.rx * p.ry * p.rz) / (S[0] * S[1] * S[2]);
  return { kind: 'pebble', name: mass < 0.5 ? '小石' : mass < 1.5 ? '石' : '大きな石', c: [p.x, p.y, p.z], semi: [p.rx, p.ry, p.rz], yaw: -p.rot, mass, v0: p.v0, vn: p.vn };
}

/** 発見物の貝殻・巻貝 → 挟める物の影（伏せた殻は下半分が無いので、楕円体の中心を少し上げて薄くする） */
function findDecor(f: Find, r: { v0: number; vn: number }): DecorItemDef {
  const s = f.scale;
  const shell = f.kind === 'shell';
  return {
    kind: 'shell',
    name: shell ? '貝殻' : '巻貝',
    c: [f.pos[0], f.pos[1] + (shell ? 0.025 : 0.08) * s, f.pos[2]],
    semi: shell ? [0.13 * s, 0.03 * s, 0.12 * s] : [0.1 * s, 0.1 * s, 0.11 * s],
    yaw: f.rot,
    mass: (shell ? 0.14 : 0.18) * s * s * s,
    v0: r.v0,
    vn: r.vn,
  };
}

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
  // 起動の記録（AquaPlatform.diag）：段階ごとの時刻。iOS の CI はアプリの標準エラーで受け取る
  diag(`boot start app=${IS_APP} dpr=${window.devicePixelRatio} view=${window.innerWidth}x${window.innerHeight} ua=${navigator.userAgent}`);
  // 自動検証の指定（アプリ版は環境変数 AQUA_SELFTEST）。noprepare = 描画の準備を飛ばす（変更前と同じく最初のフレームでまとめて
  // シェーダーを作る：iOS の CI で原因を比べる対照）
  const selftestP = selftestMode();
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
  // 接地 IK（第 4 段階）：8 本の脚が地形の上に足場を探す
  rig.attachFeet(world);
  const camera = new AquaCamera(world);
  camera.placeBehind(crab);
  const input = new Input(canvas);
  // マウスの右ボタン：押したままずらして掘る（照準）
  input.mouseDig = true;

  const built = buildAquariumMeshes(world);
  const plants = buildAquariumSurfels(world, built.light);
  diag(`build meshes+plants done ${(performance.now() - t0).toFixed(0)}ms`);
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
  // ゴカイ：岩・流木が砂に接する根元の石の隙間に 3 匹（スタート地点の近くに 1 匹。スナモグリの巣穴・発見物・挟める物からは離す）。
  // まわりの砂は掘れるが、隙間の巣は壊れない。手応えの設定は表示の設定（uiPrefs）が決まってから入れる
  const worms = new WormSystem(world, {
    count: 3,
    near: world.spawn,
    feel: 'std',
    avoid: [
      { x: BURROW_XZ[0], z: BURROW_XZ[1], r: 2.6 },
      ...finds.map((f) => ({ x: f.pos[0], z: f.pos[2], r: 1.2 })),
      ...PROPS.map(([x, z]) => ({ x, z, r: 0.7 })),
      { x: BLOCKS_XZ[0], z: BLOCKS_XZ[1], r: 1.6 },
    ],
  });
  // 挟める物（小石・貝殻・重い石）と、右の大きな鋏で挟む操作
  const props = new PropSystem(world);
  PROPS.forEach(([x, z, kind, s, yaw], i) => props.add(`${kind}${i}`, kind, x, z, 6, s, yaw));
  // 積み木・物理パズルの検証エリア（箱の物。保存する：版 4）
  const blocksArea = addBlocks(props, world, BLOCKS_XZ[0], BLOCKS_XZ[1]);
  const blocks = blocksArea.list;
  const grab = new GrabSystem(world, props);
  // 巣穴から見えているスナモグリの触角・鋏の付け根も、同じ鋏で挟める（引っこ抜き。抜けた後は挟めない）
  grab.creatures.push(buddy.tug);
  const findRanges: ({ v0: number; vn: number } | null)[] = [];
  const findsMesh = buildFindsMesh(finds, built.light, findRanges);
  const view = new AquariumRenderer(canvas, world, built.meshes, crabMesh, plants.set, rig, {
    finds,
    findsMesh,
    glowMesh: buildGlowMesh(finds),
    fishMesh: buildFishMesh(),
    shrimpMesh: buildShrimpMesh(),
    life,
    buddy: { sys: buddy, mesh: buildBuddyMesh(), burrowMesh: buildBurrowMesh(world, built.light, BURROW_XZ[0], BURROW_XZ[1]) },
    props: { sys: props, meshes: buildPropMeshes() },
    worms,
  }, { light: built.light, plantAnchors: plants.anchors });
  {
    const gl = view.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    diag(`renderer created ${(performance.now() - t0).toFixed(0)}ms gl=${glName} parallelCompile=${!!gl.getExtension('KHR_parallel_shader_compile')} tris=${view.stats.tris}`);
  }
  // 描画の喪失と復旧（AquaGpuGuard）。シェーダーは最初のフレームより前に 1 つずつ作る（view.prepare）
  let skipPrepare = false;
  const gpu = new GpuGuard(canvas, view.renderer.getContext(), () =>
    skipPrepare ? ((skipPrepare = false), Promise.resolve({ programs: 0, ms: 0, slowest: [], lost: false })) : view.prepare(settings, (d, n) => (loading.textContent = `描画を準備しています… ${d} / ${n}`)),
  );
  // 水草をかき分ける（第 3 段階）：植物ごとのしなり（近くの植物だけばねで動かす。設定で GPU だけの方式と比べられる）
  const plantField = new PlantField(plants.plants);
  view.surfel.enablePlantBend(plants.plants.plantId, plantField.uniforms);
  // 検証エリアの石の床の下の植物・景色の小石は隠す（床を突き抜けて見えない・挟めない）
  {
    const fr = floorRect(blocksArea.floor), T = plantField.table;
    for (let i = 0; i < plantField.removed.length; i++) {
      const x = T.root[i * 3], y = T.root[i * 3 + 1], z = T.root[i * 3 + 2];
      if (x > fr.x0 - 0.05 && x < fr.x1 + 0.05 && z > fr.z0 - 0.05 && z < fr.z1 + 0.05 && y < fr.top + 0.05) plantField.removed[i] = 1;
    }
    view.digFx.hideInRect(fr.x0 - 0.05, fr.x1 + 0.05, fr.z0 - 0.05, fr.z1 + 0.05, fr.top);
  }
  /** 水草を押す球：カニの体（脚の広がり）と、挟んでいる物・動いている物 */
  const pushers: Pusher[] = [];
  const updatePlants = (dt: number) => {
    pushers.length = 0;
    const R = crab.radius;
    // 体：中心は体の中心より少し下（脚の付け根）、半径は脚の広がり。速さはカニの速さ
    pushers.push({ x: crab.x, y: crab.y + R * 0.7, z: crab.z, r: R * 1.75, vx: crab.vx, vy: crab.vy, vz: crab.vz });
    for (const pr of props.props) {
      if (!pr.held && !pr.awake) continue;
      const sp = Math.hypot(pr.v[0], pr.v[1], pr.v[2]);
      if (!pr.held && sp < 0.05) continue;
      pushers.push({ x: pr.p[0], y: pr.p[1], z: pr.p[2], r: pr.rb * 1.15, vx: pr.v[0], vy: pr.v[1], vz: pr.v[2] });
      if (pushers.length >= 6) break;
    }
    // 見通しの線：冒険カメラ → カニの体の中心（密集した水草の中でもカニを見失わないよう、線にかかる草もそっとよける）
    const P = camera.pose.pos;
    const sight = camera.mode === 'adventure' ? { a: [P[0], P[1], P[2]] as [number, number, number], b: [crab.x, crab.y + R, crab.z] as [number, number, number], r: 0.32 } : null;
    plantField.update(dt, pushers, sight);
  };
  // 景色の小石（約 520 個）と水槽の中の発見物の貝殻・巻貝も、どれでも挟める（挟んだ瞬間だけ物理の物にする：AquaDecor）
  const decor = new DecorProps(props, [
    { geo: view.decorGeo.pebbles, items: built.meshes.pebbleList.map(pebbleDecor) },
    {
      geo: view.decorGeo.finds,
      items: finds.flatMap((f, i) => {
        const r = findRanges[i];
        return r && world.regionAt(f.pos[0], f.pos[1] + 0.05, f.pos[2]) === 'tank' ? [findDecor(f, r)] : [];
      }),
    },
  ]);
  grab.ghosts = () => decor.ghosts();
  grab.promote = (pr) => decor.promote(pr);
  // 左の小さな鋏（ゲームパッドの左トリガー）：右と同じ仕組みの 2 本目。物の時間は 2 本で 1 回だけ進める（PropSystem.updateMany）
  const grabL = new GrabSystem(world, props);
  grabL.armReach = ARM_REACH / CLAWS.scale.R * CLAWS.scale.L;
  grabL.creatures.push(buddy.tug);
  grabL.ghosts = grab.ghosts;
  grabL.promote = grab.promote;
  grab.other = grabL;
  grabL.other = grab;
  // ハサミ集中モード（AquaClawFocus）：カニはその場に留まり、左右の腕を独立して動かす・開閉する
  const focus = new ClawFocus(world, props, rig, crab, camera, grab, grabL);
  // 第 5 段階：水草を挟む・引く・抜く・ちぎる（かけらはそのまま挟んで運べる）と、エビ・小魚を捕まえる（左右の鋏とも）
  const weeds = new WeedPieces(plantField, view.surfel, props, plants.set.pos);
  const onDetach = (G: GS) => (d: Detach) => {
    const T = plantField.table;
    // 抜けた：根元の砂が舞う。ちぎれた：小さな泡。どちらも短い音
    if (d.cutY === null) view.tugFx('crumble', T.root[d.i * 3], T.root[d.i * 3 + 1], T.root[d.i * 3 + 2], 8, null);
    else view.tugFx('bubble', d.at[0], d.at[1], d.at[2], 3);
    audio.pop(d.cutY === null ? 0.35 : 0.2);
    weeds.spawn(d, G);
  };
  const plantGrabR = new PlantGrab(plantField, onDetach(grab)), plantGrabL = new PlantGrab(plantField, onDetach(grabL));
  const lifeGrabR = new LifeGrab(life, world), lifeGrabL = new LifeGrab(life, world);
  grab.creatures.push(lifeGrabR, plantGrabR);
  grabL.creatures.push(lifeGrabL, plantGrabL);
  // ゴカイ：外に出ている体のどこでも、左右どちらの鋏でも挟める（1 匹を 2 本で同時には挟まない）。
  // 保存から戻して個体を作り直したら入れ替える
  for (const w of worms.worms) grab.creatures.push(w), grabL.creatures.push(w);
  const swapWorms = (sw: { from: Worm; to: Worm }[]) => {
    for (const G of [grab, grabL]) for (const { from, to } of sw) {
      const k = G.creatures.indexOf(from);
      if (k >= 0) G.creatures[k] = to;
    }
  };
  // ---------------- 食事（AquaEat）：挟んだ物を口元へ運んで食べる・栄養 ----------------
  // 岩・流木の水中の苔（藻）は、岩をつかんだまま「食べる」でむしり取れる（むしった跡はしばらくして生え戻る）
  const algae = new AlgaeBeds(view.surfel, plants.set.pos, plants.tag, weeds);
  const eat = new EatSystem();
  /** 物・生き物ごとの食べ物の窓口（同じ物には同じ窓口） */
  const foodOf = new WeakMap<object, Food>();
  const cachedFood = (key: object, make: () => Food): Food => {
    let f = foodOf.get(key);
    if (!f) foodOf.set(key, (f = make()));
    return f;
  };
  /** いま物・生き物を挟んでいる鋏（食べ終えたときに空にする） */
  const clawHolding = (o: unknown): GS | null => [grab, grabL].find((G) => G.holding === o || G.holdingCreature === o) ?? null;
  /** 水草のかけら・むしった藻（物） */
  const propFood = (pr: Prop): Food =>
    cachedFood(pr, () => ({
      id: pr.id,
      kind: pr.food!.kind,
      name: pr.food!.kind === 'algae' ? '藻' : pr.name,
      size: pr.food!.size,
      get left() {
        return pr.left;
      },
      begin() {},
      setLeft(v: number) {
        pr.left = v;
      },
      finish() {
        clawHolding(pr)?.consume();
        weeds.remove(pr);
      },
      at: () => pr.p,
    }));
  /** 捕まえたエビ・小魚（1 口目から動かなくなり、残りに合わせて小さくなる。食べ終えると消える） */
  const critterFood = (kind: 'fish' | 'shrimp', b: Fish | Shrimp, LG: LifeGrab): Food =>
    cachedFood(b, () => ({
      id: `${kind}${kind === 'fish' ? life.fish.indexOf(b as Fish) : life.shrimp.indexOf(b as Shrimp)}`,
      kind,
      name: FOOD_KIND[kind].name,
      size: 1,
      get left() {
        return b.eat?.left ?? 1;
      },
      begin() {
        b.eat ??= { left: 1, gone: false, vy: 0 };
        // 動かなくなった：しっかり持てる
        LG.grip = Math.max(LG.grip, 12);
      },
      setLeft(v: number) {
        b.eat ??= { left: 1, gone: false, vy: 0 };
        b.eat.left = v;
      },
      finish() {
        b.eat ??= { left: 0, gone: true, vy: 0 };
        b.eat.left = 0;
        b.eat.gone = true;
        clawHolding(LG)?.consume();
      },
      at: () => [b.x, b.y + (kind === 'shrimp' ? 0.04 : 0), b.z],
    }));
  /** 引き抜いたゴカイ（1 口目から動かなくなり、残りに合わせて体が短くなる。食べ終えると消える） */
  const wormFood = (w: Worm): Food =>
    cachedFood(w, () => ({
      id: w.id,
      kind: 'worm',
      name: WORM_NAME,
      size: (w.traits.len / 0.87) * w.traits.thick,
      get left() {
        return w.left;
      },
      begin() {
        w.kill();
      },
      setLeft(v: number) {
        w.left = v;
      },
      finish() {
        clawHolding(w)?.consume();
        w.vanish();
      },
      at: () => w.gripPoint(),
    }));
  /**
   * 仲間は食べない（いまはスナモグリ。将来の仲間は GrabCreature の companion で宣言する）。仲間になる前の巣穴の個体も
   * 巣穴に踏ん張っているので食べない
   */
  const isCompanion = (cr: GrabCreature): boolean => (cr === buddy.tug && buddy.found) || (cr as { companion?: boolean }).companion === true;
  /** 鋏 G が挟んでいる物から、食べる対象を決める（null = 食べる操作の対象外：何も挟んでいない・根の付いた水草） */
  const eatTarget = (G: GS, LG: LifeGrab, PG: PlantGrab): EatTarget | null => {
    if (G.state !== 'holding') return null;
    const pr = G.holding;
    if (pr) return pr.food ? { kind: 'food', food: propFood(pr) } : { kind: 'refuse', why: 'inedible', bring: pr.mass < 0.5, name: pr.name };
    const cr = G.holdingCreature;
    if (!cr || cr === PG) return null;
    if (isCompanion(cr)) return { kind: 'refuse', why: 'companion', bring: false, name: cr === buddy.tug ? BUDDY_NAME : cr.name };
    if (cr === buddy.tug) return { kind: 'refuse', why: 'anchored', bring: false, name: '巣穴の生き物' };
    if (cr === G.fixed) {
      return {
        kind: 'scrape',
        scrape: () => {
          const p = algae.scrape(G.fixed.p, G);
          return p ? propFood(p) : null;
        },
      };
    }
    if (cr === LG && LG.held) return { kind: 'food', food: critterFood(LG.held.kind, LG.held.c, LG) };
    const w = worms.worms.find((x) => x === cr);
    if (w) return w.anchored ? { kind: 'refuse', why: 'anchored', bring: false, name: w.name } : { kind: 'food', food: wormFood(w) };
    return null;
  };
  const eatClaws = (): EatClaw[] => [
    { side: 'R', target: eatTarget(grab, lifeGrabR, plantGrabR) },
    { side: 'L', target: eatTarget(grabL, lifeGrabL, plantGrabL) },
  ];
  /** 食べている鋏・手伝う鋏（右 / 左の GrabSystem） */
  const eatG = () => (eat.side === 'R' ? grab : eat.side === 'L' ? grabL : null);
  // 効果音（最初に画面に触れた・キーを押したときに鳴らせるようになる）
  const audio = new AquaAudio();
  view.digFx.pebbleLost = (k) => decor.pebbleLost(k);
  const buildMs = performance.now() - t0;

  // ---------------- 画面の表示 ----------------
  const touch = isTouchDevice();
  const diagMode = new URLSearchParams(location.search).has('diag');
  // 左上の表示：ふだんは小さく（場所・砂・必要なときの状態）。FPS などは「詳細」の欄（?diag では開いた状態で始める）
  const hud = new AquaHud({ forceDetail: diagMode });
  // 表示の設定（ボタンの大きさ・濃さ、案内の輪や文字を出すか）。?diag では案内も出す
  const uiPrefs = new UiPrefStore(diagMode ? { guides: true } : {});
  const footDiag = new FootDiag();
  /** 操作・対象物についての知らせ（案内を出す設定のときだけ。保存の失敗などの警告は toast で常に出す） */
  const guideToast = (msg: string) => {
    if (uiPrefs.prefs.guides) toast(msg);
  };
  // 操作の説明（右上の「？」で開く。初回だけ自動で出し、「×」で閉じたら次からは出さない）。欄は右上のメニューを作った後に作る
  const helpBrief = touch
    ? `<p>左のスティックで歩く。右のボタンは絵のとおり：跳ぶ・ダッシュ・掘る（切り替えで盛る。何かを挟んでいる間は 食べる）・ハサミ（たたくと閉じる / もう一度で開く。スティックの上の小さい方は左のハサミ）・視点（長押しで一覧）。右上の「集中」で左右の腕を自由に動かすハサミ集中モード。画面をドラッグで見回す。</p><p class="hint">詳しい操作は、右上の「？」でいつでも見られます。</p>`
    : `<p><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 歩く・<kbd>Shift</kbd> 走る・<kbd>Space</kbd> 跳ぶ・<kbd>F</kbd> 掘る・<kbd>E</kbd> / <kbd>Q</kbd> 押している間 右 / 左のハサミで挟む（挟んだまま <kbd>F</kbd> 食べる）・<kbd>Tab</kbd> ハサミ集中モード・<kbd>V</kbd> 視点（長押しで一覧）。ドラッグで見回し、ホイールでズーム。</p><p class="hint">詳しい操作は、右上の「？」でいつでも見られます。</p>`;
  const helpFull = touch
    ? `<ul><li>ボタンの絵：地面から上への矢印 ジャンプ、流れる線と » ダッシュ、くぼみへ↓と砂粒 掘る（砂山へ↓ は盛る。水草を挟んでいる間は 切れ目 = ちぎる・根と↑ = 抜く）、カニのハサミ 挟む（閉じた絵 = 挟んでいる）、いまの視点の絵 視点の切り替え、小さな横長 掘る ↔ 盛る。「🔊」の欄の「ボタンの名前を表示」で名前も出せる</li><li>左スティック：移動。ダッシュ：押している間</li><li>ジャンプ：跳ぶ（水中で長押し＝遊泳。壁では離れる）</li><li>壁登り：岩・流木・土の壁へスティックを倒し続けると張り付く（壁へ＝上、手前＝下、左右＝横。離すとその場で止まる）。そのまま張り出し・岩や流木の裏・トンネルの天井まで逆さで歩ける（張り出しへはその向きへ押し続けると回り込む。跳んで天井に触れるとつかまる。ジャンプで離れる。「案内を出す」にすると、逆さの間はカニの横の矢印がスティック↑の向き）</li><li>掘る：押している間 前の砂を掘る。押したまま指をずらすと、その向き（上・下・左右・斜め）を掘る。掘りながらスティックで好きな向きへ動ける</li><li>盛る：「掘る」ボタンの上の切り替えで「盛る」にすると、同じボタンで手持ちの砂を置ける（押している間 少しずつ積もる。黄緑の輪 = 置ける所、赤 = 置けない）。砂は掘ると集まる（左上の「砂」。上限あり）</li><li>画面ドラッグ：視点の回転。2 本指：カメラのズーム</li><li>視点：短く押すと 三人称 → 肩越し → 自由追従 → ガラス越し（水槽の外から地下の穴を観察）→ 箱庭 → 三人称 の順に切り替わり、切り替えた視点の名前が少しだけ出る。長押しで視点の一覧（いまの視点に印。押したまま指を滑らせて離すか、たたいて選ぶ。「従来」も一覧から）</li><li>挟む：1 回たたくと右の大きなハサミを閉じ（ボタンが明るく「離す」になる）、もう一度たたくと開く。閉じたままジャンプ・ダッシュ・移動・視点の操作ができる。景色の小石・貝殻はどれでも挟める。水草の茎・葉も挟める（引っ張るほど大きくしなって抵抗し、カニが引き戻される。離すとビヨーンと戻る。引くだけでは抜けない：引っ張りすぎるとハサミが滑る。挟んだまま「掘る」ボタン（ちぎる / 抜くの絵になる）を押すと、高い所を挟んだテープ状の葉・有茎草はちぎれ、それ以外は引っ張っている間だけ根元から抜ける。抜いた・ちぎった草は運べる）。エビ・小魚も、ゆっくり近づいて素早く挟めば捕まえられる（暴れて逃げることもある）。挟んだまま歩く・泳ぐと引っ張られてついてくる。重い石は持ち上がらず引きずる（大きな石・岩・流木は動かず、カニの方が引き戻される）。閉じたまま近くの物へ寄ると、ハサミがそちらを向いて挟む。ふだんは輪や名前を出さない（触れて・挟んでみると、動き・重さ・音で分かる。「🔊」の欄の「案内を出す」で、挟める所の輪・物の名前を出せる）</li><li>左のハサミ：スティックの上の小さい「挟む」（たたくと閉じる / もう一度で開く）。左右で別々の物も、1 つの物の 2 か所も挟める</li><li>ハサミ集中モード：右上の「集中」で入る（「通常へ」で戻る）。カニはその場に留まり、左のスティック = 左の腕・右のスティック = 右の腕。それぞれのスティックの上の外側のボタンを押している間 そのハサミを閉じる（人差し指で押せる。「🔊」の欄でたたいて切り替える方式にもできる）。スティックの内側の細いつまみを上下にずらすと高さ。「動かし方」で腕の動かし方を切り替え。画面のドラッグ 視点・2 本指 ズーム。挟んでいる物は切り替えても落とさない</li><li>引っこ抜く：巣穴から見えている触角を「挟む」で挟み（閉じたまま穴へ近づくと、ハサミが触角を向く）、スティックで後ろへ下がって引っ張る（押しているだけでは抜けない）。暴れているときに引きすぎるとハサミが滑る（震えたら少しゆるめる）。力が抜けた隙に引くと出てくる。離すと穴へ戻っていく</li><li>食べる：ハサミで挟んだまま「掘る」ボタン（食べるの絵になる）を押している間、口元へ運んで少しずつ食べる（離すと中断。もう一度押すと続きから。「挟む」を開くと食べかけを落とす）。藻（岩・流木をつかんだまま押すと、そこの苔をむしる）・ちぎった水草・捕まえたエビ / 小魚・引き抜いたゴカイを食べられる。捕まえた生き物は、食べずに「挟む」を開けば逃がせる。小石・貝殻は口元で確かめて押し戻す。仲間は食べない。食べると左上の「栄養」が増える（減らない）</li><li>仲間：右上のボタンで「呼ぶ（同行）/ 自由に暮らす」を切り替え</li><li>右上の「セーブ」：進捗は自動で保存（書き出し・読み込み・初期状態に戻す）</li><li>右上の「？」：この説明</li><li>ゲームパッド：左スティック 移動、右スティック 腕（両ハサミ）の向き、LT / L2 左ハサミ・RT / R2 右ハサミ（押している間。押し込むほど強く握る）、左右のスティックの同時押し ハサミ集中モード（左スティック = 左の腕・右スティック = 右の腕・LT / RT 押し込んだ分だけ閉じる＝触れた後は握る力・LB / RB を押したままスティック 高さと手首・十字キー カメラ・Y / △ 腕の動かし方・B / ○ で戻る）、A / × ジャンプ、B / ○ ダッシュ、X / □ 掘る・盛る（押している間は右スティックで掘る向き）、Y / △ 掘る ↔ 盛る、RB / R1 次の視点、左スティック押し込み 肩越し ↔ 三人称、水草を挟んだまま X / □ ちぎる・抜く、ほかの物を挟んだまま X / □ 押している間 食べる、LB / L1 を押したまま右スティック・十字キーでカメラ、Back 仲間、Start 説明</li><li>右上の「🔊」：音と設定（消音・音量、操作ボタンの大きさ・濃さ、カメラの方式、歩き方（接地 IK / 従来）と接地の診断、水草のかき分け、案内の表示。最初に画面に触れると音が出せるようになる）</li><li>左上の「詳細」：区画・発見の数・FPS・画面の倍率の記録など（× で閉じる）</li></ul><p class="hint">光る石・湧く泡をたよりに、隠れた場所を探そう。水面の丸い穴は、水槽の下へ続いている。岸辺の斜面の砂は深く、トンネルを掘れる</p>`
    : `<ul><li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移動　<kbd>Shift</kbd> 走る</li><li><kbd>Space</kbd> ジャンプ（水中で長押し＝遊泳。壁では離れる）</li><li>壁登り：岩・流木・土の壁へ押し続けると張り付く（壁へ＝上、手前＝下、左右＝横。離すとその場で止まる）。そのまま張り出し・岩や流木の裏・トンネルの天井まで逆さで歩ける（跳んで・泳いで天井に触れても張り付く。<kbd>Space</kbd> で離れる）</li><li><kbd>F</kbd> 長押し：掘る（押したままマウスを動かすと上下左右・斜めを狙う。掘りながら <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> で好きな向きへ動ける）</li><li>右ボタンを押したままドラッグ：その向きを掘る</li><li><kbd>G</kbd> 掘る ↔ 盛る の切り替え。盛るのときは <kbd>F</kbd> 長押しで手持ちの砂を置く（少しずつ積もる。黄緑の輪 = 置ける所、赤 = 置けない）。砂は掘ると集まる（左上の「砂」。上限あり）</li><li>ドラッグ：視点回転　ホイール：ズーム</li><li><kbd>V</kbd> 次の視点（三人称 → 肩越し → 自由追従 → ガラス越し → 箱庭。ガラス越しはガラス際まで掘った穴を外から観察）。<kbd>V</kbd> 長押しで視点の一覧（<kbd>1</kbd>〜<kbd>6</kbd> かクリックで選ぶ・<kbd>Esc</kbd> で閉じる）　<kbd>C</kbd> 肩越し ↔ 三人称　<kbd>R</kbd> スタート地点へ</li><li><kbd>E</kbd> 押している間：右の大きなハサミを閉じて、届く所の小石・貝殻を挟む（離すと放す）。景色の小石・貝殻はどれでも挟める。水草の茎・葉も挟める（引っ張るほどしなって抵抗し、離すとビヨーンと戻る。引くだけでは抜けない。挟んだまま <kbd>F</kbd> で、高い所を挟んだ葉はちぎれ、それ以外は引っ張りながらなら根元から抜ける。抜いた草は運べる）。エビ・小魚も、ゆっくり近づいて素早く挟めば捕まえられる。押したままマウスを動かすと腕（ハサミ）の向きを右・左・上・下へ変えられる。挟んだまま歩く・泳ぐと引っ張られてついてくる。重い石は持ち上がらず引きずる（大きな石・岩・流木は動かず、カニの方が引き戻される）。ふだんは輪や名前を出さない（触れて・挟んでみると、動き・重さ・音で分かる。「🔊」の欄の「案内を出す」で、挟める所の輪・物の名前を出せる）</li><li>引っこ抜く：巣穴から見えている触角を <kbd>E</kbd> で挟み、押したまま <kbd>S</kbd> などで後ろへ下がって引っ張る（押しているだけでは抜けない）。暴れているときに引きすぎる（<kbd>Shift</kbd> で急に引く等）とハサミが滑る（震えたら少しゆるめる）。力が抜けた隙に引くと出てくる。離すと穴へ戻っていく　<kbd>B</kbd> 仲間を呼ぶ / 自由に暮らす（右上のボタンでも。以前の <kbd>Q</kbd> は左のハサミになった）</li><li><kbd>Q</kbd> 押している間：左の小さなハサミで挟む（<kbd>E</kbd> の右と同じ。押したままマウスを動かすと左の腕だけ向きを変える）。左右で別々の物も、1 つの物の 2 か所も挟める</li><li><kbd>Tab</kbd> ハサミ集中モード（右上の「集中」でも。<kbd>Tab</kbd> / <kbd>Esc</kbd> で戻る）：カニはその場に留まり、左右の腕を別々に動かす。<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 左の腕・<kbd>Q</kbd> / <kbd>E</kbd> 左の高さ・<kbd>Z</kbd> / <kbd>X</kbd> 左の手首・左 <kbd>Shift</kbd> 押している間 左を閉じる。マウス 右の腕（方向キーでも）・左ボタン 押している間 右を閉じる・右ボタンを押したまま上下 右の高さ（左右で手首）。中ボタンのドラッグ 視点・ホイール ズーム・<kbd>M</kbd> 腕の動かし方（面に沿う / 床に沿う＋高さ / 画面に沿う）。挟んでいる物は切り替えても落とさない（押し直すまで持っている）</li><li>食べる：<kbd>E</kbd> で挟んだまま <kbd>F</kbd>（またはマウスの右ボタン）を押している間、口元へ運んで少しずつ食べる（離すと中断。もう一度押すと続きから。<kbd>E</kbd> を離すと食べかけを落とす）。藻（岩・流木をつかんだまま押すと、そこの苔をむしる）・ちぎった水草・捕まえたエビ / 小魚・引き抜いたゴカイを食べられる。捕まえた生き物は、食べずに <kbd>E</kbd> を離せば逃がせる。小石・貝殻は口元で確かめて押し戻す。仲間は食べない。食べると左上の「栄養」が増える（減らない）</li><li>右上の「セーブ」：進捗は自動で保存（書き出し・読み込み・初期状態に戻す）</li><li><kbd>H</kbd> または右上の「？」：この説明の表示 / 非表示</li><li>ゲームパッド：左スティック 移動、右スティック 腕（両ハサミ）の向き、LT / L2 左ハサミ・RT / R2 右ハサミ（押している間。押し込むほど強く握る）、左右のスティックの同時押し ハサミ集中モード（左スティック = 左の腕・右スティック = 右の腕・LT / RT 押し込んだ分だけ閉じる＝触れた後は握る力・LB / RB を押したままスティック 高さと手首・十字キー カメラ・Y / △ 腕の動かし方・B / ○ で戻る）、A / × ジャンプ、B / ○ ダッシュ、X / □ 掘る・盛る（押している間は右スティックで掘る向き）、Y / △ 掘る ↔ 盛る、RB / R1 次の視点、左スティック押し込み 肩越し ↔ 三人称、水草を挟んだまま X / □ ちぎる・抜く、ほかの物を挟んだまま X / □ 押している間 食べる、LB / L1 を押したまま右スティック・十字キーでカメラ、Back 仲間、Start 説明</li><li>右上の「🔊」：音と設定（消音・音量、操作ボタンの大きさ・濃さ、カメラの方式、歩き方（接地 IK / 従来）と接地の診断、水草のかき分け、案内の表示。最初に画面に触れると音が出せるようになる）</li><li><kbd>I</kbd> または左上の「詳細」：区画・発見の数・FPS・画面の倍率の記録などの表示 / 非表示</li></ul><p class="hint">光る石・湧く泡をたよりに、隠れた場所を探そう。見晴らしの良い所で立ち止まると景色を眺めます。水面の丸い穴は、水槽の下へ続いている。岸辺の斜面の砂は深く、トンネルを掘れる</p>`;
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

  // ---------------- 視点（第 6 段階：冒険カメラの方式とカメラの種類を 1 列の視点にまとめる。AquaCamPicker.ts） ----------------
  const viewToast = new ViewToast(touch ? '長押しで視点の一覧' : 'V 長押しで視点の一覧');
  /**
   * 切り替えた直後の移動の基準（null = カメラの向き）：スティック・キーを倒したまま視点を変えても、離すまでは前の向きのまま
   * 進む（切り替えた瞬間にカニが急に向きを変えない）。離す・大きく倒し直すと新しい視点の向きになる
   */
  let moveLatch: { yaw: number; ang: number } | null = null;
  const setView = (v: CamView) => {
    const before = camera.view, yaw0 = camera.yaw;
    // 冒険カメラの方式は設定に覚える（ガラス越し・箱庭から戻るときの方式）
    if (v !== 'observe' && v !== 'diorama') uiPrefs.set({ camStyle: v });
    camera.setView(v, crab);
    picker.render();
    const now = camera.view;
    if (now === before) return;
    viewToast.show(now);
    touchUi?.setButton('cam', VIEW_ICON[now]);
    const mv = input.moveAxis();
    if (Math.hypot(mv.x, mv.y) > 0.2 && Math.abs(Math.atan2(Math.sin(camera.yaw - yaw0), Math.cos(camera.yaw - yaw0))) > 0.05) moveLatch = { yaw: yaw0, ang: Math.atan2(mv.x, mv.y) };
  };
  const picker = new ViewPicker(() => camera.view, (v) => setView(v), touch);
  /** 短く押した：次の視点（一覧が開いていれば閉じるだけ） */
  const cycleView = (dir = 1) => {
    if (picker.isOpen) return picker.close();
    setView(nextView(camera.view, dir));
  };
  // V：離したときに次の視点、0.4 秒押し続けたら一覧（tick で見る）。一覧が開いている間は 1〜6 で選ぶ・Esc で閉じる
  let vDown = -1;
  input.onPress('KeyV', () => (vDown = 0));
  for (let k = 1; k <= 6; k++) input.onPress(`Digit${k}`, () => picker.chooseIndex(k - 1));
  input.onPress('Escape', () => picker.close());
  // 肩越し ↔ 三人称（C キー・ゲームパッドの左スティック押し込み。ガラス越し・箱庭からは肩越しへ）
  const toggleClose = () => setView(camera.view === 'close' ? camera.style : 'close');
  input.onPress('KeyC', toggleClose);
  input.onPress('KeyH', () => help?.toggle());
  input.onPress('KeyI', () => hud.toggle());
  input.onPress('KeyR', () => {
    setFocus(false);
    eat.reset();
    grab.release();
    grabL.release();
    touchUi?.setGrabLatched(false);
    touchUi?.setGrabLatched(false, 'L');
    crab.teleport(world.spawn.x, world.spawn.z);
  });
  /** ハサミ集中モードへ入る・戻る（下で中身を決める：画面の切り替え・ポインターの固定・スマホの操作） */
  let setFocus: (on: boolean) => void = () => {};
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
    // 水草の森の中（第 3 段階の検証）
    forest: [-11.0, -6.6, 6],
    // 積み木・物理パズルの検証エリアの手前
    blocks: [BLOCKS_XZ[0], BLOCKS_XZ[1] - 1.5, 6],
  };
  const goto = (name: string) => {
    const p = places[name];
    if (p) {
      setFocus(false);
      eat.reset();
      grab.release();
      grabL.release();
      // スマホの「挟む」スイッチも開く（瞬間移動の後に閉じたままにしない）
      touchUi?.setGrabLatched(false);
      touchUi?.setGrabLatched(false, 'L');
    }
    if (p) crab.teleport(p[0], p[1], world.contactSurfaceBelow(p[0], p[2], p[1]) + 0.02);
    return crab.region;
  };
  let touchUi: TouchControls | null = null;
  if (touch) {
    // （巣穴の生き物も「挟む」で挟んで引っ張る。以前の「調べる / 引っこ抜く」ボタンは使わない）
    // カメラのボタン：短く押す = 次の視点、長押し = 視点の一覧（押したまま指を滑らせて離すと選ぶ）
    touchUi = new TouchControls(input, {
      runLabel: 'ダッシュ', jump: true, dig: true, grab: true, grabL: true, icons: true,
      onCamera: () => cycleView(1),
      onCameraHold: () => picker.open(),
      onCameraDrag: (x, y, end) => picker.drag(x, y, end),
    });
    touchUi.setButton('cam', VIEW_ICON[camera.view]);
    document.body.classList.add('touch');
  }
  // 初めて遊ぶとき（説明を閉じたことが無い）は、ボタンの名前をしばらく出す（説明を閉じてから 12 秒で消える）
  let coachT = touch && localStorage.getItem(HELP_KEY) !== 'closed' ? Infinity : 0;
  uiPrefs.onChange((p) => {
    touchUi?.setLook(p.btnScale, p.btnAlpha);
    touchUi?.setLabels(p.labels || coachT > 0);
    camera.setStyle(p.camStyle);
    touchUi?.setButton('cam', VIEW_ICON[camera.view]);
    if (worms.feel !== p.wormFeel) worms.setFeel(p.wormFeel);
    if (rig.gait !== p.gait) {
      rig.gait = p.gait;
      rig.feet?.reset();
    }
    footDiag.on = p.footDiag || diagMode;
    plantField.setMode(p.plants);
    document.body.classList.toggle('aqua-guides', p.guides);
  });
  // 掘る ↔ 盛る：PC は G キー、スマホは掘るボタンの上の小さな切り替え（掘るボタン・F キーはどちらでも共用）
  // （切り替えは掘る・盛るの 2 つの印。いま使う方が明るい。下の細い帯が手持ちの砂の量）
  const toolBtn = document.createElement('button');
  toolBtn.type = 'button';
  toolBtn.className = 'tb tool';
  toolBtn.innerHTML = `<span class="face">${touchIcon('dig', 'i-dig')}${touchIcon('fill', 'i-fill')}</span>`;
  const showTool = () => {
    const fill = crab.tool === 'fill';
    toolBtn.classList.toggle('fill', fill);
    toolBtn.setAttribute('aria-label', fill ? '盛る（たたくと掘るへ）' : '掘る（たたくと盛るへ）');
    const dg = touchUi?.root.querySelector('.dig');
    dg?.classList.toggle('fill', fill);
    dg?.setAttribute('aria-label', fill ? '盛る' : '掘る');
    document.body.classList.toggle('tool-fill', fill);
  };
  const toggleTool = () => {
    crab.toggleTool();
    showTool();
    guideToast(crab.tool === 'fill' ? `盛る：手持ちの砂を置く（${touch ? '「盛る」ボタン' : 'F キー'}を押している間）` : '掘る：砂を掘って集める');
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
  // 手持ちの砂の帯（上限が無いので、持っている量の目安：2 で約 63%、6 で約 95%）
  const sandBar = (v: number) => 1 - Math.exp(-v / 2);
  const saveCtx: SaveContext = {
    spotIds: new Set(spots.map((s) => s.id)),
    // 仲間の一覧（buddies）にゴカイの個体も入れる（species = 'gokai'。体長・太さ・体色・砂の中か外かは traits）
    buddyIds: new Set([BUDDY_ID, ...worms.ids]),
    tankIds: new Set([HOME_TANK]),
    maxPrims: DIG.maxPrims,
    maxR: DIG.rMax,
    sandCap: SAND.maxStore,
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
  const restoreInfo = { status: loaded.status, prims: 0, restoreMs: 0, flushMs: 0, loadMs, playerFallback: false, blocks: 0 };
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
    // ゴカイ：見つけたか・砂の中なら巣穴の口・外なら頭の位置と向き・個体差（地形を戻した後なので、掘った穴・盛った砂に合わせて置く）
    swapWorms(worms.restore(d.buddies));
    // 栄養（版 3）と、食べられたエビ・小魚（食べかけは底に横たわったまま・食べ終えた個体は消えたまま）
    eat.nutrition.restore(d.player.nutrition);
    if (tank) life.restoreEaten(tank.food.critters);
    // 積み木の検証エリア（版 4）：置いた・組み立てた位置と向き
    if (tank) restoreInfo.blocks = restoreBlocks(props, blocks, tank.props);
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
    if (P.camera !== 'adventure') camera.setView(P.camera, crab);
  }
  diag(`save loaded store=${store.kind} status=${loaded.status} prims=${restoreInfo.prims} sand=${crab.sandHeld.toFixed(2)} flush=${restoreInfo.flushMs.toFixed(0)}ms at ${(performance.now() - t0).toFixed(0)}ms`);
  showTool();
  // 第 10 段階（救済）：手持ちの砂を、地形から「掘って手元にあるはずの量」と見比べ、少なければ戻す（以前の版の持てる量の上限 4 で
  // 捨てた砂があっても、掘った穴を埋め直せる）。フレームに分けて測る。手持ちが 0 で盛ろうとしたときにも見直す
  crab.onSandRescue = (v) => toast(`砂を ${Math.floor(v / SAND.unit)} 杯ぶん手持ちに戻しました（掘った地形から数え直し）`);
  if (world.dig.count > 0) crab.auditSand(true);
  const bootNote =
    loaded.status === 'recovered' ? `保存データが壊れていたため、1 つ前のデータから再開しました（${loaded.error}）。壊れたデータは別に残しています。`
    : loaded.status === 'corrupt' ? `保存データを読み込めなかったため、初期状態で始めました（${loaded.error}）。読めなかったデータは別に残しています。`
    : store.info.fallback?.result === 'imported' ? '前回は保存先（IndexedDB）を開けなかったため、予備の保存先（localStorage）に保存していました。その進捗を引き継いで再開しました。'
    : store.info.fallback?.result === 'kept' ? `前回は保存先（IndexedDB）を開けず、予備の保存先（localStorage）に保存していました。両方に別の進捗があったため、保存した時刻が新しい方（${store.info.fallback.chosen === 'localStorage' ? '前回の起動' : 'IndexedDB'}の進捗）で再開し、もう一方は消さずに残しました。下のボタンで書き出す・切り替えることができます。`
    : store.info.alt ? '以前の引き継ぎで残したもう一方の進捗があります。下のボタンで書き出す・切り替えることができます。'
    : store.kind === 'localStorage' ? '保存先（IndexedDB）を開けなかったため、予備の保存先（localStorage）に保存しています。IndexedDB に以前の進捗があっても消えてはいません。次に IndexedDB を開けた起動で自動で引き継ぎます（両方に進捗があれば両方残します）。'
    : store.info.fromJournal ? '前回は閉じる・読み込み直す直前の保存が終わらなかったため、その直前の控えから再開しました（進捗は失われていません）。'
    : store.info.orphan ? '前回閉じる直前の進捗（控え）は、別のタブの保存の方が新しかったため使いませんでした。「使わなかった進捗を書き出す」でファイルに残せます。'
    : noSave ? '自動検証のため保存しません（?nosave）。'
    : null;
  // 知らせは利用者が気にすべきときだけ（控えから戻したのは、再読み込み・タブを閉じたときのふつうの流れなので出さない）
  const bootToast = loaded.status === 'recovered' ? '保存データを 1 つ前から復元しました' : loaded.status === 'corrupt' ? '保存データを読めず、初期状態で始めました'
    : store.info.fallback?.result === 'kept' ? '別の保存先にも進捗がありました。両方残しています（セーブのメニュー）'
    : store.info.fallback?.result === 'imported' ? '予備の保存先の進捗を引き継ぎました'
    // 予備の保存先へ落ちた起動で、そこが空のとき（以前の進捗が見えないので知らせる。いつも localStorage の環境では最初の 1 回だけ）
    : store.kind === 'localStorage' && loaded.status === 'empty' ? '保存先を開けず、予備の保存先を使っています（セーブのメニュー）'
    : store.info.orphan ? '使わなかった進捗があります（セーブのメニュー）' : null;
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
    player: { tank: HOME_TANK, x: crab.x, y: crab.y, z: crab.z, heading: crab.heading, camera: camera.mode, sand: Math.max(0, crab.sandHeld), tool: crab.tool, nutrition: eat.nutrition.toSave() },
    progress: { visited: [...tracker.visited], flags: { ...flags, [FLAG_EXAMINED]: buddy.examined } },
    tanks: { [HOME_TANK]: { dig: { prims: world.dig.exportPrims() }, food: { critters: life.eatenList() }, props: blocksToSave(blocks) } },
    buddies: [buddy.toSave(), ...worms.toSave()],
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
  // （Q は左のハサミ（E = 右と対）にしたので、仲間は B キー：2026-11-28）
  input.onPress('KeyB', toggleBuddy);
  // 右上の「音」（消音・音量・試し聞き）
  const audioMenu = new AudioMenu(menu, audio);
  // 同じ欄に表示の設定（ボタンの大きさ・濃さ・案内）
  mountUiPrefs(audioMenu.panel, uiPrefs, { touch, cam: true, plants: true, gait: true, worm: true });
  // ゲームパッド（つないだら使える。割り当ては AquaGamepad.ts の先頭）
  const pad = new AquaGamepad(input, {
    toggleTool,
    toggleCamera: () => cycleView(1),
    cameraBehind: () => camera.placeBehind(crab),
    toggleClose,
    toggleBuddy,
    toggleHelp: () => help?.toggle(),
    toast,
    toggleFocus: () => setFocus(!focus.on),
    cycleScheme: () => cycleScheme(),
  });
  showBuddyBtn();

  // ---------------- ハサミ集中モード ----------------
  // 右上の「集中」ボタン（PC・スマホとも）・Tab キー・パッドの左右のスティックの同時押し（B / ○ でも戻る）
  const focusBtn = document.createElement('button');
  focusBtn.type = 'button';
  focusBtn.className = 'menu-btn focus';
  focusBtn.setAttribute('aria-label', 'ハサミ集中モード');
  focusBtn.innerHTML = `${touchIcon('clawOpen')}<span>集中</span>`;
  menu.insertBefore(focusBtn, menu.firstChild);
  focusBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  focusBtn.addEventListener('click', () => setFocus(!focus.on));
  // 集中モードの印（いまの腕の動かし方・戻り方）
  const focusTag = document.createElement('div');
  focusTag.id = 'focus-tag';
  document.body.appendChild(focusTag);
  const showFocusTag = () => {
    focusTag.classList.toggle('show', focus.on);
    focusTag.textContent = `ハサミ集中：${FOCUS_SCHEME_LABEL[focus.scheme]}${touch ? '' : pad.connected ? '（B / ○ で戻る・Y / △ で動かし方）' : '（Tab で戻る・M で動かし方）'}`;
  };
  const focusTouch = touch ? new FocusTouch(input, () => setFocus(false), () => cycleScheme()) : null;
  /** ポインターの固定（失敗しても遊べる。新しいブラウザは Promise を返すので、拒否を握りつぶす） */
  const lockPointer = () => {
    try {
      const r = (canvas.requestPointerLock as unknown as (() => unknown) | undefined)?.call(canvas) as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* 固定は必須ではない */
    }
  };
  const marks = new ClawMarks();
  const cycleScheme = () => {
    const s = focus.cycleScheme();
    uiPrefs.set({ focusScheme: s });
    toast(`腕の動かし方：${FOCUS_SCHEME_LABEL[s]}`);
  };
  setFocus = (on: boolean) => {
    if (on === focus.on) return;
    // 入る：いま食べていればやめる（挟んだ物は持ったまま）。スマホの通常の「挟む」スイッチは集中モードでは使わない
    if (on) eat.reset();
    focus.set(on);
    pad.focus = on;
    input.focusMouse = on && !touch;
    document.body.classList.toggle('claw-focus', on);
    focusBtn.classList.toggle('on', on);
    focusTouch?.show(on);
    // マウスの動きをそのまま右の鋏へ（画面の端で止まらない）。固定できない環境でも動きは届く
    if (on && !touch) lockPointer();
    else if (document.pointerLockElement) document.exitPointerLock?.();
    // 戻る：挟んでいる鋏のスマホのスイッチは閉じたまま（押し直すまで持っている）
    if (!on) {
      touchUi?.setGrabLatched(grab.state === 'holding', 'R');
      touchUi?.setGrabLatched(grabL.state === 'holding', 'L');
    }
    showFocusTag();
    toast(on ? `ハサミ集中モード（${FOCUS_SCHEME_LABEL[focus.scheme]}）` : '通常のモード');
  };
  input.onPress('Tab', () => setFocus(!focus.on));
  input.onPress('KeyM', () => focus.on && cycleScheme());
  input.trapTab = true;
  // （Esc は視点の一覧を閉じる。一覧が開いていなければ集中モードから戻る）
  input.onPress('Escape', () => (picker.isOpen ? picker.close() : setFocus(false)));
  // ポインターの固定がブラウザに外された（Esc など）：集中モードのまま、マウスはふつうに使える（クリックでまた固定）
  canvas.addEventListener('pointerdown', () => {
    if (focus.on && !touch && !document.pointerLockElement) lockPointer();
  });
  uiPrefs.onChange((p) => {
    focus.setScheme(p.focusScheme);
    focusTouch?.setMode(p.focusToggle);
    marks.on = p.clawMarks;
    showFocusTag();
  });
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
  // 挟める所の輪（スマホ・PC とも）：届く物のつかみ点に明るい輪（ready）、届かないが近い物に薄い輪（near）
  const grabCursor = document.createElement('div');
  grabCursor.id = 'grab-cursor';
  grabCursor.innerHTML = '<i></i><span></span>';
  document.body.appendChild(grabCursor);
  const showGrabHint = () => {
    const pr = grab.hint;
    touchUi?.setGrabReady(!!pr);
    touchUi?.setGrabReady(!!grabL.hint, 'L');
    // 輪：届く物 → 明るく、近い物 → 薄く（挟んでいる間・何も無いときは出さない）
    const at = grab.hintAt ?? grab.near?.at ?? null;
    const qc = at && !grab.held ? view.project(at[0], at[1], at[2]) : null;
    grabCursor.className = qc ? (grab.hintAt ? 'show ready' : 'show near') : '';
    if (qc) {
      grabCursor.style.transform = `translate(${qc.x}px, ${qc.y}px)`;
      const label = grab.hintAt ? (touch ? '挟める' : '') : '';
      const sp = grabCursor.querySelector('span')!;
      if (sp.textContent !== label) sp.textContent = label;
    }
    // 巣穴の触角は巣穴の案内（act-prompt）が出すので、文字は出さない（輪は出す）
    const q = pr && !touch && pr !== buddy.tug ? view.project(pr.p[0], pr.p[1] + pr.rb + 0.12, pr.p[2]) : null;
    grabHint.classList.toggle('show', !!q);
    if (!pr || !q) return;
    const html = `<kbd>E</kbd> 挟む：${pr.name}`;
    if (grabHint.innerHTML !== html) grabHint.innerHTML = html;
    grabHint.style.transform = `translate(${q.x}px, ${q.y}px) translate(-50%, -100%)`;
  };
  // 天井・張り出しを歩いている間の案内：スティックの上（前）が画面のどちらへ進むかの矢印
  const climbCue = document.createElement('div');
  climbCue.id = 'climb-cue';
  climbCue.innerHTML = '<i class="arrow"></i><span>スティック↑</span>';
  document.body.appendChild(climbCue);
  const updateClimbCue = () => {
    const on = crab.climbing && crab.climbN[1] < -0.3;
    climbCue.classList.toggle('show', on);
    if (!on) return;
    const f = crab.climbBasis.f, n = crab.climbN;
    // 体の中心（面から半径の所）から、スティックの前に当たる向きへ
    const cx = crab.x, cy = crab.y + crab.radius, cz = crab.z;
    const q0 = view.project(cx - n[0] * 0.05, cy - n[1] * 0.05, cz - n[2] * 0.05);
    const q1 = view.project(cx + f[0] * 0.5, cy + f[1] * 0.5, cz + f[2] * 0.5);
    if (!q0 || !q1) return;
    const ang = Math.atan2(q1.y - q0.y, q1.x - q0.x);
    climbCue.style.transform = `translate(${q0.x}px, ${q0.y}px)`;
    (climbCue.querySelector('.arrow') as HTMLElement).style.transform = `rotate(${ang.toFixed(3)}rad)`;
  };
  /** 水草を挟んだまま「掘る」を押した（抜く・ちぎる・引きが足りない）：音・震え・案内 */
  let digWas = false;
  const onTwist = (r: TwistResult, pg: PlantGrab) => {
    if (r === 'cut') {
      audio.click(true);
      vibrate(20);
    } else if (r === 'uproot') {
      audio.grunt(0.5);
      vibrate([15, 30, 15]);
    } else if (r === 'weak') {
      audio.grunt(0.2);
      guideToast(`${pg.name}の根が強い。もっと引っ張りながら${touch ? '「抜く」' : ' F '}を押すと抜ける`);
    }
  };
  /** スマホの「掘る」ボタン：水草を挟んでいる間は「ちぎる」「抜く」、ほかの物を挟んでいる間は「食べる」の印にする */
  let digMode = '';
  const showDigMode = () => {
    const pg = plantGrabR.holding ? plantGrabR : plantGrabL.holding ? plantGrabL : null;
    const holding = grab.state === 'holding' || grabL.state === 'holding' || eat.phase !== 'idle';
    const m = pg ? (pg.cutsHere ? 'snip' : 'uproot') : holding ? 'eat' : crab.tool === 'fill' ? 'fill' : 'dig';
    if (m === digMode) return;
    digMode = m;
    const dg = touchUi?.root.querySelector<HTMLElement>('.dig');
    if (!dg) return;
    dg.classList.toggle('snip', m === 'snip');
    dg.classList.toggle('uproot', m === 'uproot');
    dg.classList.toggle('eat', m === 'eat');
    touchUi!.setButton('dig', null, m === 'snip' ? 'ちぎる' : m === 'uproot' ? '抜く' : m === 'eat' ? '食べる' : m === 'fill' ? '盛る' : '掘る');
  };
  // ---------------- 食事の見た目と出来事 ----------------
  /** 食べる動きを、姿勢（口元へ運ぶ・顎脚）・鋏（滑らない）・物（口に入っている）へ写す（前のフレームの値。体の更新より前） */
  const syncFeed = () => {
    const s = eat.side;
    const F = rig.feed;
    F.side = s === 'R' ? -1 : s === 'L' ? 1 : 0;
    F.w = eat.feedW;
    F.push = eat.push;
    F.twist = eat.twist;
    F.mouth = eat.mouth;
    F.palp = eat.palp;
    grab.feeding = s === 'R' && eat.feedW > 0.02;
    grabL.feeding = s === 'L' && eat.feedW > 0.02;
    lifeGrabR.subdued = grab.feeding;
    lifeGrabL.subdued = grabL.feeding;
    for (const [G, sd] of [[grab, 'R'], [grabL, 'L']] as const) if (G.holding) G.holding.eating = eat.side === sd && eat.feedW > 0.3;
  };
  const assistAt: [number, number, number] = [0, 0, 0], mouthAt: [number, number, number] = [0, 0, 0];
  /**
   * 空いている方の鋏の手伝い（噛んでいる間）：食べ物の横をつまむ → 口元へ運ぶ → 口の前で開く → 食べ物へ戻る、を 1 口と半周ずらして
   * 繰り返す（その鋏が何も挟んでいない・押していないときだけ。姿勢の更新の前と、物を進めた後の 2 回書く）
   */
  const applyAssist = () => {
    const k = eat.assist;
    if (k < 0.02 || !eat.food) return;
    const free = eat.side === 'R' ? { G: grabL, rg: rig.gripL, sx: 1 } : { G: grab, rg: rig.grip, sx: -1 };
    if (free.G.state !== 'idle') return;
    const fp = eat.food.at();
    rig.mouthPoint(mouthAt, 0.01);
    const ph = eat.assistPh;
    const close = ph < 0.15 ? ph / 0.15 : ph < 0.5 ? 1 : ph < 0.65 ? 1 - (ph - 0.5) / 0.15 : 0;
    const u = ph < 0.15 ? 0 : ph < 0.5 ? smooth(0.15, 0.5, ph) : ph < 0.65 ? 1 : 1 - smooth(0.65, 1, ph);
    // 食べ物の、手伝う鋏の側を少し外した所
    const hx = Math.cos(crab.heading), hz = -Math.sin(crab.heading);
    for (let i = 0; i < 3; i++) assistAt[i] = fp[i] + (mouthAt[i] - fp[i]) * u * 0.85;
    assistAt[0] += hx * free.sx * 0.025;
    assistAt[2] += hz * free.sx * 0.025;
    free.rg.on = true;
    free.rg.close = close * k;
    free.rg.hold = false;
    free.rg.target = [assistAt[0], assistAt[1], assistAt[2]];
    free.rg.shake = 0;
  };
  const smooth = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  /** 食べかすの色（種類ごと） */
  const crumbRGB = Object.fromEntries(Object.entries(FOOD_KIND).map(([k, s]) => [k, s.crumbs.map((c) => hex(c))]));
  /** 運んでいる途中の食べ物のある所（口の手前）。かけら・泡を出す */
  const eatFx = (n: number, kind: string) => {
    rig.mouthPoint(mouthAt, 0.02);
    const fx = Math.sin(crab.heading), fz = Math.cos(crab.heading);
    view.digFx.crumbs(mouthAt[0], mouthAt[1], mouthAt[2], n, crumbRGB[kind] ?? crumbRGB.plant, [fx, fz]);
  };
  const REFUSE_SAY: Record<string, (n: string) => string> = {
    companion: (n) => `${n}は仲間なので食べない`,
    inedible: (n) => `${n}は食べられない（口元で確かめて押し戻した）`,
    anchored: (n) => `${n}はまだ隙間に踏ん張っている（引き抜いてから）`,
    rooted: (n) => `${n}は根が付いている（ちぎる・抜くと食べられる）`,
    nothing: () => 'ここには食べられる藻が無い（苔の付いた水中の岩・流木をつかむ）',
  };
  const onEatEvents = () => {
    for (const e of eat.drainEvents()) {
      if (e.kind === 'start') {
        if (e.food.kind === 'algae' && !e.resume) {
          audio.tear();
          const p = e.food.at();
          view.tugFx('bubble', p[0], p[1], p[2], 2);
        }
      } else if (e.kind === 'bite') {
        audio.munch(FOOD_KIND[e.food.kind].sound, e.amount);
        eatFx(2 + Math.round(e.amount * 14), e.food.kind);
        if (Math.random() < 0.5) view.tugFx('bubble', mouthAt[0], mouthAt[1], mouthAt[2], 1);
        if (e.first && (e.food.kind === 'shrimp' || e.food.kind === 'fish' || e.food.kind === 'worm')) saver.markImportant();
        else saver.markDirty();
      } else if (e.kind === 'finish') {
        audio.gulp();
        eatFx(5, e.food.kind);
        view.tugFx('bubble', mouthAt[0], mouthAt[1], mouthAt[2], 3);
        vibrate(12);
        guideToast(`${e.food.name}を食べた（栄養 +${foodNutrition(e.food.kind, e.food.size).toFixed(0)}）`);
        saver.markImportant();
      } else if (e.kind === 'stop') {
        if (e.why === 'release' && e.left > 0) guideToast(`食べるのをやめた：${e.food.name}（残り ${Math.round(e.left * 100)}%。もう一度押すと続き）`);
        saver.markDirty();
      } else if (e.kind === 'refuse') guideToast(REFUSE_SAY[e.why](e.name));
      else if (e.kind === 'spit') {
        audio.spit(e.bring);
        rig.mouthPoint(mouthAt, 0.03);
        view.tugFx('bubble', mouthAt[0], mouthAt[1], mouthAt[2], e.bring ? 3 : 1);
      }
    }
  };
  /** 食べている間の注視点（冒険カメラ：口元を少し上から見る。null = 食べていない） */
  const eatFocus = (): [number, number, number] | null =>
    eat.eating && eat.feedW > 0.5 && camera.mode === 'adventure' ? rig.mouthPoint([0, 0, 0], 0.02) : null;
  /** 水草を抜いた・ちぎった「掘る」の押し下げは、離すまで食べるに使わない（引き抜いた草をすぐ食べ始めない） */
  let twistLatch = false;
  const onGrabEvents = () => {
    for (const G of [grab, grabL]) {
      for (const e of G.drainEvents()) {
        if (e.kind === 'slip') audio.slip();
        else if (e.kind === 'grab') audio.click(true);
        else if (e.kind === 'release') audio.click(false);
        if (e.kind === 'slip' && (e.prop === buddy.tug || worms.worms.some((w) => w === e.prop && w.anchored))) {
          guideToast('ハサミが滑った！ 強く引きすぎ（暴れている間は少しゆるめる）');
          vibrate(40);
        } else if (e.kind === 'slip' && e.prop === G.fixed) guideToast(`ハサミが${G.fixed.name}から外れた（強く引きすぎ）`);
        else if (e.kind === 'slip') guideToast(`${e.prop?.name ?? '物'}がハサミから滑り落ちた`);
        else if (e.kind === 'grab' && e.prop === G.fixed) guideToast(`${G.fixed.name}をつかんだ（動かない。離れようとすると引き戻される）`);
        else if (e.kind === 'heavy') guideToast(crab.submerged > 0.5 ? `${e.prop?.name ?? '物'}は重くて、なかなか動かない…` : `${e.prop?.name ?? '物'}は重くて動かない（水の中なら少し軽くなる）`);
      }
    }
  };
  /** 巣穴の生き物を挟んでいる鋏（右・左。どちらも挟んでいなければ null） */
  const tugClaw = (): GS | null => (grab.holdingCreature === buddy.tug ? grab : grabL.holdingCreature === buddy.tug ? grabL : null);
  /** 挟んでいるゴカイ（鋏と個体。巣穴に踏ん張っているか anchored） */
  const wormHeld = (): { G: GS; w: Worm } | null => {
    for (const G of [grab, grabL]) {
      const c = G.holdingCreature;
      if (c && worms.worms.includes(c as Worm)) return { G, w: c as Worm };
    }
    return null;
  };
  /** 巣穴から引っ張っているゴカイ（体の一部がまだ砂の中） */
  const wormTug = () => {
    const h = wormHeld();
    return h && h.w.anchored ? h : null;
  };
  /** 2 本の鋏の手応えを合わせる（力は足し、速さの上限は小さい方） */
  const mergeTow = (a: Tow | null, b: Tow | null): Tow | null => (!a ? b : !b ? a : { ax: a.ax + b.ax, ay: a.ay + b.ay, az: a.az + b.az, slow: Math.min(a.slow, b.slow) });
  // 抜けた瞬間の「スポン！」の文字と衝撃の輪（穴の上。カニ・生き物を隠さないよう、穴より上にずらして短く出す）
  const popWord = document.createElement('div');
  popWord.id = 'pop-word';
  popWord.innerHTML = '<i class="ring"></i><b>スポン！</b>';
  document.body.appendChild(popWord);
  let popAt: [number, number, number] | null = null, popT = 0, hitStop = 0;
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
    const reach = grab.hint === buddy.tug || grabL.hint === buddy.tug;
    prompt.classList.toggle('ready', reach);
    const html = !reach ? 'もっと近づいて、ハサミで触角を挟む' : touch ? '「挟む」で触角を挟む' : '<kbd>E</kbd> 挟む：見えている触角';
    const el = prompt.querySelector('.what')!;
    if (el.innerHTML !== html) el.innerHTML = html;
  };
  /**
   * 引っ張っている間の手応え（毎フレーム）：つかんだ所の輪・引く向きの矢印・短い言葉と、砂粒・泡・カニの踏ん張りの砂・
   * カメラの揺れを、生き物の段階・引き戻し・張力に合わせて出す
   */
  let fxCrumble = 0, fxKick = 0, slackT = 0, sayT = 0, say = '';
  const updateTug = (dt: number) => {
    // 巣穴に踏ん張っている生き物：スナモグリ、または巣穴から体の一部が出ているゴカイ（どちらも同じ手応えの見せ方）
    const tw = wormTug();
    const TG = tugClaw() ?? tw?.G ?? null;
    const T = tugClaw() ? buddy.tug : tw?.w ?? buddy.tug;
    const held = !!TG;
    tugCue.classList.toggle('show', held);
    rig.tugShake = held ? T.env : 0;
    // ゴカイ：つかみ点と口の中ほどを、より上から見下ろす（体が鋏から口へ視線に沿って伸び、後ろからでは縮んで見えるので）
    const wm = tw ? tw.w.mouth : null;
    // 食べている間は口元を少し上から（食べ物の減り方・顎脚が見えるように）
    const ef = held ? null : eatFocus();
    camera.focus = !held ? ef : wm ? [(T.p[0] + wm[0]) / 2, (T.p[1] + wm[1]) / 2, (T.p[2] + wm[2]) / 2] : [T.p[0], T.p[1], T.p[2]];
    // （離した・抜けた後は値を変えない：寄せ具合 focusW と一緒になめらかに戻る）
    if (held) camera.focusPitch = wm ? 0.6 : 0.22;
    else if (ef) camera.focusPitch = 0.16;
    // 音：砂のこすれ・踏ん張り（張力で大きく・高く）
    audio.setTug(held ? { load: T.load, rub: T.rub, extV: T.extV, env: T.env } : null);
    if (!held) {
      slackT = 0;
      // 次に挟んだとき前の言葉が残らない
      if (say) tugCue.querySelector('.say')!.textContent = say = '';
      return;
    }
    const [bx, by, bz] = tw ? tw.w.mouth : buddy.burrow;
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
    if (!q || !q2 || !TG) return;
    const warn = TG.warn;
    const level = warn > 0.25 ? 'danger' : T.load > 1 ? 'move' : T.load > 0.55 ? 'hold' : 'slack';
    tugCue.dataset.level = level;
    tugCue.style.transform = `translate(${q.x}px, ${q.y}px)`;
    tugCue.style.setProperty('--k', clamp(TG.load, 0, 1).toFixed(3));
    tugCue.style.setProperty('--w', warn.toFixed(3));
    const ang = Math.atan2(q2.y - q.y, q2.x - q.x);
    (tugCue.querySelector('.arrow') as HTMLElement).style.transform = `rotate(${ang.toFixed(3)}rad)`;
    // 張っていない時間（下がっていない）：案内を出す
    slackT = TG.load < 0.3 && crab.speed < 0.2 ? slackT + dt : 0;
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
  /**
   * ゴカイの出来事：抜けた（砂煙・砂粒・泡・「ちゅぽん」・カニのよろめき。体が飛び出して縮み・くねるのは物理）・引き戻した・
   * 隠れた・掘り出された・潜った
   */
  const onWormEvents = () => {
    for (const { worm: w, e } of worms.drainEvents()) {
      if (e.kind === 'pop') {
        view.puff(e.x, e.y, e.z, e.power > 0.5);
        // 石の隙間：砂は少しだけ（根元の砂がこぼれる）。石にこすれた「カチッ」を重ねる
        view.tugFx('crumble', e.x, e.y, e.z, 4 + Math.round(e.power * 4), null);
        view.tugFx('bubble', e.x, e.y, e.z, 6 + Math.round(e.power * 8));
        audio.slurp(e.power);
        audio.click(true);
        // 張っていた力に応じて：ふつうは後ろへよろめく、目いっぱい張っていたら転ぶ
        if (e.power > 0.93) crab.tumble(e.dir[0], e.dir[1], (e.power - 0.93) * 8);
        else crab.stagger(e.dir[0], e.dir[1], e.power);
        camera.kick(e.dir[0] * 0.35 * e.power, 0.2, e.dir[1] * 0.35 * e.power);
        popAt = [e.x, e.y + 0.3, e.z];
        popT = 0.7;
        hitStop = 0.04 + 0.04 * e.power;
        popWord.classList.remove('show');
        popWord.classList.add('ring-only');
        void popWord.offsetWidth;
        popWord.classList.add('show');
        vibrate([20, 30, 45]);
        if (e.first) {
          banner.className = 'show first hidden buddy';
          banner.querySelector('.kicker')!.textContent = '見つけた！';
          banner.querySelector('.name')!.textContent = WORM_NAME;
          banner.querySelector('.desc')!.textContent = WORM_DESC;
          bannerT = 4.5;
        }
        saver.markImportant();
      } else if (e.kind === 'tug') {
        // 引き戻した：口から泡、カメラが口の方へ少し引かれる、「ぐっ」
        const m = w.mouth;
        view.tugFx('bubble', m[0], m[1], m[2], e.stage === 'early' ? 2 : 4);
        const dx = m[0] - crab.x, dz = m[2] - crab.z, l = Math.hypot(dx, dz) || 1;
        const k = e.stage === 'early' ? 0.1 : e.stage === 'mid' ? 0.18 : 0.25;
        camera.kick((dx / l) * k, -0.04, (dz / l) * k);
        audio.grunt(e.stage === 'early' ? 0.25 : e.stage === 'mid' ? 0.5 : 0.75);
        if (e.stage !== 'early') vibrate(14);
      } else if (e.kind === 'stage' && e.stage === 'late') {
        const m = w.mouth;
        view.tugFx('crumble', m[0], m[1], m[2], 6, null);
      } else if (e.kind === 'grab' && w.anchored) {
        const m = w.mouth;
        view.tugFx('bubble', m[0], m[1], m[2], 2);
      } else if (e.kind === 'hide') {
        // すばやく引っ込んだ：砂が少し跳ね、小さな泡
        view.tugFx('crumble', e.x, e.y, e.z, 2, null);
        view.tugFx('bubble', e.x, e.y, e.z, 2);
        if (Math.hypot(crab.x - e.x, crab.z - e.z) < 3) audio.bubble(undefined, 0.06);
      } else if (e.kind === 'dig') view.puff(e.x, e.y, e.z, false);
      else if (e.kind === 'buried') {
        view.tugFx('crumble', e.x, e.y, e.z, 4, null);
        saver.markDirty();
      }
    }
  };
  const onBuddyEvents = () => {
    for (const e of buddy.drainEvents()) {
      if (e.kind === 'examined') {
        guideToast('何かの触角を挟んだ！ 後ろへ下がって引っ張ろう');
        saver.markImportant();
      } else if (e.kind === 'popped') {
        // 抜けた瞬間：抵抗が急に消え、「スポン！」の音と文字・衝撃の輪、砂煙・砂粒・泡の柱が舞い、カニは勢い余って後ろへ転ぶ。
        // ほんの一瞬（0.07 秒）時間を遅くして手応えを強める。カメラの揺れは小さめ（カニ・生き物を見失わない）
        view.puff(e.x, e.y, e.z, true);
        view.tugFx('crumble', e.x, e.y, e.z, 18, null);
        view.tugFx('bubble', e.x, e.y, e.z, 12);
        crab.tumble(e.dir[0], e.dir[1], e.power);
        camera.kick(e.dir[0] * 0.9 * e.power, 0.5, e.dir[1] * 0.9 * e.power);
        audio.pop(e.power);
        popAt = [e.x, e.y + 0.35, e.z];
        popT = 0.9;
        hitStop = 0.07;
        popWord.classList.remove('show', 'ring-only');
        void popWord.offsetWidth; // 文字の動きを最初から
        popWord.classList.add('show');
        vibrate([30, 40, 60]);
      } else if (e.kind === 'land') {
        view.puff(e.x, e.y, e.z, false);
        audio.bubble(undefined, 0.18);
      }
      else if (e.kind === 'joined') {
        banner.className = 'show first hidden buddy';
        banner.querySelector('.kicker')!.textContent = '仲間になった！';
        banner.querySelector('.name')!.textContent = BUDDY_NAME;
        // （呼び方の説明は案内を出す設定のときだけ。ふだんは仲間の名前と一言）
        banner.querySelector('.desc')!.textContent = uiPrefs.prefs.guides ? `${BUDDY_DESC}。${touch ? '右上のボタン' : 'Q キー・右上のボタン'}で呼ぶと、ついてくる` : BUDDY_DESC;
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
          // 引き戻されたときの「ぐっ」（踏ん張る音）と泡
          audio.grunt(t.stage === 'early' ? 0.3 : t.stage === 'mid' ? 0.6 : 0.9);
          audio.bubble();
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
  // holdL = true で左の鋏（ゲームパッドの左トリガー）を押したことにする（自動検証用）
  // focusCtl = 集中モードの左右の鋏の入力（null = 実際の入力。自動検証用。値は実際の入力に足す）
  const debug: { freeze: boolean; fps: number; dig: boolean; hold: boolean; holdL: boolean; digAim: { x: number; y: number } | null; focusCtl: { R: Partial<ClawCtl>; L: Partial<ClawCtl> } | null; step: (n: number, dt?: number) => void } = { freeze: false, fps: 0, dig: false, hold: false, holdL: false, digAim: null, focusCtl: null, step: () => {} };
  /**
   * 集中モードの左右の鋏の入力：ゲームパッド（左右のスティック・トリガー・バンパー + スティック = 高さとひねり）・
   * PC（WASD + Q / E 高さ + Z / X ひねり + 左 Shift 閉じる = 左、マウス + 左クリック閉じる + 右ドラッグ 高さ・ひねり = 右）・
   * スマホ（左右のスティック・高さのつまみ・開閉のボタン）をまとめる。開閉はいちばん強く押している物
   */
  const focusCtls = (): { R: ClawCtl; L: ClawCtl } => {
    const R = emptyCtl(), L = emptyCtl();
    const P = pad.pf;
    if (pad.connected) {
      for (const [C, s, mod, t] of [[L, P.l, P.lb, P.lt], [R, P.r, P.rb, P.rt]] as const) {
        if (mod) {
          C.lift += s.y;
          C.roll += s.x;
        } else {
          C.mx += s.x;
          C.my += s.y;
        }
        C.close = Math.max(C.close, t);
      }
    }
    const k = (c: string) => (input.isDown(c) ? 1 : 0);
    L.mx += k('KeyD') - k('KeyA');
    L.my += k('KeyW') - k('KeyS');
    L.lift += k('KeyE') - k('KeyQ');
    L.roll += k('KeyX') - k('KeyZ');
    if (input.isDown('ShiftLeft')) L.close = 1;
    if (input.focusMouse) {
      if (input.mouseR) {
        R.liftD += input.mouseRDY;
        R.roll += clamp(input.mouseRDX * 0.08, -1, 1);
      } else {
        R.dx += input.mouseDX;
        R.dy += input.mouseDY;
      }
      if (input.mouseL) R.close = 1;
    }
    // 方向キー：右の鋏（マウスの代わり）・Enter 右を閉じる
    R.mx += k('ArrowRight') - k('ArrowLeft');
    R.my += k('ArrowUp') - k('ArrowDown');
    if (input.isDown('Enter')) R.close = 1;
    const T = focusTouch;
    if (T) {
      L.mx += T.stick.L.x; L.my += T.stick.L.y; L.lift += T.lift.L; L.close = Math.max(L.close, T.close.L);
      R.mx += T.stick.R.x; R.my += T.stick.R.y; R.lift += T.lift.R; R.close = Math.max(R.close, T.close.R);
    }
    const D = debug.focusCtl;
    if (D) {
      for (const [C, d] of [[R, D.R], [L, D.L]] as const) {
        for (const key of ['mx', 'my', 'dx', 'dy', 'lift', 'liftD', 'roll'] as const) C[key] += d[key] ?? 0;
        if (d.close !== undefined) C.close = Math.max(C.close, d.close);
      }
    }
    for (const C of [R, L]) {
      const l = Math.hypot(C.mx, C.my);
      if (l > 1) {
        C.mx /= l;
        C.my /= l;
      }
      C.lift = clamp(C.lift, -1, 1);
      C.roll = clamp(C.roll, -1, 1);
    }
    return { R, L };
  };
  /** 離した・滑った数（集中モードのスマホの切り替え式ボタンを開く）・積み木の位置の指紋（動いて止まったら保存） */
  const slipSeen = { R: 0, L: 0 };
  let blockSig = blocks.reduce((s, b) => s + b.p[0] * 3.1 + b.p[1] * 7.3 + b.p[2] * 1.7 + b.q[0] + b.q[1] * 2 + b.q[3] * 5, 0);
  /**
   * 鋏の印：通常モードは、いま押すと挟む所（右は常に。左は右と違う物のときか左を使っている間）。
   * 集中モードは鋏の先・下の面の影と高さの線・いま閉じると挟む所・挟んでいる所
   */
  const drawMarks = () => {
    const fw = focus.w;
    const hintR = grab.hintAt && !grab.held ? grab.hintAt : null;
    const lActive = grabHeldLNow || grabL.state !== 'idle' || fw > 0.5;
    const hintL = grabL.hintAt && !grabL.held && (lActive || grabL.hint !== grab.hint) ? grabL.hintAt : null;
    marks.draw((x, y, z) => view.project(x, y, z), fw, {
      R: { tip: rig.pinch, floor: fw > 0.5 ? focus.R.floor : null, hint: hintR, hold: fw > 0.5 ? grab.gripAt() : null, busy: grab.state === 'holding' },
      L: { tip: rig.pinchL, floor: fw > 0.5 ? focus.L.floor : null, hint: hintL, hold: fw > 0.5 ? grabL.gripAt() : null, busy: grabL.state === 'holding' },
    });
  };
  let grabHeldLNow = false;
  let time = 0;
  let last = performance.now();
  let acc = 0, frames = 0, hudT = 0, frameMax = 0, frameMaxShown = 0;
  const tick = (dtRaw: number) => {
    // 抜けた瞬間の「間」（hitStop の間だけ時間を 1/4 に）
    const slow = hitStop > 0 ? 0.25 : 1;
    if (hitStop > 0) hitStop -= Math.min(dtRaw, 0.05);
    const dt = debug.freeze ? 0 : Math.min(dtRaw, 0.05) * slow;
    time += dt;
    if (!debug.freeze) {
      // ゲームパッド：左スティック・ボタン・トリガー・右スティックを Input と左右の鋏へ
      pad.poll(dtRaw);
      // 挟む：PC は E（押している間）、スマホは「挟む」スイッチ（たたくと閉じ、もう一度で開く）、ゲームパッドは右トリガー。
      // 小石・貝殻・重い石も、景色の小石・貝殻も、巣穴から見えている触角も、岩・流木も同じ操作。左の鋏は左トリガー
      // 左のハサミ：Q（押している間）・スマホの左の「挟む」スイッチ・左トリガー（2026-11-28：PC・スマホでも使える）
      const inFocus = focus.on;
      const grabHeld = !inFocus && (input.touchGrabLatch || input.isDown('KeyE') || pad.clawR || debug.hold);
      const grabHeldL = !inFocus && (input.touchGrabLatchL || input.isDown('KeyQ') || pad.clawL || debug.holdL);
      grabHeldLNow = grabHeldL;
      // 握る強さ（通常モード）：トリガーの押し込み（0.35 で閉じる）を 0.25〜1 にする。ボタン・キーは 1
      if (!inFocus) {
        grab.squeeze = pad.clawR && pad.analog && !input.isDown('KeyE') && !input.touchGrabLatch && !debug.hold ? clamp((pad.clawRv - 0.2) / 0.7, 0.25, 1) : 1;
        grabL.squeeze = pad.clawL && pad.analog && !input.isDown('KeyQ') && !input.touchGrabLatchL && !debug.holdL ? clamp((pad.clawLv - 0.2) / 0.7, 0.25, 1) : 1;
      }
      // 腕の向き（ゲームパッドの右スティック・E を押したままのマウス = 両方。Q を押したままのマウス = 左だけ）
      const aim = inFocus ? { x: 0, y: 0 } : input.armAim();
      const aimQ = inFocus ? null : input.armAimL();
      grab.aiming = Math.hypot(aim.x, aim.y) > 0.15;
      grabL.aiming = grab.aiming || (!!aimQ && Math.hypot(aimQ.x, aimQ.y) > 0.15);
      const aimL = aimQ ?? { x: aim.x, y: aim.y };
      // 狙いの補助（腕）：手で向けていない・閉じている・まだ挟んでいない間は、近くの挟める物の方へ腕を下げる・横へ向ける
      // （ふだんの構えは体の右 0.06・高さ 0.33。体の向きは下の face で物へ向く。左の鋏は左へ 0.06）
      for (const [G, A, held, sx] of [[grab, aim, grabHeld, 1], [grabL, aimL, grabHeldL, -1]] as const) {
        const na = G.near?.at;
        if (G.aiming || !held || G.held || !na) continue;
        const dx = na[0] - crab.x, dz = na[2] - crab.z, h = crab.heading;
        A.x = clamp((dx * -Math.cos(h) + dz * Math.sin(h) - 0.06 * sx) / 0.13, -1, 1);
        A.y = clamp((na[1] - crab.y - 0.33) / 0.12, -1, 1);
      }
      rig.armAim.x = aim.x;
      rig.armAim.y = aim.y;
      rig.armAimL = aimL;
      // 集中モード：左右の鋏の目標・開閉（カニの姿勢を決める前に。届く範囲は前のフレームの付け根で決める）
      focus.update(dt, ...(((c) => [c.R, c.L])(focusCtls()) as [ClawCtl, ClawCtl]), input);
      // 仲間・巣穴（触角の出具合・引っ張っている間の体。引っ張っている間はカニを穴へ向け、穴の上に乗せない）
      const br = buddy.update(dt, crab);
      showPrompt((grab.busy && !grab.holdingCreature) || (grabL.busy && !grabL.holdingCreature) ? null : br.prompt);
      onBuddyEvents();
      // ゴカイ（挟まれていない個体。挟まれている個体は鋏の側 GrabSystem.post で進む）
      worms.update(dt, { x: crab.x, y: crab.y + crab.radius, z: crab.z, speed: crab.speed, grounded: crab.grounded, vy: crab.vy, inTank: crab.region === 'tank' }, world.dig.stats.carves + world.dig.stats.fills);
      onWormEvents();
      // 巣穴からゴカイを引っ張っている間も、スナモグリと同じくカニは巣穴の口へ向き、口の上に乗らない
      const wt = wormTug();
      const pull = br.pull ?? (wt ? { x: wt.w.mouth[0], z: wt.w.mouth[2], t: clamp(wt.w.load, 0, 1) } : null);
      // 狙いの補助：「挟む」を押している（閉じている）がまだ挟んでいない間は、鋏の側を近くの挟める物へ向け直す
      // （横歩きで横を向いていても届く。巣穴の触角は少し遠くからでも向く）。押していないときは向きを変えない（勝手につかまない）
      const [bx, , bz] = buddy.burrow;
      const nearAt = grab.near?.at ?? grabL.near?.at ?? null;
      const face = !(grabHeld || grabHeldL) || grab.held || grabL.held || grab.aiming ? null
        : br.prompt?.kind === 'peek' && Math.hypot(crab.x - bx, crab.z - bz) < 0.9 ? { x: bx, z: bz }
        : nearAt ? { x: nearAt[0], z: nearAt[2] } : null;
      // V キー：離したら次の視点、長く押したら一覧（第 6 段階）
      if (vDown >= 0) {
        if (input.isDown('KeyV')) {
          vDown += dtRaw;
          if (vDown > 0.4 && vDown < 1e6) {
            picker.open();
            vDown = 1e6;
          }
        } else {
          if (vDown < 1e6) cycleView(1);
          vDown = -1;
        }
      }
      // 水草を挟んでいる間の「掘る」ボタン：抜く・ちぎる（第 6 段階。引くだけでは抜けない。押した瞬間だけ）
      const digNow = input.isDigHeld() || debug.dig;
      const pg = plantGrabR.holding ? plantGrabR : plantGrabL.holding ? plantGrabL : null;
      if (digNow && !digWas && pg) {
        onTwist(pg.twist(), pg);
        twistLatch = true;
      }
      if (!digNow) twistLatch = false;
      digWas = digNow;
      // 食事（前のフレームの食べる動き）を姿勢・鋏へ
      syncFeed();
      // （水草を挟んでいる間は、正面（鋏の側）を挟んだ所へ向けたまま下がる・回り込む：背を向けて鋏が届かなくならない）
      // 切り替えた直後の移動の基準：倒したままなら前の視点の向き（離す・大きく倒し直すまで）
      // 集中モード：カニはその場に留まる（移動・走る・跳ぶ・掘るは使わない。物の反作用・水流では少し動く）
      const mv = inFocus ? { x: 0, y: 0 } : input.moveAxis();
      if (moveLatch && (Math.hypot(mv.x, mv.y) < 0.2 || Math.abs(Math.atan2(Math.sin(Math.atan2(mv.x, mv.y) - moveLatch.ang), Math.cos(Math.atan2(mv.x, mv.y) - moveLatch.ang))) > 1.0)) moveLatch = null;
      // 鋏が挟む方に使われている間は掘れない（掘るのも鋏を使うので）
      crab.update(dt, { move: mv, run: !inFocus && input.isRunning(), jumpHeld: !inFocus && input.isJumpHeld(), cameraYaw: moveLatch?.yaw ?? camera.yaw, dig: !inFocus && digNow && !grab.busy && !grabL.busy, digAim: debug.digAim ?? input.digAim(), pull, face: inFocus ? null : pg ? { x: pg.p[0], z: pg.p[2] } : face, tow: mergeTow(mergeTow(grab.tow, grabL.tow), eat.feedW > 0 ? { ax: 0, ay: 0, az: 0, slow: eat.slow } : null), support: rig.gait !== 'cycle' && rig.feet && rig.ikW > 0.5 ? rig.feet.support : null, lead: rig.gait === 'lead' || rig.gait === 'hybrid' });
      camera.update(dt, input, crab);
      // 挟む：鋏の構え → 体と鋏の姿勢 → 左右の鋏の状態 → 物・生き物を進める（ばね。2 本で 1 回）→ 動いた物へ鋏を伸ばし直す・生き物の体を置き直す
      Object.assign(rig.grip, grab.rigGrip());
      Object.assign(rig.gripL, grabL.rigGrip());
      applyAssist();
      rig.update(dt, crab);
      const reqR = grab.pre(dt, grabHeld, crab, rig);
      const reqL = grabL.pre(dt, grabHeldL, crab, rig.left);
      const reqs = [reqR, reqL].filter((r) => r !== null);
      // 集中モード：開いている鋏の先で物を押せる（挟んでいる物は押さない）
      const tips = focus.w > 0.5 ? [
        { p: rig.pinch, r: 0.028, skip: grab.holding },
        { p: rig.pinchL, r: 0.024, skip: grabL.holding },
      ].filter((t, i) => (i === 0 ? grab : grabL).state !== 'holding') : [];
      const res = props.updateMany(dt, crab, reqs, tips);
      const none = { force: [0, 0, 0] as [number, number, number], stretch: 0, slide: 0 };
      grab.post(dt, crab, rig, reqR ? res[0] : none);
      grabL.post(dt, crab, rig.left, reqL ? res[reqR ? 1 : 0] : none);
      // 抜けた・ちぎれた水草のかけらを、その鋏に挟ませる
      plantGrabR.flush();
      plantGrabL.flush();
      // 食べる：挟んだまま「掘る」を押している間（根の付いた水草を挟んでいる・抜いた直後の押し下げを除く）。
      // 口元へ運ぶ・噛み取る・ちぎる・確かめて押し戻す（AquaEat）。食べ終えた物は鋏を空にして世界から消える
      // （押しているかだけを渡す：食べ終えた後は、押したままでは次の物を食べ始めない＝一度離すまで待つ）
      const pgNow = plantGrabR.holding || plantGrabL.holding;
      eat.update(dt, digNow && !pgNow && !twistLatch, eatClaws());
      onEatEvents();
      algae.update(dt);
      Object.assign(rig.grip, grab.rigGrip());
      Object.assign(rig.gripL, grabL.rigGrip());
      applyAssist();
      rig.reaimGrip();
      buddy.placeInBurrow();
      // 物理の物になった景色の小石・貝殻の頂点を動かす・遠くで止まった物を景色へ戻す
      decor.update({ x: crab.x, y: crab.y + crab.radius, z: crab.z });
      // 「挟む」を押している間、鋏で狙っている植物（届く・近い・閉じている）は体で押しのけない（第 6 段階：太い株が体に押されて
      // 鋏の届かない所へ逃げ、挟めなかった）
      plantField.nopush.length = 0;
      // （太い株（シダ・葉の広い草）は押していなくても：押した瞬間に届く所にいるように）
      for (const [G, PGx, on] of [[grab, plantGrabR, grabHeld], [grabL, plantGrabL, grabHeldL]] as const) {
        if (!(G.creature === PGx || G.near?.target === PGx || G.hint === PGx)) continue;
        const k = PGx.i >= 0 ? PGx.i : PGx.candIndex;
        if (k >= 0 && (on || plantField.table.kind[k] === 2 || plantField.table.kind[k] === 3)) plantField.nopush.push(k);
      }
      updatePlants(dt);
      weeds.update(dt);
      updateTug(dt);
      showGrabHint();
      showDigMode();
      // 初回のボタンの名前：説明を閉じてから 12 秒で消す
      if (coachT > 0) {
        if (coachT === Infinity && help && help.state === 'closed') coachT = 12;
        else if (coachT !== Infinity && (coachT -= dtRaw) <= 0) touchUi?.setLabels(uiPrefs.prefs.labels);
      }
      onGrabEvents();
      // スマホの「挟む」スイッチ：閉じているのにハサミが開いた（滑った・抜けた・水流に乗った・瞬間移動）ら、スイッチも開く
      if (input.touchGrabLatch && grab.state === 'idle') touchUi?.setGrabLatched(false);
      if (input.touchGrabLatchL && grabL.state === 'idle') touchUi?.setGrabLatched(false, 'L');
      // 集中モードのスマホの開閉（たたいて切り替え）：滑った・離れたら開く
      if (focusTouch && focus.on) {
        if (grab.state === 'idle' && focusTouch.close.R > 0 && grab.stats.slips + grab.stats.releases !== slipSeen.R) focusTouch.open('R');
        if (grabL.state === 'idle' && focusTouch.close.L > 0 && grabL.stats.slips + grabL.stats.releases !== slipSeen.L) focusTouch.open('L');
      }
      slipSeen.R = grab.stats.slips + grab.stats.releases;
      slipSeen.L = grabL.stats.slips + grabL.stats.releases;
      drawMarks();
      // 積み木が動いた（止まった後）：保存する
      const bsig = blocks.reduce((s, b) => s + b.p[0] * 3.1 + b.p[1] * 7.3 + b.p[2] * 1.7 + b.q[0] + b.q[1] * 2 + b.q[3] * 5, 0);
      if (Math.abs(bsig - blockSig) > 1e-3 && !blocks.some((b) => b.awake)) {
        blockSig = bsig;
        saver.markDirty();
      }
      updateClimbCue();
      // 「スポン！」の文字と輪：穴の上に置いて、0.9 秒で消える
      if (popT > 0 && popAt) {
        popT -= dtRaw;
        const q = view.project(popAt[0], popAt[1], popAt[2]);
        if (q) popWord.style.transform = `translate(${q.x}px, ${q.y}px)`;
        if (popT <= 0) popWord.classList.remove('show');
      }
      life.update(dt, { x: crab.x, y: crab.y + crab.radius, z: crab.z, speed: crab.speed });
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
    footDiag.draw(rig.feet, (x, y, z) => view.project(x, y, z), rig.gait !== 'cycle' && rig.ikW > 0.05, rig.gait === 'lead' || rig.gait === 'hybrid' ? crab : null);
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
      // （左の鋏も使っているときは「右：… / 左：…」）
      const clawText = (G: GS) => {
        const held = G.held, strain = G.strain;
        // （集中モード・アナログのトリガー：握る強さも）
        const gp = held && (focus.on || G.squeeze < 1) ? `・握る ${Math.round(G.gripNow * 100)}%` : '';
        return held ? `${held.name}${strain > 0.8 ? '（重い！）' : strain > 0.45 ? '（ずっしり）' : ''}${gp}` : G.state === 'closing' ? '…' : focus.on ? '—' : '空振り';
      };
      const both = grabL.state !== 'idle' || focus.on;
      const eatingText = eat.eating && eat.food ? `食べている：${eat.food.name}（残り ${Math.round(eat.food.left * 100)}%）` : null;
      const grabChip = grab.state === 'idle' && !both && !eatingText ? null : {
        text: eatingText ?? (both ? `右：${grab.state === 'idle' ? '—' : clawText(grab)} / 左：${clawText(grabL)}` : `挟む：${clawText(grab)}`),
        heavy: !eatingText && ((!!grab.held && grab.strain > 0.45) || (!!grabL.held && grabL.strain > 0.45)),
      };
      // 栄養（一度でも食べたら出す）。詳細の欄：合計・次の脱皮の目安・種類ごと
      const NU = eat.nutrition;
      const nutrition = {
        total: NU.total,
        bar: NU.progress,
        show: NU.total > 0 || eat.stats.starts > 0,
        detail: `${NU.total.toFixed(1)}（脱皮の目安 ${NU.next ?? GROWTH.moltAt[GROWTH.moltAt.length - 1]} まで ${Math.round(NU.progress * 100)}%・段階 ${NU.stage}）　${(['algae', 'plant', 'shrimp', 'fish', 'worm'] as const).map((k) => `${FOOD_KIND[k].name} ${NU.byKind[k].toFixed(1)}（${NU.eaten[k]}）`).join('・')}`,
      };
      // 手持ちの砂（1 杯 = SAND.unit）
      // （第 10 段階：持てる量の上限なし。帯は持っている量の目安＝多いほど満ちる）
      const held = Math.max(0, crab.sandHeld), cups = Math.floor(held / SAND.unit + 1e-6), capCups = 0;
      const st = saver.state;
      const fs = view.digFx.stats;
      const nf = world.dig.fillCount;
      hud.update({
        place: tracker.current ? tracker.current.name : `${REGION_LABEL[crab.region]}のどこか`,
        placeHidden: tracker.current?.kind === 'hidden',
        sand: sandBar(held),
        cups,
        capCups,
        fill: crab.tool === 'fill',
        nutrition,
        swim: crab.swimStamina,
        // 遊泳の体力は、泳いでいる・減っている間だけ小さな表示に出す
        swimShow: crab.state === 'swim' || crab.swimStamina < 0.98,
        // 照準の先の物・挟んでいる物の文字は、案内を出す設定のときだけ小さな表示に（ふだんは詳細の欄だけ）
        dig,
        grab: grabChip,
        guides: uiPrefs.prefs.guides,
        // 警告：保存できていない・別のタブと競合（ふだんはセーブのボタンの印だけ）
        warn: st === 'error' ? '保存できていません（セーブ）' : st === 'conflict' ? '別のタブと競合中（保存していません）' : null,
        // 区画（水槽・濾過槽は水中 / 陸上も）
        zone: region === 'tank' ? (under ? '水中' : '陸上') : region === 'sump' ? `濾過槽・${under ? '水中' : '陸上'}` : REGION_LABEL[region],
        land: !under,
        cam: VIEW_LABEL[camera.view],
        state: CRAB_STATE_LABEL[crab.state],
        found: `${tracker.visited.size} / ${tracker.total}　（ひみつ ${tracker.hiddenFound} / ${tracker.hiddenTotal}）`,
        perf: `${debug.fps.toFixed(0)} FPS ・ E ${(view.stats.tris / 1000).toFixed(0)}k 三角形 + C ${(view.stats.surfels / 1000).toFixed(0)}k 円盤`,
        frame: `フレーム ${debug.fps > 0 ? (1000 / debug.fps).toFixed(1) : '-'} ms（0.5 秒の最大 ${(frameMaxShown * 1000).toFixed(1)} ms）`,
        digPerf: world.dig.count ? `穴 ${world.dig.count - nf} 個${nf ? `・砂山 ${nf} 個` : ''} ・ 区画 ${fs.chunks} ・ 作り直し ${fs.lastMs.toFixed(1)} ms（最大 ${fs.maxMs.toFixed(1)}）・ 待ち ${fs.pending}` : '地形の作り直し：まだ掘っていません',
        viewport: viewport.viewportText(),
        device: ` ・ 音：（）`,
      });
      toolBtn.style.setProperty('--sand', sandBar(held).toFixed(3));
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
  // 描画を失っている・準備中の間は、描画もゲームの更新も止める（戻ったときに時間が飛ばないよう、時刻だけ進める）
  let rendered = 0, beatT = 0;
  const selftest: { mode: string | null } = { mode: null };
  const beat = () =>
    diag(`frame ${rendered} fps=${debug.fps.toFixed(0)} gpu=${gpu.state} holes=${world.dig.count} sand=${crab.sandHeld.toFixed(2)} buddy=${buddy.found ? buddy.mode : 'hidden'} worms=${worms.worms.map((w) => w.life).join('/')} pos=${crab.x.toFixed(2)},${crab.z.toFixed(2)} save=${saver.state} writes=${store.stats.writes}`);
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (!gpu.canRender) {
      last = Math.max(last, now);
      return;
    }
    const dtRaw = Math.min(Math.max((now - last) / 1000, 0), 0.25);
    last = Math.max(last, now);
    const tf = rendered < 3 ? performance.now() : 0;
    tick(dtRaw);
    rendered++;
    if (tf) diag(`frame ${rendered} took ${(performance.now() - tf).toFixed(0)}ms programs=${view.renderer.info.programs?.length ?? 0}`);
    // 最初の 60 秒（自動検証の間は 4 分）は 5 秒ごとに記録する
    beatT += dtRaw;
    if (beatT >= 5 && performance.now() - t0 < (selftest.mode ? 240_000 : 60_000)) {
      beatT = 0;
      beat();
    }
  };
  loading.textContent = '描画を準備しています…';
  selftest.mode = await selftestP;
  if (selftest.mode) diag(`selftest ${selftest.mode}`);
  skipPrepare = selftest.mode === 'noprepare';
  await gpu.start();
  gpu.attach(
    {
      // 控え（同期）を書いてから保存先へ。保存しない設定（?nosave）なら書かずに成功扱い。競合中は書かない（false = 自動の読み込み直しをしない）
      flush: async () => {
        if (noSave) return true;
        if (saver.suspended || store.conflict) return false;
        store.writeJournal(store.stamp(gather()));
        return saver.flush();
      },
    },
    toast,
  );
  loading.remove();
  /** 起動から最初のフレームまで（生成 + 保存データの読み込み・復元） */
  const bootMs = performance.now() - t0;
  diag(`boot done ${bootMs.toFixed(0)}ms gpu=${gpu.state}`);
  // 画面の大きさ・安全領域・操作ボタンの位置（iOS の画面の下の帯・ホームインジケーターとボタンの重なりを記録で確かめる）
  requestAnimationFrame(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const safe = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => parseFloat(v) || 0);
    probe.remove();
    const cr = canvas.getBoundingClientRect();
    let low = 0, lowName = '-';
    for (const el of document.querySelectorAll<HTMLElement>('#touch-ui .stick, #touch-ui button')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > low) [low, lowName] = [r.bottom, el.className.split(' ')[0] || el.tagName];
    }
    diag(`layout inner=${window.innerWidth}x${window.innerHeight} canvas=${cr.width.toFixed(0)}x${cr.height.toFixed(0)}@${cr.top.toFixed(0)} safe(t,r,b,l)=${safe.join(',')} lowestControl=${lowName}:${low.toFixed(0)} limit=${(window.innerHeight - safe[2]).toFixed(0)}`);
  });
  requestAnimationFrame(loop);
  // 自動検証（アプリ版：環境変数 AQUA_SELFTEST、ブラウザ版：?selftest=）。gpu = 起動の 4 秒後にその場で 2.5 秒掘って保存し、
  // 状態を記録する（CI が外から GPU 処理を止め、復旧の後も穴・手持ちの砂が残るかを記録で確かめる）
  if (selftest.mode === 'gpu') {
    setTimeout(() => {
      debug.dig = true;
      debug.digAim = { x: 0, y: -0.55 };
      setTimeout(() => {
        debug.dig = false;
        debug.digAim = null;
        saver.markImportant();
        setTimeout(() => {
          diag('selftest dug');
          beat();
        }, 1500);
      }, 2500);
    }, 4000);
  }
  (window as unknown as Record<string, unknown>).__aqua = Object.assign(debug, { world, crab, rig, camera, view, settings, input, spots, finds, tracker, life, resetDiscovery, goto, places, sump: SUMP, save: { store, saver, menu: saveMenu, ctx: saveCtx, gather, restore: restoreInfo, loaded }, help, viewport, buddy, toggleBuddy, worms, grab, grabL, eat, algae, eatClaws, plantField, pushers, plantSet: plants.set, weeds, plantGrabR, plantGrabL, lifeGrabR, lifeGrabL, props, decor, touchUi, focus, focusTouch, marks, blocks, resetBlocks: () => resetBlocks(props, blocks), setFocus: (on: boolean) => setFocus(on), focusCtls, setView, cycleView, toggleClose, picker, viewToast, moveLatch: () => moveLatch, uiPrefs, audio, audioMenu, pad, buildMs, bootMs, gpu, diagLog, buildPhases: built.ms, plantMs: plants.ms, plantCounts: plants.counts, plantTimes: plants.times });
}

// 読み込み表示を先に描画させてから重い生成処理に入る
setTimeout(() => {
  boot().catch((e) => {
    const l = document.getElementById('loading');
    if (l) l.textContent = `初期化に失敗しました：${(e as Error).message}`;
    throw e;
  });
}, 50);
