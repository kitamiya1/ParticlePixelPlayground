// 低解像度レンダーターゲットに粒を描き、輪郭・ディザ・減色をかけて整数倍で画面へ拡大する。

import * as THREE from 'three';
import type { RenderSettings } from '../settings';
import { MAX_PALETTE, paletteById } from './palettes';
import { postFragment, postVertex } from './shaders';

export class PixelPipeline {
  rt: THREE.WebGLRenderTarget | null = null;
  lowW = 0;
  lowH = 0;
  /** キャンバスを低解像度画素で表したサイズ（端数あり） */
  canvasLowW = 0;
  canvasLowH = 0;
  scale = 1;
  private readonly postScene = new THREE.Scene();
  private readonly postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly post: THREE.ShaderMaterial;
  private readonly paletteTex: THREE.DataTexture;
  private paletteId = '';

  constructor() {
    const data = new Uint8Array(MAX_PALETTE * 4);
    this.paletteTex = new THREE.DataTexture(data, MAX_PALETTE, 1, THREE.RGBAFormat);
    this.paletteTex.magFilter = this.paletteTex.minFilter = THREE.NearestFilter;
    this.post = new THREE.ShaderMaterial({
      vertexShader: postVertex,
      fragmentShader: postFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tPalette: { value: this.paletteTex },
        uLowRes: { value: new THREE.Vector2() },
        uCanvasLow: { value: new THREE.Vector2() },
        uOffset: { value: new THREE.Vector2() },
        uScale: { value: 1 },
        uNear: { value: 1 },
        uFar: { value: 200 },
        uIsOrtho: { value: 1 },
        uOutline: { value: 0.8 },
        uOutlineThresh: { value: 0.6 },
        uOutlineDarken: { value: 0.45 },
        uDither: { value: 0.5 },
        uDitherMatrix: { value: 4 },
        uQuantMode: { value: 2 },
        uLevels: { value: 6 },
        uPaletteSize: { value: 0 },
        uPaletteSpread: { value: 0.1 },
        uSkyTop: { value: new THREE.Color('#6fa8dc') },
        uSkyHorizon: { value: new THREE.Color('#d4e8f4') },
      },
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mesh = new THREE.Mesh(tri, this.post);
    mesh.frustumCulled = false;
    this.postScene.add(mesh);
  }

  /** キャンバスサイズと画素サイズに合わせてターゲットを用意する */
  ensureSize(canvasW: number, canvasH: number, scale: number) {
    this.scale = scale;
    this.canvasLowW = canvasW / scale;
    this.canvasLowH = canvasH / scale;
    // 端に 2px の余白を持たせ、サブピクセル補正でずらしても欠けないようにする
    const w = Math.ceil(this.canvasLowW) + 4;
    const h = Math.ceil(this.canvasLowH) + 4;
    if (this.rt && w === this.lowW && h === this.lowH) return;
    this.rt?.dispose();
    this.lowW = w;
    this.lowH = h;
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      depthTexture,
    });
  }

  /** パレットテクスチャを更新する（方式 B の後処理とも共有） */
  updatePalette(id: string) {
    if (id === this.paletteId) return;
    this.paletteId = id;
    const p = paletteById(id);
    const data = this.paletteTex.image.data as Uint8Array;
    data.fill(0);
    p.colors.forEach((hex, i) => {
      const c = new THREE.Color(hex);
      data[i * 4] = Math.round(c.r * 255);
      data[i * 4 + 1] = Math.round(c.g * 255);
      data[i * 4 + 2] = Math.round(c.b * 255);
      data[i * 4 + 3] = 255;
    });
    this.paletteTex.needsUpdate = true;
    const u = this.post.uniforms;
    u.uPaletteSize.value = p.colors.length;
    u.uQuantMode.value = id === 'none' ? 0 : id === 'levels' ? 1 : 2;
    // 色同士の平均的な距離に応じてディザの振れ幅を決める
    u.uPaletteSpread.value = p.colors.length > 0 ? Math.min(0.35, 0.55 / Math.cbrt(p.colors.length)) : 0;
  }

  renderScene(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  }

  /**
   * 後処理して画面へ描く。target / raw は解析用（ちらつき計測）：
   * raw=true なら低解像度画素 1 つを 1 画素として、ずらし補正なしで target に描く。
   */
  composite(renderer: THREE.WebGLRenderer, s: RenderSettings, camera: THREE.OrthographicCamera | THREE.PerspectiveCamera, offset: THREE.Vector2, target: THREE.WebGLRenderTarget | null = null, raw = false) {
    this.updatePalette(s.palette);
    const u = this.post.uniforms;
    u.tColor.value = this.rt!.texture;
    u.tDepth.value = this.rt!.depthTexture;
    u.uLowRes.value.set(this.lowW, this.lowH);
    if (raw) {
      u.uCanvasLow.value.set(this.lowW, this.lowH);
      u.uOffset.value.set(0, 0);
      u.uScale.value = 1;
    } else {
      u.uCanvasLow.value.set(this.canvasLowW, this.canvasLowH);
      u.uOffset.value.copy(offset);
      u.uScale.value = this.scale;
    }
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uIsOrtho.value = (camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0;
    u.uOutline.value = s.outline;
    u.uOutlineThresh.value = s.outlineThresh;
    u.uOutlineDarken.value = s.outlineDarken;
    u.uDither.value = s.dither;
    u.uDitherMatrix.value = s.ditherMatrix;
    u.uLevels.value = s.colorLevels;
    renderer.setRenderTarget(target);
    renderer.render(this.postScene, this.postCam);
  }
}
