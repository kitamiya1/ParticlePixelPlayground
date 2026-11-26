// 水槽ゲームの描画。方式 F v2（Hybrid E+C）と同じ組み立て：
// - E 側（三角形メッシュ）：底床・小石・岩・流木・水槽の枠・台と部屋・カニ（ボーンで剛体として動かす）。
//   光は画素ごとに LIGHTING_CHUNK（方式 A〜F と共通）で計算し、水中表現（PPP_WATER）を足す。
// - C 側（法線を向いた不透明な円盤）：既存の SurfelRenderer をそのまま使い、水草・苔・植物の細部を描く。
// - 両方を同じ低解像度ターゲット・同じ深度バッファに続けて描き、後処理（輪郭・ディザ・減色・拡大）は
//   既存の PixelPipeline で 1 回だけかける（F v2 と同じ）。
// - そのあと同じターゲットへ、深度テストありで滝・浮遊粒子・泡（不透明）→ 光の筋・水面・ガラス（半透明）を描く。
// 水中の色・霞・光の揺らぎ（コースティクス）は shaders.ts の WATER_CHUNK（PPP_WATER のときだけ有効）。
// 水槽の外（水槽台・濾過槽・配管・部屋）：不透明な物は E 側のメッシュ（AquariumStandBuild）、透明な管・アクリル・
// 濾過槽の水面・管の中の水は AquariumPlumbingFx。濾過槽の水は uSumpMin / uSumpMax の水の箱として霞の計算に入る。
// 箱庭カメラでは水槽台の外側の面のうちカメラを向く面をディザで透かし（CUTAWAY）、中の濾過槽と配管を見せる。
// 冒険カメラが薄い物（流木の殻・枝・岩の縁・台の板・家具）を越えたときは、カメラとカニの間に入った部分だけを
// ディザで抜く（OCCLUDER_CUT。範囲は AquaCamera.cut）。砂（底床・掘った区画）には使わない（中身の無い断面が見えるので、
// 砂ではカメラが手前で止まる）。
// 穴掘り（AquariumDigFx）：掘った区画は底床と同じマテリアルの別メッシュに差し替え、砂粒・照準を fxScene に描く。

import * as THREE from 'three';
import { clamp } from '../core/math';
import type { TriMesh } from '../render/pixelmesh/MeshBuild';
import { CharacterRig } from '../render/CharacterRig';
import { createSharedUniforms } from '../render/ParticleMaterial';
import { PixelPipeline } from '../render/PixelPipeline';
import { BAYER, LIGHTING_CHUNK, OCCLUDER_CUT_CHUNK } from '../render/shaders';
import type { SplatPointSet } from '../render/shared/PointSet';
import { SurfelRenderer } from '../render/surfel/SurfelRenderer';
import type { RenderSettings } from '../settings';
import type { AquaCamera } from './AquaCamera';
import type { AquaLife } from './AquaLife';
import type { BuddySystem } from './AquaBuddy';
import type { Prop, PropKind, PropSystem } from './AquaGrab';
import type { AquariumMeshes, LightGrid } from './AquariumBuild';
import { AquariumDigFx } from './AquariumDigFx';
import type { Find } from './AquariumSpots';
import { LAMP_DIR, TANK, type AquariumWorld } from './AquariumWorld';
import type { CrabController, CrabEvent } from './CrabController';
import { CRAB_BONE, CRAB_BONE_COUNT } from './crabModel';
import type { CrabRig } from './CrabRig';
import { AquariumPlumbingFx } from './AquariumPlumbingFx';
import { SUMP, SUMP_IN } from './AquariumStand';
import { bubbleFragment, bubbleVertex, fallFragment, fallVertex, pointFragment, shaftFragment, shaftVertex, waterFragment, waterVertex } from './aquaShaders';

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
varying float vBone;
#endif
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vMisc;
void main() {
  vec3 p = position, n = normal;
#ifdef USE_BONES
  vBone = aBone;
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
#ifdef USE_BEAMS
// 流木のトンネルの節穴から差す光：光の円柱の中にある面（内壁・床・カニ）を明るくする
uniform vec4 uBeamP[3]; // 始点（節穴の少し外側。流木の外の水中は照らさない）, 半径
uniform vec4 uBeamD[3]; // 向き, 長さ
float pppBeamLight(vec3 p) {
  float k = 0.0;
  for (int i = 0; i < 3; i++) {
    vec3 d = p - uBeamP[i].xyz;
    float t = dot(d, uBeamD[i].xyz);
    if (t > 0.0 && t < uBeamD[i].w) {
      float r = length(d - uBeamD[i].xyz * t);
      k += 1.0 - smoothstep(uBeamP[i].w * 0.45, uBeamP[i].w * 1.05, r);
    }
  }
  return k;
}
#endif
#if defined(CUTAWAY) || defined(OCCLUDER_CUT) || defined(USE_BONES)
${BAYER}
#endif
#ifdef CUTAWAY
uniform float uCutaway;
#endif
#ifdef OCCLUDER_CUT
// 自由追従・腕の最短で抜いている間は 1：地形の中から見た裏面（断面）を暗い土の色で塗る
uniform float uCap;
#endif
#ifdef USE_BONES
// カメラがカニのすぐ近く（地下の近い視点・狭い所）にあるとき、体と脚をディザで透かす（x = 体・脚, y = 鋏。視界を塞がない）
uniform vec2 uCrabFade;
varying float vBone;
#endif
${OCCLUDER_CUT_CHUNK}
void main() {
#ifdef USE_BONES
  if (uCrabFade.x > 0.01) {
    float f = vBone > 0.5 && vBone < ${CRAB_BONE.fingerR + 0.5} ? uCrabFade.y : uCrabFade.x;
    if (f > bayer4(gl_FragCoord.xy) * 0.96 + 0.02) discard;
  }
#endif
#ifdef OCCLUDER_CUT
  // 冒険カメラが越えた薄い物のうち、カメラとカニの間に入った部分を抜く
  if (pppOccluderCut(vWorld)) discard;
  // 地形の中から見た裏面（掘っていない砂・岩・流木の中）：中身の無い穴を見せず、暗い断面の色で塗る（明るさは少しだけ揺らす）
  if (uCap > 0.5 && !gl_FrontFacing) {
    float g = hash13(floor(vWorld * 14.0) + 0.5);
    gl_FragColor = vec4(vColor * (0.24 + 0.08 * g), 1.0);
    return;
  }
#endif
#ifdef CUTAWAY
  // 箱庭カメラ：カメラを向く外側の面を大きく抜いて、中が見えるようにする（縁の気配は残す）
  if (uCutaway > 0.5 && dot(normalize(vNormal), cameraPosition - vWorld) > 0.0 && bayer4(gl_FragCoord.xy) < 0.82) discard;
#endif
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
#ifdef USE_BEAMS
  c += base * vec3(1.0, 0.94, 0.78) * pppBeamLight(vWorld) * 0.95 * max(dot(n, -uBeamD[0].xyz), 0.3);
#endif
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
#ifdef BUDDY
// 引っこ抜き：x = 節の間の伸び、y = 穴の口（体の座標の z）、z = そこから後ろを真下へ曲げる角
attribute vec3 iTug;
#endif
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vMisc;
void main() {
  vec3 p = position, n = normal;
  float tail = aMisc.y;
#ifdef BUDDY
  // 節の間の伸び：頭・胸（z > 0.10）は伸びの分だけ前へ。腹の 6 節は節ごとに固いまま、継ぎ目（各節の後ろ 30%）だけが伸びる
  // （体の一部だけが引き伸ばされない。節が離れて見える）
  if (iTug.x > 0.0) {
    float su = clamp((0.10 - p.z) / 0.31, 0.0, 1.0) * 6.0;
    float sk = floor(min(su, 5.999));
    float stair = (sk + smoothstep(0.7, 1.0, su - sk)) / 6.0;
    p.z += iTug.x * (1.0 - stair);
  }
#endif
#ifdef FISH
  float sw = sin(iAnim.x - p.z * 16.0) * (0.012 + tail * 0.05) * (0.7 + iAnim.y * 0.8);
  p.x += sw;
  n.x -= cos(iAnim.x - p.z * 16.0) * tail * 0.6;
#else
#ifdef BUDDY
  // 触角（aMisc.x = 先ほど 1）：左右・上下にゆっくり揺らす（もがいている間は速く大きく）
  float aw = aMisc.x * (1.0 + iAnim.y * 1.5);
  p.x += sin(iAnim.x * 0.9 + p.z * 9.0 + sign(p.x) * 1.3) * 0.035 * aw;
  p.y += cos(iAnim.x * 0.7 + sign(p.x) * 2.1) * 0.025 * aw;
#endif
  float bob = sin(iAnim.x) * 0.006 * (1.0 - iAnim.y);
  p.y += bob * (0.5 + tail) - tail * tail * iAnim.y * 0.07 * (0.6 + 0.4 * sin(iAnim.x * 2.0));
  p.z += tail * iAnim.y * 0.035;
#endif
#ifdef BUDDY
  // 穴の口より後ろ（穴の中）を、腹を曲げる向き（−y）へ真下まで曲げる（口から 0.08 の間でなめらかに）。
  // 穴の外は引く向きへ傾いていても、穴の中の体は砂から突き出さない
  if (iTug.z > 0.001 && p.z < iTug.y) {
    float ba = iTug.z * smoothstep(0.0, 0.08, iTug.y - p.z);
    float bc = cos(ba), bs = sin(ba), bz = p.z - iTug.y;
    p.yz = vec2(p.y * bc + bz * bs, -p.y * bs + bz * bc + iTug.y);
    n.yz = vec2(n.y * bc + n.z * bs, -n.y * bs + n.z * bc);
  }
#endif
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  vColor = aColor;
  vMisc = vec2(1.0, 0.25);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** 台の中の照明（LED の帯）：照明の影響を受けずに光る */
const emissiveFragment = /* glsl */ `
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vMisc;
void main() { gl_FragColor = vec4(vColor * 1.2, 1.0); }
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
uniform float uGlassClear;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), V)), 4.0);
  // ガラス越しに観察している間（uGlassClear = 1）は、映り込み（フレネル・斜めの帯）を弱めて中を見やすくする
  float refl = 1.0 - 0.75 * uGlassClear;
  float a = 0.05 * refl + fres * 0.4 * refl;
  vec3 col = vec3(0.78, 0.9, 0.88);
  float s = vWorld.x * 0.3 + vWorld.z * 0.3 + vWorld.y * 0.55;
  a += (smoothstep(0.93, 1.0, sin(s * 0.9)) * 0.12 + smoothstep(0.97, 1.0, sin(s * 2.6 + 1.0)) * 0.07) * refl;
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



interface Bubble {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r: number; life: number; kind: 0 | 1; ph: number;
  /** 消える水面の高さ（水槽・濾過槽の部屋ごと） */
  top: number;
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
    /** 濾過槽の部屋ごとの水の箱（max.y = 水面） */
    uSumpMin: { value: SUMP.chambers.map((c) => new THREE.Vector3(c.x0, SUMP.floorTop, SUMP_IN.minZ)) },
    uSumpMax: { value: SUMP.chambers.map((c) => new THREE.Vector3(c.x1, c.level, SUMP_IN.maxZ)) },
  });
  /** 節穴から差す光の円柱（AquariumPlumbingFx が決める） */
  private readonly beamU = {
    uBeamP: { value: [new THREE.Vector4(0, -99, 0, 0), new THREE.Vector4(0, -99, 0, 0), new THREE.Vector4(0, -99, 0, 0)] },
    uBeamD: { value: [new THREE.Vector4(0, -1, 0, 0), new THREE.Vector4(0, -1, 0, 0), new THREE.Vector4(0, -1, 0, 0)] },
  };
  private readonly cutU = { uCutaway: { value: 0 }, uCutTo: { value: new THREE.Vector3() }, uCutRange: { value: new THREE.Vector4() }, uCap: { value: 0 } };
  /** 砂（底床・掘った区画・小石・巣穴）を抜く範囲（自由追従・腕の最短で抜いている間だけ w > 0） */
  private readonly cutSandU = { value: new THREE.Vector4() };
  /** 断面を塗るときに両面を描くマテリアル（砂と、抜ける岩・流木など） */
  private capMats: THREE.ShaderMaterial[] = [];
  readonly plumbing: AquariumPlumbingFx;
  private readonly meshScene = new THREE.Scene();
  private readonly fxScene = new THREE.Scene();
  private readonly alphaScene = new THREE.Scene();
  readonly surfel: SurfelRenderer;
  private readonly crabMesh: THREE.Mesh;
  private readonly lift = { uCharLift: { value: 0.22 } };
  /** カニを透かす量（AquaCamera.crabFade。x = 体・脚, y = 鋏） */
  private readonly crabFadeU = { value: new THREE.Vector2() };
  /** ガラスの映り込みを弱める量（ガラス越しのカメラで 1。なめらかに切り替える） */
  private readonly glassClearU = { value: 0 };
  private readonly waterMat: THREE.ShaderMaterial;
  private readonly fallMat: THREE.ShaderMaterial;
  private readonly shaftMat: THREE.ShaderMaterial;
  private readonly bubbles: Bubble[] = [];
  private readonly bubbleGeo: THREE.BufferGeometry;
  private readonly maxBubbles = 720;
  private readonly fishMesh: THREE.InstancedMesh;
  private readonly shrimpMesh: THREE.InstancedMesh;
  /** 最初の仲間（スナモグリ）の体（1 個のインスタンス）と、その巣穴 */
  private readonly buddyMesh: THREE.InstancedMesh | null = null;
  private readonly buddy: BuddySystem | null = null;
  /** 挟める物（AquaGrab）と、種類ごとのインスタンスの束 */
  private readonly props: PropSystem | null = null;
  private readonly propMeshes: { mesh: THREE.InstancedMesh; list: Prop[] }[] = [];
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
  /** 起動時の三角形の数（穴掘りで増減する分は digFx.stats から足す） */
  private baseTris = 0;
  readonly digFx: AquariumDigFx;
  /** 景色の小石・発見物の貝殻のメッシュ（AquaDecor が挟んだ物の頂点を書き換える） */
  readonly decorGeo: { pebbles: THREE.BufferGeometry; finds: THREE.BufferGeometry };
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
    explore: { finds: Find[]; findsMesh: TriMesh; glowMesh: TriMesh; fishMesh: TriMesh; shrimpMesh: TriMesh; life: AquaLife; buddy?: { sys: BuddySystem; mesh: TriMesh; burrowMesh: TriMesh }; props?: { sys: PropSystem; meshes: Record<PropKind, TriMesh> } },
    dig: { light: LightGrid; plantAnchors: Float32Array },
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
    // 砂も、自由追従・腕の最短で抜いている間だけ抜く（範囲は cutSandU。ふだんは w = 0）
    const worldMat = this.meshMaterial(false, { OCCLUDER_CUT: '' });
    worldMat.uniforms.uCutRange = this.cutSandU;
    // 薄い物を越えたカメラが手前を抜く物（岩・流木・枠・部屋の家具・台と濾過槽の中身）。砂・小石・発見物は抜かない
    const cutMat = this.meshMaterial(false, { OCCLUDER_CUT: '' });
    this.capMats = [worldMat, cutMat];
    const cuttable = new Set([meshes.rocks, meshes.woods, meshes.frame, meshes.room, meshes.stand]);
    const geos = new Map<TriMesh, THREE.BufferGeometry>();
    for (const m of [meshes.terrain, meshes.pebbles, meshes.rocks, meshes.woods, meshes.frame, meshes.room, meshes.stand, explore.findsMesh]) {
      const geo = triGeometry(m);
      geos.set(m, geo);
      const mesh = new THREE.Mesh(geo, cuttable.has(m) ? cutMat : worldMat);
      mesh.frustumCulled = false;
      this.meshScene.add(mesh);
      this.stats.tris += m.triCount;
    }
    // 穴掘りで底床の区画を隠す・小石を消すので、底床と小石は頂点番号・位置を書き換えられるようにする
    geos.get(meshes.terrain)!.getIndex()!.setUsage(THREE.DynamicDrawUsage);
    (geos.get(meshes.pebbles)!.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    // 景色の小石・発見物の貝殻を挟んで動かす（AquaDecor が頂点と法線を書き換える）
    this.decorGeo = { pebbles: geos.get(meshes.pebbles)!, finds: geos.get(explore.findsMesh)! };
    // 水槽台の外側の面（箱庭カメラで手前を透かす）と台の中の照明
    const outerMesh = new THREE.Mesh(triGeometry(meshes.cabinetOuter), this.meshMaterial(false, { CUTAWAY: '', OCCLUDER_CUT: '' }));
    const ledMesh = new THREE.Mesh(triGeometry(meshes.emissive), new THREE.ShaderMaterial({ vertexShader: meshVertex, fragmentShader: emissiveFragment }));
    for (const m of [outerMesh, ledMesh]) {
      m.frustumCulled = false;
      this.meshScene.add(m);
    }
    this.stats.tris += meshes.cabinetOuter.triCount + meshes.emissive.triCount;
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
    if (explore.buddy) {
      this.buddy = explore.buddy.sys;
      this.buddyMesh = this.creatureMesh(explore.buddy.mesh, 1, false, { BUDDY: '' });
      this.buddyMesh.geometry.setAttribute('iTug', new THREE.InstancedBufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage));
      const burrow = new THREE.Mesh(triGeometry(explore.buddy.burrowMesh), worldMat);
      burrow.frustumCulled = false;
      this.meshScene.add(burrow);
      this.stats.tris += explore.buddy.mesh.triCount + explore.buddy.burrowMesh.triCount;
    }
    // 挟める物（小石・貝殻・重い石）：種類ごとに 1 つのインスタンスの束
    if (explore.props) {
      this.props = explore.props.sys;
      for (const kind of Object.keys(explore.props.meshes) as PropKind[]) {
        const list = this.props.props.filter((p) => p.kind === kind);
        if (!list.length) continue;
        const m = explore.props.meshes[kind];
        const im = this.creatureMesh(m, list.length, false);
        // 浮かせる強さは小さな生き物より弱く（景色の小石と見分けられる程度）
        (im.material as THREE.ShaderMaterial).uniforms.uCharLift.value = 0.12;
        // iAnim = (位相 0, 動き 1)：creatureVertex の上下の揺れを止める（物は揺れない）
        const ia = im.geometry.getAttribute('iAnim') as THREE.InstancedBufferAttribute;
        for (let i = 0; i < list.length; i++) ia.setXY(i, 0, 1);
        this.propMeshes.push({ mesh: im, list });
        this.stats.tris += m.triCount * list.length;
      }
    }
    for (const f of explore.finds) if (f.kind === 'spring') this.springs.push({ pos: f.pos, scale: f.scale, t: Math.random() });
    this.baseTris = this.stats.tris;

    // C 側：既存の SurfelRenderer（キャラクターは持たない = 方式 F と同じ）。水中表現だけ定義で足す
    this.surfel = new SurfelRenderer(u, this.noRig, plants, null);
    this.surfel.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m?.defines) {
        m.defines.PPP_WATER = '';
        // 流木・岩に付いた苔も、メッシュと同じ範囲で抜く（抜かないと、抜いた流木の跡に苔だけが残ってカニを隠す）
        m.defines.OCCLUDER_CUT = '';
        m.uniforms.uCutTo = this.cutU.uCutTo;
        m.uniforms.uCutRange = this.cutU.uCutRange;
      }
    });
    // 巣穴の口を覆う植物（絨毯の水草）の円盤を消す（穴と触角が見えるように）
    if (this.buddy) {
      const [bx, , bz] = this.buddy.burrow, A = dig.plantAnchors, gone: number[] = [];
      for (let i = 0; i < A.length / 3; i++) if (Math.hypot(A[i * 3] - bx, A[i * 3 + 2] - bz) < 0.42) gone.push(i);
      if (gone.length) this.surfel.hideWorldPoints(gone);
    }

    // 穴掘り：掘った区画のメッシュ（底床と同じマテリアル）・砂粒・照準
    this.digFx = new AquariumDigFx({
      world, light: dig.light, meshScene: this.meshScene, fxScene: this.fxScene, material: worldMat, toGeometry: triGeometry,
      terrain: { geo: geos.get(meshes.terrain)!, chunks: meshes.terrainChunks },
      pebbles: { geo: geos.get(meshes.pebbles)!, list: meshes.pebbleList },
      surfel: this.surfel, anchors: dig.plantAnchors, uniforms: u,
    });

    // 不透明の効果：滝・浮遊粒子・泡
    this.fallMat = new THREE.ShaderMaterial({ vertexShader: fallVertex, fragmentShader: fallFragment, uniforms: { uTime: u.uTime, uLen: { value: 4 } }, side: THREE.DoubleSide });
    this.fxScene.add(this.buildWaterfall());
    this.fxScene.add(this.buildMotes());
    this.bubbleGeo = new THREE.BufferGeometry();
    this.bubbleGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxBubbles * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.bubbleGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.maxBubbles), 1).setUsage(THREE.DynamicDrawUsage));
    this.bubbleGeo.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(this.maxBubbles), 1).setUsage(THREE.DynamicDrawUsage));
    const bubblePts = new THREE.Points(this.bubbleGeo, new THREE.ShaderMaterial({ vertexShader: bubbleVertex, fragmentShader: bubbleFragment, uniforms: { ...u, uMaxPx: { value: 14 } }, defines: { PPP_WATER: '' } }));
    bubblePts.frustumCulled = false;
    this.fxScene.add(bubblePts);

    // 半透明：光の筋 → 水面 → ガラス
    this.shaftMat = new THREE.ShaderMaterial({
      vertexShader: shaftVertex,
      fragmentShader: shaftFragment,
      defines: { GROUND_CLIP: '' },
      uniforms: { uTime: u.uTime, uShaftDir: { value: new THREE.Vector3(-LAMP_DIR[0], -LAMP_DIR[1], -LAMP_DIR[2]) }, ...this.groundTexture() },
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
        // 縦穴式の排水口：水面に丸い穴（この中は水面を描かない）
        uDrain: { value: new THREE.Vector3(world.stand.drainAxis[0], world.stand.drainAxis[1], world.stand.mouthR) },
        uDrainRim: { value: world.stand.drainRim },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(TANK.maxX - TANK.minX, TANK.maxZ - TANK.minZ).rotateX(-Math.PI / 2), this.waterMat);
    water.position.set((TANK.minX + TANK.maxX) / 2, TANK.waterY, (TANK.minZ + TANK.maxZ) / 2);
    water.renderOrder = 2;
    this.alphaScene.add(water);
    const glassMat = new THREE.ShaderMaterial({ vertexShader: glassVertex, fragmentShader: glassFragment, uniforms: { uWaterY: u.uWaterY, uGlassClear: this.glassClearU }, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const H = TANK.topY - TANK.floorY + 0.35, cy = (TANK.topY + TANK.floorY - 0.35) / 2, g = TANK.glass * 0.5;
    const W = TANK.maxX - TANK.minX, D = TANK.maxZ - TANK.minZ;
    for (const [w, x, z, ry] of [[W, 0, TANK.maxZ + g, 0], [W, 0, TANK.minZ - g, 0], [D, TANK.maxX + g, 0, Math.PI / 2], [D, TANK.minX - g, 0, Math.PI / 2]] as const) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w + TANK.glass * 2, H), glassMat);
      m.position.set(x, cy, z);
      m.rotation.y = ry;
      m.renderOrder = 3;
      this.alphaScene.add(m);
    }

    // 配管・濾過槽・節穴の光
    this.plumbing = new AquariumPlumbingFx(world, u, { fx: this.fxScene, alpha: this.alphaScene }, { uTime: u.uTime, uSunDir: u.uSunDir, uWaterFog: u.uWaterFog, uCharPos: u.uCharPos });
    this.plumbing.beamList.forEach((b, i) => {
      if (i > 2) return;
      this.beamU.uBeamP.value[i].set(b.start[0], b.start[1], b.start[2], b.r);
      this.beamU.uBeamD.value[i].set(b.dir[0], b.dir[1], b.dir[2], b.len);
    });
  }

  /** 元の底床の高さの小さなテクスチャ（光の筋を砂の中で消す。0.2 間隔 = 高さ場と同じ） */
  private groundTexture(): Record<string, THREE.IUniform> {
    const nx = Math.round((TANK.maxX - TANK.minX) / 0.2) + 1, nz = Math.round((TANK.maxZ - TANK.minZ) / 0.2) + 1;
    const MAX = 10;
    const data = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = Math.round(clamp(this.world.groundAt(TANK.minX + i * 0.2, TANK.minZ + j * 0.2) / MAX, 0, 1) * 255);
    const tex = new THREE.DataTexture(data, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1; // 1 行が 4 の倍数のバイト数でない
    tex.needsUpdate = true;
    return { uGround: { value: tex }, uGroundRect: { value: new THREE.Vector4(TANK.minX, TANK.minZ, TANK.maxX - TANK.minX, TANK.maxZ - TANK.minZ) }, uGroundMax: { value: MAX } };
  }

  private meshMaterial(bones: boolean, extra: Record<string, string> = {}): THREE.ShaderMaterial {
    // 共有ユニフォームは同じオブジェクトを参照させる（方式 A〜F のマテリアルと同じ作り）
    const uniforms: Record<string, THREE.IUniform> = { ...this.uniforms, ...this.lift, ...this.beamU, ...this.cutU, uReceiveBlob: { value: bones ? 0 : 1 } };
    // BLOB_UP：カニの接地影は上向きの面だけ（ガラス際の断面・壁に縦の帯を落とさない）
    const defines: Record<string, string> = { PPP_WATER: '', USE_BEAMS: '', BLOB_UP: '', ...extra };
    if (bones) {
      uniforms.uBones = { value: this.rig.bones };
      uniforms.uCrabFade = this.crabFadeU;
      defines.USE_BONES = '';
    }
    return new THREE.ShaderMaterial({ uniforms, defines, vertexShader: meshVertex, fragmentShader: meshFragment, side: THREE.FrontSide });
  }

  private creatureMesh(m: TriMesh, count: number, fish: boolean, extra: Record<string, string> = {}): THREE.InstancedMesh {
    const g = triGeometry(m);
    g.setAttribute('iAnim', new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uCharLift: { value: 0.14 }, uReceiveBlob: { value: 0 } },
      defines: { ...(fish ? { PPP_WATER: '', USE_LIFT: '', FISH: '' } : { PPP_WATER: '', USE_LIFT: '' }), ...extra },
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
    const B = this.buddy, bm = this.buddyMesh;
    if (B && bm) {
      // 体の軸（+z = 頭）を pitch だけ上へ起こし（巣穴の中は頭が上）、横に roll
      this.e4.set(-B.pitch, B.heading, B.roll, 'YXZ');
      this.q4.setFromEuler(this.e4);
      this.m4.compose(this.v4.set(B.x, B.y, B.z), this.q4, this.s4);
      bm.setMatrixAt(0, this.m4);
      const ba = bm.geometry.getAttribute('iAnim') as THREE.InstancedBufferAttribute;
      ba.setXY(0, B.phase, B.act);
      const bt = bm.geometry.getAttribute('iTug') as THREE.InstancedBufferAttribute;
      bt.setXYZ(0, B.stretch, B.bendZ, B.found ? 0 : B.bendA);
      bm.instanceMatrix.needsUpdate = ba.needsUpdate = bt.needsUpdate = true;
    }
    // 挟める物：位置・向き（四元数）・大きさ
    for (const { mesh, list } of this.propMeshes) {
      list.forEach((p, i) => {
        this.q4.set(p.q[0], p.q[1], p.q[2], p.q[3]);
        this.m4.compose(this.v4.set(p.p[0], p.p[1], p.p[2]), this.q4, this.s4.setScalar(p.scale));
        mesh.setMatrixAt(i, this.m4);
      });
      this.s4.setScalar(1);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * 砂煙と泡（引っこ抜いた瞬間・仲間が砂に潜って移った所）。strong = 抜けた瞬間（大きく）
   */
  puff(x: number, y: number, z: number, strong: boolean) {
    const n = strong ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.digFx.burst({ kind: 'dig', x, y: y + 0.05, z, power: strong ? 1 : 0.5, dir: [Math.sin(a) * 0.3, 0.9, Math.cos(a) * 0.3], material: 'sand' });
    }
    if (y < TANK.waterY - 0.2) this.spawn(0, x, y + 0.08, z, strong ? 22 : 6, strong ? 0.3 : 0.15, 0.04, strong ? 1.6 : 0.9);
  }

  /**
   * 引っこ抜きの最中の砂粒と泡（main が段階・出来事に合わせて呼ぶ）。
   * crumble = 穴の縁の砂が崩れる（n 粒。toward = 崩れる側）、bubble = 穴の口から泡（生き物が引き戻した）、
   * kick = カニの足もとの砂を蹴る（踏ん張っている。dir = 蹴る向き）
   */
  tugFx(kind: 'crumble' | 'bubble' | 'kick', x: number, y: number, z: number, n: number, dir: readonly number[] | null = null) {
    if (kind === 'crumble') this.digFx.crumble(x, y, z, 0.16, n, dir);
    else if (kind === 'kick') this.digFx.burst({ kind: 'dig', x, y: y + 0.02, z, power: 0.05 * n, dir: dir ? [dir[0], 0.4, dir[1]] : [0, 1, 0], material: 'sand' });
    else if (y < TANK.waterY - 0.2) this.spawn(0, x, y + 0.06, z, n, 0.08, 0.025, 0.8);
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
    // 倒木の節穴へ差し込む光は AquariumPlumbingFx（芯のはっきりした筋 + 床の光だまり + 光の中の粒）
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
    // 泡が消える水面：生まれた所の水の水面（管の中ではすぐ消える。しぶきは少し下の水面で消える）
    let top = this.world.waterLevelAt(x, kind ? y - 0.12 : y, z);
    if (top > 500) top = y + 0.3;
    else if (top < -500) top = kind ? -1e3 : y;
    for (let i = 0; i < n; i++) {
      if (this.bubbles.length >= this.maxBubbles) this.bubbles.shift();
      const a = Math.random() * Math.PI * 2, rr = Math.random() * spread;
      this.bubbles.push({
        x: x + Math.cos(a) * rr, y: y + Math.random() * spread * 0.5, z: z + Math.sin(a) * rr,
        vx: (Math.random() - 0.5) * (kind ? 2.4 : 0.3), vy: vUp * (0.6 + Math.random() * 0.6), vz: (Math.random() - 0.5) * (kind ? 2.4 : 0.3),
        r: r0 * (0.5 + Math.random()), life: kind ? 0.6 + Math.random() * 0.4 : 6, kind, ph: Math.random() * 6.28, top,
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
        // 波紋は水槽の水面だけ（濾過槽の水面はしぶきと泡）
        if (Math.abs(e.y - TANK.waterY) < 0.01) this.ripple(e.x, e.z, 0.6 + e.power, time);
        this.spawn(1, e.x, e.y + 0.05, e.z, Math.round(6 + e.power * 14), 0.2, 0.05, 2.6 + e.power * 2);
        if (e.kind === 'enterWater') this.spawn(0, e.x, e.y - 0.3, e.z, Math.round(8 + e.power * 12), 0.3, 0.045, 1.2);
      } else if (e.kind === 'swimStart') {
        this.spawn(0, e.x, e.y + 0.2, e.z, 8, 0.25, 0.04, 1.0);
      } else if (e.kind === 'stroke') {
        this.spawn(0, e.x, e.y + 0.15, e.z, 2, 0.2, 0.03, 1.0);
      } else if (e.kind === 'jump' && crab.submerged > 0.5) {
        this.spawn(0, e.x, e.y + 0.05, e.z, 3, 0.25, 0.03, 0.8);
      } else if (e.kind === 'dig' || e.kind === 'digBlocked' || e.kind === 'fill') {
        this.digFx.burst(e);
        // 水中で砂をかき出すと、砂の中の空気が小さな泡になって上る
        if (e.kind === 'dig' && e.y < TANK.waterY - 0.2 && Math.random() < 0.6) this.spawn(0, e.x, e.y + 0.05, e.z, 1 + Math.floor(Math.random() * 2), 0.12, 0.022, 0.7);
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
        if (b.y > b.top - 0.03 || this.world.solid(b.x, b.y, b.z) < 0) b.life = 0;
      } else {
        // しぶき：重力で落ち、水面より下で消える
        b.vy -= 14 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        if (b.y < b.top && b.vy < 0) b.life = 0;
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
    this.digFx.update(dt, crab);
    this.stats.tris = this.baseTris + this.digFx.stats.tris - this.digFx.stats.hiddenTris;
    this.plumbing.update(dt, time);
    this.cutU.uCutaway.value = cam.mode === 'diorama' ? 1 : 0;
    const cut = cam.cut;
    this.cutU.uCutTo.value.set(cut.to[0], cut.to[1], cut.to[2]);
    this.cutU.uCutRange.value.set(cut.near, cut.far, cut.radius, cam.mode === 'adventure' ? cut.on : 0);
    // 砂も抜く（自由追従・腕の最短）間は、地形の中から見た裏面を断面の色で塗る（両面を描く。ふだんは表だけ）
    const sandCut = cam.mode === 'adventure' ? cut.on * cut.sand : 0;
    this.cutSandU.value.set(cut.near, cut.far, cut.radius, sandCut);
    const cap = cam.mode === 'adventure' && (sandCut > 0.02 || cam.style === 'free') ? 1 : 0;
    if (this.cutU.uCap.value !== cap) {
      this.cutU.uCap.value = cap;
      for (const m of this.capMats) m.side = cap ? THREE.DoubleSide : THREE.FrontSide;
    }
    this.plumbing.boost.value = cam.mode === 'diorama' ? 1 : 0;
    const fade = cam.mode === 'adventure' ? cam.crabFade : 0;
    this.crabFadeU.value.set(fade, fade * 0.45);
    const clear = cam.mode === 'observe' && crab.region === 'tank' ? 1 : 0;
    this.glassClearU.value += (clear - this.glassClearU.value) * (dt > 0 ? 1 - Math.exp(-dt * 6) : 1);

    // カメラ（低解像度ターゲットの大きさ = キャンバス + 余白。透視投影なので画素スナップのずれは 0）
    const c = this.camera;
    const pose = cam.pose;
    // 縦長の画面（スマホの縦持ち）では縦の画角を広げ、横に見える範囲が横長の画面と同じくらいになるようにする
    const aspect = p.canvasLowW / p.canvasLowH;
    const wide = 1.3;
    c.fov = aspect >= wide ? pose.fov : Math.min(cam.mode === 'diorama' ? 84 : 72,(2 * Math.atan((Math.tan((pose.fov * Math.PI) / 360) * wide) / aspect) * 180) / Math.PI);
    c.aspect = p.lowW / p.lowH;
    c.near = cam.mode === 'diorama' ? 1 : 0.05;
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
