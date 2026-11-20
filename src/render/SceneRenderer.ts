// 描画の統括。ゲーム状態を読み取るだけで、ゲームロジックには書き込まない。

import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { RenderMethod, RenderSettings, SplatSource } from '../settings';
import { BONE_PIVOTS, CHARACTER_PARTS } from '../visual/emitters/character';
import { buildSdfCharacter, buildSdfObjects, characterSourceFromGeometry, type CharacterSplatSource } from '../visual/sdf/sdfObjects';
import { SUN_DIR, type WorldVisuals } from '../visual/WorldVisualBuilder';
import type { IslandLayout } from '../world/IslandLayout';
import { CharacterRig } from './CharacterRig';
import { createParticleMaterial, createSharedUniforms } from './ParticleMaterial';
import { PixelPipeline } from './PixelPipeline';
import { mergeAndShuffle, pointSetFromBuilder, pointSetFromGeometry, type SplatPointSet } from './splat/SplatData';
import { SplatRenderer } from './splat/SplatRenderer';

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
  readonly worldTotal: number;
  readonly charTotal: number;
  private readonly offset = new THREE.Vector2();
  /** 最後に描いた粒数 */
  drawnParticles = 0;
  /** 最後に描いたスプラット数（方式 B） */
  drawnSplats = 0;
  /** 方式 B の描画一式（使っていない間は null = GPU 資源を持たない） */
  splat: SplatRenderer | null = null;
  private splatKey = '';
  /** 方式 B の元データ（CPU 側にだけ保持し、方式を戻したときの作り直しに使う） */
  private readonly splatSources = new Map<SplatSource, { world: SplatPointSet; character: CharacterSplatSource; ms: number }>();
  /** 方式 B の生成にかかった時間（点群の用意 / GPU 側の構築） */
  splatPrepMs = 0;
  splatBuildMs = 0;
  /** 方式 B を作り直した回数（GPU 資源の蓄積確認用） */
  splatRebuilds = 0;
  private readonly visuals: WorldVisuals;
  private lastLowCam: THREE.OrthographicCamera | THREE.PerspectiveCamera | null = null;
  /** スナップ後のカメラ位置（低解像度画素単位の整数。ちらつき計測の動き補正に使う） */
  readonly snapIndex = new THREE.Vector2();
  private analysisRT: THREE.WebGLRenderTarget | null = null;

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

  render(game: Game, s: RenderSettings, dt: number) {
    const canvas = this.renderer.domElement;
    const cw = canvas.width, ch = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(1, Math.round(s.pixelScale * dpr));
    this.pipeline.ensureSize(cw, ch, scale);
    this.applySettings(s, game.time);

    // キャラクター
    const c = game.character;
    this.rig.update(dt, c);
    this.charPoints.matrix.copy(this.rig.root);
    this.charPoints.matrixWorld.copy(this.rig.root);
    this.uniforms.uCharPos.value.set(c.x, c.y, c.z);

    // 密度：シャッフル済みバッファの先頭から必要数だけ描く
    const n = Math.max(1, Math.round(this.worldTotal * s.density));
    this.worldPoints.geometry.setDrawRange(0, n);
    this.drawnParticles = s.viewMode === 'mesh' ? 0 : n + this.charTotal;

    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, cw / r.getPixelRatio(), ch / r.getPixelRatio());

    // 方式 B は必要なときだけ GPU 資源を持つ（A のみ・メッシュのみの表示では解放する）
    const useSplat = s.viewMode !== 'mesh' && (s.renderMethod === 'splats' || s.viewMode === 'compare');
    const usePoints = s.viewMode !== 'mesh' && (s.renderMethod === 'points' || s.viewMode === 'compare');
    this.syncSplat(useSplat, s.splatSource, game.layout);
    if (!usePoints) this.drawnParticles = 0;
    this.drawnSplats = 0;

    if (s.viewMode !== 'mesh') {
      const cam = this.setupCamera(game, s, true);
      this.lastLowCam = cam;
      this.uniforms.uPxPerUnit.value = cam.projectionMatrix.elements[5] * this.pipeline.lowH * 0.5;
      this.uniforms.uIsOrtho.value = s.projection === 'ortho' ? 1 : 0;
      const offset = this.offset.clone().negate();
      // まず両方式とも低解像度ターゲットへ描く（ハサミ切り抜きはターゲットにも効くので切っておく）
      if (usePoints) this.pipeline.renderScene(r, this.particleScene, cam);
      if (this.splat && useSplat) {
        const comp = s.densityComp ? Math.min(2.2, Math.pow(Math.max(s.density, 0.02), -0.5)) : 1;
        this.splat.update(s, this.rig, cam, comp);
        this.splat.renderScene(r, cam, this.pipeline.lowW, this.pipeline.lowH, Math.round(s.splatSupersample) >= 2 ? 2 : 1);
        this.drawnSplats = this.splat.drawn;
      }
      const pr = r.getPixelRatio();
      const W = cw / pr, H = ch / pr;
      if (s.viewMode === 'compare') {
        // 左：方式 A / 右：方式 B（同じカメラ・同じ描画解像度）
        r.setScissorTest(true);
        r.setScissor(0, 0, W / 2, H);
        this.pipeline.composite(r, s, cam, offset);
        if (this.splat) {
          r.setScissor(W / 2, 0, W / 2, H);
          this.splat.post.composite(r, s, offset);
        }
        r.setScissorTest(false);
      } else if (s.renderMethod === 'splats' && this.splat) {
        this.splat.post.composite(r, s, offset);
      } else {
        this.pipeline.composite(r, s, cam, offset);
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

  /** 方式 B の元データを用意する（初回だけ CPU で生成し、以後は使い回す） */
  private splatSource(src: SplatSource, layout: IslandLayout) {
    let d = this.splatSources.get(src);
    if (d) return d;
    const t0 = performance.now();
    const cg = this.visuals.character;
    if (src === 'sdf') {
      // 樹木・岩・キャラクターを SDF から生成し、地形・草花・雲は既存の粒を変換して使う
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
    this.splatSources.set(src, d);
    return d;
  }

  /** 方式 B の GPU 資源を必要に応じて作成・破棄する */
  private syncSplat(want: boolean, src: SplatSource, layout: IslandLayout) {
    const key = want ? src : '';
    if (key === this.splatKey) return;
    this.splatKey = key;
    this.splat?.dispose();
    this.splat = null;
    if (!want) return;
    const d = this.splatSource(src, layout);
    this.splatPrepMs = d.ms;
    this.splat = new SplatRenderer(this.renderer, this.uniforms, this.pipeline, d.world, d.character);
    this.splatBuildMs = this.splat.buildMs;
    this.splatRebuilds++;
  }

  /** 方式 B の元データの点数（統計表示用） */
  splatSourceInfo(src: SplatSource) {
    const d = this.splatSources.get(src);
    return d ? { world: d.world.count, character: d.character.count } : null;
  }

  /**
   * 直前に描いたフレームを、低解像度画素 1 つ = 1 画素の画像として読み出す（ちらつき計測用）。
   * 後処理（輪郭・ディザ・減色）まで含めた最終的なドットを比較できる。
   */
  readLowRes(s: RenderSettings, method: RenderMethod): { w: number; h: number; data: Uint8Array } | null {
    const p = this.pipeline;
    if (!this.lastLowCam || !p.rt) return null;
    const w = p.lowW, h = p.lowH;
    if (!this.analysisRT || this.analysisRT.width !== w || this.analysisRT.height !== h) {
      this.analysisRT?.dispose();
      this.analysisRT = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    }
    const r = this.renderer;
    const prevScissor = r.getScissorTest();
    r.setScissorTest(false);
    const zero = new THREE.Vector2();
    if (method === 'splats') {
      if (!this.splat) return null;
      this.splat.post.composite(r, s, zero, this.analysisRT, true);
    } else {
      this.pipeline.composite(r, s, this.lastLowCam, zero, this.analysisRT, true);
    }
    const data = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(this.analysisRT, 0, 0, w, h, data);
    r.setRenderTarget(null);
    r.setScissorTest(prevScissor);
    return { w, h, data };
  }

  /** 解析用ターゲットを解放する */
  releaseAnalysis() {
    this.analysisRT?.dispose();
    this.analysisRT = null;
  }
}
