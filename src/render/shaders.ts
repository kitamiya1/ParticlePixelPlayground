// 粒描画とピクセル後処理のシェーダー。

export const BAYER = /* glsl */ `
float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
`;

/**
 * 水槽ゲーム（aquarium.html）用：冒険カメラが薄い物を越えたとき、カメラとキャラクターの間に入った部分を抜く。
 * OCCLUDER_CUT を定義したマテリアルだけで有効（定義しない既存の方式 A〜F のシェーダーは変わらない）。bayer4 が先に要る。
 * 円すい（頂点 = カメラ、uCutTo の位置で半径 uCutRange.z）の中で、カメラからの距離が uCutRange.x〜y の部分を抜く
 * （w = 強さ）。縁はディザでぼかす
 */
export const OCCLUDER_CUT_CHUNK = /* glsl */ `
#ifdef OCCLUDER_CUT
uniform vec3 uCutTo;
uniform vec4 uCutRange;
bool pppOccluderCut(vec3 wp) {
  if (uCutRange.w < 0.01) return false;
  vec3 ax = uCutTo - cameraPosition;
  float L = max(length(ax), 1e-3);
  vec3 dn = ax / L;
  vec3 rel = wp - cameraPosition;
  float al = dot(rel, dn);
  if (al <= uCutRange.x || al >= uCutRange.y) return false;
  float R = uCutRange.z * al / L;
  float k = (1.0 - smoothstep(R * 0.55, R, length(rel - dn * al))) * uCutRange.w;
  return k > bayer4(gl_FragCoord.xy) * 0.96 + 0.02;
}
#endif
`;

/**
 * 水槽ゲーム（aquarium.html）用の水中表現。PPP_WATER を定義したマテリアルだけで有効になり、
 * 定義しない既存の方式 A〜F のシェーダーは変わらない（#ifdef の外には何も足さない）。
 * - pppCaustic：水中の面への直射光を、水面の揺らぎ（コースティクス）と水深による減衰で変える
 * - pppWaterTint：水深による色の吸収 + カメラから点までの「水の中を通る長さ」に応じた青緑の霞
 *   （水槽の水の箱で線分を切り取るので、水槽の外から見ても・水中から見ても同じ式で決まる）
 * - 水槽の下の濾過槽（部屋ごとに水位が違う）も、uSumpMin / uSumpMax の水の箱として同じ式に入れる
 */
const WATER_CHUNK = /* glsl */ `
#ifdef PPP_WATER
uniform float uWaterY;
uniform vec3 uTankMin;
uniform vec3 uTankMax;
uniform vec3 uWaterFog;
uniform vec3 uWaterAbsorb;
uniform float uWaterDensity;
uniform float uWaterHaze;
uniform float uCaustic;
uniform float uWaterAtten;
uniform float uCurrent;
uniform vec3 uLandTint;
uniform float uDapple;
// 水槽の外の水（濾過槽の部屋ごとの水の箱。max.y = 水面）。使わない箱は min > max にしておく
uniform vec3 uSumpMin[4];
uniform vec3 uSumpMax[4];
float pppCausticPattern(vec2 p, float t) {
  float a = sin(p.x * 1.7 + sin(p.y * 1.3 + t) * 1.2 + t * 0.7) + sin(p.y * 1.9 + sin(p.x * 1.1 - t * 0.8) * 1.3 - t * 0.6);
  float b = sin(p.x * 2.6 - sin(p.y * 2.2 - t * 1.1) * 0.9 - t * 0.9) + sin(p.y * 2.3 + sin(p.x * 2.9 + t * 0.7) * 1.1 + t);
  return pow(1.0 - abs(a) * 0.5, 10.0) + pow(1.0 - abs(b) * 0.5, 12.0) * 0.6;
}
float pppInBox(vec3 p, vec3 a, vec3 b) {
  return step(a.x, p.x) * step(p.x, b.x) * step(a.y, p.y) * step(p.y, b.y) * step(a.z, p.z) * step(p.z, b.z);
}
/** 水槽の内側（底より上）か。水槽の下（水槽台の中）は外 */
float pppInTank(vec3 p) {
  return step(uTankMin.x, p.x) * step(p.x, uTankMax.x) * step(uTankMin.z, p.z) * step(p.z, uTankMax.z) * step(uTankMin.y - 0.05, p.y);
}
/** 点のある水の水面の高さ（水の外なら -1e4） */
float pppWaterTop(vec3 p) {
  if (pppInTank(p) > 0.5 && p.y <= uWaterY) return uWaterY;
  for (int i = 0; i < 4; i++) if (pppInBox(p, uSumpMin[i], uSumpMax[i]) > 0.5) return uSumpMax[i].y;
  return -1e4;
}
/** 水の中か（水槽の水面より下、または濾過槽の水の中） */
float pppInWater(vec3 p) {
  return step(-1e3, pppWaterTop(p));
}
/** 水深による直射光の減衰（光の段階化の前に掛ける） */
float pppCaustic(vec3 p, vec3 n) {
  float top = pppWaterTop(p);
  if (top < -1e3) return 1.0;
  return exp(-(top - p.y) * uWaterAtten);
}
/** 水面の揺らぎが底に落とす光の網（段階化の後に足す。段階の境目で模様がつぶれないように） */
float pppCausticGlow(vec3 p, vec3 n) {
  float top = pppWaterTop(p);
  if (top < -1e3) return 0.0;
  float depth = top - p.y;
  // 水面の位置まで光の向きに沿って戻した座標で模様を決める
  vec2 q = p.xz - uSunDir.xz / max(uSunDir.y, 0.2) * depth;
  float k = pppCausticPattern(q * 2.1, uTime * 1.3);
  return uCaustic * k * max(n.y, 0.0) * exp(-depth * uWaterAtten * 2.0);
}
/** 線分 ro→p のうち、箱の中にある長さ */
float pppBoxPath(vec3 ro, vec3 p, vec3 bmin, vec3 bmax) {
  vec3 d = p - ro;
  d = mix(d, vec3(1e-4), step(abs(d), vec3(1e-4)));
  vec3 inv = 1.0 / d;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 lo = min(t0, t1), hi = max(t0, t1);
  float a = max(max(lo.x, lo.y), max(lo.z, 0.0));
  float b = min(min(hi.x, hi.y), min(hi.z, 1.0));
  return max(b - a, 0.0) * length(d);
}
/** 線分 ro→p のうち、水の箱（水槽の内側 × 水面より下、濾過槽の各部屋の水）の中にある長さ */
float pppWaterPath(vec3 ro, vec3 p) {
  float L = pppBoxPath(ro, p, uTankMin, vec3(uTankMax.x, uWaterY, uTankMax.z));
  for (int i = 0; i < 4; i++) L += pppBoxPath(ro, p, uSumpMin[i], uSumpMax[i]);
  return L;
}
/** 陸地（水槽の内側で水面より上）の色味：暖かい光 + ゆっくり動く木漏れ日のまだら（水中との色の差を付ける） */
vec3 pppLandTint(vec3 c, vec3 p, vec3 n, float sh) {
  float inside = pppInTank(p);
  float land = smoothstep(uWaterY + 0.02, uWaterY + 0.25, p.y) * inside;
  float k = sin(p.x * 1.3 + uTime * 0.35 + sin(p.z * 0.9 + uTime * 0.2) * 1.5) * sin(p.z * 1.1 - uTime * 0.3 + sin(p.x * 0.7) * 1.2);
  vec3 lc = c * uLandTint * (1.0 + uDapple * k * max(n.y, 0.0) * sh);
  return mix(c, lc, land);
}
vec3 pppWaterTint(vec3 c, vec3 p) {
  float top = pppWaterTop(p);
  // 水槽の水面ちょうどは境目をなめらかに（既存の見た目と同じ幅）
  float under = top > -1e3 ? 1.0 : 0.0;
  if (pppInTank(p) > 0.5) { under = 1.0 - smoothstep(uWaterY - 0.03, uWaterY + 0.03, p.y); top = uWaterY; }
  // 水の外の点は、これまでどおり水槽の水面からの深さで霞の色を決める
  float depth = max((top > -1e3 ? top : uWaterY) - p.y, 0.0);
  c *= mix(vec3(1.0), uWaterAbsorb, under * (1.0 - exp(-depth * 0.22)));
  float L = pppWaterPath(cameraPosition, p);
  float f = (1.0 - exp(-L * uWaterDensity)) * uWaterHaze;
  vec3 fogc = uWaterFog * (0.6 + 0.4 * exp(-depth * 0.15));
  return mix(c, fogc, clamp(f, 0.0, 0.92));
}
#endif
`;

/**
 * 方式 A（粒）・C（サーフェル）・D（ボクセル）・E（ピクセル化メッシュ）で共有する光・影・風・霞の計算。
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
${WATER_CHUNK}

vec3 pppWorldLit(vec3 objPos, inout vec4 wp, vec3 wn, vec3 baseColor, float w, float sunVis) {
  // 風：位置に沿って流れる突風 + 個別の揺れ
  if (w > 0.0 && uWind > 0.0) {
    float ph = hash13(objPos * 7.31) * 6.2831;
    float wave = dot(wp.xz, uWindDir) * 0.35;
    float gust = 0.55 + 0.45 * sin(uTime * 0.8 - wave * 0.6);
    float sway = sin(uTime * 2.1 - wave + ph * 0.3) * 0.6 + sin(uTime * 3.7 + ph) * 0.25;
    vec2 side = vec2(-uWindDir.y, uWindDir.x);
    vec2 off = uWindDir * (gust * 0.6 + sway * 0.45) + side * sin(uTime * 1.3 + ph) * 0.15;
#ifdef PPP_WATER
    // 水中は風の揺れを弱める（代わりに下の水の流れで揺らす）
    off *= mix(1.0, 0.3, pppInWater(wp.xyz));
#endif
    wp.xz += off * w * uWind * 0.32;
    wp.y -= length(off) * w * uWind * 0.04;
  }
#ifdef PPP_WATER
  // 水中の植物：ゆっくり向きの変わる水の流れ + 根元から先へ伝わるうねり（葉が波打つ）
  if (w > 0.0 && uCurrent > 0.0 && pppInWater(wp.xyz) > 0.5) {
    float ph2 = hash13(objPos * 3.17) * 6.2831;
    vec2 flow = vec2(sin(uTime * 0.31 + wp.z * 0.21), cos(uTime * 0.27 + wp.x * 0.17));
    float wave = sin(uTime * 1.25 - wp.y * 1.6 + dot(wp.xz, vec2(0.4, 0.3)) + ph2 * 0.15);
    vec2 side2 = vec2(-flow.y, flow.x);
    wp.xz += (flow * (0.55 + 0.25 * wave) + side2 * wave * 0.35) * w * uCurrent;
  }
#endif

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
#ifdef PPP_WATER
  direct *= pppCaustic(wp.xyz, wn);
#endif
  if (uLightSteps > 0.5) direct = floor(direct * uLightSteps + 0.5) / uLightSteps;
  vec3 hemi = mix(uGroundColor, uSkyColor, wn.y * 0.5 + 0.5);
  vec3 c = baseColor * (hemi * uAmbient * (1.0 - blob * 0.3) + uSunColor * direct);
#ifdef PPP_WATER
  c += baseColor * uSunColor * pppCausticGlow(wp.xyz, wn) * sh;
  c = pppLandTint(c, wp.xyz, wn, sh);
  c = pppWaterTint(c, wp.xyz);
#endif

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
