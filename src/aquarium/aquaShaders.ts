// 水槽ゲームの水・光の筋・泡・落ちる水のシェーダー（AquariumRenderer と AquariumPlumbingFx が共有する）。
// 水面は水中から見たとき・水槽の外の濾過槽の水面にも同じ式を使う（uWaterY を水面ごとに変える）。

import { BAYER, LIGHTING_CHUNK } from '../render/shaders';

/**
 * 水面：揺らぐ法線・フレネル反射・照明の映り込み・波紋。水中から見ると全反射で明るい鏡になる。
 * uDrain（x, z, 半径）：縦穴式の排水口。水面はその円の中を描かない（本当に開いた穴）。まわりに吸い込まれる渦の縞。
 * FUNNEL を定義したもの：穴の縁から管の口へ落ち込む漏斗状の水面（奥ほど暗い）
 */
export const waterVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const waterFragment = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uWaterY;
uniform vec3 uWaterFog;
uniform vec4 uRipple;   // x, z, 開始時刻, 強さ
uniform vec4 uRipple2;
uniform vec3 uFall;     // 滝壺の x, z, 半径
uniform vec3 uCharPos;
uniform vec3 uDrain;    // 排水口の x, z, 水面の穴の半径（0 なら無し）
uniform float uDrainRim; // 管の口の高さ（漏斗の暗さ）
varying vec3 vWorld;
${BAYER}
vec2 waveGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  g += vec2(0.9, 0.4) * cos(dot(p, vec2(0.9, 0.4)) * 1.3 + t * 1.1) * 0.06;
  g += vec2(-0.5, 0.8) * cos(dot(p, vec2(-0.5, 0.8)) * 2.1 + t * 1.6) * 0.045;
  g += vec2(0.3, -0.95) * cos(dot(p, vec2(0.3, -0.95)) * 3.7 - t * 2.0) * 0.03;
  g += vec2(0.7, 0.7) * cos(dot(p, vec2(0.7, 0.7)) * 6.3 + t * 2.7) * 0.018;
  return g;
}
float ring(vec2 p, vec4 r, float t) {
  float age = t - r.z;
  if (age < 0.0 || age > 2.5) return 0.0;
  float d = length(p - r.xy);
  float front = age * 1.6;
  return sin((d - front) * 14.0) * exp(-abs(d - front) * 4.0) * exp(-age * 1.4) * r.w;
}
void main() {
  vec2 dq = vWorld.xz - uDrain.xy;
  float dr = length(dq);
#ifndef FUNNEL
  if (uDrain.z > 0.0 && dr < uDrain.z) discard;
#endif
  vec3 V = normalize(cameraPosition - vWorld);
  bool below = cameraPosition.y < uWaterY;
  vec2 g = waveGrad(vWorld.xz, uTime);
  float rp = ring(vWorld.xz, uRipple, uTime) + ring(vWorld.xz, uRipple2, uTime);
  // カニが水面近くを動くと小さな波紋
  float cd = length(vWorld.xz - uCharPos.xz);
  rp += sin(cd * 16.0 - uTime * 7.0) * exp(-cd * 3.0) * 0.35 * (1.0 - smoothstep(0.0, 0.5, abs(uCharPos.y + 0.24 - uWaterY)));
  vec3 n = normalize(vec3(-g.x - rp * 0.25, 1.0, -g.y - rp * 0.25));
  float shimmer = 0.5 + 0.5 * sin(dot(vWorld.xz, vec2(3.1, 2.3)) + g.x * 40.0 + uTime);
  vec3 col;
  float a;
  // 滝壺の泡
  float fd = length(vWorld.xz - uFall.xy);
  float foam = (1.0 - smoothstep(uFall.z * 0.3, uFall.z, fd + (sin(atan(vWorld.z - uFall.y, vWorld.x - uFall.x) * 7.0 + uTime * 3.0) * 0.12)));
  if (!below) {
    float cosV = max(dot(n, V), 0.0);
    float fres = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);
    vec3 refl = mix(vec3(0.62, 0.66, 0.64), vec3(0.92, 0.92, 0.86), smoothstep(0.2, 0.9, reflect(-V, n).y));
    col = mix(uWaterFog * 1.5 + vec3(0.02, 0.06, 0.05), refl, clamp(fres * 1.4, 0.0, 1.0));
    a = 0.1 + fres * 0.7;
    float spec = pow(max(dot(reflect(-V, n), uSunDir), 0.0), 90.0);
    col += vec3(1.0, 0.98, 0.9) * spec * 2.0;
    a = clamp(a + spec, 0.0, 0.95);
    // 映り込みの明暗のゆらぎ
    col *= 0.92 + 0.16 * shimmer;
  } else {
    // 水中から：浅い角度は全反射（明るい鏡）、真上近くは「スネルの窓」で上が透けて見える
    float up = -V.y;
    float window = smoothstep(0.62, 0.72, up);
    col = mix(uWaterFog * 1.7 + vec3(0.05, 0.1, 0.08) * shimmer, vec3(0.85, 0.96, 0.95), window);
    a = mix(0.82, 0.32, window);
    float sp = pow(max(dot(refract(-V, -n, 1.33), uSunDir), 0.0), 40.0);
    col += vec3(0.9, 1.0, 0.95) * sp * 0.8 * window;
  }
  col = mix(col, vec3(0.95, 0.98, 0.98), foam * 0.85);
  a = max(a, foam * 0.9);
  if (uDrain.z > 0.0) {
    // 排水口へ吸い込まれる渦：内側ほど速く回る螺旋の縞
    float R = uDrain.z;
    float near = 1.0 - smoothstep(R * 0.9, R * 2.4, dr);
    float ang = atan(dq.y, dq.x);
    float sp = sin(ang * 5.0 + log(max(dr, 0.05)) * 9.0 + uTime * 3.4 / max(dr, 0.5));
    float streak = smoothstep(0.5, 0.95, sp) * near;
    col = mix(col, vec3(0.9, 0.98, 0.98), streak * 0.6);
    a = max(a, streak * 0.65);
#ifdef FUNNEL
    // 漏斗：管の口へ近いほど暗い（水面に開いた縦穴に見える）
    float deep = 1.0 - smoothstep(uDrainRim + 0.05, uWaterY - 0.05, vWorld.y);
    col = mix(col, vec3(0.02, 0.07, 0.08), deep * 0.8);
    a = max(a, 0.5 + deep * 0.4);
#endif
  }
  gl_FragColor = vec4(col, a);
}
`;

/** 水面から差し込む光の筋（円柱状に回り込む細長い板、加算合成） */
export const shaftVertex = /* glsl */ `
attribute vec3 iStart;
attribute vec4 iParam; // 幅, 長さ, 位相（負なら揺らさない）, 強さ
uniform vec3 uShaftDir;
uniform float uTime;
varying vec2 vUv;
varying float vStrength;
varying float vPhase;
varying float vAlign;
void main() {
  vec3 axis = normalize(uShaftDir);
  // 水面の揺らぎにつれて、光の筋の差し込む位置がゆっくり動く
  float ph = abs(iParam.z);
  vec3 st = iStart + step(0.0, iParam.z) * vec3(sin(uTime * 0.23 + ph) * 0.6, 0.0, cos(uTime * 0.19 + ph * 1.3) * 0.45);
  vec3 p0 = st + axis * iParam.y * position.y;
  vec3 vd = normalize(cameraPosition - p0);
  vec3 side = normalize(cross(axis, vd) + vec3(1e-4));
  vec3 p = p0 + side * position.x * iParam.x;
  // 光の筋の向きに沿って見る（真上から覗く・真下から見上げる）と板が線になるので薄める
  vAlign = abs(dot(axis, vd));
  vUv = position.xy;
  vStrength = iParam.w;
  vPhase = iParam.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const shaftFragment = /* glsl */ `
uniform float uTime;
#ifdef BEAM
uniform float uBeamFade;
uniform float uBeamIn;  // 始まりを薄く立ち上げる長さの割合（節穴の光は穴の外側の短い部分）
#endif
varying vec2 vUv;
varying float vStrength;
varying float vPhase;
varying float vAlign;
void main() {
  float u = vUv.x, v = vUv.y;
#ifdef BEAM
  // 節穴（の少し上から倒木の中まで）・管の口から差す細い光：芯がはっきりした筋（加算で明るく、端は柔らかく）。
  // uBeamFade = 0 なら先まで明るさを保つ（倒木の中の床まで届く）、1 なら先ほど薄れる（管の奥）
  float core = pow(max(1.0 - u * u, 0.0), 5.0);
  float along = mix(1.0 - smoothstep(0.9, 1.0, v), pow(1.0 - v, 1.1), uBeamFade);
  float k = (core * 0.8 + pow(max(1.0 - u * u, 0.0), 1.5) * 0.35) * smoothstep(0.0, uBeamIn, v) * along;
  k *= 0.82 + 0.18 * sin(uTime * 1.1 + abs(vPhase) * 3.0 + v * 6.0);
  k *= 1.0 - smoothstep(0.9, 0.99, vAlign) * 0.85;
  gl_FragColor = vec4(vec3(1.0, 0.95, 0.78) * k * vStrength * 0.27, 1.0);
#else
  float k = pow(1.0 - u * u, 2.0) * smoothstep(0.0, 0.12, v) * pow(1.0 - v, 1.6);
  k *= 0.55 + 0.45 * sin(uTime * 0.6 + abs(vPhase) + v * 2.5);
  gl_FragColor = vec4(vec3(0.7, 0.95, 0.88) * k * vStrength * 0.16, 1.0);
#endif
}
`;

export const pointFragment = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }
`;

/** 泡・しぶき（CPU で動かす点。泡は輪の形、しぶきは白い点） */
export const bubbleVertex = /* glsl */ `
attribute float aSize;
attribute float aKind;
uniform float uPxPerUnit;
uniform float uMaxPx;
${LIGHTING_CHUNK}
varying vec3 vColor;
varying float vPx;
varying float vKind;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  float px = aSize * uPxPerUnit / max(-mv.z, 0.05);
  vPx = clamp(px, 1.0, uMaxPx);
  vKind = aKind;
  vColor = aKind < 0.5 ? pppWaterTint(vec3(0.82, 0.96, 1.0), position) : vec3(0.92, 0.98, 1.0);
  gl_PointSize = aSize <= 0.0 ? 0.0 : vPx;
  gl_Position = aSize <= 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
}
`;

export const bubbleFragment = /* glsl */ `
varying vec3 vColor;
varying float vPx;
varying float vKind;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0) discard;
  if (vKind < 0.5 && vPx >= 4.0) {
    // 大きな泡は輪 + ハイライト
    bool hi = length(q - vec2(-0.35, -0.35)) < 0.3;
    if (r < 0.62 && !hi) discard;
    gl_FragColor = vec4(hi ? vec3(1.0) : vColor, 1.0);
    return;
  }
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/** 滝：流れ落ちる縞（ディザ付きの抜きで半透明に見せる、深度は書く） */
export const fallVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const fallFragment = /* glsl */ `
uniform float uTime;
uniform float uLen;
varying vec2 vUv;
varying vec3 vWorld;
${BAYER}
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float w = vUv.x * 2.0 - 1.0;
  float col = floor((w * 0.5 + 0.5) * 9.0);
  float hh = h1(col + 3.0);
  float s = fract(vUv.y * uLen * 1.4 - uTime * (1.8 + hh * 1.2) + hh * 5.0);
  float cover = 0.92 - abs(w) * 0.55 - (1.0 - smoothstep(0.0, 0.08, vUv.y)) * 0.3;
  if (bayer4(gl_FragCoord.xy) > cover) discard;
  vec3 c = mix(vec3(0.55, 0.8, 0.86), vec3(0.95, 0.99, 1.0), step(0.55, s));
  c *= 0.85 + 0.15 * step(0.0, w);
  gl_FragColor = vec4(c, 1.0);
}
`;
