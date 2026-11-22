// 水槽ゲームの描画。方式 F v2（Hybrid E+C）と同じ組み立て：
// - E 側（三角形メッシュ）：底床・小石・岩・流木・水槽の枠・台と部屋・カニ（ボーンで剛体として動かす）。
//   光は画素ごとに LIGHTING_CHUNK（方式 A〜F と共通）で計算し、水中表現（PPP_WATER）を足す。
// - C 側（法線を向いた不透明な円盤）：既存の SurfelRenderer をそのまま使い、水草・苔・植物の細部を描く。
// - 両方を同じ低解像度ターゲット・同じ深度バッファに続けて描き、後処理（輪郭・ディザ・減色・拡大）は
//   既存の PixelPipeline で 1 回だけかける（F v2 と同じ）。
// - そのあと同じターゲットへ、深度テストありで滝・浮遊粒子・泡（不透明）→ 光の筋・水面・ガラス（半透明）を描く。
// 水中の色・霞・光の揺らぎ（コースティクス）は shaders.ts の WATER_CHUNK（PPP_WATER のときだけ有効）。

import * as THREE from 'three';
import { clamp } from '../core/math';
import type { TriMesh } from '../render/pixelmesh/MeshBuild';
import { CharacterRig } from '../render/CharacterRig';
import { createSharedUniforms } from '../render/ParticleMaterial';
import { PixelPipeline } from '../render/PixelPipeline';
import { BAYER, LIGHTING_CHUNK } from '../render/shaders';
import type { SplatPointSet } from '../render/shared/PointSet';
import { SurfelRenderer } from '../render/surfel/SurfelRenderer';
import type { RenderSettings } from '../settings';
import type { AquaCamera } from './AquaCamera';
import type { AquaLife } from './AquaLife';
import type { AquariumMeshes } from './AquariumBuild';
import type { Find } from './AquariumSpots';
import { LAMP_DIR, TANK, type AquariumWorld } from './AquariumWorld';
import type { CrabController, CrabEvent } from './CrabController';
import { CRAB_BONE_COUNT } from './crabModel';
import type { CrabRig } from './CrabRig';

function triGeometry(m: TriMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(m.col, 3, true));
  g.setAttribute('aMisc', new THREE.BufferAttribute(m.misc, 2, true));
  if (m.bone) g.setAttribute('aBone', new THREE.BufferAttribute(m.bone, 1));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
}

/** E 側のメッシュ：aMisc = (日照, 細かな明暗の強さ)。光は画素ごと（方式 E と同じ考え方） */
const meshVertex = /* glsl */ `
attribute vec3 aColor;
attribute vec2 aMisc;
#ifdef USE_BONES
attribute float aBone;
uniform mat4 uBones[${CRAB_BONE_COUNT}];
#endif
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vMisc;
void main() {
  vec3 p = position, n = normal;
#ifdef USE_BONES
  mat4 bm = uBones[int(aBone + 0.5)];
  p = (bm * vec4(p, 1.0)).xyz;
  n = mat3(bm) * n;
#endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  vColor = aColor;
  vMisc = aMisc;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const meshFragment = /* glsl */ `
uniform float uCharLift;
${LIGHTING_CHUNK}
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vMisc;
void main() {
  vec3 n = normalize(vNormal);
  vec3 base = vColor;
  // 画素ごとの細かな 3 段の明暗（砂粒・岩肌・甲羅の粒）。画素より細かくなる遠景では消す（ちらつき防止）
  vec3 fw = fwidth(vWorld);
  float px = max(max(fw.x, fw.y), fw.z);
  float detail = 1.0 - smoothstep(0.025, 0.07, px);
  float gq = hash13(floor(vWorld * 18.0) + 0.5);
  float q = gq < 0.28 ? -1.0 : (gq > 0.8 ? 1.0 : 0.0);
  base *= 1.0 + q * 0.13 * vMisc.y * detail;
  vec4 wp = vec4(vWorld, 1.0);
  vec3 c = pppWorldLit(vec3(0.0), wp, n, base, 0.0, vMisc.x);
#if defined(USE_BONES) || defined(USE_LIFT)
  // 方式 F v2 のキャラクターの持ち上げと同じ（背景の岩・砂から浮かせる。小さな生き物にも弱めに使う）
  vec3 vd = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - clamp(dot(n, vd), 0.0, 1.0), 2.0);
  c = c * (1.0 + uCharLift) + uCharLift * 0.04 + rim * uCharLift * 2.0 * vec3(1.0, 0.92, 0.8);
#endif
  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * 小さな生き物（インスタンス描画）：体の軸は +z が頭。iAnim = (位相, 強さ)。
 * 小魚は尾ほど大きく体を左右にくねらせ、エビは尾を下へ打つ（逃げるときに強い）。光は E 側と同じ meshFragment。
 */
const creatureVertex = /* glsl */ `
attribute vec3 aColor;
attribute vec2 aMisc;
attribute vec2 iAnim;
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vMisc;
void main() {
  vec3 p = position, n = normal;
  float tail = aMisc.y;
#ifdef FISH
  float sw = sin(iAnim.x - p.z * 16.0) * (0.012 + tail * 0.05) * (0.7 + iAnim.y * 0.8);
  p.x += sw;
  n.x -= cos(iAnim.x - p.z * 16.0) * tail * 0.6;
#else
  float bob = sin(iAnim.x) * 0.006 * (1.0 - iAnim.y);
  p.y += bob * (0.5 + tail) - tail * tail * iAnim.y * 0.07 * (0.6 + 0.4 * sin(iAnim.x * 2.0));
  p.z += tail * iAnim.y * 0.035;
#endif
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  vColor = aColor;
  vMisc = vec2(1.0, 0.25);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** 光る石：自ら光る結晶（照明の影響を受けず、ゆっくり明滅する）。aMisc = (明滅の位相, 明るさ) */
const glowFragment = /* glsl */ `
${LIGHTING_CHUNK}
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vMisc;
void main() {
  float pulse = 0.78 + 0.22 * sin(uTime * 1.7 + vMisc.x * 6.2831);
  vec3 c = vColor * (0.6 + 0.7 * vMisc.y) * pulse * 1.2;
  c = pppWaterTint(c, vWorld);
  gl_FragColor = vec4(c, 1.0);
}
`;

/** 光る石のまわりの淡い光（加算合成の円） */
const haloVertex = /* glsl */ `
attribute float aPhase;
attribute float aSize;
uniform float uTime;
uniform float uPxPerUnit;
varying float vA;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  vA = 0.7 + 0.3 * sin(uTime * 1.7 + aPhase * 6.2831);
  gl_PointSize = clamp(aSize * uPxPerUnit / max(-mv.z, 0.05), 2.0, 90.0);
  gl_Position = projectionMatrix * mv;
}
`;
const haloFragment = /* glsl */ `
varying float vA;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  if (r > 1.0) discard;
  float k = pow(1.0 - r, 2.2) * vA;
  gl_FragColor = vec4(vec3(0.45, 0.95, 0.85) * k * 0.55, 1.0);
}
`;

/** 陸地の上を漂う花粉・塵（暖かい色。水中の浮遊粒子と色味を分ける） */
const pollenVertex = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uPxPerUnit;
varying vec3 vColor;
void main() {
  float t = uTime;
  vec3 p = position;
  p.x += sin(t * (0.11 + aSeed.x * 0.15) + aSeed.y * 6.28) * 0.8;
  p.y += sin(t * (0.23 + aSeed.y * 0.2) + aSeed.z * 6.28) * 0.35;
  p.z += cos(t * (0.13 + aSeed.z * 0.12) + aSeed.w * 6.28) * 0.6;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float tw = pow(max(0.0, sin(t * (0.8 + aSeed.x) + aSeed.w * 31.0)), 16.0);
  vColor = mix(mix(vec3(0.95, 0.8, 0.62), vec3(0.82, 0.9, 0.6), aSeed.y), vec3(1.0, 0.98, 0.9), tw);
  gl_PointSize = clamp((0.03 + aSeed.z * 0.02) * uPxPerUnit / max(-mv.z, 0.05), 1.0, 2.0) + tw;
  gl_Position = projectionMatrix * mv;
}
`;

/** 水面：揺らぐ法線・フレネル反射・照明の映り込み・波紋。水中から見ると全反射で明るい鏡になる */
const waterVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const waterFragment = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uWaterY;
uniform vec3 uWaterFog;
uniform vec4 uRipple;   // x, z, 開始時刻, 強さ
uniform vec4 uRipple2;
uniform vec3 uFall;     // 滝壺の x, z, 半径
uniform vec3 uCharPos;
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
  gl_FragColor = vec4(col, a);
}
`;

/** ガラス：うすい色・フレネル・斜めの映り込みの帯・水面の線（メニスカス） */
const glassVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const glassFragment = /* glsl */ `
uniform float uWaterY;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), V)), 4.0);
  float a = 0.05 + fres * 0.4;
  vec3 col = vec3(0.78, 0.9, 0.88);
  float s = vWorld.x * 0.3 + vWorld.z * 0.3 + vWorld.y * 0.55;
  a += smoothstep(0.93, 1.0, sin(s * 0.9)) * 0.12 + smoothstep(0.97, 1.0, sin(s * 2.6 + 1.0)) * 0.07;
  if (vWorld.y < uWaterY) {
    col = mix(col, vec3(0.32, 0.62, 0.6), 0.55);
    a += 0.05;
  }
  float line = 1.0 - smoothstep(0.0, 0.07, abs(vWorld.y - uWaterY));
  a += line * 0.45;
  col = mix(col, vec3(0.92, 1.0, 1.0), line);
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.8));
}
`;

/** 水面から差し込む光の筋（円柱状に回り込む細長い板、加算合成） */
const shaftVertex = /* glsl */ `
attribute vec3 iStart;
attribute vec4 iParam; // 幅, 長さ, 位相（負なら揺らさない）, 強さ
uniform vec3 uShaftDir;
uniform float uTime;
varying vec2 vUv;
varying float vStrength;
varying float vPhase;
void main() {
  vec3 axis = normalize(uShaftDir);
  // 水面の揺らぎにつれて、光の筋の差し込む位置がゆっくり動く
  float ph = abs(iParam.z);
  vec3 st = iStart + step(0.0, iParam.z) * vec3(sin(uTime * 0.23 + ph) * 0.6, 0.0, cos(uTime * 0.19 + ph * 1.3) * 0.45);
  vec3 p0 = st + axis * iParam.y * position.y;
  vec3 vd = normalize(cameraPosition - p0);
  vec3 side = normalize(cross(axis, vd) + vec3(1e-4));
  vec3 p = p0 + side * position.x * iParam.x;
  vUv = position.xy;
  vStrength = iParam.w;
  vPhase = iParam.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const shaftFragment = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vStrength;
varying float vPhase;
void main() {
  float u = vUv.x, v = vUv.y;
  float k = pow(1.0 - u * u, 2.0) * smoothstep(0.0, 0.12, v) * pow(1.0 - v, 1.6);
  k *= 0.55 + 0.45 * sin(uTime * 0.6 + abs(vPhase) + v * 2.5);
  gl_FragColor = vec4(vec3(0.7, 0.95, 0.88) * k * vStrength * 0.16, 1.0);
}
`;

/** 浮遊粒子（水中をゆっくり漂う 1〜2 画素の点） */
const motesVertex = /* glsl */ `
attribute vec4 aSeed;
uniform float uPxPerUnit;
${LIGHTING_CHUNK}
varying vec3 vColor;
void main() {
  float t = uTime;
  float H = uWaterY - uTankMin.y - 0.3;
  vec3 p = position;
  p.y = uTankMin.y + 0.15 + mod(p.y - uTankMin.y + t * (0.03 + aSeed.x * 0.06), H);
  p.x += sin(t * (0.2 + aSeed.y * 0.3) + aSeed.z * 6.28) * 0.35;
  p.z += cos(t * (0.17 + aSeed.x * 0.25) + aSeed.w * 6.28) * 0.35;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  // ときどき光を受けてきらめく
  float tw = pow(max(0.0, sin(t * (0.5 + aSeed.y * 0.7) + aSeed.x * 40.0)), 20.0) * step(0.55, aSeed.z);
  vColor = pppWaterTint(mix(mix(vec3(0.62, 0.72, 0.62), vec3(0.9, 0.95, 0.86), aSeed.w), vec3(1.0), tw), p);
  gl_PointSize = clamp((0.025 + aSeed.z * 0.03) * uPxPerUnit / max(-mv.z, 0.05), 1.0, 2.0) + tw;
  gl_Position = projectionMatrix * mv;
}
`;
const pointFragment = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }
`;

/** 泡・しぶき（CPU で動かす点。泡は輪の形、しぶきは白い点） */
const bubbleVertex = /* glsl */ `
attribute float aSize;
attribute float aKind;
uniform float uPxPerUnit;
${LIGHTING_CHUNK}
varying vec3 vColor;
varying float vPx;
varying float vKind;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  float px = aSize * uPxPerUnit / max(-mv.z, 0.05);
  vPx = clamp(px, 1.0, 14.0);
  vKind = aKind;
  vColor = aKind < 0.5 ? pppWaterTint(vec3(0.82, 0.96, 1.0), position) : vec3(0.92, 0.98, 1.0);
  gl_PointSize = aSize <= 0.0 ? 0.0 : vPx;
  gl_Position = aSize <= 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
}
`;
const bubbleFragment = /* glsl */ `
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
const fallVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const fallFragment = /* glsl */ `
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

interface Bubble {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; life: number; kind: 0 | 1; ph: number;
}

export class AquariumRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly pipeline = new PixelPipeline();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.05, 320);
  /** 共有ユニフォーム（方式 A〜F と同じもの）+ 水中表現 */
  readonly uniforms = Object.assign(createSharedUniforms(), {
    uWaterY: { value: TANK.waterY },
    uTankMin: { value: new THREE.Vector3(TANK.minX, TANK.floorY, TANK.minZ) },
    uTankMax: { value: new THREE.Vector3(TANK.maxX, TANK.topY, TANK.maxZ) },
    uWaterFog: { value: new THREE.Vector3(0.11, 0.34, 0.36) },
    uWaterAbsorb: { value: new THREE.Vector3(0.68, 0.9, 0.86) },
    uWaterDensity: { value: 0.062 },
    uWaterHaze: { value: 1 },
    uCaustic: { value: 0.55 },
    uWaterAtten: { value: 0.05 },
    /** 水中の植物を揺らす水の流れの強さ */
    uCurrent: { value: 0.42 },
    /** 陸地の色味（暖かい光）と木漏れ日のまだらの強さ */
    uLandTint: { value: new THREE.Vector3(1.07, 1.02, 0.9) },
    uDapple: { value: 0.16 },
  });
  private readonly meshScene = new THREE.Scene();
  private readonly fxScene = new THREE.Scene();
  private readonly alphaScene = new THREE.Scene();
  readonly surfel: SurfelRenderer;
  private readonly crabMesh: THREE.Mesh;
  private readonly lift = { uCharLift: { value: 0.22 } };
  private readonly waterMat: THREE.ShaderMaterial;
  private readonly fallMat: THREE.ShaderMaterial;
  private readonly shaftMat: THREE.ShaderMaterial;
  private readonly bubbles: Bubble[] = [];
  private readonly bubbleGeo: THREE.BufferGeometry;
  private readonly maxBubbles = 720;
  private readonly fishMesh: THREE.InstancedMesh;
  private readonly shrimpMesh: THREE.InstancedMesh;
  private readonly springs: { pos: [number, number, number]; scale: number; t: number }[] = [];
  private pearlT = 0;
  private readonly m4 = new THREE.Matrix4();
  private readonly q4 = new THREE.Quaternion();
  private readonly e4 = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly v4 = new THREE.Vector3();
  private readonly s4 = new THREE.Vector3(1, 1, 1);
  private readonly life: AquaLife;
  private airStoneT = 0;
  private mouthT = 2;
  private fallSprayT = 0;
  private rippleSlot = 0;
  private readonly zero = new THREE.Vector2();
  readonly stats = { tris: 0, surfels: 0, bubbles: 0 };
  /** 描画中の円盤の割合（0..1。間引きで軽くする） */
  surfelDensity = 1;
  /** SurfelRenderer に渡す人型のリグ（キャラクターを持たないので使われない） */
  private readonly noRig = new CharacterRig();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly world: AquariumWorld,
    meshes: AquariumMeshes,
    crab: TriMesh,
    plants: SplatPointSet,
    private readonly rig: CrabRig,
    explore: { finds: Find[]; findsMesh: TriMesh; glowMesh: TriMesh; fishMesh: TriMesh; shrimpMesh: TriMesh; life: AquaLife },
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.autoClear = false;
    const u = this.uniforms;
    u.uSunDir.value.set(...LAMP_DIR);
    u.uSunColor.value.setRGB(0.95, 0.9, 0.78);
    u.uSkyColor.value.setRGB(0.72, 0.8, 0.86);
    u.uGroundColor.value.setRGB(0.36, 0.33, 0.29);
    u.uFogStrength.value = 0; // 既存の霞・島の下の靄は使わない（水中の霞は WATER_CHUNK）
    u.uWindDir.value.set(0.85, 0.5).normalize();
    // 背景（深度の無い所）は部屋の暗い色（部屋の箱で囲むので通常は見えない）
    this.pipeline.post.uniforms.uSkyTop.value.set('#3a3230');
    this.pipeline.post.uniforms.uSkyHorizon.value.set('#5c4f47');

    // E 側
    const worldMat = this.meshMaterial(false);
    for (const m of [meshes.terrain, meshes.pebbles, meshes.rocks, meshes.woods, meshes.frame, meshes.room, explore.findsMesh]) {
      const mesh = new THREE.Mesh(triGeometry(m), worldMat);
      mesh.frustumCulled = false;
      this.meshScene.add(mesh);
      this.stats.tris += m.triCount;
    }
    this.crabMesh = new THREE.Mesh(triGeometry(crab), this.meshMaterial(true));
    this.crabMesh.frustumCulled = false;
    this.crabMesh.matrixAutoUpdate = false;
    this.meshScene.add(this.crabMesh);
    this.stats.tris += crab.triCount;

    // 探索の要素：光る石・小さな生き物
    this.life = explore.life;
    const glow = new THREE.Mesh(triGeometry(explore.glowMesh), new THREE.ShaderMaterial({ uniforms: { ...this.uniforms }, defines: { PPP_WATER: '' }, vertexShader: meshVertex, fragmentShader: glowFragment }));
    glow.frustumCulled = false;
    this.meshScene.add(glow);
    this.fishMesh = this.creatureMesh(explore.fishMesh, explore.life.fish.length, true);
    this.shrimpMesh = this.creatureMesh(explore.shrimpMesh, explore.life.shrimp.length, false);
    this.stats.tris += explore.glowMesh.triCount + explore.fishMesh.triCount * explore.life.fish.length + explore.shrimpMesh.triCount * explore.life.shrimp.length;
    for (const f of explore.finds) if (f.kind === 'spring') this.springs.push({ pos: f.pos, scale: f.scale, t: Math.random() });

    // C 側：既存の SurfelRenderer（キャラクターは持たない = 方式 F と同じ）。水中表現だけ定義で足す
    this.surfel = new SurfelRenderer(u, this.noRig, plants, null);
    this.surfel.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m?.defines) m.defines.PPP_WATER = '';
    });

    // 不透明の効果：滝・浮遊粒子・泡
    this.fallMat = new THREE.ShaderMaterial({ vertexShader: fallVertex, fragmentShader: fallFragment, uniforms: { uTime: u.uTime, uLen: { value: 4 } }, side: THREE.DoubleSide });
    this.fxScene.add(this.buildWaterfall());
    this.fxScene.add(this.buildMotes());
    this.bubbleGeo = new THREE.BufferGeometry();
    this.bubbleGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxBubbles * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.bubbleGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.maxBubbles), 1).setUsage(THREE.DynamicDrawUsage));
    this.bubbleGeo.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(this.maxBubbles), 1).setUsage(THREE.DynamicDrawUsage));
    const bubblePts = new THREE.Points(this.bubbleGeo, new THREE.ShaderMaterial({ vertexShader: bubbleVertex, fragmentShader: bubbleFragment, uniforms: { ...u }, defines: { PPP_WATER: '' } }));
    bubblePts.frustumCulled = false;
    this.fxScene.add(bubblePts);

    // 半透明：光の筋 → 水面 → ガラス
    this.shaftMat = new THREE.ShaderMaterial({
      vertexShader: shaftVertex,
      fragmentShader: shaftFragment,
      uniforms: { uTime: u.uTime, uShaftDir: { value: new THREE.Vector3(-LAMP_DIR[0], -LAMP_DIR[1], -LAMP_DIR[2]) } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const shafts = this.buildShafts();
    shafts.renderOrder = 1;
    this.alphaScene.add(shafts);
    const halos = this.buildHalos(explore.finds);
    halos.renderOrder = 1;
    this.alphaScene.add(halos);
    this.fxScene.add(this.buildPollen());
    const wf = world.waterfall;
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      uniforms: {
        uTime: u.uTime, uSunDir: u.uSunDir, uWaterY: u.uWaterY, uWaterFog: u.uWaterFog, uCharPos: u.uCharPos,
        uRipple: { value: new THREE.Vector4(0, 0, -10, 0) }, uRipple2: { value: new THREE.Vector4(0, 0, -10, 0) },
        uFall: { value: new THREE.Vector3(wf.bottom[0], wf.bottom[2], 0.8) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(TANK.maxX - TANK.minX, TANK.maxZ - TANK.minZ).rotateX(-Math.PI / 2), this.waterMat);
    water.position.set((TANK.minX + TANK.maxX) / 2, TANK.waterY, (TANK.minZ + TANK.maxZ) / 2);
    water.renderOrder = 2;
    this.alphaScene.add(water);
    const glassMat = new THREE.ShaderMaterial({ vertexShader: glassVertex, fragmentShader: glassFragment, uniforms: { uWaterY: u.uWaterY }, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const H = TANK.topY - TANK.floorY + 0.35, cy = (TANK.topY + TANK.floorY - 0.35) / 2, g = TANK.glass * 0.5;
    const W = TANK.maxX - TANK.minX, D = TANK.maxZ - TANK.minZ;
    for (const [w, x, z, ry] of [[W, 0, TANK.maxZ + g, 0], [W, 0, TANK.minZ - g, 0], [D, TANK.maxX + g, 0, Math.PI / 2], [D, TANK.minX - g, 0, Math.PI / 2]] as const) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w + TANK.glass * 2, H), glassMat);
      m.position.set(x, cy, z);
      m.rotation.y = ry;
      m.renderOrder = 3;
      this.alphaScene.add(m);
    }
  }

  private meshMaterial(bones: boolean): THREE.ShaderMaterial {
    // 共有ユニフォームは同じオブジェクトを参照させる（方式 A〜F のマテリアルと同じ作り）
    const uniforms: Record<string, THREE.IUniform> = { ...this.uniforms, ...this.lift, uReceiveBlob: { value: bones ? 0 : 1 } };
    const defines: Record<string, string> = { PPP_WATER: '' };
    if (bones) {
      uniforms.uBones = { value: this.rig.bones };
      defines.USE_BONES = '';
    }
    return new THREE.ShaderMaterial({ uniforms, defines, vertexShader: meshVertex, fragmentShader: meshFragment, side: THREE.FrontSide });
  }

  private creatureMesh(m: TriMesh, count: number, fish: boolean): THREE.InstancedMesh {
    const g = triGeometry(m);
    g.setAttribute('iAnim', new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uCharLift: { value: 0.14 }, uReceiveBlob: { value: 0 } },
      defines: fish ? { PPP_WATER: '', USE_LIFT: '', FISH: '' } : { PPP_WATER: '', USE_LIFT: '' },
      vertexShader: creatureVertex,
      fragmentShader: meshFragment,
    });
    const im = new THREE.InstancedMesh(g, mat, count);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    this.meshScene.add(im);
    return im;
  }

  /** 小さな生き物の位置・向き・動きの位相をインスタンスへ写す */
  private updateCreatures() {
    const L = this.life;
    const fa = this.fishMesh.geometry.getAttribute('iAnim') as THREE.InstancedBufferAttribute;
    L.fish.forEach((f, i) => {
      this.e4.set(-f.pitch, f.heading, 0, 'YXZ');
      this.q4.setFromEuler(this.e4);
      this.m4.compose(this.v4.set(f.x, f.y, f.z), this.q4, this.s4);
      this.fishMesh.setMatrixAt(i, this.m4);
      fa.setXY(i, f.phase, f.fear);
    });
    this.fishMesh.instanceMatrix.needsUpdate = fa.needsUpdate = true;
    const sa = this.shrimpMesh.geometry.getAttribute('iAnim') as THREE.InstancedBufferAttribute;
    L.shrimp.forEach((s, i) => {
      this.e4.set(0, s.heading, 0, 'YXZ');
      this.q4.setFromEuler(this.e4);
      this.m4.compose(this.v4.set(s.x, s.y, s.z), this.q4, this.s4);
      this.shrimpMesh.setMatrixAt(i, this.m4);
      sa.setXY(i, s.phase, s.state === 'dart' ? 1 : 0);
    });
    this.shrimpMesh.instanceMatrix.needsUpdate = sa.needsUpdate = true;
  }

  private buildHalos(finds: Find[]): THREE.Points {
    const glows = finds.filter((f) => f.kind === 'glow');
    const pos = new Float32Array(glows.length * 3), ph = new Float32Array(glows.length), size = new Float32Array(glows.length);
    glows.forEach((f, i) => {
      pos.set([f.pos[0], f.pos[1] + 0.15 * f.scale, f.pos[2]], i * 3);
      // 光る石のメッシュと同じ位相（buildGlowMesh の fi * 0.37）
      ph[i] = (finds.indexOf(f) * 0.37) % 1;
      size[i] = 1.3 * f.scale;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const m = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: haloVertex, fragmentShader: haloFragment, uniforms: { uTime: this.uniforms.uTime, uPxPerUnit: this.uniforms.uPxPerUnit }, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.frustumCulled = false;
    return m;
  }

  private buildPollen(): THREE.Points {
    const n = 420;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4);
    let s = 777;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    let k = 0;
    for (let tries = 0; k < n && tries < 20000; tries++) {
      const x = 3 + rnd() * (TANK.maxX - 3.4), z = TANK.minZ + 0.4 + rnd() * (TANK.maxZ - TANK.minZ - 0.8);
      const g = this.world.groundAt(x, z);
      if (g < TANK.waterY + 0.15) continue;
      pos.set([x, g + 0.4 + rnd() * rnd() * 3.5, z], k * 3);
      seed.set([rnd(), rnd(), rnd(), rnd()], k * 4);
      k++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed.subarray(0, k * 4), 4));
    const m = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: pollenVertex, fragmentShader: pointFragment, uniforms: { uTime: this.uniforms.uTime, uPxPerUnit: this.uniforms.uPxPerUnit } }));
    m.frustumCulled = false;
    return m;
  }

  /** 滝：崖の上を流れる帯（岩の上面に沿う）→ 落ち口から前へ飛び出して落ちる弧、を 1 本の帯にする */
  private buildWaterfall(): THREE.Mesh {
    const w = this.world;
    const wf = w.waterfall;
    const [tx, ty, tz] = wf.top;
    const [bx, by, bz] = wf.bottom;
    const center: [number, number, number][] = [];
    // 崖の上の流れ：上から下へ距離関数を探って岩の上面の高さを求める
    const [sx, sz] = wf.source;
    const topAt = (x: number, z: number) => {
      for (let y = TANK.topY; y > TANK.waterY; y -= 0.02) if (w.solid(x, y, z) < 0) return y + 0.04;
      return ty;
    };
    const streamN = 8;
    for (let i = 0; i < streamN; i++) {
      const t = i / streamN;
      const x = sx + (tx - sx) * t, z = sz + (tz - sz) * t;
      center.push([x, Math.max(topAt(x, z), ty), z]);
    }
    // 落ちる弧（水平には平方根で早く進み、縦は一定の速さで落ちる）
    const fallN = 24;
    for (let i = 0; i <= fallN; i++) {
      const s = i / fallN;
      center.push([tx + (bx - tx) * Math.sqrt(s), ty + (by - 0.05 - ty) * s, tz + (bz - tz) * Math.sqrt(s)]);
    }
    const cols = 6;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    let len = 0;
    const lens: number[] = [0];
    for (let i = 1; i < center.length; i++) lens.push((len += Math.hypot(center[i][0] - center[i - 1][0], center[i][1] - center[i - 1][1], center[i][2] - center[i - 1][2])));
    center.forEach((p, i) => {
      // 帯の横方向：流れの水平の向きに直交
      const q = center[Math.min(center.length - 1, i + 1)], o = center[Math.max(0, i - 1)];
      const dx = q[0] - o[0], dz = q[2] - o[2];
      const dl = Math.hypot(dx, dz) || 1;
      const ux = -dz / dl, uz = dx / dl;
      const falling = i >= streamN;
      const width = wf.width * (falling ? 0.85 + 0.35 * ((i - streamN) / fallN) : 0.7);
      for (let c = 0; c <= cols; c++) {
        const k = c / cols - 0.5;
        pos.push(p[0] + ux * k * width, p[1], p[2] + uz * k * width);
        uv.push(c / cols, lens[i] / len);
      }
    });
    for (let r = 0; r < center.length - 1; r++) for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.fallMat.uniforms.uLen.value = len;
    const m = new THREE.Mesh(g, this.fallMat);
    m.frustumCulled = false;
    return m;
  }

  private buildMotes(): THREE.Points {
    const n = 2400;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4);
    let s = 12345;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    let k = 0;
    while (k < n) {
      const x = TANK.minX + rnd() * (TANK.maxX - TANK.minX), z = TANK.minZ + rnd() * (TANK.maxZ - TANK.minZ);
      if (this.world.groundAt(x, z) > TANK.waterY - 0.3) continue;
      pos.set([x, TANK.floorY + rnd() * TANK.waterY, z], k * 3);
      seed.set([rnd(), rnd(), rnd(), rnd()], k * 4);
      k++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    const m = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: motesVertex, fragmentShader: pointFragment, uniforms: { ...this.uniforms }, defines: { PPP_WATER: '' } }));
    m.frustumCulled = false;
    return m;
  }

  private buildShafts(): THREE.Mesh {
    const g = new THREE.InstancedBufferGeometry();
    const rows = 8;
    const pos: number[] = [], idx: number[] = [];
    for (let r = 0; r <= rows; r++) pos.push(-1, r / rows, 0, 1, r / rows, 0);
    for (let r = 0; r < rows; r++) idx.push(r * 2, r * 2 + 1, r * 2 + 3, r * 2, r * 2 + 3, r * 2 + 2);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const shafts = [
      [-15, -4, 1.4, 6.5, 0.0, 1.0], [-11.5, 1.5, 1.0, 6.0, 1.3, 0.8], [-8, -5.5, 1.8, 7.0, 2.1, 1.0], [-5, 3, 1.1, 6.0, 3.7, 0.9],
      [-2, -2, 1.5, 5.5, 4.4, 0.8], [-13, 6, 1.2, 6.0, 5.2, 0.7], [-6.5, 7.5, 0.9, 5.5, 0.7, 0.7], [0.5, 5.5, 1.0, 4.5, 2.9, 0.6],
      [-17, 0, 0.9, 6.0, 3.3, 0.6], [-9.5, -8.5, 1.2, 6.0, 1.9, 0.8],
      // 水草の森・柱のてっぺん
      [-12.5, -6.8, 1.3, 5.5, 0.4, 0.9], [-6.8, -7.6, 1.0, 5.0, 2.6, 0.8], [-3.0, -6.2, 1.0, 2.6, 1.1, 1.0],
    ];
    // 倒木の節穴へ差し込む細い光（揺らさない：位相を負にする）
    const { logA, logB } = this.world.landmarks;
    const kx = logA[0] + (logB[0] - logA[0]) * 0.58, ky = logA[1] + (logB[1] - logA[1]) * 0.58 + 0.9, kz = logA[2] + (logB[2] - logA[2]) * 0.58;
    const tk = (TANK.waterY - 0.05 - ky) / LAMP_DIR[1];
    shafts.push([kx + LAMP_DIR[0] * tk, kz + LAMP_DIR[2] * tk, 0.32, tk + 1.4, -0.5, 1.3]);
    const start = new Float32Array(shafts.length * 3), param = new Float32Array(shafts.length * 4);
    shafts.forEach(([x, z, w, l, ph, st], i) => {
      start.set([x, TANK.waterY - 0.05, z], i * 3);
      param.set([w, l, ph, st], i * 4);
    });
    g.setAttribute('iStart', new THREE.InstancedBufferAttribute(start, 3));
    g.setAttribute('iParam', new THREE.InstancedBufferAttribute(param, 4));
    g.instanceCount = shafts.length;
    const m = new THREE.Mesh(g, this.shaftMat);
    m.frustumCulled = false;
    return m;
  }

  setSize(w: number, h: number) {
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h, false);
  }

  // ---------------- 泡・しぶき ----------------

  private spawn(kind: 0 | 1, x: number, y: number, z: number, n: number, spread: number, r0: number, vUp: number) {
    for (let i = 0; i < n; i++) {
      if (this.bubbles.length >= this.maxBubbles) this.bubbles.shift();
      const a = Math.random() * Math.PI * 2, rr = Math.random() * spread;
      this.bubbles.push({
        x: x + Math.cos(a) * rr, y: y + Math.random() * spread * 0.5, z: z + Math.sin(a) * rr,
        vx: (Math.random() - 0.5) * (kind ? 2.4 : 0.3), vy: vUp * (0.6 + Math.random() * 0.6), vz: (Math.random() - 0.5) * (kind ? 2.4 : 0.3),
        r: r0 * (0.5 + Math.random()), life: kind ? 0.6 + Math.random() * 0.4 : 6, kind, ph: Math.random() * 6.28,
      });
    }
  }

  private ripple(x: number, z: number, power: number, time: number) {
    const u = this.rippleSlot++ % 2 === 0 ? this.waterMat.uniforms.uRipple : this.waterMat.uniforms.uRipple2;
    u.value.set(x, z, time, power);
  }

  private handleEvents(events: CrabEvent[], crab: CrabController, time: number) {
    for (const e of events) {
      if (e.kind === 'enterWater' || e.kind === 'exitWater') {
        this.ripple(e.x, e.z, 0.6 + e.power, time);
        this.spawn(1, e.x, TANK.waterY + 0.05, e.z, Math.round(6 + e.power * 14), 0.2, 0.05, 2.6 + e.power * 2);
        if (e.kind === 'enterWater') this.spawn(0, e.x, TANK.waterY - 0.3, e.z, Math.round(8 + e.power * 12), 0.3, 0.045, 1.2);
      } else if (e.kind === 'swimStart') {
        this.spawn(0, e.x, e.y + 0.2, e.z, 8, 0.25, 0.04, 1.0);
      } else if (e.kind === 'stroke') {
        this.spawn(0, e.x, e.y + 0.15, e.z, 2, 0.2, 0.03, 1.0);
      } else if (e.kind === 'jump' && crab.submerged > 0.5) {
        this.spawn(0, e.x, e.y + 0.05, e.z, 3, 0.25, 0.03, 0.8);
      }
    }
  }

  private updateBubbles(dt: number, crab: CrabController) {
    const wl = TANK.waterY;
    // エアストーン：細かな泡が絶えず上る
    this.airStoneT -= dt;
    while (this.airStoneT < 0) {
      this.airStoneT += 0.11;
      const [x, y, z] = this.world.airStone;
      this.spawn(0, x, y, z, 1, 0.08, 0.035, 1.2);
    }
    // 泡の湧き場所：砂の底から細かな泡がまとまって上る
    for (const sp of this.springs) {
      sp.t -= dt;
      while (sp.t < 0) {
        sp.t += 0.09 / sp.scale;
        this.spawn(0, sp.pos[0], sp.pos[1] + 0.04, sp.pos[2], 1, 0.1 * sp.scale, Math.random() < 0.15 ? 0.05 : 0.028, 0.8);
      }
    }
    // 水草の光合成の泡（森と広場の絨毯から、ときどき小さな泡が離れて上る）
    this.pearlT -= dt;
    while (this.pearlT < 0) {
      this.pearlT += 0.07;
      const inForest = Math.random() < 0.7;
      const x = inForest ? -15.4 + Math.random() * 11 : -11.5 + Math.random() * 6;
      const z = inForest ? -9.4 + Math.random() * 4.8 : 4.6 + Math.random() * 3.8;
      const g = this.world.groundAt(x, z);
      const y = inForest ? g + (wl - g) * (0.45 + Math.random() * 0.45) : g + 0.12;
      if (this.world.solid(x, y, z) > 0.05) this.spawn(0, x, y, z, 1, 0.02, 0.016, 0.35);
    }
    // 待機中のカニは、ときどき口から小さな泡を吐く
    this.mouthT -= dt;
    if (this.mouthT < 0) {
      this.mouthT = 1.8 + Math.random() * 2.5;
      if (crab.submerged > 0.9 && crab.state === 'idle') {
        const fx = Math.sin(crab.heading) * 0.2, fz = Math.cos(crab.heading) * 0.2;
        this.spawn(0, crab.x + fx, crab.y + 0.16, crab.z + fz, 2 + Math.floor(Math.random() * 3), 0.02, 0.025, 0.9);
      }
    }
    // 滝壺：しぶきと泡
    this.fallSprayT -= dt;
    if (this.fallSprayT < 0) {
      this.fallSprayT = 0.05;
      const [x, , z] = this.world.waterfall.bottom;
      this.spawn(1, x, wl + 0.02, z, 1, 0.3, 0.04, 2.2);
      this.spawn(0, x, wl - 0.25, z, 1, 0.35, 0.035, 0.6);
    }
    const pos = this.bubbleGeo.getAttribute('position') as THREE.BufferAttribute;
    const size = this.bubbleGeo.getAttribute('aSize') as THREE.BufferAttribute;
    const kind = this.bubbleGeo.getAttribute('aKind') as THREE.BufferAttribute;
    let w = 0;
    for (let i = 0; i < this.bubbles.length; i++) {
      const b = this.bubbles[i];
      b.life -= dt;
      if (b.kind === 0) {
        // 泡：浮力で加速し、揺れながら上る。水面で消える
        b.vy = Math.min(b.vy + dt * 1.5, 1.4 + b.r * 6);
        b.ph += dt * 6;
        b.x += (Math.sin(b.ph) * 0.25 + b.vx) * dt;
        b.z += (Math.cos(b.ph * 0.8) * 0.25 + b.vz) * dt;
        b.y += b.vy * dt;
        if (b.y > wl - 0.03 || this.world.solid(b.x, b.y, b.z) < 0) b.life = 0;
      } else {
        // しぶき：重力で落ち、水面より下で消える
        b.vy -= 14 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        if (b.y < wl && b.vy < 0) b.life = 0;
      }
      if (b.life > 0) this.bubbles[w++] = b;
    }
    this.bubbles.length = w;
    for (let i = 0; i < this.maxBubbles; i++) {
      const b = this.bubbles[i];
      if (b) {
        pos.setXYZ(i, b.x, b.y, b.z);
        size.setX(i, b.r * 2);
        kind.setX(i, b.kind);
      } else size.setX(i, 0);
    }
    pos.needsUpdate = size.needsUpdate = kind.needsUpdate = true;
    this.stats.bubbles = this.bubbles.length;
  }

  // ---------------- 描画 ----------------

  render(s: RenderSettings, cam: AquaCamera, crab: CrabController, time: number, dt: number) {
    const canvas = this.renderer.domElement;
    const cw = canvas.width, ch = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(1, Math.round(s.pixelScale * dpr));
    const p = this.pipeline;
    p.ensureSize(cw, ch, scale);

    const u = this.uniforms;
    u.uTime.value = time;
    u.uWind.value = s.wind;
    u.uAmbient.value = s.ambient;
    u.uShadowStrength.value = s.shadowStrength;
    u.uLightSteps.value = s.lightSteps;
    u.uSnap.value = s.pointSnap ? 1 : 0;
    u.uRes.value.set(p.lowW, p.lowH);
    u.uCharPos.value.set(crab.x, crab.y, crab.z);

    this.handleEvents(crab.drainEvents(), crab, time);
    this.updateBubbles(dt, crab);
    this.updateCreatures();

    // カメラ（低解像度ターゲットの大きさ = キャンバス + 余白。透視投影なので画素スナップのずれは 0）
    const c = this.camera;
    const pose = cam.pose;
    // 縦長の画面（スマホの縦持ち）では縦の画角を広げ、横に見える範囲が横長の画面と同じくらいになるようにする
    const aspect = p.canvasLowW / p.canvasLowH;
    const wide = 1.3;
    c.fov = aspect >= wide ? pose.fov : Math.min(cam.mode === 'diorama' ? 84 : 72,(2 * Math.atan((Math.tan((pose.fov * Math.PI) / 360) * wide) / aspect) * 180) / Math.PI);
    c.aspect = p.lowW / p.lowH;
    c.near = cam.mode === 'adventure' ? 0.05 : 1;
    c.far = 320;
    c.updateProjectionMatrix();
    c.position.set(...pose.pos);
    c.lookAt(...pose.target);
    c.updateMatrixWorld();
    u.uPxPerUnit.value = c.projectionMatrix.elements[5] * p.lowH * 0.5;
    u.uIsOrtho.value = 0;

    this.crabMesh.matrix.copy(this.rig.root);
    this.crabMesh.matrixWorld.copy(this.rig.root);
    const sd = { ...s, density: clamp(this.surfelDensity, 0.05, 1) };
    this.surfel.update(sd, this.noRig, Math.min(2.2, 1 / Math.sqrt(sd.density)), p.lowW, p.lowH);
    this.stats.surfels = this.surfel.drawn;

    const r = this.renderer;
    r.setScissorTest(false);
    p.renderScene(r, this.meshScene, c);
    r.setRenderTarget(p.rt);
    r.render(this.surfel.scene, c);
    r.render(this.fxScene, c);
    r.render(this.alphaScene, c);
    r.setRenderTarget(null);
    r.setViewport(0, 0, cw / r.getPixelRatio(), ch / r.getPixelRatio());
    p.composite(r, s, c, this.zero);
  }

  /** 世界座標 → 画面（CSS px）。画面外・背後なら null */
  project(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    // 低解像度ターゲットは端に 2 画素の余白があるので、そのぶん画面の座標に直す
    const p = this.pipeline;
    const sx = (v.x * 0.5 + 0.5) * p.lowW - (p.lowW - p.canvasLowW) / 2;
    const sy = (0.5 - v.y * 0.5) * p.lowH - (p.lowH - p.canvasLowH) / 2;
    return { x: rect.left + (sx / p.canvasLowW) * rect.width, y: rect.top + (sy / p.canvasLowH) * rect.height };
  }
}
