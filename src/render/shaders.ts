// 粒描画とピクセル後処理のシェーダー。

export const BAYER = /* glsl */ `
float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
`;

/**
 * 方式 A（粒）と方式 C（サーフェル）で共有する光・影・風・霞の計算。
 * 同じ式・同じユニフォームを使うことで、描く図形以外の条件を揃える。
 * pppWorldLit: objPos は風の揺れの位相用（オブジェクト座標）、wp は風で動かすワールド座標。
 */
export const LIGHTING_CHUNK = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;
uniform float uShadowStrength;
uniform float uLightSteps;
uniform vec3 uCharPos;
uniform float uReceiveBlob;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogStrength;
uniform vec3 uMistColor;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 pppWorldLit(vec3 objPos, inout vec4 wp, vec3 wn, vec3 baseColor, float w, float sunVis) {
  // 風：位置に沿って流れる突風 + 個別の揺れ
  if (w > 0.0 && uWind > 0.0) {
    float ph = hash13(objPos * 7.31) * 6.2831;
    float wave = dot(wp.xz, uWindDir) * 0.35;
    float gust = 0.55 + 0.45 * sin(uTime * 0.8 - wave * 0.6);
    float sway = sin(uTime * 2.1 - wave + ph * 0.3) * 0.6 + sin(uTime * 3.7 + ph) * 0.25;
    vec2 side = vec2(-uWindDir.y, uWindDir.x);
    vec2 off = uWindDir * (gust * 0.6 + sway * 0.45) + side * sin(uTime * 1.3 + ph) * 0.15;
    wp.xz += off * w * uWind * 0.32;
    wp.y -= length(off) * w * uWind * 0.04;
  }

  // 光：半球環境光 + 太陽（焼き込み影 × 段階化）
  float ndl = max(dot(wn, uSunDir), 0.0);
  float sh = mix(1.0, sunVis, uShadowStrength);
  float blob = 0.0;
  if (uReceiveBlob > 0.5) {
    float dist = length(wp.xz - uCharPos.xz);
    float dy = uCharPos.y - wp.y;
    blob = (1.0 - smoothstep(0.22, 0.5, dist)) * step(-0.35, dy) * (1.0 - smoothstep(0.8, 2.0, dy));
    sh *= 1.0 - blob * uShadowStrength;
  }
  float direct = ndl * sh;
  if (uLightSteps > 0.5) direct = floor(direct * uLightSteps + 0.5) / uLightSteps;
  vec3 hemi = mix(uGroundColor, uSkyColor, wn.y * 0.5 + 0.5);
  vec3 c = baseColor * (hemi * uAmbient * (1.0 - blob * 0.3) + uSunColor * direct);

  // 奥行き：視線方向の霞 + 島の下の靄
  vec4 mv = viewMatrix * wp;
  float viewD = -mv.z;
  float fogF = smoothstep(uFogNear, uFogFar, viewD) * uFogStrength;
  float mist = (1.0 - smoothstep(-16.0, -2.0, wp.y)) * uFogStrength * 0.75;
  c = mix(c, uMistColor, clamp(mist, 0.0, 0.7));
  c = mix(c, uFogColor, clamp(fogF, 0.0, 0.8));
  return c;
}
`;

export const particleVertex = /* glsl */ `
attribute vec3 aColor;
attribute vec3 aMisc; // x: サイズ, y: 風の影響度, z: 焼き込んだ日照

#ifdef USE_BONES
attribute float aBone;
uniform mat4 uBones[6];
#endif

uniform float uPointScale;
uniform float uPxPerUnit;
uniform float uIsOrtho;
uniform vec2 uRes;
uniform float uSnap;
${LIGHTING_CHUNK}

varying vec3 vColor;
varying float vPx;

void main() {
  vec3 p = position;
  vec3 n = normal;
#ifdef USE_BONES
  mat4 bm = uBones[int(aBone + 0.5)];
  p = (bm * vec4(p, 1.0)).xyz;
  n = mat3(bm) * n;
#endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec3 wn = normalize(mat3(modelMatrix) * n);

  vColor = pppWorldLit(position, wp, wn, aColor, aMisc.y, aMisc.z);

  vec4 mv = viewMatrix * wp;
  float viewD = -mv.z;
  vec4 clip = projectionMatrix * mv;
  float px = aMisc.x * uPointScale * uPxPerUnit / mix(max(viewD, 0.01), 1.0, uIsOrtho);
  px = clamp(px, 1.0, 48.0);
  if (uSnap > 0.5 && clip.w > 0.0) {
    // 粒を画素グリッドに吸着させ、カメラ移動時のちらつきを抑える
    px = floor(px + 0.5);
    vec2 sp = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
    sp = mod(px, 2.0) > 0.5 ? floor(sp) + 0.5 : floor(sp + 0.5);
    clip.xy = (sp / uRes * 2.0 - 1.0) * clip.w;
  }
  gl_PointSize = px;
  vPx = px;
  gl_Position = clip;
}
`;

export const particleFragment = /* glsl */ `
uniform float uGaussShade;
uniform float uGaussSharp;
uniform float uAlphaCut;
uniform float uAlphaDither;
varying vec3 vColor;
varying float vPx;
${BAYER}
void main() {
  // 画素中心の位置で評価するため、小さな粒ほど中心寄りに補正する（2px の粒に穴が開かないように）
  vec2 c = (gl_PointCoord * 2.0 - 1.0) * max(vPx - 1.0, 0.0) / max(vPx, 1.0);
  float r2 = dot(c, c);
  // ガウス関数による粒の濃度
  float g = exp(-r2 * uGaussSharp);
  // 半透明部分は「ディザ付きアルファテスト」で描く：深度を書けるので描画順に依存せず、ちらつかない
  float th = uAlphaCut;
  if (uAlphaDither > 0.5) th = uAlphaCut * (0.35 + 1.3 * bayer4(gl_FragCoord.xy));
#ifdef COUNT_FRAGMENTS
  // 重ね塗り計測：R = ラスタライズされた断片, G = 実際に色を書く断片（加算合成で数える）
  gl_FragColor = vec4(1.0, g < th ? 0.0 : 1.0, 0.0, 1.0);
  return;
#endif
  if (g < th) discard;
  float shade = mix(1.0, 0.6 + 0.5 * g, uGaussShade);
  gl_FragColor = vec4(vColor * shade, 1.0);
}
`;

export const postVertex = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const postFragment = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tPalette;
uniform vec2 uLowRes;
uniform vec2 uCanvasLow;
uniform vec2 uOffset;
uniform float uScale;
uniform float uNear;
uniform float uFar;
uniform float uIsOrtho;
uniform float uOutline;
uniform float uOutlineThresh;
uniform float uOutlineDarken;
uniform float uDither;
uniform float uDitherMatrix;
uniform float uQuantMode; // 0: なし 1: 階調 2: パレット
uniform float uLevels;
uniform float uPaletteSize;
uniform float uPaletteSpread;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform float uMaskOut;
${BAYER}

float linDepth(float d) {
  if (uIsOrtho > 0.5) return uNear + d * (uFar - uNear);
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

float sampleLin(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  return d >= 0.99999 ? 1e5 : linDepth(d);
}

void main() {
  // キャンバス画素 → 低解像度画素（整数倍拡大 + サブピクセル補正）
  vec2 lp = gl_FragCoord.xy / uScale - uCanvasLow * 0.5 + uLowRes * 0.5 + uOffset;
  vec2 pix = floor(lp);
  vec2 uv = (pix + 0.5) / uLowRes;
  float d = texture2D(tDepth, uv).r;
  bool sky = d >= 0.99999;
  if (uMaskOut > 0.5) {
    // 隙間の評価用：物体（深度あり）= 白、背景 = 黒
    gl_FragColor = vec4(vec3(sky ? 0.0 : 1.0), 1.0);
    return;
  }
  vec3 col;
  if (sky) {
    float t = smoothstep(0.05, 1.0, uv.y);
    col = mix(uSkyHorizon, uSkyTop, t);
  } else {
    col = texture2D(tColor, uv).rgb;
    if (uOutline > 0.0) {
      // 深度の段差で輪郭を検出（手前側の画素を暗くする）
      float ld = linDepth(d);
      vec2 px = 1.0 / uLowRes;
      float m = 0.0;
      m = max(m, sampleLin(uv + vec2(px.x, 0.0)) - ld);
      m = max(m, sampleLin(uv - vec2(px.x, 0.0)) - ld);
      m = max(m, sampleLin(uv + vec2(0.0, px.y)) - ld);
      m = max(m, sampleLin(uv - vec2(0.0, px.y)) - ld);
      float edge = step(uOutlineThresh, m);
      col = mix(col, col * uOutlineDarken, edge * uOutline);
    }
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
