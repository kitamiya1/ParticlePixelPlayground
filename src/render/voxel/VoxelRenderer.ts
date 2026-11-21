// 描画方式 D：ボクセル（不透明な立方体の集合 + 深度）。Spark には依存しない。
// 立方体を個別の Three.js オブジェクトにせず、空気に面した「面」1 枚を四角形のインスタンス 1 個として描く。
// - 浮き島：面を向き（±X・±Y・±Z）ごとに 6 つの InstancedBufferGeometry に分け、カメラから見て裏向きの組は丸ごと描かない
//   （平行投影では 6 組のうち常に 3 組だけを描く）。
// - キャラクター：ボーンごとの剛体ボクセル（静止姿勢で 1 回だけボクセル化し、ボーン行列で動かす）。
// 光・影・風・霞は方式 A・C と同じ GLSL（LIGHTING_CHUNK）。風はボクセル単位で同じだけ動かす。
// 後処理も方式 A・C と同じ PixelPipeline（深度を書くので奥行き差の輪郭が使える）。

import * as THREE from 'three';
import type { RenderSettings } from '../../settings';
import { BONE_COUNT, BONE_PIVOTS } from '../../visual/emitters/character';
import type { CharacterRig } from '../CharacterRig';
import type { SharedUniforms } from '../ParticleMaterial';
import { PixelPipeline } from '../PixelPipeline';
import { LIGHTING_CHUNK } from '../shaders';
import type { FaceList, VoxelCharacter, VoxelWorld } from './VoxelGrid';

const voxelVertex = /* glsl */ `
attribute vec3 iCell;  // 格子座標
attribute vec4 iColor; // RGB + 焼き込み日照
attribute vec4 iMisc;  // 面の向き, 4 隅の遮蔽（2 bit × 4）, 風の影響度, ボーン番号

#ifdef USE_BONES
uniform mat4 uBones[${BONE_COUNT}];
uniform vec3 uPivots[${BONE_COUNT}];
#endif
uniform vec3 uOrigin;
uniform float uVoxel;
${LIGHTING_CHUNK}

varying vec3 vColor;
varying vec2 vQ;
varying float vAO;

// 面の向き → 法線 N と面内の 2 軸（U × V = N。CPU 側の FACE_U / FACE_V と同じ並び）
void faceAxes(float d, out vec3 N, out vec3 U, out vec3 V) {
  if (d < 0.5)      { N = vec3( 1, 0, 0); U = vec3(0, 1, 0); V = vec3(0, 0, 1); }
  else if (d < 1.5) { N = vec3(-1, 0, 0); U = vec3(0, 0, 1); V = vec3(0, 1, 0); }
  else if (d < 2.5) { N = vec3(0,  1, 0); U = vec3(0, 0, 1); V = vec3(1, 0, 0); }
  else if (d < 3.5) { N = vec3(0, -1, 0); U = vec3(1, 0, 0); V = vec3(0, 0, 1); }
  else if (d < 4.5) { N = vec3(0, 0,  1); U = vec3(1, 0, 0); V = vec3(0, 1, 0); }
  else              { N = vec3(0, 0, -1); U = vec3(0, 1, 0); V = vec3(1, 0, 0); }
}

void main() {
  vec3 N, U, V;
  faceAxes(iMisc.x, N, U, V);
  vec3 center = uOrigin + (iCell + 0.5) * uVoxel;
  vec3 local = (N * 0.5 + U * position.x + V * position.y) * uVoxel;
  // この頂点の隅の遮蔽（隅の番号は (U,V) = (-,-), (+,-), (+,+), (-,+) の順）
  float corner = position.x < 0.0 ? (position.y < 0.0 ? 0.0 : 3.0) : (position.y < 0.0 ? 1.0 : 2.0);
  vAO = mod(floor(iMisc.y / pow(4.0, corner)), 4.0) / 3.0;
  vQ = position.xy;
#ifdef USE_BONES
  int b = int(iMisc.w + 0.5);
  mat4 bm = uBones[b];
  vec4 wc = modelMatrix * (bm * vec4(center - uPivots[b], 1.0));
  vec3 wn = normalize(mat3(modelMatrix) * (mat3(bm) * N));
  vec3 wl = mat3(modelMatrix) * (mat3(bm) * local);
#else
  vec4 wc = modelMatrix * vec4(center, 1.0);
  vec3 wn = N;
  vec3 wl = local;
#endif
  // 光と風はボクセルの中心で計算する（面ごと・頂点ごとにずれないよう、1 個のボクセルは同じだけ動く）
  vColor = pppWorldLit(center, wc, wn, iColor.rgb, iMisc.z / 255.0, iColor.a);
  gl_Position = projectionMatrix * viewMatrix * vec4(wc.xyz + wl, 1.0);
}
`;

const voxelFragment = /* glsl */ `
uniform float uEdge;
uniform float uAO;
varying vec3 vColor;
varying vec2 vQ;
varying float vAO;
void main() {
#ifdef COUNT_FRAGMENTS
  // 重ね塗り計測：不透明で破棄しないので、ラスタライズされた断片 = 色を書く断片
  gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0);
  return;
#endif
  // 隅の遮蔽（隣のボクセルに囲まれた角ほど暗く）
  vec3 c = vColor * mix(1.0, 0.5 + 0.5 * vAO, uAO);
  // 立方体の縁：面の端から 1 画素ぶんを暗くする（画素の幅は fwidth で求める）。
  // 面が 4 画素より小さいと縁だけで面が埋まって全体が暗くなるので、その向きの縁は描かない
  if (uEdge > 0.0) {
    vec2 q = abs(vQ);
    vec2 fw = fwidth(vQ);
    bool ex = fw.x < 0.25 && q.x > 0.5 - fw.x;
    bool ey = fw.y < 0.25 && q.y > 0.5 - fw.y;
    if (ex || ey) c *= 1.0 - uEdge;
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

/** 面リスト → インスタンス化した四角形 */
function faceGeometry(f: FaceList): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('iCell', new THREE.InstancedBufferAttribute(f.cell, 3));
  g.setAttribute('iColor', new THREE.InstancedBufferAttribute(f.col, 4, true));
  g.setAttribute('iMisc', new THREE.InstancedBufferAttribute(f.misc, 4));
  g.instanceCount = f.count;
  return g;
}

export interface VoxelStats {
  /** 浮き島：占有ボクセル / 空気に面したボクセル / 面の総数 */
  worldSolid: number;
  worldSurface: number;
  worldFaces: number;
  charSolid: number;
  charSurface: number;
  charFaces: number;
  worldBuildMs: number;
  charBuildMs: number;
}

export class VoxelRenderer {
  readonly scene = new THREE.Scene();
  /** 方式 D 専用の低解像度ターゲットと後処理（中身は方式 A と同じ PixelPipeline） */
  readonly pipeline = new PixelPipeline();
  private world: { data: VoxelWorld; meshes: THREE.Mesh[]; geos: THREE.InstancedBufferGeometry[] } | null = null;
  private char: { data: VoxelCharacter; mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry } | null = null;
  private readonly worldMat: THREE.ShaderMaterial;
  private readonly charMat: THREE.ShaderMaterial;
  private readonly worldU = { uOrigin: { value: new THREE.Vector3() }, uVoxel: { value: 0.2 } };
  private readonly charU = { uOrigin: { value: new THREE.Vector3() }, uVoxel: { value: 0.06 } };
  private readonly look = { uEdge: { value: 0 }, uAO: { value: 0.6 } };
  private disposed = false;
  /** 最後に描いた面の数 */
  drawnFaces = 0;
  /** 最後に描いた面の向きの組の数（浮き島 6 組のうち） */
  drawnGroups = 0;

  constructor(shared: SharedUniforms, rig: CharacterRig) {
    this.worldMat = this.material(shared, this.worldU, { receiveBlob: true });
    this.charMat = this.material(shared, this.charU, { bones: rig.bones });
  }

  private material(shared: SharedUniforms, own: Record<string, THREE.IUniform>, opts: { bones?: THREE.Matrix4[]; receiveBlob?: boolean }) {
    // 方式 A のマテリアルと同じく、共有ユニフォームは同じオブジェクトを参照させる
    const uniforms: Record<string, THREE.IUniform> = { ...shared, ...own, ...this.look, uReceiveBlob: { value: opts.receiveBlob ? 1 : 0 } };
    const defines: Record<string, string> = {};
    if (opts.bones) {
      uniforms.uBones = { value: opts.bones };
      uniforms.uPivots = { value: BONE_PIVOTS.map((p) => new THREE.Vector3(...p)) };
      defines.USE_BONES = '';
    }
    return new THREE.ShaderMaterial({ uniforms, defines, vertexShader: voxelVertex, fragmentShader: voxelFragment, side: THREE.FrontSide, depthTest: true, depthWrite: true });
  }

  /** 浮き島のボクセルを差し替える（前のものは GPU から解放する） */
  setWorld(data: VoxelWorld) {
    this.disposeWorld();
    const geos = data.faces.map(faceGeometry);
    const meshes = geos.map((g) => {
      const m = new THREE.Mesh(g, this.worldMat);
      m.frustumCulled = false;
      return m;
    });
    this.scene.add(...meshes);
    this.worldU.uOrigin.value.set(...data.origin);
    this.worldU.uVoxel.value = data.size;
    this.world = { data, meshes, geos };
  }

  /** キャラクターのボクセルを差し替える */
  setCharacter(data: VoxelCharacter) {
    this.disposeChar();
    const geo = faceGeometry(data.faces);
    const mesh = new THREE.Mesh(geo, this.charMat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    this.charU.uOrigin.value.set(...data.origin);
    this.charU.uVoxel.value = data.size;
    this.char = { data, mesh, geo };
  }

  get stats(): VoxelStats | null {
    const w = this.world?.data, c = this.char?.data;
    if (!w || !c) return null;
    return {
      worldSolid: w.solidCount, worldSurface: w.surfaceCount, worldFaces: w.faceCount,
      charSolid: c.solidCount, charSurface: c.surfaceCount, charFaces: c.faces.count,
      worldBuildMs: w.buildMs, charBuildMs: c.buildMs,
    };
  }

  /** 設定・キャラクターの姿勢・カメラの向きを反映する */
  update(s: RenderSettings, rig: CharacterRig, camera: THREE.OrthographicCamera | THREE.PerspectiveCamera) {
    this.look.uEdge.value = s.voxelEdge;
    this.look.uAO.value = s.voxelAO;
    let drawn = 0, groups = 0;
    if (this.world) {
      // 裏向きの組を丸ごと省く。平行投影：視線と法線の向きだけで決まる。透視投影：面の中心の範囲のどこかが表向きなら描く
      const e = camera.matrixWorld.elements;
      const back = [e[8], e[9], e[10]]; // カメラの +Z（画面の奥から手前へ）
      const cp = [e[12], e[13], e[14]];
      const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera;
      const { faces, bounds } = this.world.data;
      for (let d = 0; d < 6; d++) {
        const axis = d >> 1, sign = d & 1 ? -1 : 1;
        let visible = true;
        if (s.voxelCull && faces[d].count) {
          if (ortho) visible = back[axis] * sign > 1e-6;
          else visible = sign > 0 ? cp[axis] > bounds[d].min[axis] + 0.5 * this.worldU.uVoxel.value : cp[axis] < bounds[d].max[axis] - 0.5 * this.worldU.uVoxel.value;
        }
        this.world.meshes[d].visible = visible && faces[d].count > 0;
        if (this.world.meshes[d].visible) {
          drawn += faces[d].count;
          groups++;
        }
      }
    }
    if (this.char) {
      this.char.mesh.matrix.copy(rig.root);
      this.char.mesh.matrixWorld.copy(rig.root);
      drawn += this.char.data.faces.count;
    }
    this.drawnFaces = drawn;
    this.drawnGroups = groups;
  }

  /** 低解像度ターゲットへ描く（ターゲットの大きさは方式 A と同じにする） */
  renderScene(renderer: THREE.WebGLRenderer, camera: THREE.Camera, canvasW: number, canvasH: number, scale: number) {
    this.pipeline.ensureSize(canvasW, canvasH, scale);
    this.pipeline.renderScene(renderer, this.scene, camera);
  }

  /** 重ね塗り計測：計測用シェーダーに差し替え、深度テストなし・加算合成で 1 断片 = 1 として数える */
  renderCount(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget) {
    const counters = [this.worldMat, this.charMat].map((m) => {
      const c = m.clone();
      c.uniforms = m.uniforms;
      c.defines = { ...m.defines, COUNT_FRAGMENTS: '' };
      c.blending = THREE.AdditiveBlending;
      c.depthTest = false;
      c.depthWrite = false;
      c.transparent = true;
      return c;
    });
    const meshes = [...(this.world?.meshes ?? []), ...(this.char ? [this.char.mesh] : [])];
    const saved = meshes.map((m) => m.material);
    for (const m of meshes) m.material = m === this.char?.mesh ? counters[1] : counters[0];
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
    this.scene.remove(...this.world.meshes);
    this.world.geos.forEach((g) => g.dispose());
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
    this.worldMat.dispose();
    this.charMat.dispose();
    this.pipeline.dispose();
  }
}
