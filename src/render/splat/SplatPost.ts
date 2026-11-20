// 方式 B のピクセルアート後処理。低解像度（× スーパーサンプリング）に描いたスプラットを、
// 「被覆率で画素を塗る/塗らない（くっきり）」または「ガウスの濃淡のまま空と合成（やわらか）」で 1 画素にまとめ、
// 輪郭・ディザ・減色をかけて整数倍で画面へ拡大する。減色とディザの式は方式 A と同じ。

import * as THREE from 'three';
import type { RenderSettings } from '../../settings';
import { BAYER, postVertex } from '../shaders';
import type { PixelPipeline } from '../PixelPipeline';

const splatPostFragment = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tPalette;
uniform vec2 uLowRes;
uniform vec2 uCanvasLow;
uniform vec2 uOffset;
uniform float uScale;
uniform float uSS;
uniform float uCrisp;
uniform float uCoverage;
uniform float uOutline;
uniform float uOutlineDarken;
uniform float uDither;
uniform float uDitherMatrix;
uniform float uQuantMode;
uniform float uLevels;
uniform float uPaletteSize;
uniform float uPaletteSpread;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
${BAYER}

// 1 サンプル：Spark は線形化した色を乗算済みアルファで出力するので、元の色空間へ戻す
vec4 fetchS(vec2 texel) {
  vec4 c = texture2D(tColor, (texel + 0.5) / (uLowRes * uSS));
  if (c.a > 1e-4) c.rgb = pow(max(c.rgb / c.a, 0.0), vec3(1.0 / 2.2));
  else c.rgb = vec3(0.0);
  return vec4(c.rgb, clamp(c.a, 0.0, 1.0));
}

// 1 画素ぶんのサンプルを集める。cov: 不透明サンプルの割合, a: 平均アルファ
void artPixel(vec2 pix, out vec3 solidCol, out vec3 softCol, out float cov, out float a) {
  solidCol = vec3(0.0); softCol = vec3(0.0); cov = 0.0; a = 0.0;
  float ns = 0.0, nsolid = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      if (float(i) >= uSS || float(j) >= uSS) continue;
      vec4 c = fetchS(pix * uSS + vec2(float(i), float(j)));
      ns += 1.0;
      a += c.a;
      softCol += c.rgb * c.a;
      if (c.a >= uCoverage) { solidCol += c.rgb; nsolid += 1.0; }
    }
  }
  softCol = a > 1e-4 ? softCol / a : vec3(0.0);
  a /= ns;
  cov = nsolid / ns;
  solidCol = nsolid > 0.0 ? solidCol / nsolid : softCol;
}

bool isObject(vec2 pix) {
  vec3 s, f; float cov, a;
  artPixel(pix, s, f, cov, a);
  return uCrisp > 0.5 ? cov >= 0.5 : a >= 0.5;
}

void main() {
  vec2 lp = gl_FragCoord.xy / uScale - uCanvasLow * 0.5 + uLowRes * 0.5 + uOffset;
  vec2 pix = floor(lp);
  vec2 uv = (pix + 0.5) / uLowRes;
  vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.05, 1.0, uv.y));

  vec3 solidCol, softCol; float cov, a;
  artPixel(pix, solidCol, softCol, cov, a);
  vec3 col;
  bool obj;
  if (uCrisp > 0.5) {
    // くっきり：被覆率で塗るかどうかを決める（ピクセルアート向け、半透明画素を作らない）
    obj = cov >= 0.5;
    col = obj ? solidCol : sky;
  } else {
    // やわらか：ガウスの濃淡（アルファ）のまま空と合成する
    obj = a >= 0.5;
    col = mix(sky, softCol, a);
  }
  if (obj && uOutline > 0.0) {
    // 輪郭：シルエットの縁（4 近傍のどれかが背景）を暗くする
    bool edge = !isObject(pix + vec2(1.0, 0.0)) || !isObject(pix - vec2(1.0, 0.0)) || !isObject(pix + vec2(0.0, 1.0)) || !isObject(pix - vec2(0.0, 1.0));
    if (edge) col = mix(col, col * uOutlineDarken, uOutline);
  }

  float bay = uDitherMatrix < 3.0 ? bayer2(pix) : uDitherMatrix < 6.0 ? bayer4(pix) : bayer8(pix);
  float dn = (bay - 0.5) * uDither;
  if (uQuantMode > 1.5) {
    col += dn * uPaletteSpread;
    vec3 best = col;
    float bd = 1e9;
    for (int i = 0; i < 64; i++) {
      if (float(i) >= uPaletteSize) break;
      vec3 pc = texture2D(tPalette, vec2((float(i) + 0.5) / 64.0, 0.5)).rgb;
      vec3 dd = col - pc;
      float dist = dot(dd * dd, vec3(0.30, 0.59, 0.11));
      if (dist < bd) { bd = dist; best = pc; }
    }
    col = best;
  } else if (uQuantMode > 0.5) {
    float L = max(uLevels - 1.0, 1.0);
    col = floor(clamp(col + dn / L, 0.0, 1.0) * L + 0.5) / L;
  } else {
    col += dn / 48.0;
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export class SplatPost {
  rt: THREE.WebGLRenderTarget | null = null;
  ss = 2;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: THREE.ShaderMaterial;
  private readonly tri: THREE.BufferGeometry;

  constructor(private readonly pipeline: PixelPipeline) {
    const pu = pipeline.post.uniforms;
    this.material = new THREE.ShaderMaterial({
      vertexShader: postVertex,
      fragmentShader: splatPostFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        // パレットと空の色は方式 A と同じオブジェクトを共有する
        tPalette: pu.tPalette,
        uPaletteSize: pu.uPaletteSize,
        uQuantMode: pu.uQuantMode,
        uPaletteSpread: pu.uPaletteSpread,
        uSkyTop: pu.uSkyTop,
        uSkyHorizon: pu.uSkyHorizon,
        uLowRes: { value: new THREE.Vector2() },
        uCanvasLow: { value: new THREE.Vector2() },
        uOffset: { value: new THREE.Vector2() },
        uScale: { value: 1 },
        uSS: { value: 2 },
        uCrisp: { value: 1 },
        uCoverage: { value: 0.5 },
        uOutline: { value: 0.8 },
        uOutlineDarken: { value: 0.45 },
        uDither: { value: 0.5 },
        uDitherMatrix: { value: 4 },
        uLevels: { value: 6 },
      },
    });
    this.tri = new THREE.BufferGeometry();
    this.tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mesh = new THREE.Mesh(this.tri, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /** スプラットを描く低解像度ターゲット（ピクセル数 × スーパーサンプリング） */
  ensureTarget(lowW: number, lowH: number, ss: number): THREE.WebGLRenderTarget {
    this.ss = ss;
    const w = lowW * ss, h = lowH * ss;
    if (this.rt && this.rt.width === w && this.rt.height === h) return this.rt;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    return this.rt;
  }

  /**
   * 合成して画面（または解析用ターゲット）へ描く。
   * raw=true なら低解像度画素 1 つを 1 画素として、ずらし補正なしで描く（ちらつき計測用）。
   */
  composite(renderer: THREE.WebGLRenderer, s: RenderSettings, offset: THREE.Vector2, target: THREE.WebGLRenderTarget | null = null, raw = false) {
    this.pipeline.updatePalette(s.palette);
    const p = this.pipeline;
    const u = this.material.uniforms;
    u.tColor.value = this.rt!.texture;
    u.uLowRes.value.set(p.lowW, p.lowH);
    if (raw) {
      u.uCanvasLow.value.set(p.lowW, p.lowH);
      u.uOffset.value.set(0, 0);
      u.uScale.value = 1;
    } else {
      u.uCanvasLow.value.set(p.canvasLowW, p.canvasLowH);
      u.uOffset.value.copy(offset);
      u.uScale.value = p.scale;
    }
    u.uSS.value = this.ss;
    u.uCrisp.value = s.splatCrisp ? 1 : 0;
    u.uCoverage.value = s.splatCoverage;
    u.uOutline.value = s.outline;
    u.uOutlineDarken.value = s.outlineDarken;
    u.uDither.value = s.dither;
    u.uDitherMatrix.value = s.ditherMatrix;
    u.uLevels.value = s.colorLevels;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.cam);
  }

  dispose() {
    this.rt?.dispose();
    this.rt = null;
    this.material.dispose();
    this.tri.dispose();
  }
}
