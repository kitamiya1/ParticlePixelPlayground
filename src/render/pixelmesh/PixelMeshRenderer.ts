// 描画方式 E：ピクセル化メッシュ（通常のポリゴンメッシュ + 低解像度描画 + ドット絵の後処理）。Spark には依存しない。
// - 地形・樹木・岩・雲：静的な三角形メッシュ（MeshBuild）。草の葉・花の茎は細い帯、花の頭は星形の円盤のインスタンス。
// - キャラクター：部位ごとの三角形メッシュをボーン行列で剛体として動かす（方式 A・D と同じ CharacterRig）。
// - 光・影・風・霞：方式 A・C・D と同じ GLSL（LIGHTING_CHUNK）。風は頂点シェーダーで動かし、光は画素ごとに計算する
//   （陰影の段階化が三角形の補間でぼけないように）。
// - 後処理：方式 A・C・D と同じ PixelPipeline（深度を書くので奥行き差の輪郭が使える）。

import * as THREE from 'three';
import type { RenderSettings } from '../../settings';
import { BONE_COUNT } from '../../visual/emitters/character';
import type { CharacterRig } from '../CharacterRig';
import type { SharedUniforms } from '../ParticleMaterial';
import { PixelPipeline } from '../PixelPipeline';
import { LIGHTING_CHUNK } from '../shaders';
import type { BladeInstances, PixelMeshCharacter, PixelMeshWorld, TriMesh } from './MeshBuild';

/** 草の葉・花の茎の帯：段 f = 0, 1/3, 2/3 は左右 2 点、先端 f = 1 は 1 点（三角形 5 枚） */
const BLADE_TEMPLATE = { pos: [-1, 0, 0, 1, 0, 0, -1, 1 / 3, 0, 1, 1 / 3, 0, -1, 2 / 3, 0, 1, 2 / 3, 0, 0, 1, 0], index: [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 6] };
/** 花の頭：中心 + 花びら 5 枚の星形（外周 10 点、y = 1 が中心の印） */
const HEAD_TEMPLATE = (() => {
  const pos = [0, 1, 0];
  const index: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2, r = i % 2 ? 0.55 : 1;
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    index.push(0, 1 + i, 1 + ((i + 1) % 10));
  }
  return { pos, index };
})();

const meshVertex = /* glsl */ `
#if defined(USE_BLADE) || defined(USE_HEAD)
attribute vec3 iBase;
attribute vec4 iShape;
attribute vec4 iColA;
attribute vec4 iColB;
#else
attribute vec3 aColor;
attribute vec2 aMisc; // 日照, 風の影響度
#endif
#ifdef USE_BONES
attribute float aBone;
uniform mat4 uBones[${BONE_COUNT}];
#endif
${LIGHTING_CHUNK}

varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSun;

void main() {
  vec3 p, n, col, phase = vec3(0.0);
  float sun, wind;
#if defined(USE_BLADE)
  // 粒版の草と同じ曲げ方（傾き × f² × 長さ × 2）。幅はカメラの横方向へ張る（どの向きから見ても帯の幅が見える）
  float f = position.y, len = iShape.x;
  p = iBase + vec3(iShape.y * f * f * len * 2.0, len * f, iShape.z * f * f * len * 2.0);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 side = normalize(vec3(camRight.x, 0.0, camRight.z) + vec3(1e-5));
  p += side * position.x * iShape.w * 0.5 * (1.0 - 0.6 * f);
  n = normalize(vec3(iShape.y, 1.0, iShape.z));
  col = mix(iColA.rgb, iColB.rgb, f);
  sun = iColA.a;
  wind = pow(f, 1.4) * iColB.a;
  phase = iBase;
#elif defined(USE_HEAD)
  float ca = cos(iShape.y), sa = sin(iShape.y);
  vec2 q = vec2(position.x * ca - position.z * sa, position.x * sa + position.z * ca) * iShape.x;
  p = iBase + vec3(q.x, 0.0, q.y);
  n = vec3(0.0, 1.0, 0.0);
  col = position.y > 0.5 ? iColB.rgb : iColA.rgb;
  sun = iColA.a;
  wind = iColB.a;
  // 茎と同じ揺れの位相（茎の根元の位置）にして、頭が茎の先から外れないようにする
  phase = iBase - vec3(0.0, iShape.z, 0.0);
#else
  p = position;
  n = normal;
  col = aColor;
  sun = aMisc.x;
  wind = aMisc.y;
#endif
#ifdef USE_BONES
  mat4 bm = uBones[int(aBone + 0.5)];
  p = (bm * vec4(p, 1.0)).xyz;
  n = mat3(bm) * n;
#endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec3 wn = normalize(mat3(modelMatrix) * n);
  // 風による変位だけを使う（光は画素ごとに計算し直す）。メッシュの頂点は位相を共通にして、形が崩れないようにする
  if (wind > 0.0) pppWorldLit(phase, wp, wn, col, wind, sun);
  vWorld = wp.xyz;
  vNormal = wn;
  vColor = col;
  vSun = sun;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * 方式 F の地面（USE_GROUND。地形の網だけに使う）：頂点の色の補間ではなく画素ごとに塗る。
 * - 道：道の符号付き距離（tPath。CPU の Terrain.pathSignedDistance を焼いたテクスチャ）の内側に、
 *   ボロノイの石・目地・土・苔を描く。石の縁は法線を外へ傾けて、光の段階化で石ごとの明暗（凹凸）を出す。
 * - 道のふち：土の帯（幅に揺らぎ）。
 * - 草地：頂点の色に、ワールド座標に固定した細かな 3 段の明暗を足す（C の草の粒と質感を揃える）。
 *   画素より細かくなる遠景では消す（ちらつき防止）。
 * - キャラクターの足元の接地影。
 */
const GROUND_CHUNK = /* glsl */ `
uniform sampler2D tPath;
uniform vec2 uPathMin;
uniform vec2 uPathSize;
uniform vec3 uStone0;
uniform vec3 uStone1;
uniform vec3 uStone2;
uniform vec3 uMortar;
uniform vec3 uDirt;
uniform vec3 uMoss;
uniform vec4 uRoad;     // x: 石の細かさ（1 単位あたりのセル数）, y: 目地の幅, z: 土のセルの割合, w: 石の明るさのばらつき
uniform float uRelief;  // 石の縁の法線の傾き
uniform float uGroundDetail;
uniform float uContact;
float gHash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 gHash22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
// ボロノイ：x = 境界までの距離（セル単位）, yz = 点からいちばん近いセル中心へのベクトル。cellId に格子番号
vec3 gVoronoi(vec2 x, out vec2 cellId) {
  vec2 n = floor(x), f = fract(x);
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + 0.12 + 0.76 * gHash22(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + 0.12 + 0.76 * gHash22(n + g) - f;
    if (dot(mr - r, mr - r) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  cellId = n + mg;
  return vec3(md, mr);
}
void pppGround(inout vec3 col, inout vec3 n, vec3 wpos) {
  if (n.y < 0.3) return; // 島の縁の側面は頂点の色のまま
  vec2 p = wpos.xz;
  vec4 pt = texture2D(tPath, (p - uPathMin) / uPathSize);
  float sd = pt.r * 4.0 - 2.0;
  // 1 画素あたりのワールド長（画素が地面に落ちる面積の平方根。浅い角度で奥行き方向だけ伸びても細部を消しすぎない）
  vec2 px = dFdx(p), py = dFdy(p);
  float fw = sqrt(max(abs(px.x * py.y - px.y * py.x), 1e-8));
  float detail = 1.0 - smoothstep(0.08, 0.17, fw);
  float jit = (gHash12(floor(p * 5.0)) - 0.5) * 0.12;
  // 草地：細かな 3 段の明暗 + 草の多い所はわずかに暗く
  float gh = gHash12(floor(p * 7.0));
  float q = gh < 0.3 ? -1.0 : (gh > 0.78 ? 1.0 : 0.0);
  vec3 grass = col * (1.0 + q * 0.1 * uGroundDetail * detail) * (1.0 - pt.g * 0.14 * uGroundDetail);
  // 道のふちの土（幅に揺らぎ）
  float verge = 1.0 - smoothstep(0.0, 0.4 + jit * 2.0, sd);
  vec3 dirt = uDirt * (1.0 + (gHash12(floor(p * 9.0)) - 0.5) * 0.14 * detail);
  vec3 c = mix(grass, dirt, verge * 0.85);
  if (sd + jit < 0.0) {
    vec2 cid;
    vec3 v = gVoronoi(p * uRoad.x, cid);
    float h1 = gHash12(cid * 1.37 + 3.1), h2 = gHash12(cid * 2.11 + 7.7), h3 = gHash12(cid * 0.73 + 11.3);
    vec3 stone = h1 < 0.4 ? uStone0 : (h1 < 0.75 ? uStone1 : uStone2);
    stone *= 1.0 + (h2 - 0.5) * uRoad.w;
    // 道の外側ほど土のセルが増える（石が端でまばらになる）
    bool isDirt = h3 < uRoad.z + smoothstep(-0.45, 0.0, sd) * 0.55;
    float lod = smoothstep(0.45, 0.9, fw * uRoad.x); // 石が 1〜2 画素より小さい遠景では平均色へ
    vec3 avg = mix((uStone0 + uStone1 + uStone2) / 3.0, uMortar, 0.25);
    // 遠景でも一色の面にならないよう、石より大きな単位（約 1.4 単位）の明るさの揺らぎを残す
    avg *= 1.0 + (gHash12(floor(p * 0.7)) - 0.5) * 0.22;
    vec3 rc;
    if (isDirt) {
      rc = dirt;
      // 土のセルにも小石を少し
      if (gHash12(floor(p * 11.0)) > 0.9) rc = mix(rc, uStone1, 0.7);
      avg = mix(avg, uDirt, uRoad.z);
    } else if (v.x < uRoad.y) {
      rc = mix(uMortar, uMoss, step(0.82, gHash12(floor(p * 8.0))) * 0.55);
    } else {
      rc = stone;
      float bev = (1.0 - smoothstep(uRoad.y, uRoad.y + 0.17, v.x)) * (1.0 - lod);
      vec2 dir = -v.yz / max(length(v.yz), 1e-4);
      n = normalize(n + vec3(dir.x, 0.0, dir.y) * bev * uRelief);
    }
    c = mix(rc, avg, lod);
  }
  // 接地影：キャラクターの足元を少し暗く（地面だけ。円の外は変えない）
  float cd = length(p - uCharPos.xz);
  float dy = uCharPos.y - wpos.y;
  c *= 1.0 - uContact * 0.4 * (1.0 - smoothstep(0.1, 0.3, cd)) * step(-0.3, dy) * step(dy, 0.6);
  col = c;
}
`;

const meshFragment = /* glsl */ `
uniform float uFlat;
uniform float uCharLift;
${LIGHTING_CHUNK}
#ifdef USE_GROUND
${GROUND_CHUNK}
#endif
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vSun;
void main() {
#ifdef COUNT_FRAGMENTS
  // 重ね塗り計測：不透明で破棄しないので、ラスタライズされた断片 = 色を書く断片
  gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0);
  return;
#endif
  vec3 n = normalize(vNormal);
  if (uFlat > 0.5) {
    // フラットシェーディング：画面上の位置の微分から三角形の面の向きを求める
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    n = dot(fn, n) < 0.0 ? -fn : fn;
  }
  vec4 wp = vec4(vWorld, 1.0);
  vec3 base = vColor;
#ifdef USE_GROUND
  pppGround(base, n, vWorld);
#endif
  vec3 c = pppWorldLit(vec3(0.0), wp, n, base, 0.0, vSun);
#ifdef USE_BONES
  // 方式 F：キャラクターを背景から浮かせる（明るさの持ち上げ + 輪郭側の縁の光。E では 0 なので変わらない）
  vec3 vd = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - clamp(dot(n, vd), 0.0, 1.0), 2.0);
  c = c * (1.0 + uCharLift) + uCharLift * 0.04 + rim * uCharLift * 2.2 * vec3(1.0, 0.94, 0.82);
#endif
  gl_FragColor = vec4(c, 1.0);
}
`;

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

function instGeometry(t: { pos: number[]; index: number[] }, b: BladeInstances): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
  g.setIndex(t.index);
  g.setAttribute('iBase', new THREE.InstancedBufferAttribute(b.base, 3));
  g.setAttribute('iShape', new THREE.InstancedBufferAttribute(b.shape, 4));
  g.setAttribute('iColA', new THREE.InstancedBufferAttribute(b.colA, 4, true));
  g.setAttribute('iColB', new THREE.InstancedBufferAttribute(b.colB, 4, true));
  g.instanceCount = b.count;
  return g;
}

export interface PixelMeshStats {
  /** 浮き島：静的メッシュの三角形 / 頂点、草の葉・花の茎の帯、花の頭 */
  worldTris: number;
  worldVerts: number;
  blades: number;
  grass: number;
  heads: number;
  charTris: number;
  charVerts: number;
  worldBuildMs: number;
  charBuildMs: number;
  detail: number;
}

/** 方式 F の地面用：道の符号付き距離・草の多さを上から見た格子に焼いたもの（R = 距離 -2..2 を 0..255, G = 草の多さ 0..1） */
export interface GroundField {
  data: Uint8Array;
  w: number;
  h: number;
  /** 格子の左下（x, z）と大きさ（ワールド単位） */
  min: [number, number];
  size: [number, number];
}

export class PixelMeshRenderer {
  readonly scene = new THREE.Scene();
  /** 方式 E 専用の低解像度ターゲットと後処理（中身は方式 A と同じ PixelPipeline） */
  readonly pipeline = new PixelPipeline();
  private world: { data: PixelMeshWorld; meshes: THREE.Mesh[]; geos: THREE.BufferGeometry[]; blade: THREE.Mesh | null; bladeGeo: THREE.InstancedBufferGeometry | null; trunks: THREE.Mesh | null; terrain: THREE.Mesh } | null = null;
  private char: { data: PixelMeshCharacter; mesh: THREE.Mesh; geo: THREE.BufferGeometry } | null = null;
  private readonly worldMat: THREE.ShaderMaterial;
  private readonly charMat: THREE.ShaderMaterial;
  private readonly bladeMat: THREE.ShaderMaterial;
  private readonly headMat: THREE.ShaderMaterial;
  private readonly look = { uFlat: { value: 0 }, uCharLift: { value: 0 } };
  /** 方式 F の地面（setGroundField で用意。無ければ地形も worldMat で描く） */
  private ground: { mat: THREE.ShaderMaterial; tex: THREE.DataTexture } | null = null;
  /** 地面の塗り方のユニフォーム（方式 F の HybridRenderer が毎フレーム設定する） */
  readonly groundU = {
    tPath: { value: null as THREE.Texture | null },
    uPathMin: { value: new THREE.Vector2() },
    uPathSize: { value: new THREE.Vector2(1, 1) },
    uStone0: { value: new THREE.Vector3() },
    uStone1: { value: new THREE.Vector3() },
    uStone2: { value: new THREE.Vector3() },
    uMortar: { value: new THREE.Vector3() },
    uDirt: { value: new THREE.Vector3() },
    uMoss: { value: new THREE.Vector3() },
    uRoad: { value: new THREE.Vector4(2.2, 0.08, 0, 0.12) },
    uRelief: { value: 0.6 },
    uGroundDetail: { value: 0 },
    uContact: { value: 0 },
  };
  /** 地形を地面用のマテリアルで描くか（false なら E と同じ worldMat = v1 の見た目） */
  groundActive = false;
  /** キャラクターの明るさの持ち上げ（方式 F のみ。E では 0） */
  charLift = 0;
  private disposed = false;
  /** 最後に描いた三角形の数（静的メッシュ + 帯・花の頭のインスタンス分 + キャラクター） */
  drawnTris = 0;
  /** 最後に描いた帯（花の茎 + 草の葉）の数 */
  drawnBlades = 0;
  /** 幹・枝のメッシュ（方式 F で別に作ったときだけ）を描くか */
  trunksVisible = true;

  private readonly sharedRef: SharedUniforms;

  constructor(shared: SharedUniforms, rig: CharacterRig) {
    this.sharedRef = shared;
    this.worldMat = this.material(shared, { receiveBlob: true });
    this.charMat = this.material(shared, { bones: rig.bones });
    this.bladeMat = this.material(shared, { receiveBlob: true, define: 'USE_BLADE' });
    this.headMat = this.material(shared, { receiveBlob: true, define: 'USE_HEAD' });
  }

  private material(shared: SharedUniforms, opts: { bones?: THREE.Matrix4[]; receiveBlob?: boolean; define?: string }) {
    // 方式 A のマテリアルと同じく、共有ユニフォームは同じオブジェクトを参照させる
    const uniforms: Record<string, THREE.IUniform> = { ...shared, ...this.look, uReceiveBlob: { value: opts.receiveBlob ? 1 : 0 } };
    const defines: Record<string, string> = {};
    if (opts.bones) {
      uniforms.uBones = { value: opts.bones };
      defines.USE_BONES = '';
    }
    if (opts.define) defines[opts.define] = '';
    if (opts.define === 'USE_GROUND') Object.assign(uniforms, this.groundU);
    // 草の帯・花の頭は薄い板なので両面、それ以外は閉じた立体なので表だけ
    const side = opts.define && opts.define !== 'USE_GROUND' ? THREE.DoubleSide : THREE.FrontSide;
    return new THREE.ShaderMaterial({ uniforms, defines, vertexShader: meshVertex, fragmentShader: meshFragment, side, depthTest: true, depthWrite: true });
  }

  /** 方式 F の地面用の距離場を用意する（前のものは解放する）。以後 groundActive = true で地形をこれで塗る */
  setGroundField(f: GroundField) {
    if (this.ground) {
      this.ground.tex.dispose();
    } else {
      this.ground = { mat: this.material(this.sharedRef, { receiveBlob: true, define: 'USE_GROUND' }), tex: null as unknown as THREE.DataTexture };
    }
    const tex = new THREE.DataTexture(f.data, f.w, f.h, THREE.RGBAFormat);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.ground.tex = tex;
    this.groundU.tPath.value = tex;
    this.groundU.uPathMin.value.set(f.min[0], f.min[1]);
    this.groundU.uPathSize.value.set(f.size[0], f.size[1]);
  }

  /**
   * 浮き島のメッシュを差し替える（前のものは GPU から解放する）。
   * decor=false なら草の葉・花（帯と星形の円盤）を GPU へ上げない（方式 F では草花を C の円盤で描くため）。
   */
  setWorld(data: PixelMeshWorld, opts: { decor?: boolean } = {}) {
    this.disposeWorld();
    const decor = opts.decor ?? true;
    const geos = [data.terrain, data.objects, data.clouds].map(triGeometry);
    const meshes: THREE.Mesh[] = geos.map((g) => new THREE.Mesh(g, this.worldMat));
    let trunks: THREE.Mesh | null = null;
    if (data.trunks) {
      const tg = triGeometry(data.trunks);
      geos.push(tg);
      trunks = new THREE.Mesh(tg, this.worldMat);
      meshes.push(trunks);
    }
    let blade: THREE.Mesh | null = null, bladeGeo: THREE.InstancedBufferGeometry | null = null;
    if (decor) {
      bladeGeo = instGeometry(BLADE_TEMPLATE, data.blades);
      const headGeo = instGeometry(HEAD_TEMPLATE, data.heads);
      geos.push(headGeo);
      meshes.push(new THREE.Mesh(headGeo, this.headMat));
      blade = new THREE.Mesh(bladeGeo, this.bladeMat);
      meshes.push(blade);
    }
    for (const m of meshes) m.frustumCulled = false;
    this.scene.add(...meshes);
    this.world = { data, meshes, geos, blade, bladeGeo, trunks, terrain: meshes[0] };
  }

  /** キャラクターのメッシュを差し替える */
  setCharacter(data: PixelMeshCharacter) {
    this.disposeChar();
    const geo = triGeometry(data.mesh);
    const mesh = new THREE.Mesh(geo, this.charMat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    this.char = { data, mesh, geo };
  }

  get stats(): PixelMeshStats | null {
    const w = this.world?.data, c = this.char?.data;
    if (!w || !c) return null;
    return {
      worldTris: w.terrain.triCount + w.objects.triCount + w.clouds.triCount + (w.trunks?.triCount ?? 0),
      worldVerts: w.terrain.vertexCount + w.objects.vertexCount + w.clouds.vertexCount + (w.trunks?.vertexCount ?? 0),
      blades: w.blades.count, grass: w.grassCount, heads: w.heads.count,
      charTris: c.mesh.triCount, charVerts: c.mesh.vertexCount,
      worldBuildMs: w.buildMs, charBuildMs: c.buildMs, detail: w.detail,
    };
  }

  /** 内訳（地形・樹木と岩・雲の三角形数） */
  get breakdown() {
    const w = this.world?.data;
    return w ? { terrain: w.terrain.triCount, objects: w.objects.triCount, trunks: w.trunks?.triCount ?? 0, clouds: w.clouds.triCount, phases: w.phases } : null;
  }

  /** 設定・キャラクターの姿勢を反映する */
  update(s: RenderSettings, rig: CharacterRig) {
    this.look.uFlat.value = s.meshFlat ? 1 : 0;
    this.look.uCharLift.value = this.charLift;
    let tris = 0;
    if (this.world) {
      this.world.terrain.material = this.groundActive && this.ground ? this.ground.mat : this.worldMat;
      const w = this.world.data;
      tris += w.terrain.triCount + w.objects.triCount + w.clouds.triCount;
      if (this.world.trunks) {
        this.world.trunks.visible = this.trunksVisible;
        if (this.trunksVisible) tris += w.trunks!.triCount;
      }
      this.drawnBlades = 0;
      if (this.world.blade && this.world.bladeGeo) {
        // 草の密度：花の茎（先頭）は常に描き、続くシャッフル済みの草の葉は必要数だけ描く
        const grass = Math.round(w.grassCount * Math.max(0, Math.min(1, s.meshGrass)));
        const stems = w.blades.count - w.grassCount;
        this.world.bladeGeo.instanceCount = stems + grass;
        this.world.blade.visible = stems + grass > 0;
        this.drawnBlades = stems + grass;
        tris += (stems + grass) * 5 + w.heads.count * 10;
      }
    }
    if (this.char) {
      this.char.mesh.matrix.copy(rig.root);
      this.char.mesh.matrixWorld.copy(rig.root);
      tris += this.char.data.mesh.triCount;
    }
    this.drawnTris = tris;
  }

  /** 低解像度ターゲットへ描く（ターゲットの大きさは方式 A と同じにする） */
  renderScene(renderer: THREE.WebGLRenderer, camera: THREE.Camera, canvasW: number, canvasH: number, scale: number) {
    this.pipeline.ensureSize(canvasW, canvasH, scale);
    this.pipeline.renderScene(renderer, this.scene, camera);
  }

  /** 重ね塗り計測：計測用シェーダーに差し替え、深度テストなし・加算合成で 1 断片 = 1 として数える（clear=false なら前の計数に足す） */
  renderCount(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget, clear = true) {
    const mats = [this.worldMat, this.charMat, this.bladeMat, this.headMat];
    if (this.ground) mats.push(this.ground.mat);
    const counters = mats.map((m) => {
      const c = m.clone();
      c.uniforms = m.uniforms;
      c.defines = { ...m.defines, COUNT_FRAGMENTS: '' };
      c.blending = THREE.AdditiveBlending;
      c.depthTest = false;
      c.depthWrite = false;
      c.transparent = true;
      return c;
    });
    const meshes = this.scene.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh);
    const saved = meshes.map((m) => m.material as THREE.ShaderMaterial);
    meshes.forEach((m, i) => (m.material = counters[mats.indexOf(saved[i])]));
    renderer.setRenderTarget(target);
    if (clear) {
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
    }
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(null);
    meshes.forEach((m, i) => (m.material = saved[i]));
    counters.forEach((c) => c.dispose());
  }

  private disposeWorld() {
    if (!this.world) return;
    this.scene.remove(...this.world.meshes);
    this.world.geos.forEach((g) => g.dispose());
    this.world.bladeGeo?.dispose();
    this.world = null;
  }

  private disposeChar() {
    if (!this.char) return;
    this.scene.remove(this.char.mesh);
    this.char.geo.dispose();
    this.char = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeWorld();
    this.disposeChar();
    [this.worldMat, this.charMat, this.bladeMat, this.headMat].forEach((m) => m.dispose());
    if (this.ground) {
      this.ground.mat.dispose();
      this.ground.tex.dispose();
      this.ground = null;
    }
    this.pipeline.dispose();
  }
}
