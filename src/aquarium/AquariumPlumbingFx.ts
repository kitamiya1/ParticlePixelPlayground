// 配管・濾過槽の透明な物と水の動きの描画（Three.js）。AquariumRenderer の各シーンへ足して、毎フレーム update する。
// - 透明な管（排水管・給水管）：外壁 + 内壁の 2 層。フレネルの輪郭・映り込みの帯・照明のハイライト・薄い曇り・切り口の白い縁
//   （完全な無色透明にせず、管の形が水槽の中からも外からも読めるようにする）
// - 排水管の中：内壁を伝って落ちる水の膜（ディザで抜いた縞。隙間から中のカニが見える）・落ちる水滴・下へ運ばれる泡・
//   上から差す光の筋。水面の穴のまわりは漏斗状に落ち込む水面（AquariumRenderer の水面と同じシェーダー）
// - 濾過槽：アクリルの壁（縁を明るく）・部屋ごとの水面（水位が違う）・越流の仕切りを落ちる水の膜・落水口の泡
// - 流木のトンネル：節穴から差す光の筋（芯のはっきりした筋）と、光の中を漂う粒

import * as THREE from 'three';
import { BAYER } from '../render/shaders';
import { bubbleFragment, bubbleVertex, shaftFragment, shaftVertex, waterFragment, waterVertex } from './aquaShaders';
import { LAMP_DIR, TANK } from './aquaConst';
import { SUMP, SUMP_IN, type Pipe, type Vec3 } from './AquariumStand';
import type { AquariumWorld } from './AquariumWorld';

/** 節穴の光の筋を、節穴の外側どれだけ手前から描くか（光が穴へ入っていく所が分かる程度の短さ） */
const KNOT_LEAD = 0.35;

const pipeVertex = /* glsl */ `
attribute float aAlong;
attribute float aLayer;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAlong;
varying float vLayer;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vAlong = aAlong;
  vLayer = aLayer;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** 透明な管：aLayer = 0 外壁, 1 内壁, 2 切り口 */
const pipeFragment = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uTint;
uniform float uFill;
uniform float uTopY;
uniform float uTopLight;
uniform float uWaterY;
uniform vec3 uTankMin;
uniform vec3 uTankMax;
uniform float uBoost;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAlong;
varying float vLayer;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vNormal);
  float ndv = abs(dot(n, V));
  // 輪郭：視線と面が浅い角度になる管の左右の縁ほど濃い
  float fres = pow(1.0 - ndv, 2.2);
  float a = 0.06 + fres * 0.62;
  vec3 col = uTint;
  // 映り込みの帯（縁の少し内側に細い明るい縦の帯）と照明のハイライト
  float band = smoothstep(0.16, 0.26, ndv) * (1.0 - smoothstep(0.26, 0.38, ndv));
  float spec = pow(max(dot(reflect(-V, n), uSunDir), 0.0), 26.0);
  col += vec3(1.0) * (band * 0.4 + spec * 0.9);
  a += band * 0.2 + spec * 0.5;
  // 薄い曇り（細かな粒のむら）
  float fr = fract(sin(dot(floor(vWorld * 36.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  a += (fr - 0.5) * 0.04 + 0.02;
  // 中を満たす水（給水管）
  col = mix(col, vec3(0.38, 0.72, 0.74), uFill * 0.45);
  a += uFill * 0.07;
  // 水槽の水の中にある部分は青緑に沈む
  float inTank = step(uTankMin.x, vWorld.x) * step(vWorld.x, uTankMax.x) * step(uTankMin.z, vWorld.z) * step(vWorld.z, uTankMax.z) * step(uTankMin.y, vWorld.y) * step(vWorld.y, uWaterY);
  col = mix(col, vec3(0.3, 0.6, 0.58), inTank * 0.45);
  // 上から差す光：管の口に近い内壁ほど明るい
  float lit = exp(-max(uTopY - vWorld.y, 0.0) * 0.3) * uTopLight * step(0.5, vLayer) * step(vLayer, 1.5);
  col += vec3(0.85, 1.0, 0.95) * lit * 0.35;
  a += lit * 0.1;
  // 上から覗き込むと、口から深いほど暗い（細い縦穴の奥へは光が届かない）。横から見たときは暗くしない
  float down = smoothstep(0.5, 0.9, V.y) * uTopLight;
  float deep = smoothstep(0.2, 2.6, uTopY - vWorld.y) * step(vWorld.y, uTopY + 0.05);
  col = mix(col, vec3(0.02, 0.06, 0.07), down * deep * 0.85);
  a += down * deep * 0.35;
  // 箱庭カメラ（遠くから）：管の形とつながりが読めるよう、色と輪郭を濃くする
  col = mix(col, vec3(0.55, 0.9, 0.95), uBoost * 0.35);
  a += uBoost * (0.16 + fres * 0.3);
  // 切り口の縁は白く
  if (vLayer > 1.5) { col = vec3(0.92, 1.0, 1.0); a = 0.8; }
  gl_FragColor = vec4(col, clamp(a, 0.04, 0.88));
}
`;

/** アクリル：うすい色・フレネル・縁の明るい線・部屋ごとの水位の線（x で部屋が決まる） */
const acrylicVertex = /* glsl */ `
attribute vec2 aFace;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vFace;
varying vec2 vSize;
attribute vec2 aSize;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vFace = aFace;
  vSize = aSize;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const acrylicFragment = /* glsl */ `
uniform vec4 uLevels;
uniform vec3 uBounds;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vFace;
varying vec2 vSize;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormal), V)), 3.0);
  float a = 0.05 + fres * 0.42;
  vec3 col = vec3(0.8, 0.9, 0.9);
  // 縁（面の端から 0.05 以内）は明るい線
  vec2 e = min(vFace, 1.0 - vFace) * vSize;
  float edge = 1.0 - smoothstep(0.02, 0.06, min(e.x, e.y));
  a += edge * 0.45;
  col = mix(col, vec3(0.95, 1.0, 1.0), edge);
  float level = vWorld.x < uBounds.x ? uLevels.x : vWorld.x < uBounds.y ? uLevels.y : vWorld.x < uBounds.z ? uLevels.z : uLevels.w;
  if (vWorld.y < level) {
    col = mix(col, vec3(0.32, 0.62, 0.6), 0.5);
    a += 0.05;
  }
  float line = 1.0 - smoothstep(0.0, 0.05, abs(vWorld.y - level));
  a += line * 0.4;
  col = mix(col, vec3(0.92, 1.0, 1.0), line);
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.8));
}
`;

/** 落ちる水の膜：uv.x = 横（周・幅）、uv.y = 上からの距離（ワールド単位）。縞が下へ流れ、ディザで抜いて隙間を作る */
const sheetVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const sheetFragment = /* glsl */ `
uniform float uTime;
uniform float uCols;
uniform float uSpeed;
uniform float uCover;
uniform float uFade;
uniform float uLookDark;
varying vec2 vUv;
varying vec3 vWorld;
${BAYER}
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float col = floor(vUv.x * uCols);
  float hh = h1(col + 3.0);
  // 筋ごとに速さの違う縞（下へ流れる）
  float s = fract(vUv.y * 1.3 - uTime * uSpeed * (0.8 + hh * 0.6) + hh * 9.0);
  float stripe = 0.55 + 0.45 * step(0.35, fract(vUv.x * uCols)) * step(fract(vUv.x * uCols), 0.85);
  // 上ほど厚い膜、下へ行くほど筋に分かれて薄くなる
  float cover = uCover * stripe * mix(1.0, 0.55, smoothstep(0.0, uFade, vUv.y)) * (0.6 + 0.4 * step(0.4, s));
  if (bayer4(gl_FragCoord.xy) > cover) discard;
  vec3 c = mix(vec3(0.5, 0.78, 0.84), vec3(0.94, 0.99, 1.0), step(0.6, s));
  // 深いほど暗い（穴の奥は暗い）。上から覗き込むときは特に暗く（縦穴の奥）
  c *= mix(1.0, 0.55, smoothstep(0.0, uFade * 1.6, vUv.y));
  float down = smoothstep(0.5, 0.9, normalize(cameraPosition - vWorld).y) * uLookDark;
  c *= mix(1.0, 0.15, down * smoothstep(0.4, 2.8, vUv.y));
  gl_FragColor = vec4(c, 1.0);
}
`;

interface PipeParticle {
  pipe: 0 | 1;
  s: number;
  ang: number;
  rad: number;
  speed: number;
  kind: 0 | 1;
  size: number;
  ph: number;
}

interface FreeParticle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number; kind: 0 | 1; size: number; top: number;
}

export class AquariumPlumbingFx {
  readonly waterMats: THREE.ShaderMaterial[] = [];
  private readonly drainMat: THREE.ShaderMaterial;
  private readonly sheetMats: THREE.ShaderMaterial[] = [];
  private readonly particles: PipeParticle[] = [];
  private readonly free: FreeParticle[] = [];
  private readonly geo = new THREE.BufferGeometry();
  private readonly maxPts = 900;
  private readonly beamMotes: { beam: number; t: number; a: number; r: number; sp: number; ph: number }[] = [];
  private readonly beams: { start: Vec3; dir: Vec3; len: number; r: number }[] = [];
  private freeT = 0;
  /** 箱庭カメラのとき管を目立たせる（AquariumRenderer が毎フレーム決める） */
  readonly boost = { value: 0 };
  private readonly tmp: Vec3 = [0, 0, 0];

  constructor(
    private readonly world: AquariumWorld,
    uniforms: Record<string, THREE.IUniform>,
    scenes: { fx: THREE.Scene; alpha: THREE.Scene },
    /** 水面（AquariumRenderer と同じ作り）のユニフォーム：時間・照明・霞の色・カニの位置は共有 */
    shared: { uTime: THREE.IUniform; uSunDir: THREE.IUniform; uWaterFog: THREE.IUniform; uCharPos: THREE.IUniform },
  ) {
    const S = world.stand;
    const tankU = { uWaterY: { value: TANK.waterY }, uTankMin: { value: new THREE.Vector3(TANK.minX, TANK.floorY, TANK.minZ) }, uTankMax: { value: new THREE.Vector3(TANK.maxX, TANK.topY, TANK.maxZ) } };

    // ---- 透明な管 ----
    const mkPipe = (p: Pipe, tint: THREE.Color, fill: number, topLight: number, topY: number) => {
      const m = new THREE.Mesh(
        tubeGeometry(p),
        new THREE.ShaderMaterial({
          vertexShader: pipeVertex,
          fragmentShader: pipeFragment,
          uniforms: { uTime: shared.uTime, uSunDir: shared.uSunDir, uTint: { value: tint }, uFill: { value: fill }, uTopY: { value: topY }, uTopLight: { value: topLight }, uBoost: this.boost, ...tankU },
          transparent: true,
          depthWrite: false,
        }),
      );
      m.frustumCulled = false;
      m.renderOrder = 1.5;
      scenes.alpha.add(m);
      return m;
    };
    mkPipe(S.drain, new THREE.Color(0.78, 0.92, 0.92), 0, 1, S.drainRim);
    mkPipe(S.ret, new THREE.Color(0.74, 0.86, 0.9), 1, 0, 0);

    // ---- 排水管の中の水の膜（内壁を伝って落ちる）と、管の口の縁を越えて落ちる水 ----
    const [ax, az] = S.drainAxis;
    const rim = S.drainRim, bottom = S.drain.pts[1][1];
    const sheet = this.sheetMaterial(26, 2.6, 0.5, 5.5);
    sheet.uniforms.uLookDark.value = 1;
    const sg = revolveGeometry(ax, az, [
      [S.drain.outer + 0.06, rim + 0.1, 0],
      [S.drain.outer - 0.02, rim + 0.12, 0.1],
      [S.drain.inner + 0.01, rim + 0.03, 0.2],
      [S.drain.inner - 0.04, rim - 0.3, 0.55],
      ...Array.from({ length: 12 }, (_, i): [number, number, number] => {
        const y = rim - 0.6 - ((rim - 0.6 - bottom) * (i + 1)) / 12;
        return [S.drain.inner - 0.04, y, rim - y + 0.2];
      }),
    ]);
    const sm = new THREE.Mesh(sg, sheet);
    sm.frustumCulled = false;
    scenes.fx.add(sm);

    // ---- 水面の穴のまわりの漏斗（水面と同じシェーダー、奥ほど暗い） ----
    this.drainMat = this.waterMaterial(shared, TANK.waterY, [ax, az, S.mouthR], [0, 0, 0], true, rim);
    const prof: [number, number, number][] = [];
    const r0 = S.drain.outer + 0.05, R = S.mouthR;
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const r = r0 + (R - r0) * t;
      prof.push([r, rim + 0.12 + (TANK.waterY - rim - 0.12) * (1 - Math.pow(1 - t, 2.4)), t]);
    }
    const funnel = new THREE.Mesh(revolveGeometry(ax, az, prof), this.drainMat);
    funnel.frustumCulled = false;
    funnel.renderOrder = 2;
    scenes.alpha.add(funnel);

    // ---- 濾過槽：アクリル・部屋ごとの水面・越流の水の膜 ----
    const ch = SUMP.chambers;
    const acr = new THREE.Mesh(
      boxesGeometry(S.acrylic),
      new THREE.ShaderMaterial({
        vertexShader: acrylicVertex,
        fragmentShader: acrylicFragment,
        uniforms: { uLevels: { value: new THREE.Vector4(ch[0].level, ch[1].level, ch[2].level, ch[3].level) }, uBounds: { value: new THREE.Vector3(ch[0].x1 + 0.06, ch[1].x1 + 0.06, ch[2].x1 + 0.06) } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    acr.frustumCulled = false;
    acr.renderOrder = 1.6;
    scenes.alpha.add(acr);
    for (const c of ch) {
      const hole: [number, number, number] = c.id === 'drop' ? [ax, az, S.drain.outer] : c.id === 'pump' ? [6.6, -5.0, S.ret.outer] : [0, 0, 0];
      const fall: [number, number, number] = c.id === 'drop' ? [ax, az, 1.5] : c.id === 'pump' ? [c.x0 + 0.1, 0, 0] : [0, 0, 0];
      const m = this.waterMaterial(shared, c.level, hole, fall, false, 0);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(c.x1 - c.x0, SUMP_IN.maxZ - SUMP_IN.minZ, 8, 8).rotateX(-Math.PI / 2), m);
      plane.position.set((c.x0 + c.x1) / 2, c.level, (SUMP_IN.minZ + SUMP_IN.maxZ) / 2);
      plane.renderOrder = 1.55;
      plane.frustumCulled = false;
      scenes.alpha.add(plane);
    }
    // ろ材室 → ポンプ室：仕切りを越えて落ちる水（水位差）
    const b3 = SUMP.baffles[2];
    const weir = this.sheetMaterial(60, 1.4, 0.55, 0.6);
    const wg = sheetPlane(b3.x + SUMP.wall / 2 + 0.03, b3.top + 0.02, ch[3].level, SUMP_IN.minZ, SUMP_IN.maxZ);
    const wm = new THREE.Mesh(wg, weir);
    wm.frustumCulled = false;
    scenes.fx.add(wm);
    // スポンジ室 → ろ材室：仕切りの上を越える薄い水
    const b2 = SUMP.baffles[1];
    const weir2 = this.sheetMaterial(50, 1.0, 0.4, 0.2);
    const wm2 = new THREE.Mesh(sheetPlane(b2.x + SUMP.wall / 2 + 0.03, b2.top + 0.03, ch[2].level, SUMP_IN.minZ, SUMP_IN.maxZ), weir2);
    wm2.frustumCulled = false;
    scenes.fx.add(wm2);

    // ---- 管の中・まわりの粒（水滴・泡）：泡と同じシェーダー ----
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxPts * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.maxPts), 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(this.maxPts), 1).setUsage(THREE.DynamicDrawUsage));
    const pts = new THREE.Points(this.geo, new THREE.ShaderMaterial({ vertexShader: bubbleVertex, fragmentShader: bubbleFragment, uniforms: { ...uniforms, uMaxPx: { value: 4 } }, defines: { PPP_WATER: '' } }));
    pts.frustumCulled = false;
    scenes.fx.add(pts);
    let seed = 4242;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const dl = rim - bottom;
    for (let i = 0; i < 150; i++) this.particles.push({ pipe: 0, s: rnd() * dl, ang: rnd() * 6.28, rad: Math.sqrt(rnd()) * 0.62, speed: 5 + rnd() * 3.5, kind: 1, size: 0.022 + rnd() * 0.022, ph: rnd() * 6.28 });
    for (let i = 0; i < 45; i++) this.particles.push({ pipe: 0, s: rnd() * dl, ang: rnd() * 6.28, rad: 0.45 + rnd() * 0.25, speed: 2.6 + rnd() * 1.8, kind: 0, size: 0.03 + rnd() * 0.035, ph: rnd() * 6.28 });
    for (let i = 0; i < 110; i++) this.particles.push({ pipe: 1, s: rnd() * S.ret.length, ang: rnd() * 6.28, rad: Math.sqrt(rnd()) * 0.36, speed: 4.5 + rnd() * 2.5, kind: 0, size: 0.04 + rnd() * 0.05, ph: rnd() * 6.28 });

    // ---- 流木のトンネルの節穴から差す光 ----
    // 流木専用の光なので、節穴のすぐ上（KNOT_LEAD）から倒木の内側の床までだけにする。節穴より上の水中は
    // 水槽全体の光の筋（AquariumRenderer.buildShafts）の受け持ちで、ここで強い芯の筋を描くと流木の外に光の柱が立って見える
    for (const k of world.landmarks.knots) {
      const dir: Vec3 = [-LAMP_DIR[0], -LAMP_DIR[1], -LAMP_DIR[2]];
      const start: Vec3 = [k.c[0] - dir[0] * KNOT_LEAD, k.c[1] - dir[1] * KNOT_LEAD, k.c[2] - dir[2] * KNOT_LEAD];
      // 節穴を抜けたあと、倒木の内側の床に当たるまで
      let t = 0.45;
      for (let i = 0; i < 60 && t < 3; i++) {
        const d = world.solid(k.c[0] + dir[0] * t, k.c[1] + dir[1] * t, k.c[2] + dir[2] * t);
        if (d < 0.01) break;
        t += Math.max(d * 0.8, 0.02);
      }
      this.beams.push({ start, dir, len: KNOT_LEAD + t, r: k.r * 1.05 });
    }
    const beamGeo = shaftGeometry(this.beams.map((b, i) => ({ start: b.start, width: b.r * 1.15, len: b.len + 0.15, phase: -(1 + i), strength: i === 0 ? 2.2 : 1.8 })));
    // uBeamIn：筋の始まり（節穴の外側の短い部分）を薄く立ち上げる長さの割合
    const beamMat = new THREE.ShaderMaterial({ vertexShader: shaftVertex, fragmentShader: shaftFragment, defines: { BEAM: '' }, uniforms: { uTime: shared.uTime, uBeamFade: { value: 0 }, uBeamIn: { value: 0.22 }, uShaftDir: { value: new THREE.Vector3(-LAMP_DIR[0], -LAMP_DIR[1], -LAMP_DIR[2]) } }, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.frustumCulled = false;
    beamMesh.renderOrder = 1;
    scenes.alpha.add(beamMesh);
    this.beams.forEach((b, i) => {
      for (let j = 0; j < 55; j++) this.beamMotes.push({ beam: i, t: rnd(), a: rnd() * 6.28, r: Math.sqrt(rnd()) * b.r * 0.85, sp: 0.03 + rnd() * 0.05, ph: rnd() * 6.28 });
    });
    // 排水管の口から真下へ差し込む光（管の中から上を見上げる・上から覗き込むと見える）
    const dShafts = shaftGeometry([
      { start: [ax, TANK.waterY + 0.1, az], width: 0.36, len: 9, phase: -0.3, strength: 1.4 },
      { start: [ax + 0.22, TANK.waterY + 0.1, az - 0.12], width: 0.18, len: 6.5, phase: -1.7, strength: 1.2 },
      { start: [ax - 0.18, TANK.waterY + 0.1, az + 0.2], width: 0.14, len: 5, phase: -2.9, strength: 1.0 },
    ]);
    const dMat = beamMat.clone();
    dMat.uniforms.uTime = shared.uTime;
    dMat.uniforms.uShaftDir = { value: new THREE.Vector3(0, -1, 0) };
    dMat.uniforms.uBeamFade = { value: 1 };
    dMat.uniforms.uBeamIn = { value: 0.06 };
    const dMesh = new THREE.Mesh(dShafts, dMat);
    dMesh.frustumCulled = false;
    dMesh.renderOrder = 1;
    scenes.alpha.add(dMesh);
  }

  /** 光の筋（節穴）の位置。床・内壁・カニに落ちる光だまりの計算に使う（AquariumRenderer の uBeam*） */
  get beamList(): readonly { start: Vec3; dir: Vec3; len: number; r: number }[] {
    return this.beams;
  }

  private sheetMaterial(cols: number, speed: number, cover: number, fade: number): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: sheetVertex,
      fragmentShader: sheetFragment,
      uniforms: { uTime: { value: 0 }, uCols: { value: cols }, uSpeed: { value: speed }, uCover: { value: cover }, uFade: { value: fade }, uLookDark: { value: 0 } },
      side: THREE.DoubleSide,
    });
    this.sheetMats.push(m);
    return m;
  }

  private waterMaterial(shared: { uTime: THREE.IUniform; uSunDir: THREE.IUniform; uWaterFog: THREE.IUniform; uCharPos: THREE.IUniform }, level: number, drain: [number, number, number], fall: [number, number, number], funnel: boolean, rim: number): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      defines: funnel ? { FUNNEL: '' } : {},
      uniforms: {
        uTime: shared.uTime, uSunDir: shared.uSunDir, uWaterFog: shared.uWaterFog, uCharPos: shared.uCharPos,
        uWaterY: { value: level },
        uRipple: { value: new THREE.Vector4(0, 0, -10, 0) }, uRipple2: { value: new THREE.Vector4(0, 0, -10, 0) },
        uFall: { value: new THREE.Vector3(...fall) },
        uDrain: { value: new THREE.Vector3(...drain) },
        uDrainRim: { value: rim },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.waterMats.push(m);
    return m;
  }

  update(dt: number, time: number) {
    for (const m of this.sheetMats) m.uniforms.uTime.value = time;
    const S = this.world.stand;
    const [ax, az] = S.drainAxis;
    const rim = S.drainRim, bottom = S.drain.pts[1][1];
    const dl = rim - bottom;
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const size = this.geo.getAttribute('aSize') as THREE.BufferAttribute;
    const kind = this.geo.getAttribute('aKind') as THREE.BufferAttribute;
    let n = 0;
    for (const p of this.particles) {
      if (p.pipe === 0) {
        p.s = (p.s + p.speed * dt) % dl;
        p.ph += dt * 5;
        const a = p.ang + (p.kind === 0 ? Math.sin(p.ph) * 0.3 : p.s * 0.1);
        const r = p.rad + (p.kind === 0 ? Math.sin(p.ph * 1.3) * 0.04 : 0);
        pos.setXYZ(n, ax + Math.cos(a) * r, rim - p.s, az + Math.sin(a) * r);
      } else {
        p.s = (p.s + p.speed * dt) % S.ret.length;
        p.ph += dt * 4;
        const c = S.ret.pointAt(p.s, this.tmp);
        const u = S.ret.tangentAt(p.s);
        // 中心線に直交する 2 軸 b = u × h（h は u と平行でない軸）、c = u × b
        const hx = Math.abs(u[1]) > 0.9 ? 1 : 0, hy = 1 - hx;
        let bx = -u[2] * hy, by = u[2] * hx, bz = u[0] * hy - u[1] * hx;
        const bl = Math.hypot(bx, by, bz) || 1;
        bx /= bl; by /= bl; bz /= bl;
        const cx = u[1] * bz - u[2] * by, cy = u[2] * bx - u[0] * bz, cz = u[0] * by - u[1] * bx;
        const ca = Math.cos(p.ang + Math.sin(p.ph) * 0.4) * p.rad, sa = Math.sin(p.ang + Math.sin(p.ph) * 0.4) * p.rad;
        pos.setXYZ(n, c[0] + bx * ca + cx * sa, c[1] + by * ca + cy * sa, c[2] + bz * ca + cz * sa);
      }
      size.setX(n, p.size * 2);
      kind.setX(n, p.kind);
      n++;
    }
    // 管の口の縁で跳ねる水しぶき・落水口から上る泡・吐き出し口から出る泡（寿命のある粒）
    this.freeT -= dt;
    while (this.freeT < 0) {
      this.freeT += 0.02;
      const r = Math.random;
      const a = r() * Math.PI * 2;
      const er = S.drain.outer + 0.1;
      this.free.push({ x: ax + Math.cos(a) * er, y: rim + 0.12, z: az + Math.sin(a) * er, vx: -Math.cos(a) * 0.6, vy: 0.4 + r() * 0.5, vz: -Math.sin(a) * 0.6, life: 0, max: 0.35, kind: 1, size: 0.03, top: 99 });
      if (r() < 0.6) {
        const ch1 = SUMP.chambers[0].level;
        this.free.push({ x: ax + (r() - 0.5) * 1.2, y: bottom - 0.1 - r() * 0.6, z: az + (r() - 0.5) * 1.2, vx: (r() - 0.5) * 0.4, vy: 0.6 + r() * 0.4, vz: (r() - 0.5) * 0.4, life: 0, max: 3, kind: 0, size: 0.03 + r() * 0.04, top: ch1 - 0.03 });
      }
      if (r() < 0.35) {
        const o = S.outlet;
        this.free.push({ x: o[0] + (r() - 0.5) * 0.5, y: o[1] + (r() - 0.5) * 0.5, z: o[2] + 0.1, vx: (r() - 0.5) * 0.4, vy: 0.4 + r() * 0.3, vz: 2.4 + r() * 1.5, life: 0, max: 3, kind: 0, size: 0.03 + r() * 0.04, top: TANK.waterY - 0.03 });
      }
    }
    let w = 0;
    for (const f of this.free) {
      f.life += dt;
      if (f.kind === 1) f.vy -= 9 * dt;
      else {
        f.vy = Math.min(f.vy + dt * 1.2, 1.4);
        f.vx *= Math.exp(-dt * 1.5);
        f.vz *= Math.exp(-dt * 1.5);
      }
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      if (f.life < f.max && f.y < f.top) this.free[w++] = f;
    }
    this.free.length = w;
    for (const f of this.free) {
      if (n >= this.maxPts - this.beamMotes.length) break;
      pos.setXYZ(n, f.x, f.y, f.z);
      size.setX(n, f.size * 2);
      kind.setX(n, f.kind);
      n++;
    }
    // 光の中を漂う粒（光の筋に沿ってゆっくり沈み、少し揺れる）
    for (const m of this.beamMotes) {
      const b = this.beams[m.beam];
      m.t = (m.t + m.sp * dt / Math.max(1, b.len * 0.25)) % 1;
      m.ph += dt * 0.7;
      const t = 0.35 + m.t * (b.len - 0.35);
      const d = b.dir;
      // 光の向きに直交する 2 軸
      const ex = -d[2], ez = d[0];
      const el = Math.hypot(ex, ez) || 1;
      const ux = ex / el, uz = ez / el;
      const vx = d[1] * uz, vy = d[2] * ux - d[0] * uz, vz = -d[1] * ux;
      const ca = Math.cos(m.a + Math.sin(m.ph) * 0.5) * m.r, sa = Math.sin(m.a + Math.sin(m.ph) * 0.5) * m.r;
      pos.setXYZ(n, b.start[0] + d[0] * t + ux * ca + vx * sa, b.start[1] + d[1] * t + vy * sa, b.start[2] + d[2] * t + uz * ca + vz * sa);
      // きらめき：ときどき大きく
      size.setX(n, 0.035 + Math.pow(Math.max(0, Math.sin(m.ph * 3 + m.a * 7)), 12) * 0.05);
      kind.setX(n, 1);
      n++;
    }
    for (let i = n; i < this.maxPts; i++) size.setX(i, 0);
    pos.needsUpdate = size.needsUpdate = kind.needsUpdate = true;
  }
}

// ---------------- 形 ----------------

/** 管：中心線に沿った外壁・内壁の 2 枚の筒 + 両端の切り口の輪 */
function tubeGeometry(p: Pipe): THREE.BufferGeometry {
  // 長い辺は細かく分ける（ワールド座標の varying をなめらかに）
  const pts: Vec3[] = [];
  const along: number[] = [];
  let s = 0;
  for (let i = 0; i < p.pts.length; i++) {
    if (i > 0) {
      const a = p.pts[i - 1], b = p.pts[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const k = Math.max(1, Math.ceil(L / 0.8));
      for (let j = 1; j <= k; j++) {
        const t = j / k;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        along.push(s + L * t);
      }
      s += L;
    } else {
      pts.push([...p.pts[0]] as Vec3);
      along.push(0);
    }
  }
  // 平行移動で回転しない枠（法線の基準）
  const tang = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return d.normalize();
  });
  const frames: { n: THREE.Vector3; b: THREE.Vector3 }[] = [];
  let nPrev = new THREE.Vector3().crossVectors(tang[0], Math.abs(tang[0].y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  for (let i = 0; i < pts.length; i++) {
    const t = tang[i];
    const n = nPrev.clone().sub(t.clone().multiplyScalar(nPrev.dot(t))).normalize();
    const b = new THREE.Vector3().crossVectors(t, n);
    frames.push({ n, b });
    nPrev = n;
  }
  const seg = 28;
  const pos: number[] = [], nrm: number[] = [], al: number[] = [], layer: number[] = [], idx: number[] = [];
  const surface = (r: number, inward: boolean, lay: number) => {
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const { n, b } = frames[i];
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        const dx = n.x * Math.cos(a) + b.x * Math.sin(a), dy = n.y * Math.cos(a) + b.y * Math.sin(a), dz = n.z * Math.cos(a) + b.z * Math.sin(a);
        pos.push(pts[i][0] + dx * r, pts[i][1] + dy * r, pts[i][2] + dz * r);
        const sg = inward ? -1 : 1;
        nrm.push(dx * sg, dy * sg, dz * sg);
        al.push(along[i]);
        layer.push(lay);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * (seg + 1) + k, b = a + 1, c = a + seg + 1, d = c + 1;
      if (inward) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  };
  surface(p.outer, false, 0);
  surface(p.inner, true, 1);
  // 切り口（両端の輪）
  for (const end of [0, pts.length - 1]) {
    const base = pos.length / 3;
    const { n, b } = frames[end];
    const t = tang[end].clone().multiplyScalar(end === 0 ? -1 : 1);
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const dx = n.x * Math.cos(a) + b.x * Math.sin(a), dy = n.y * Math.cos(a) + b.y * Math.sin(a), dz = n.z * Math.cos(a) + b.z * Math.sin(a);
      for (const r of [p.inner, p.outer]) {
        pos.push(pts[end][0] + dx * r, pts[end][1] + dy * r, pts[end][2] + dz * r);
        nrm.push(t.x, t.y, t.z);
        al.push(along[end]);
        layer.push(2);
      }
    }
    for (let k = 0; k < seg; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(al, 1));
  g.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
  g.setIndex(idx);
  return g;
}

/** 縦軸まわりの回転体：profile = [半径, 高さ, v（膜の上からの距離）] */
function revolveGeometry(cx: number, cz: number, profile: [number, number, number][]): THREE.BufferGeometry {
  const seg = 40;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < profile.length; i++) {
    const [r, y, v] = profile[i];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      pos.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
      uv.push(k / seg, v);
    }
  }
  for (let i = 0; i < profile.length - 1; i++) for (let k = 0; k < seg; k++) {
    const a = i * (seg + 1) + k, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 仕切りを越えて落ちる水の板（x 一定の縦の帯。uv.x = z 方向の 0..1、uv.y = 上からの距離） */
function sheetPlane(x: number, yTop: number, yBot: number, z0: number, z1: number): THREE.BufferGeometry {
  const pos = [x, yTop, z0, x, yTop, z1, x + 0.12, yBot, z0, x + 0.12, yBot, z1];
  const uv = [0, 0, 1, 0, 0, yTop - yBot, 1, yTop - yBot];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  return g;
}

/** 箱の集まり（アクリルの板）：面ごとに 0..1 の座標と面の大きさ（縁の線用） */
function boxesGeometry(boxes: { min: Vec3; max: Vec3 }[]): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], face: number[] = [], size: number[] = [], idx: number[] = [];
  const quad = (o: Vec3, u: Vec3, v: Vec3, n: Vec3) => {
    const base = pos.length / 3;
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      pos.push(o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b, o[2] + u[2] * a + v[2] * b);
      nrm.push(...n);
      face.push(a, b);
      size.push(lu, lv);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const b of boxes) {
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    quad([x0, y1, z0], [dx, 0, 0], [0, 0, dz], [0, 1, 0]);
    quad([x0, y0, z0], [dx, 0, 0], [0, 0, dz], [0, -1, 0]);
    quad([x0, y0, z1], [dx, 0, 0], [0, dy, 0], [0, 0, 1]);
    quad([x0, y0, z0], [dx, 0, 0], [0, dy, 0], [0, 0, -1]);
    quad([x1, y0, z0], [0, 0, dz], [0, dy, 0], [1, 0, 0]);
    quad([x0, y0, z0], [0, 0, dz], [0, dy, 0], [-1, 0, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 2));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 2));
  g.setIndex(idx);
  return g;
}

/** 光の筋（AquariumRenderer の buildShafts と同じ作りのインスタンス） */
function shaftGeometry(list: { start: Vec3; width: number; len: number; phase: number; strength: number }[]): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const rows = 12;
  const pos: number[] = [], idx: number[] = [];
  for (let r = 0; r <= rows; r++) pos.push(-1, r / rows, 0, 1, r / rows, 0);
  for (let r = 0; r < rows; r++) idx.push(r * 2, r * 2 + 1, r * 2 + 3, r * 2, r * 2 + 3, r * 2 + 2);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const start = new Float32Array(list.length * 3), param = new Float32Array(list.length * 4);
  list.forEach((s, i) => {
    start.set(s.start, i * 3);
    param.set([s.width, s.len, s.phase, s.strength], i * 4);
  });
  g.setAttribute('iStart', new THREE.InstancedBufferAttribute(start, 3));
  g.setAttribute('iParam', new THREE.InstancedBufferAttribute(param, 4));
  g.instanceCount = list.length;
  return g;
}

