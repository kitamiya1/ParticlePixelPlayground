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

const meshFragment = /* glsl */ `
uniform float uFlat;
${LIGHTING_CHUNK}
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
  gl_FragColor = vec4(pppWorldLit(vec3(0.0), wp, n, vColor, 0.0, vSun), 1.0);
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

export class PixelMeshRenderer {
  readonly scene = new THREE.Scene();
  /** 方式 E 専用の低解像度ターゲットと後処理（中身は方式 A と同じ PixelPipeline） */
  readonly pipeline = new PixelPipeline();
  private world: { data: PixelMeshWorld; meshes: THREE.Mesh[]; geos: THREE.BufferGeometry[]; blade: THREE.Mesh; bladeGeo: THREE.InstancedBufferGeometry } | null = null;
  private char: { data: PixelMeshCharacter; mesh: THREE.Mesh; geo: THREE.BufferGeometry } | null = null;
  private readonly worldMat: THREE.ShaderMaterial;
  private readonly charMat: THREE.ShaderMaterial;
  private readonly bladeMat: THREE.ShaderMaterial;
  private readonly headMat: THREE.ShaderMaterial;
  private readonly look = { uFlat: { value: 0 } };
  private disposed = false;
  /** 最後に描いた三角形の数（静的メッシュ + 帯・花の頭のインスタンス分 + キャラクター） */
  drawnTris = 0;
  /** 最後に描いた帯（花の茎 + 草の葉）の数 */
  drawnBlades = 0;

  constructor(shared: SharedUniforms, rig: CharacterRig) {
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
    // 草の帯・花の頭は薄い板なので両面、それ以外は閉じた立体なので表だけ
    const side = opts.define ? THREE.DoubleSide : THREE.FrontSide;
    return new THREE.ShaderMaterial({ uniforms, defines, vertexShader: meshVertex, fragmentShader: meshFragment, side, depthTest: true, depthWrite: true });
  }

  /** 浮き島のメッシュを差し替える（前のものは GPU から解放する） */
  setWorld(data: PixelMeshWorld) {
    this.disposeWorld();
    const geos = [data.terrain, data.objects, data.clouds].map(triGeometry);
    const meshes = geos.map((g) => new THREE.Mesh(g, this.worldMat));
    const bladeGeo = instGeometry(BLADE_TEMPLATE, data.blades);
    const headGeo = instGeometry(HEAD_TEMPLATE, data.heads);
    geos.push(headGeo);
    meshes.push(new THREE.Mesh(headGeo, this.headMat));
    const blade = new THREE.Mesh(bladeGeo, this.bladeMat);
    for (const m of [...meshes, blade]) m.frustumCulled = false;
    this.scene.add(...meshes, blade);
    this.world = { data, meshes, geos, blade, bladeGeo };
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
      worldTris: w.terrain.triCount + w.objects.triCount + w.clouds.triCount,
      worldVerts: w.terrain.vertexCount + w.objects.vertexCount + w.clouds.vertexCount,
      blades: w.blades.count, grass: w.grassCount, heads: w.heads.count,
      charTris: c.mesh.triCount, charVerts: c.mesh.vertexCount,
      worldBuildMs: w.buildMs, charBuildMs: c.buildMs, detail: w.detail,
    };
  }

  /** 内訳（地形・樹木と岩・雲の三角形数） */
  get breakdown() {
    const w = this.world?.data;
    return w ? { terrain: w.terrain.triCount, objects: w.objects.triCount, clouds: w.clouds.triCount, phases: w.phases } : null;
  }

  /** 設定・キャラクターの姿勢を反映する */
  update(s: RenderSettings, rig: CharacterRig) {
    this.look.uFlat.value = s.meshFlat ? 1 : 0;
    let tris = 0;
    if (this.world) {
      const w = this.world.data;
      // 草の密度：花の茎（先頭）は常に描き、続くシャッフル済みの草の葉は必要数だけ描く
      const grass = Math.round(w.grassCount * Math.max(0, Math.min(1, s.meshGrass)));
      const stems = w.blades.count - w.grassCount;
      this.world.bladeGeo.instanceCount = stems + grass;
      this.world.blade.visible = stems + grass > 0;
      this.drawnBlades = stems + grass;
      tris += w.terrain.triCount + w.objects.triCount + w.clouds.triCount + (stems + grass) * 5 + w.heads.count * 10;
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

  /** 重ね塗り計測：計測用シェーダーに差し替え、深度テストなし・加算合成で 1 断片 = 1 として数える */
  renderCount(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget) {
    const mats = [this.worldMat, this.charMat, this.bladeMat, this.headMat];
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
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(null);
    meshes.forEach((m, i) => (m.material = saved[i]));
    counters.forEach((c) => c.dispose());
  }

  private disposeWorld() {
    if (!this.world) return;
    this.scene.remove(...this.world.meshes, this.world.blade);
    this.world.geos.forEach((g) => g.dispose());
    this.world.bladeGeo.dispose();
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
    this.pipeline.dispose();
  }
}
