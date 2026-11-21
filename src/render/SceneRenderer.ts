// 描画の統括。ゲーム状態を読み取るだけで、ゲームロジックには書き込まない。

import * as THREE from 'three';
import type { Game } from '../game/Game';
import { meshCharCell, type RenderMethod, type RenderSettings, type SplatSource } from '../settings';
import { BONE_PIVOTS, CHARACTER_PARTS } from '../visual/emitters/character';
import { buildSdfCharacter, buildSdfObjects, characterSourceFromGeometry, type CharacterSplatSource } from '../visual/sdf/sdfObjects';
import { SUN_DIR, type WorldVisuals } from '../visual/WorldVisualBuilder';
import type { IslandLayout } from '../world/IslandLayout';
import { CharacterRig } from './CharacterRig';
import { createParticleMaterial, createSharedUniforms } from './ParticleMaterial';
import { PixelPipeline } from './PixelPipeline';
import { mergeAndShuffle, pointSetFromBuilder, pointSetFromGeometry, type SplatPointSet } from './shared/PointSet';
import { SurfelRenderer } from './surfel/SurfelRenderer';
import { buildVoxelCharacter, buildVoxelWorld, type VoxelCharacter, type VoxelWorld } from './voxel/VoxelGrid';
import { VoxelRenderer } from './voxel/VoxelRenderer';
import { buildPixelMeshCharacter, buildPixelMeshWorld, buildPointIndex, type PixelMeshCharacter, type PixelMeshWorld } from './pixelmesh/MeshBuild';
import type { PointIndex } from './pixelmesh/PointIndex';
import { PixelMeshRenderer } from './pixelmesh/PixelMeshRenderer';
import { HybridRenderer, hybridSurfelSet } from './hybrid/HybridRenderer';
// 方式 B（Spark）は型だけを静的に参照し、実体は必要になったときに動的 import で読み込む
import type { SplatRenderer } from './splat/SplatRenderer';

type SplatModule = typeof import('./splat/SplatModule');
/** 方式 B のモジュールの読み込み状態 */
export type SplatLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

const ORTHO_DISTANCE = 90;

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly uniforms = createSharedUniforms();
  readonly pipeline = new PixelPipeline();
  readonly rig = new CharacterRig();
  private readonly particleScene = new THREE.Scene();
  private readonly meshScene = new THREE.Scene();
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 220);
  private readonly persp = new THREE.PerspectiveCamera(35, 1, 0.5, 260);
  private readonly worldPoints: THREE.Points;
  private readonly charPoints: THREE.Points;
  private readonly charMeshRoot = new THREE.Group();
  private readonly charMeshBones: THREE.Group[] = [];
  /** 方式 A の粒の総数（形状データの切り替えで変わる） */
  worldTotal: number;
  charTotal: number;
  private readonly offset = new THREE.Vector2();
  /** 最後に描いた粒数 */
  drawnParticles = 0;
  /** 最後に描いたスプラット数（方式 B） */
  drawnSplats = 0;
  /** 方式 B の描画一式（使っていない間は null = GPU 資源を持たない） */
  splat: SplatRenderer | null = null;
  private splatKey = '';
  /** 形状データ（A・B・C 共通。CPU 側にだけ保持し、方式を戻したときの作り直しに使う） */
  private readonly shapeSources = new Map<SplatSource, { world: SplatPointSet; character: CharacterSplatSource; ms: number }>();
  /** 方式 A の粒ジオメトリがどの形状データか */
  private pointsSource: SplatSource = 'convert';
  /** 方式 C の描画一式（使っていない間は null = GPU 資源を持たない） */
  surfel: SurfelRenderer | null = null;
  private surfelKey = '';
  surfelBuildMs = 0;
  surfelRebuilds = 0;
  /** 最後に描いたサーフェル数（方式 C） */
  drawnSurfels = 0;
  /** 方式 D の描画一式（使っていない間は null = GPU 資源を持たない） */
  voxel: VoxelRenderer | null = null;
  private voxelWorldKey = '';
  private voxelCharKey = '';
  /** 方式 D を作り直した回数（浮き島 / キャラクター。GPU 資源の蓄積確認用） */
  voxelRebuilds = 0;
  voxelCharRebuilds = 0;
  /** 最後に描いた面の数（方式 D。ボクセル数ではない） */
  drawnVoxelFaces = 0;
  /** 方式 D の CPU 側のボクセル（直前に作ったもの。方式を戻したときに作り直さずに GPU へ上げ直す） */
  private voxelCache: { world?: { key: string; data: VoxelWorld }; char?: { key: string; data: VoxelCharacter } } = {};
  /** 方式 E の描画一式（使っていない間は null = GPU 資源を持たない） */
  pixelMesh: PixelMeshRenderer | null = null;
  private meshWorldKey = '';
  private meshCharKey = '';
  /** 方式 E を作り直した回数（浮き島 / キャラクター。GPU 資源の蓄積確認用） */
  meshRebuilds = 0;
  meshCharRebuilds = 0;
  /** 最後に描いた三角形の数（方式 E） */
  drawnMeshTris = 0;
  /** 方式 E の CPU 側のメッシュ（直前に作ったもの。方式を戻したときに作り直さずに GPU へ上げ直す）と点群の索引 */
  private meshCache: { world?: { key: string; data: PixelMeshWorld }; char?: { key: string; data: PixelMeshCharacter }; index?: { src: SplatSource; data: PointIndex; ms: number } } = {};
  /** 方式 F の描画一式（使っていない間は null = GPU 資源を持たない） */
  hybrid: HybridRenderer | null = null;
  private hybridWorldKey = '';
  private hybridCharKey = '';
  /** 方式 F の E 側を作り直した回数（浮き島） */
  hybridRebuilds = 0;
  /** 最後に描いた三角形・円盤の数（方式 F の E 側 / C 側） */
  drawnHybridTris = 0;
  drawnHybridSurfels = 0;
  /** 方式 F の CPU 側のメッシュ（樹冠なし・幹は別。直前に作ったもの）と C 側の点群（幹の扱いごと） */
  private hybridCache: { world?: { key: string; data: PixelMeshWorld }; surfels: Map<string, SplatPointSet> } = { surfels: new Map() };
  /** 草花・雲の粒（方式 D の立体化用。カテゴリで取り出して CPU 側に保持） */
  private decorPoints: { decor: SplatPointSet; clouds: SplatPointSet } | null = null;
  /** 方式 B の生成にかかった時間（点群の用意 / GPU 側の構築） */
  splatPrepMs = 0;
  splatBuildMs = 0;
  /** 方式 B を作り直した回数（GPU 資源の蓄積確認用） */
  splatRebuilds = 0;
  /** 方式 B のモジュール（Spark を含む）の読み込み状態・所要時間・失敗理由 */
  splatStatus: SplatLoadStatus = 'idle';
  splatLoadMs = 0;
  splatError = '';
  private splatModule: SplatModule | null = null;
  /** 読み込み関数（テストで失敗を再現できるよう差し替え可能にしている） */
  splatImporter: () => Promise<SplatModule> = () => import('./splat/SplatModule');
  private readonly visuals: WorldVisuals;
  private lastLowCam: THREE.OrthographicCamera | THREE.PerspectiveCamera | null = null;
  /** スナップ後のカメラ位置（低解像度画素単位の整数。ちらつき計測の動き補正に使う） */
  readonly snapIndex = new THREE.Vector2();
  private analysisRT: THREE.WebGLRenderTarget | null = null;
  /** 隙間の評価用：深度テクスチャ → 線形の奥行き（ワールド単位）へ変換する一式（解析時だけ作る） */
  private depthPass: { scene: THREE.Scene; cam: THREE.OrthographicCamera; mat: THREE.ShaderMaterial; geo: THREE.BufferGeometry } | null = null;
  private refRT: THREE.WebGLRenderTarget | null = null;

  constructor(canvas: HTMLCanvasElement, visuals: WorldVisuals) {
    this.visuals = visuals;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.uniforms.uSunDir.value.set(...SUN_DIR);

    // 粒（世界全体を 1 ドローコール、キャラクターで 1 ドローコール）
    this.worldPoints = new THREE.Points(visuals.world, createParticleMaterial(this.uniforms, { receiveBlob: true }));
    this.worldPoints.frustumCulled = false;
    this.worldTotal = visuals.world.getAttribute('position').count;
    this.charPoints = new THREE.Points(visuals.character, createParticleMaterial(this.uniforms, { bones: this.rig.bones }));
    this.charPoints.frustumCulled = false;
    this.charPoints.matrixAutoUpdate = false;
    this.charTotal = visuals.character.getAttribute('position').count;
    this.particleScene.add(this.worldPoints, this.charPoints);

    // 比較用の簡易メッシュ
    this.meshScene.background = new THREE.Color('#a9cfe8');
    this.meshScene.add(new THREE.HemisphereLight('#b4c4e0', '#6b5c48', 1.1));
    const sun = new THREE.DirectionalLight('#fff0cc', 2.2);
    sun.position.set(SUN_DIR[0] * 50, SUN_DIR[1] * 50, SUN_DIR[2] * 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 120 });
    sun.shadow.bias = -0.0008;
    this.meshScene.add(sun);
    visuals.proxies.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
    });
    this.meshScene.add(visuals.proxies);
    this.charMeshRoot.matrixAutoUpdate = false;
    for (let i = 0; i < this.rig.bones.length; i++) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      this.charMeshBones.push(g);
      this.charMeshRoot.add(g);
    }
    for (const part of CHARACTER_PARTS) {
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(...part.color, THREE.SRGBColorSpace) });
      let mesh: THREE.Mesh;
      const pivot = new THREE.Vector3(...BONE_PIVOTS[part.bone]);
      if (part.kind === 'ellipsoid') {
        const r = part.r as number[];
        mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat);
        mesh.scale.set(r[0], r[1], r[2]);
        mesh.position.set(...part.a).sub(pivot);
      } else {
        const a = new THREE.Vector3(...part.a), b = new THREE.Vector3(...part.b!);
        const len = a.distanceTo(b);
        mesh = new THREE.Mesh(new THREE.CapsuleGeometry(part.r as number, len, 3, 8), mat);
        mesh.position.copy(a).add(b).multiplyScalar(0.5).sub(pivot);
      }
      mesh.castShadow = true;
      this.charMeshBones[part.bone].add(mesh);
    }
    this.meshScene.add(this.charMeshRoot);
  }

  setSize(w: number, h: number) {
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h, false);
  }

  /** 低解像度画素の描画サイズ（表示用） */
  get lowResolution() {
    return { w: this.pipeline.lowW, h: this.pipeline.lowH };
  }

  /**
   * カメラを配置する。forLow=true なら低解像度ターゲット用（画素スナップ付き）。
   * 戻り値の offset はスナップで生じたズレ（低解像度画素単位）。
   */
  private setupCamera(game: Game, s: RenderSettings, forLow: boolean): THREE.OrthographicCamera | THREE.PerspectiveCamera {
    const rig = game.camera;
    const [dx, dy, dz] = rig.direction();
    const t = rig.target;
    const p = this.pipeline;
    const viewW = forLow ? p.lowW : p.canvasLowW;
    const viewH = forLow ? p.lowH : p.canvasLowH;
    this.offset.set(0, 0);
    if (s.projection === 'ortho') {
      const cam = this.ortho;
      // ズーム値は画面の短い辺に映る長さ（縦長のスマホでも狭くなりすぎない）
      const wpp = rig.zoom / Math.min(p.canvasLowW, p.canvasLowH); // 1 画素あたりのワールド長
      cam.left = (-viewW / 2) * wpp;
      cam.right = (viewW / 2) * wpp;
      cam.top = (viewH / 2) * wpp;
      cam.bottom = (-viewH / 2) * wpp;
      cam.updateProjectionMatrix();
      cam.position.set(t.x + dx * ORTHO_DISTANCE, t.y + dy * ORTHO_DISTANCE, t.z + dz * ORTHO_DISTANCE);
      cam.up.set(0, 1, 0);
      cam.lookAt(t.x, t.y, t.z);
      if (forLow && s.cameraSnap) {
        // カメラ平面上で位置を画素グリッドに丸め、残りは後処理で滑らかにずらす
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
        const rx = cam.position.dot(right), uy = cam.position.dot(up);
        const sx = Math.round(rx / wpp) * wpp, sy = Math.round(uy / wpp) * wpp;
        this.snapIndex.set(Math.round(rx / wpp), Math.round(uy / wpp));
        cam.position.addScaledVector(right, sx - rx).addScaledVector(up, sy - uy);
        this.offset.set((sx - rx) / wpp, (sy - uy) / wpp);
      }
      cam.updateMatrixWorld();
      this.uniforms.uFogNear.value = ORTHO_DISTANCE + 6;
      this.uniforms.uFogFar.value = ORTHO_DISTANCE + 60;
      return cam;
    }
    const cam = this.persp;
    cam.fov = s.fov;
    cam.aspect = viewW / viewH;
    const portrait = Math.max(1, p.canvasLowH / p.canvasLowW);
    const dist = (rig.zoom * portrait) / (2 * Math.tan(THREE.MathUtils.degToRad(s.fov) / 2));
    cam.near = Math.max(0.3, dist * 0.05);
    cam.far = dist + 160;
    cam.updateProjectionMatrix();
    cam.position.set(t.x + dx * dist, t.y + dy * dist, t.z + dz * dist);
    cam.lookAt(t.x, t.y, t.z);
    cam.updateMatrixWorld();
    this.uniforms.uFogNear.value = dist + 6;
    this.uniforms.uFogFar.value = dist + 60;
    return cam;
  }

  private applySettings(s: RenderSettings, time: number) {
    const u = this.uniforms;
    u.uTime.value = time;
    const comp = s.densityComp ? Math.min(2.2, Math.pow(Math.max(s.density, 0.02), -0.5)) : 1;
    u.uPointScale.value = s.pointSize * comp;
    u.uWind.value = s.wind;
    u.uAmbient.value = s.ambient;
    u.uShadowStrength.value = s.shadowStrength;
    u.uLightSteps.value = s.lightSteps;
    u.uSnap.value = s.pointSnap ? 1 : 0;
    u.uFogStrength.value = s.fog;
    u.uGaussShade.value = s.gaussShade;
    u.uGaussSharp.value = s.gaussSharp;
    u.uAlphaCut.value = s.alphaCut;
    u.uAlphaDither.value = s.alphaDither ? 1 : 0;
    u.uRes.value.set(this.pipeline.lowW, this.pipeline.lowH);
  }

  /** いま画面に出す方式の並び（左右比較なら [左, 右]）。メッシュのみの表示では空 */
  private wantedMethods(s: RenderSettings): RenderMethod[] {
    if (s.viewMode === 'mesh') return [];
    if (s.viewMode === 'compare') return [s.compareLeft, s.compareRight];
    return [s.renderMethod];
  }

  /** 実際に描く方式（方式 B の読み込み中・失敗時は方式 A で代わりに描き、操作を止めない） */
  shownMethods(s: RenderSettings): RenderMethod[] {
    return this.wantedMethods(s).map((m) => (m === 'splats' && !this.splat ? 'points' : m));
  }

  render(game: Game, s: RenderSettings, dt: number) {
    const canvas = this.renderer.domElement;
    const cw = canvas.width, ch = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(1, Math.round(s.pixelScale * dpr));
    this.pipeline.ensureSize(cw, ch, scale);
    this.applySettings(s, game.time);

    // 形状データ（A・B・C 共通）の選択
    this.syncShapes(s.splatSource, game.layout);

    // キャラクター
    const c = game.character;
    this.rig.update(dt, c);
    this.charPoints.matrix.copy(this.rig.root);
    this.charPoints.matrixWorld.copy(this.rig.root);
    this.uniforms.uCharPos.value.set(c.x, c.y, c.z);

    // 密度：シャッフル済みバッファの先頭から必要数だけ描く
    const n = Math.max(1, Math.round(this.worldTotal * s.density));
    this.worldPoints.geometry.setDrawRange(0, n);

    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, cw / r.getPixelRatio(), ch / r.getPixelRatio());

    // 方式 B・C・D・E・F は必要なときだけ GPU 資源を持つ（使わなくなったら解放する）
    const wanted = this.wantedMethods(s);
    this.syncSplat(wanted.includes('splats'), s.splatSource, game.layout);
    this.syncSurfel(wanted.includes('surfels'), s.splatSource, game.layout);
    this.syncVoxel(wanted.includes('voxels'), s, game.layout);
    this.syncPixelMesh(wanted.includes('pixelmesh'), s, game.layout);
    this.syncHybrid(wanted.includes('hybrid'), s, game.layout);
    const shown = this.shownMethods(s);
    this.drawnParticles = shown.includes('points') ? n + this.charTotal : 0;
    this.drawnSplats = 0;
    this.drawnSurfels = 0;
    this.drawnVoxelFaces = 0;
    this.drawnMeshTris = 0;
    this.drawnHybridTris = 0;
    this.drawnHybridSurfels = 0;

    if (shown.length) {
      const cam = this.setupCamera(game, s, true);
      this.lastLowCam = cam;
      this.uniforms.uPxPerUnit.value = cam.projectionMatrix.elements[5] * this.pipeline.lowH * 0.5;
      this.uniforms.uIsOrtho.value = s.projection === 'ortho' ? 1 : 0;
      const offset = this.offset.clone().negate();
      const comp = s.densityComp ? Math.min(2.2, Math.pow(Math.max(s.density, 0.02), -0.5)) : 1;
      // まず使う方式をすべて低解像度ターゲットへ描く（ハサミ切り抜きはターゲットにも効くので切っておく）
      if (shown.includes('points')) this.pipeline.renderScene(r, this.particleScene, cam);
      if (shown.includes('splats') && this.splat) {
        this.splat.update(s, this.rig, cam, comp);
        this.splat.renderScene(r, cam, this.pipeline.lowW, this.pipeline.lowH, Math.round(s.splatSupersample) >= 2 ? 2 : 1);
        this.drawnSplats = this.splat.drawn;
      }
      if (shown.includes('surfels') && this.surfel) {
        this.surfel.update(s, this.rig, comp, this.pipeline.lowW, this.pipeline.lowH);
        this.surfel.renderScene(r, cam, cw, ch, scale);
        this.drawnSurfels = this.surfel.drawn;
      }
      if (shown.includes('voxels') && this.voxel) {
        this.voxel.update(s, this.rig, cam);
        this.voxel.renderScene(r, cam, cw, ch, scale);
        this.drawnVoxelFaces = this.voxel.drawnFaces;
      }
      if (shown.includes('pixelmesh') && this.pixelMesh) {
        this.pixelMesh.update(s, this.rig);
        this.pixelMesh.renderScene(r, cam, cw, ch, scale);
        this.drawnMeshTris = this.pixelMesh.drawnTris;
      }
      if (shown.includes('hybrid') && this.hybrid) {
        this.hybrid.update(s, this.rig, comp, this.pipeline.lowW, this.pipeline.lowH);
        this.hybrid.renderScene(r, cam, cw, ch, scale);
        this.drawnHybridTris = this.hybrid.drawnTris;
        this.drawnHybridSurfels = this.hybrid.drawnSurfels;
      }
      const pr = r.getPixelRatio();
      const W = cw / pr, H = ch / pr;
      if (shown.length === 2) {
        // 左右比較：同じカメラ・同じ描画解像度で、左右に別の方式を合成する
        r.setScissorTest(true);
        r.setScissor(0, 0, W / 2, H);
        this.compositeMethod(shown[0], s, cam, offset);
        r.setScissor(W / 2, 0, W / 2, H);
        this.compositeMethod(shown[1], s, cam, offset);
        r.setScissorTest(false);
      } else {
        this.compositeMethod(shown[0], s, cam, offset);
      }
    }

    if (s.viewMode === 'mesh' || s.viewMode === 'split') {
      this.charMeshRoot.matrix.copy(this.rig.root);
      this.rig.bones.forEach((m, i) => this.charMeshBones[i].matrix.copy(m));
      this.charMeshRoot.updateMatrixWorld(true);
      const cam = this.setupCamera(game, s, false);
      const pr = r.getPixelRatio();
      const W = cw / pr, H = ch / pr;
      if (s.viewMode === 'split') {
        r.setScissorTest(true);
        r.setScissor(W / 2, 0, W / 2, H);
      }
      r.setClearColor('#a9cfe8', 1);
      r.clear(true, true, true);
      r.render(this.meshScene, cam);
      r.setScissorTest(false);
    }
  }

  /** 方式ごとの後処理（輪郭・ディザ・減色・拡大）。mask=true ならシルエットのマスクを出す */
  private compositeMethod(
    m: RenderMethod, s: RenderSettings, cam: THREE.OrthographicCamera | THREE.PerspectiveCamera, offset: THREE.Vector2,
    target: THREE.WebGLRenderTarget | null = null, raw = false, mask = false,
  ) {
    if (m === 'splats' && this.splat) this.splat.post.composite(this.renderer, s, offset, target, raw, mask);
    else if (m === 'surfels' && this.surfel) this.surfel.pipeline.composite(this.renderer, s, cam, offset, target, raw, mask);
    else if (m === 'voxels' && this.voxel) this.voxel.pipeline.composite(this.renderer, s, cam, offset, target, raw, mask);
    else if (m === 'pixelmesh' && this.pixelMesh) this.pixelMesh.pipeline.composite(this.renderer, s, cam, offset, target, raw, mask);
    else if (m === 'hybrid' && this.hybrid) this.hybrid.pipeline.composite(this.renderer, s, cam, offset, target, raw, mask);
    else this.pipeline.composite(this.renderer, s, cam, offset, target, raw, mask);
  }

  /** 方式 B のモジュール（Spark）を読み込む。読み込み済み・読み込み中なら何もしない */
  private loadSplatModule() {
    if (this.splatStatus === 'loading' || this.splatStatus === 'ready' || this.splatStatus === 'error') return;
    this.splatStatus = 'loading';
    this.splatError = '';
    const t0 = performance.now();
    this.splatImporter().then(
      (m) => {
        this.splatModule = m;
        this.splatLoadMs = performance.now() - t0;
        this.splatStatus = 'ready';
      },
      (e: unknown) => {
        this.splatStatus = 'error';
        this.splatError = e instanceof Error ? e.message : String(e);
        console.error('方式 B（Spark）の読み込みに失敗しました', e);
      },
    );
  }

  /** 読み込み失敗の後、次に方式 B を選んだときに読み込みをやり直せるようにする */
  resetSplatError() {
    if (this.splatStatus === 'error') this.splatStatus = 'idle';
  }

  /** 形状データを用意する（A・B・C 共通。初回だけ CPU で生成し、以後は使い回す） */
  private shapeSource(src: SplatSource, layout: IslandLayout) {
    let d = this.shapeSources.get(src);
    if (d) return d;
    const t0 = performance.now();
    const cg = this.visuals.character;
    if (src === 'sdf') {
      // 樹木・岩・キャラクターを SDF から生成し、地形・草花・雲は既存の粒をそのまま使う
      const rest = pointSetFromGeometry(this.visuals.world, ['樹木', '岩']);
      const objs = pointSetFromBuilder(buildSdfObjects(layout));
      d = { world: mergeAndShuffle([rest, objs]), character: buildSdfCharacter(), ms: 0 };
    } else {
      const character = characterSourceFromGeometry(
        cg.getAttribute('position').array, cg.getAttribute('aColor').array, cg.getAttribute('normal').array,
        cg.getAttribute('aMisc').array, cg.getAttribute('aBone').array, cg.getAttribute('position').count,
      );
      // 法線は正規化済み整数（-127..127）なので実数へ戻す
      for (let i = 0; i < character.nrm.length; i++) character.nrm[i] /= 127;
      d = { world: pointSetFromGeometry(this.visuals.world), character, ms: 0 };
    }
    d.ms = performance.now() - t0;
    this.shapeSources.set(src, d);
    return d;
  }

  /**
   * 方式 A の粒ジオメトリを形状データに合わせる。「変換」は生成時のジオメトリそのもの、
   * 「SDF」は共通の点群から作ったジオメトリ（切り替えで前のものは GPU から解放する）。
   */
  private syncShapes(src: SplatSource, layout: IslandLayout) {
    if (src === this.pointsSource) return;
    this.pointsSource = src;
    const prevW = this.worldPoints.geometry, prevC = this.charPoints.geometry;
    if (src === 'sdf') {
      const d = this.shapeSource(src, layout);
      this.worldPoints.geometry = pointsGeometryFromSet(d.world);
      this.charPoints.geometry = pointsGeometryFromCharacter(d.character);
    } else {
      this.worldPoints.geometry = this.visuals.world;
      this.charPoints.geometry = this.visuals.character;
    }
    if (prevW !== this.visuals.world && prevW !== this.worldPoints.geometry) prevW.dispose();
    if (prevC !== this.visuals.character && prevC !== this.charPoints.geometry) prevC.dispose();
    this.worldTotal = this.worldPoints.geometry.getAttribute('position').count;
    this.charTotal = this.charPoints.geometry.getAttribute('position').count;
  }

  /** 方式 B の GPU 資源を必要に応じて作成・破棄する */
  private syncSplat(want: boolean, src: SplatSource, layout: IslandLayout) {
    // モジュールが未読み込みなら読み込みを始め、届くまでは方式 A で描く（キーは確定させない）
    const m = this.splatModule;
    if (want && !m) {
      this.loadSplatModule();
      return;
    }
    const key = want ? src : '';
    if (key === this.splatKey) return;
    this.splatKey = key;
    this.splat?.dispose();
    this.splat = null;
    if (!want || !m) return;
    const d = this.shapeSource(src, layout);
    this.splatPrepMs = d.ms;
    this.splat = new m.SplatRenderer(this.renderer, this.uniforms, this.pipeline, d.world, d.character);
    this.splatBuildMs = this.splat.buildMs;
    this.splatRebuilds++;
  }

  /** 方式 C の GPU 資源を必要に応じて作成・破棄する */
  private syncSurfel(want: boolean, src: SplatSource, layout: IslandLayout) {
    const key = want ? src : '';
    if (key === this.surfelKey) return;
    this.surfelKey = key;
    this.surfel?.dispose();
    this.surfel = null;
    if (!want) return;
    const d = this.shapeSource(src, layout);
    this.surfel = new SurfelRenderer(this.uniforms, this.rig, d.world, d.character);
    this.surfelBuildMs = this.surfel.buildMs;
    this.surfelRebuilds++;
  }

  /**
   * 方式 D の GPU 資源を必要に応じて作成・破棄する。浮き島とキャラクターは別々に作り直す
   * （キャラクターの粒度だけを変えたときに浮き島まで作り直さない）。
   */
  private syncVoxel(want: boolean, s: RenderSettings, layout: IslandLayout) {
    if (!want) {
      if (this.voxel) {
        this.voxel.dispose();
        this.voxel = null;
        this.voxelWorldKey = this.voxelCharKey = '';
      }
      return;
    }
    if (!this.voxel) this.voxel = new VoxelRenderer(this.uniforms, this.rig);
    const wKey = `${s.splatSource}|${s.voxelSize}|${s.voxelDecor}|${s.voxelFlowers}`;
    if (wKey !== this.voxelWorldKey) {
      this.voxelWorldKey = wKey;
      const d = this.shapeSource(s.splatSource, layout);
      if (!this.decorPoints) {
        const names = (this.visuals.world.userData.catNames as string[] | undefined) ?? [];
        const only = (keep: string) => pointSetFromGeometry(this.visuals.world, names.filter((n) => n !== keep));
        this.decorPoints = { decor: only('草花'), clouds: only('雲') };
      }
      let w = this.voxelCache.world;
      if (w?.key !== wKey) {
        w = { key: wKey, data: buildVoxelWorld(layout, d.world, this.decorPoints.decor, this.decorPoints.clouds, { size: s.voxelSize, decor: s.voxelDecor, flowers: s.voxelFlowers }) };
        this.voxelCache.world = w;
        this.voxelRebuilds++;
      }
      this.voxel.setWorld(w.data);
    }
    const cKey = String(s.voxelCharSize);
    if (cKey !== this.voxelCharKey) {
      this.voxelCharKey = cKey;
      let c = this.voxelCache.char;
      if (c?.key !== cKey) {
        c = { key: cKey, data: buildVoxelCharacter(s.voxelCharSize) };
        this.voxelCache.char = c;
        this.voxelCharRebuilds++;
      }
      this.voxel.setCharacter(c.data);
    }
  }

  /**
   * 方式 E の GPU 資源を必要に応じて作成・破棄する。浮き島とキャラクターは別々に作り直す。
   * 色を写す点群の索引は形状データ（splatSource）ごとに 1 つだけ CPU 側に保持する。
   */
  private syncPixelMesh(want: boolean, s: RenderSettings, layout: IslandLayout) {
    if (!want) {
      if (this.pixelMesh) {
        this.pixelMesh.dispose();
        this.pixelMesh = null;
        this.meshWorldKey = this.meshCharKey = '';
      }
      return;
    }
    if (!this.pixelMesh) this.pixelMesh = new PixelMeshRenderer(this.uniforms, this.rig);
    const wKey = `${s.splatSource}|${s.meshDetail}`;
    if (wKey !== this.meshWorldKey) {
      this.meshWorldKey = wKey;
      let w = this.meshCache.world;
      if (w?.key !== wKey) {
        const idx = this.pointIndexFor(s.splatSource, layout);
        w = { key: wKey, data: buildPixelMeshWorld(layout, idx.data, this.visuals.hints, { detail: s.meshDetail }, idx.ms) };
        // 索引の時間は作った回だけ数える
        idx.ms = 0;
        this.meshCache.world = w;
        this.meshRebuilds++;
      }
      this.pixelMesh.setWorld(w.data);
    }
    const cKey = String(meshCharCell(s.meshDetail));
    if (cKey !== this.meshCharKey) {
      this.meshCharKey = cKey;
      let c = this.meshCache.char;
      if (c?.key !== cKey) {
        c = { key: cKey, data: buildPixelMeshCharacter(meshCharCell(s.meshDetail)) };
        this.meshCache.char = c;
        this.meshCharRebuilds++;
      }
      this.pixelMesh.setCharacter(c.data);
    }
  }

  /** 方式 E・F 共通：色を写す点群の索引（形状データごとに 1 つだけ CPU 側に保持） */
  private pointIndexFor(src: SplatSource, layout: IslandLayout) {
    let idx = this.meshCache.index;
    if (idx?.src !== src) {
      const t0 = performance.now();
      const d = this.shapeSource(src, layout);
      idx = { src, data: buildPointIndex(d.world), ms: 0 };
      idx.ms = performance.now() - t0;
      this.meshCache.index = idx;
    }
    return idx;
  }

  /**
   * 方式 F の GPU 資源を必要に応じて作成・破棄する。
   * - E 側：樹冠を省いたメッシュ（幹は別のメッシュ）。細かさ・形状データが変わったときだけ作り直す。キャラクターは E と同じもの。
   * - C 側：既存の粒データから草花・葉（幹を C にしたときは幹も）を取り出した円盤。幹の扱いを変えたときだけ作り直す。
   */
  private syncHybrid(want: boolean, s: RenderSettings, layout: IslandLayout) {
    if (!want) {
      if (this.hybrid) {
        this.hybrid.dispose();
        this.hybrid = null;
        this.hybridWorldKey = this.hybridCharKey = '';
      }
      return;
    }
    if (!this.hybrid) this.hybrid = new HybridRenderer(this.uniforms, this.rig);
    const wKey = `${s.splatSource}|${s.meshDetail}`;
    if (wKey !== this.hybridWorldKey) {
      this.hybridWorldKey = wKey;
      let w = this.hybridCache.world;
      if (w?.key !== wKey) {
        const idx = this.pointIndexFor(s.splatSource, layout);
        w = { key: wKey, data: buildPixelMeshWorld(layout, idx.data, this.visuals.hints, { detail: s.meshDetail, hybrid: true }, idx.ms) };
        idx.ms = 0;
        this.hybridCache.world = w;
        this.hybridRebuilds++;
      }
      this.hybrid.setWorld(w.data);
    }
    const cKey = String(meshCharCell(s.meshDetail));
    if (cKey !== this.hybridCharKey) {
      this.hybridCharKey = cKey;
      let c = this.meshCache.char;
      if (c?.key !== cKey) {
        c = { key: cKey, data: buildPixelMeshCharacter(meshCharCell(s.meshDetail)) };
        this.meshCache.char = c;
        this.meshCharRebuilds++;
      }
      this.hybrid.setCharacter(c.data);
    }
    // C 側は常に既存の粒データ（変換）から取り出す（SDF 生成の点群にはカテゴリが残らないため。E 側の色の写し元は splatSource に従う）
    const trunk = s.hybridTrunk === 'surfel';
    const sKey = trunk ? 'trunk' : 'leaves';
    this.hybrid.setSurfels(sKey, () => {
      let set = this.hybridCache.surfels.get(sKey);
      if (!set) {
        set = hybridSurfelSet(this.visuals.world, trunk);
        this.hybridCache.surfels.set(sKey, set);
      }
      return set;
    });
  }

  /** 形状データの点数（統計表示用） */
  splatSourceInfo(src: SplatSource) {
    const d = this.shapeSources.get(src);
    return d ? { world: d.world.count, character: d.character.count } : null;
  }

  private ensureAnalysisRT(w: number, h: number, type: THREE.TextureDataType = THREE.UnsignedByteType) {
    const cur = this.analysisRT;
    if (!cur || cur.width !== w || cur.height !== h || cur.texture.type !== type) {
      cur?.dispose();
      this.analysisRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, type });
    }
    return this.analysisRT!;
  }

  /**
   * 直前に描いたフレームを、低解像度画素 1 つ = 1 画素の画像として読み出す（ちらつき計測用）。
   * 後処理（輪郭・ディザ・減色）まで含めた最終的なドットを比較できる。mask=true ならシルエット（物体 = 白）。
   */
  readLowRes(s: RenderSettings, method: RenderMethod, mask = false): { w: number; h: number; data: Uint8Array } | null {
    const p = this.pipeline;
    if (!this.lastLowCam || !p.rt) return null;
    if (method === 'splats' && !this.splat) return null;
    if (method === 'surfels' && !this.surfel) return null;
    if (method === 'voxels' && !this.voxel) return null;
    if (method === 'pixelmesh' && !this.pixelMesh) return null;
    if (method === 'hybrid' && !this.hybrid) return null;
    const w = p.lowW, h = p.lowH;
    const rt = this.ensureAnalysisRT(w, h);
    const r = this.renderer;
    const prevScissor = r.getScissorTest();
    r.setScissorTest(false);
    this.compositeMethod(method, s, this.lastLowCam, new THREE.Vector2(), rt, true, mask);
    const data = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, data);
    r.setRenderTarget(null);
    r.setScissorTest(prevScissor);
    return { w, h, data };
  }

  /**
   * 基準形状（簡易メッシュ）のシルエットを、直前のフレームと同じカメラ・描画解像度で描いて読み出す。
   * 物体 = 白 / 背景 = 黒。円盤やスプラットの「隙間」を評価する基準に使う。
   */
  readReferenceMask(): { w: number; h: number; data: Uint8Array } | null {
    const p = this.pipeline;
    if (!this.lastLowCam) return null;
    const w = p.lowW, h = p.lowH;
    const rt = this.ensureAnalysisRT(w, h);
    const r = this.renderer;
    this.charMeshRoot.matrix.copy(this.rig.root);
    this.rig.bones.forEach((m, i) => this.charMeshBones[i].matrix.copy(m));
    this.charMeshRoot.updateMatrixWorld(true);
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const bg = this.meshScene.background;
    this.meshScene.background = null;
    this.meshScene.overrideMaterial = white;
    const prevScissor = r.getScissorTest();
    r.setScissorTest(false);
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    r.render(this.meshScene, this.lastLowCam);
    const data = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, data);
    r.setRenderTarget(null);
    r.setScissorTest(prevScissor);
    this.meshScene.overrideMaterial = null;
    this.meshScene.background = bg;
    white.dispose();
    return { w, h, data };
  }

  /**
   * 重ね塗り（ラスタライズされた断片数）の実測。方式 A・C・D・E・F が対象（F は E 側と C 側の合計。方式 B は Spark 内部のシェーダーなので
   * 同じ方法では数えられず、CPU 側の推定値を使う）。計測用シェーダーに差し替え、深度テストなし・加算合成で
   * 1 断片 = 1 を半精度浮動小数点のターゲットに積算し、読み出して合計する。
   */
  measureFragments(method: 'points' | 'surfels' | 'voxels' | 'pixelmesh' | 'hybrid'): { rasterized: number; written: number; coveredPixels: number; pixels: number } | null {
    const p = this.pipeline;
    const cam = this.lastLowCam;
    if (!cam) return null;
    const w = p.lowW, h = p.lowH;
    const rt = this.ensureAnalysisRT(w, h, THREE.HalfFloatType);
    const r = this.renderer;
    r.setScissorTest(false);
    if (method === 'surfels') {
      if (!this.surfel) return null;
      this.surfel.renderCount(r, cam, rt);
    } else if (method === 'voxels') {
      if (!this.voxel) return null;
      this.voxel.renderCount(r, cam, rt);
    } else if (method === 'pixelmesh') {
      if (!this.pixelMesh) return null;
      this.pixelMesh.renderCount(r, cam, rt);
    } else if (method === 'hybrid') {
      if (!this.hybrid) return null;
      this.hybrid.renderCount(r, cam, rt);
    } else {
      const objs = [this.worldPoints, this.charPoints];
      const saved = objs.map((o) => o.material as THREE.ShaderMaterial);
      const counters = saved.map((m) => {
        const c = m.clone();
        c.uniforms = m.uniforms;
        c.defines = { ...m.defines, COUNT_FRAGMENTS: '' };
        c.blending = THREE.AdditiveBlending;
        c.depthTest = false;
        c.depthWrite = false;
        c.transparent = true;
        return c;
      });
      objs.forEach((o, i) => (o.material = counters[i]));
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      r.render(this.particleScene, cam);
      r.setRenderTarget(null);
      objs.forEach((o, i) => (o.material = saved[i]));
      counters.forEach((c) => c.dispose());
    }
    const half = new Uint16Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, half);
    let rasterized = 0, written = 0, covered = 0;
    for (let i = 0; i < w * h; i++) {
      const a = THREE.DataUtils.fromHalfFloat(half[i * 4]);
      rasterized += a;
      written += THREE.DataUtils.fromHalfFloat(half[i * 4 + 1]);
      if (a > 0) covered++;
    }
    return { rasterized, written, coveredPixels: covered, pixels: w * h };
  }

  /**
   * 方式 B の重ね塗りの推定（CPU で計算。実測ではない）。
   * Spark の頂点シェーダーと同じ考え方で、各スプラットの 3D 共分散を画面へ投影し、
   * 描画範囲（標準偏差 × splatStdDev）の楕円を囲む四角形の面積 = ラスタライズされる断片数、
   * 楕円の面積 = 色を書く断片数として、画面内にあるスプラットについて合計する。
   * 風による揺れ・半透明での破棄（minAlpha）・はみ出した部分の切り取りは考慮しない。
   */
  estimateSplatFragments(s: RenderSettings): { rasterized: number; written: number; pixels: number; counted: number } | null {
    const cam = this.lastLowCam;
    const d = this.shapeSources.get(s.splatSource);
    if (!cam || !d || !this.splat) return null;
    const ss = Math.round(s.splatSupersample) >= 2 ? 2 : 1;
    const W = this.pipeline.lowW * ss, H = this.pipeline.lowH * ss;
    const comp = s.densityComp ? Math.min(2.2, Math.pow(Math.max(s.density, 0.02), -0.5)) : 1;
    const spread = s.splatScale * comp;
    const sx = spread, sy = spread * s.splatAniso, sz = spread * s.splatFlat;
    const blur = this.splat.spark.blurAmount ?? 0;
    const k = s.splatStdDev;
    const maxPx = this.splat.spark.maxPixelRadius ?? 512;
    const view = cam.matrixWorldInverse.elements;
    const proj = cam.projectionMatrix.elements;
    const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera;
    let rasterized = 0, written = 0, counted = 0;
    const T = new THREE.Vector3(), B = new THREE.Vector3(), N = new THREE.Vector3();
    const addSet = (pos: Float32Array, nrm: Float32Array, size: Float32Array, n: number, model: THREE.Matrix4 | null) => {
      const me = model?.elements;
      for (let i = 0; i < n; i++) {
        let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (me) {
          const X = me[0] * x + me[4] * y + me[8] * z + me[12], Y = me[1] * x + me[5] * y + me[9] * z + me[13], Z = me[2] * x + me[6] * y + me[10] * z + me[14];
          x = X; y = Y; z = Z;
        }
        // カメラ座標
        const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
        const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
        const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
        if (vz >= 0) continue;
        // 画素単位への換算（正射影なら一定、透視なら奥行きで割る）
        const fx = 0.5 * W * proj[0], fy = 0.5 * H * proj[5];
        const sxp = ortho ? fx : fx / -vz, syp = ortho ? fy : fy / -vz;
        const px = (ortho ? vx * proj[0] : (vx * proj[0]) / -vz) * 0.5 * W + W / 2;
        const py = (ortho ? vy * proj[5] : (vy * proj[5]) / -vz) * 0.5 * H + H / 2;
        // 円盤の 3 軸（法線 = Z、世界の上を面に投影した向き = Y）
        N.set(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
        if (N.lengthSq() < 1e-8) N.set(0, 1, 0);
        N.normalize();
        if (me) N.transformDirection(model!);
        T.set(0, Math.abs(N.y) > 0.95 ? 0 : 1, Math.abs(N.y) > 0.95 ? 1 : 0).cross(N).normalize();
        B.crossVectors(N, T);
        const sig = size[i] * 0.34;
        // 3 軸をカメラ座標の x, y へ射影して 2D 共分散を作る
        let a = 0, b = 0, c = 0;
        for (const [ax, sc] of [[T, sx], [B, sy], [N, sz]] as const) {
          const cx = (view[0] * ax.x + view[4] * ax.y + view[8] * ax.z) * sig * sc * sxp;
          const cy = (view[1] * ax.x + view[5] * ax.y + view[9] * ax.z) * sig * sc * syp;
          a += cx * cx;
          b += cx * cy;
          c += cy * cy;
        }
        a += blur;
        c += blur;
        const avg = 0.5 * (a + c), diff = Math.sqrt(0.25 * (a - c) * (a - c) + b * b);
        const r1 = Math.min(maxPx, k * Math.sqrt(avg + diff)), r2 = Math.min(maxPx, k * Math.sqrt(Math.max(0, avg - diff)));
        // 画面外にはみ出す部分は、楕円を囲む軸平行の箱が画面内に残る割合で差し引く（方式 A の推定と同じ扱い）
        const ex = Math.min(maxPx, k * Math.sqrt(a)), ey = Math.min(maxPx, k * Math.sqrt(c));
        const x0 = Math.max(0, px - ex), x1 = Math.min(W, px + ex), y0 = Math.max(0, py - ey), y1 = Math.min(H, py + ey);
        if (x1 <= x0 || y1 <= y0) continue;
        const f = ((x1 - x0) * (y1 - y0)) / Math.max(1e-6, 4 * ex * ey);
        counted++;
        rasterized += 4 * r1 * r2 * f;
        written += Math.PI * r1 * r2 * f;
      }
    };
    addSet(d.world.pos, d.world.nrm, d.world.size, Math.max(1, Math.round(d.world.count * s.density)), null);
    addSet(d.character.pos, d.character.nrm, d.character.size, d.character.count, this.rig.root);
    return { rasterized, written, pixels: W * H, counted };
  }

  /**
   * 方式 A の断片数を、B と同じく CPU で推定する（実測値と比べて推定方法の確かさを示すため）。
   * 各点の gl_PointSize（px）を頂点シェーダーと同じ式で求め、px × px を画面内の点について合計する。
   */
  estimatePointFragments(s: RenderSettings): { rasterized: number; pixels: number } | null {
    const cam = this.lastLowCam;
    if (!cam) return null;
    const W = this.pipeline.lowW, H = this.pipeline.lowH;
    const view = cam.matrixWorldInverse.elements, proj = cam.projectionMatrix.elements;
    const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera;
    const scale = this.uniforms.uPointScale.value, ppu = this.uniforms.uPxPerUnit.value;
    let rasterized = 0;
    const m = new THREE.Matrix4(), v = new THREE.Vector3();
    const addGeo = (g: THREE.BufferGeometry, n: number, bones: boolean) => {
      const pos = g.getAttribute('position').array, misc = g.getAttribute('aMisc').array;
      const bone = bones ? g.getAttribute('aBone').array : null;
      for (let i = 0; i < n; i++) {
        v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        if (bone) v.applyMatrix4(m.multiplyMatrices(this.rig.root, this.rig.bones[Math.round(bone[i])]));
        const vx = view[0] * v.x + view[4] * v.y + view[8] * v.z + view[12];
        const vy = view[1] * v.x + view[5] * v.y + view[9] * v.z + view[13];
        const vz = view[2] * v.x + view[6] * v.y + view[10] * v.z + view[14];
        const d = -vz;
        if (d <= 0) continue;
        let px = (misc[i * 3] * scale * ppu) / (ortho ? 1 : Math.max(d, 0.01));
        px = Math.min(48, Math.max(1, px));
        if (s.pointSnap) px = Math.floor(px + 0.5);
        const sx = (ortho ? vx * proj[0] : (vx * proj[0]) / d) * 0.5 * W + W / 2;
        const sy = (ortho ? vy * proj[5] : (vy * proj[5]) / d) * 0.5 * H + H / 2;
        // 画面外にはみ出す部分を切り取った面積
        const x0 = Math.max(0, sx - px / 2), x1 = Math.min(W, sx + px / 2);
        const y0 = Math.max(0, sy - px / 2), y1 = Math.min(H, sy + px / 2);
        if (x1 > x0 && y1 > y0) rasterized += (x1 - x0) * (y1 - y0);
      }
    };
    addGeo(this.worldPoints.geometry, Math.max(1, Math.round(this.worldTotal * s.density)), false);
    addGeo(this.charPoints.geometry, this.charTotal, true);
    return { rasterized, pixels: W * H };
  }

  /**
   * 深度テクスチャを、カメラからの奥行き（ワールド単位）として読み出す。背景（深度なし）は Infinity。
   * source: 'points' / 'surfels' / 'voxels' はその方式の低解像度ターゲット、'reference' は基準形状（簡易メッシュ）。
   */
  readDepth(source: 'points' | 'surfels' | 'voxels' | 'pixelmesh' | 'hybrid' | 'reference'): { w: number; h: number; depth: Float32Array } | null {
    const cam = this.lastLowCam;
    const p = this.pipeline;
    if (!cam || !p.rt) return null;
    const w = p.lowW, h = p.lowH;
    const r = this.renderer;
    r.setScissorTest(false);
    let tex: THREE.DepthTexture | null = null;
    if (source === 'points') tex = p.rt.depthTexture;
    else if (source === 'surfels') tex = this.surfel?.pipeline.rt?.depthTexture ?? null;
    else if (source === 'voxels') tex = this.voxel?.pipeline.rt?.depthTexture ?? null;
    else if (source === 'pixelmesh') tex = this.pixelMesh?.pipeline.rt?.depthTexture ?? null;
    else if (source === 'hybrid') tex = this.hybrid?.pipeline.rt?.depthTexture ?? null;
    else {
      // 基準形状をこのフレームと同じカメラ・解像度で描き、その深度を使う
      if (!this.refRT || this.refRT.width !== w || this.refRT.height !== h) {
        this.refRT?.depthTexture?.dispose();
        this.refRT?.dispose();
        const dt = new THREE.DepthTexture(w, h);
        dt.minFilter = dt.magFilter = THREE.NearestFilter;
        this.refRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, depthTexture: dt });
      }
      this.charMeshRoot.matrix.copy(this.rig.root);
      this.rig.bones.forEach((m, i) => this.charMeshBones[i].matrix.copy(m));
      this.charMeshRoot.updateMatrixWorld(true);
      const bg = this.meshScene.background;
      this.meshScene.background = null;
      r.setRenderTarget(this.refRT);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, true);
      r.render(this.meshScene, cam);
      r.setRenderTarget(null);
      this.meshScene.background = bg;
      tex = this.refRT.depthTexture;
    }
    if (!tex) return null;
    if (!this.depthPass) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { tDepth: { value: null }, uNear: { value: 1 }, uFar: { value: 200 }, uIsOrtho: { value: 1 }, uRes: { value: new THREE.Vector2() } },
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: /* glsl */ `
          uniform sampler2D tDepth; uniform float uNear; uniform float uFar; uniform float uIsOrtho; uniform vec2 uRes;
          void main() {
            float d = texture2D(tDepth, gl_FragCoord.xy / uRes).r;
            float lin;
            if (d >= 0.99999) lin = 60000.0;
            else if (uIsOrtho > 0.5) lin = uNear + d * (uFar - uNear);
            else { float z = d * 2.0 - 1.0; lin = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
            gl_FragColor = vec4(lin, 0.0, 0.0, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      this.depthPass = { scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat, geo };
    }
    const u = this.depthPass.mat.uniforms;
    u.tDepth.value = tex;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uIsOrtho.value = (cam as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0;
    u.uRes.value.set(w, h);
    const rt = this.ensureAnalysisRT(w, h, THREE.FloatType);
    r.setRenderTarget(rt);
    r.render(this.depthPass.scene, this.depthPass.cam);
    const raw = new Float32Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, raw);
    r.setRenderTarget(null);
    const depth = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) depth[i] = raw[i * 4] >= 59999 ? Infinity : raw[i * 4];
    return { w, h, depth };
  }

  /** 解析用ターゲットを解放する */
  releaseAnalysis() {
    this.analysisRT?.dispose();
    this.analysisRT = null;
    this.refRT?.depthTexture?.dispose();
    this.refRT?.dispose();
    this.refRT = null;
    if (this.depthPass) {
      this.depthPass.mat.dispose();
      this.depthPass.geo.dispose();
      this.depthPass = null;
    }
  }
}

/** 共通の点群から方式 A 用の粒ジオメトリを作る（SDF 形状を方式 A でも使うため） */
function pointsGeometryFromSet(d: SplatPointSet): THREE.BufferGeometry {
  const n = d.count;
  const nrm = new Int8Array(n * 3);
  for (let i = 0; i < n * 3; i++) nrm[i] = Math.round(Math.max(-1, Math.min(1, d.nrm[i])) * 127);
  const misc = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    misc[i * 3] = d.size[i];
    misc[i * 3 + 1] = d.wind[i];
    misc[i * 3 + 2] = d.sun[i];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(d.col, 3, true));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
  g.setAttribute('aMisc', new THREE.BufferAttribute(misc, 3));
  return g;
}

/** キャラクター（静止姿勢）→ 方式 A 用（各ボーン支点からの相対座標・1 本目のボーンのみ） */
function pointsGeometryFromCharacter(c: CharacterSplatSource): THREE.BufferGeometry {
  const n = c.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Int8Array(n * 3);
  const misc = new Float32Array(n * 3);
  const bone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = c.bone0[i];
    const pv = BONE_PIVOTS[b];
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = c.pos[i * 3 + k] - pv[k];
      nrm[i * 3 + k] = Math.round(Math.max(-1, Math.min(1, c.nrm[i * 3 + k])) * 127);
    }
    misc[i * 3] = c.size[i];
    misc[i * 3 + 2] = 1;
    bone[i] = b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(c.col, 3, true));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
  g.setAttribute('aMisc', new THREE.BufferAttribute(misc, 3));
  g.setAttribute('aBone', new THREE.BufferAttribute(bone, 1));
  return g;
}
