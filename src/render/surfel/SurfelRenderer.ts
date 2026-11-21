// 描画方式 C：サーフェル（法線方向を向いた不透明な円盤 + 深度テスト）。Spark には依存しない。
// 各点を「三角形 2 枚の四角形」のインスタンスとして描き、フラグメントで円の外を捨てる。
// 光・影・風・霞は方式 A と同じ GLSL（LIGHTING_CHUNK）、後処理も方式 A と同じ（深度を書くので
// 奥行き差の輪郭がそのまま使える）。違いは「画面に正対した点」か「面の向きに沿った円盤」かだけ。

import * as THREE from 'three';
import type { RenderSettings } from '../../settings';
import { BONE_COUNT, BONE_PIVOTS } from '../../visual/emitters/character';
import type { CharacterSplatSource } from '../../visual/sdf/sdfObjects';
import type { CharacterRig } from '../CharacterRig';
import type { SharedUniforms } from '../ParticleMaterial';
import { PixelPipeline } from '../PixelPipeline';
import { LIGHTING_CHUNK } from '../shaders';
import type { SplatPointSet } from '../shared/PointSet';

const surfelVertex = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iColor;
attribute vec3 iNormal;
attribute vec3 iMisc; // x: サイズ（直径）, y: 風の影響度, z: 焼き込んだ日照

#ifdef USE_BONES
attribute vec2 iBones;   // 2 本のボーン番号
attribute float iWeight; // 1 本目の重み
uniform mat4 uBones[${BONE_COUNT}];
uniform vec3 uPivots[${BONE_COUNT}];
#endif

uniform float uSurfelRadius; // 直径 → 半径の換算と「円盤の大きさ」「密度補正」を掛けた係数
uniform float uBillboard;
uniform float uSnap;
uniform vec2 uRes;
${LIGHTING_CHUNK}

varying vec3 vColor;
varying vec2 vQ;

void main() {
  vec3 p = iPos;
  vec3 n = iNormal;
#ifdef USE_BONES
  // 静止姿勢（キャラクター座標）→ 各ボーンの支点からの相対 → ボーン行列（線形ブレンド）
  int b0 = int(iBones.x + 0.5), b1 = int(iBones.y + 0.5);
  mat4 m0 = uBones[b0], m1 = uBones[b1];
  vec3 p0 = (m0 * vec4(iPos - uPivots[b0], 1.0)).xyz;
  vec3 p1 = (m1 * vec4(iPos - uPivots[b1], 1.0)).xyz;
  p = mix(p1, p0, iWeight);
  n = mix(mat3(m1) * iNormal, mat3(m0) * iNormal, iWeight);
#endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec3 wn = normalize(mat3(modelMatrix) * n);
  vColor = pppWorldLit(iPos, wp, wn, iColor, iMisc.y, iMisc.z);

  // 円盤の面内の 2 軸：法線に垂直（世界の上方向を面に投影した向きを縦に）。比較用に画面正対も選べる
  vec3 T, B;
  if (uBillboard > 0.5) {
    T = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    B = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  } else {
    vec3 ref = abs(wn.y) > 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    T = normalize(cross(ref, wn));
    B = cross(wn, T);
  }
  float r = iMisc.x * uSurfelRadius;
  vQ = position.xy;
  vec4 clip = projectionMatrix * viewMatrix * vec4(wp.xyz + (T * position.x + B * position.y) * r, 1.0);
  if (uSnap > 0.5) {
    // 方式 A の「粒を画素グリッドに吸着」と同じ考え方：円盤の中心を画素中心へ寄せ、全頂点を同じだけずらす
    vec4 cc = projectionMatrix * viewMatrix * wp;
    if (cc.w > 0.0) {
      vec2 sp = (cc.xy / cc.w * 0.5 + 0.5) * uRes;
      vec2 d = (floor(sp) + 0.5 - sp) / uRes * 2.0;
      clip.xy += d * clip.w;
    }
  }
  gl_Position = clip;
}
`;

const surfelFragment = /* glsl */ `
varying vec3 vColor;
varying vec2 vQ;
void main() {
  bool inside = dot(vQ, vQ) <= 1.0;
#ifdef COUNT_FRAGMENTS
  // 重ね塗り計測：R = ラスタライズされた断片（四角形全体）, G = 円の内側で実際に色を書く断片
  gl_FragColor = vec4(1.0, inside ? 1.0 : 0.0, 0.0, 1.0);
  return;
#endif
  if (!inside) discard;
  gl_FragColor = vec4(vColor, 1.0);
}
`;

/** 1 枚の四角形（-1..1）。インスタンスごとに円盤として配置される */
function quad(): { position: THREE.Float32BufferAttribute; index: number[] } {
  return { position: new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3), index: [0, 1, 2, 0, 2, 3] };
}

function instancedFrom(set: { pos: Float32Array; col: Uint8Array; nrm: Float32Array; count: number }, misc: Float32Array): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const q = quad();
  g.setAttribute('position', q.position);
  g.setIndex(q.index);
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(set.pos, 3));
  g.setAttribute('iColor', new THREE.InstancedBufferAttribute(set.col, 3, true));
  g.setAttribute('iNormal', new THREE.InstancedBufferAttribute(set.nrm, 3));
  g.setAttribute('iMisc', new THREE.InstancedBufferAttribute(misc, 3));
  g.instanceCount = set.count;
  return g;
}

export class SurfelRenderer {
  readonly scene = new THREE.Scene();
  /** 方式 C 専用の低解像度ターゲットと後処理（中身は方式 A と同じ PixelPipeline） */
  readonly pipeline = new PixelPipeline();
  readonly worldTotal: number;
  readonly charTotal: number;
  readonly buildMs: number;
  private readonly worldGeo: THREE.InstancedBufferGeometry;
  private readonly charGeo: THREE.InstancedBufferGeometry | null;
  private readonly worldMat: THREE.ShaderMaterial;
  private readonly charMat: THREE.ShaderMaterial | null;
  private readonly worldMesh: THREE.Mesh;
  private readonly charMesh: THREE.Mesh | null;
  /** 方式 C だけのユニフォーム（共有ユニフォームとは別に持つ） */
  private readonly own = {
    uSurfelRadius: { value: 0.5 },
    uBillboard: { value: 0 },
    uSnap: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
  };
  private disposed = false;
  drawn = 0;

  /** charSrc = null ならキャラクターを持たない（方式 F：キャラクターは E のメッシュで描く） */
  constructor(shared: SharedUniforms, rig: CharacterRig, worldSet: SplatPointSet, charSrc: CharacterSplatSource | null) {
    const t0 = performance.now();
    // 浮き島
    const misc = new Float32Array(worldSet.count * 3);
    for (let i = 0; i < worldSet.count; i++) {
      misc[i * 3] = worldSet.size[i];
      misc[i * 3 + 1] = worldSet.wind[i];
      misc[i * 3 + 2] = worldSet.sun[i];
    }
    this.worldGeo = instancedFrom(worldSet, misc);
    this.worldTotal = worldSet.count;
    this.worldMat = this.material(shared, { receiveBlob: true });
    this.worldMesh = new THREE.Mesh(this.worldGeo, this.worldMat);
    this.worldMesh.frustumCulled = false;

    this.scene.add(this.worldMesh);
    // キャラクター（静止姿勢 + 2 ボーンの重み。方式 A と同じボーン行列で動かす）
    if (charSrc) {
      const cmisc = new Float32Array(charSrc.count * 3);
      const bones = new Float32Array(charSrc.count * 2);
      for (let i = 0; i < charSrc.count; i++) {
        cmisc[i * 3] = charSrc.size[i];
        cmisc[i * 3 + 2] = 1;
        bones[i * 2] = charSrc.bone0[i];
        bones[i * 2 + 1] = charSrc.bone1[i];
      }
      this.charGeo = instancedFrom(charSrc, cmisc);
      this.charGeo.setAttribute('iBones', new THREE.InstancedBufferAttribute(bones, 2));
      this.charGeo.setAttribute('iWeight', new THREE.InstancedBufferAttribute(charSrc.weight0, 1));
      this.charTotal = charSrc.count;
      this.charMat = this.material(shared, { bones: rig.bones });
      this.charMesh = new THREE.Mesh(this.charGeo, this.charMat);
      this.charMesh.frustumCulled = false;
      this.charMesh.matrixAutoUpdate = false;
      this.scene.add(this.charMesh);
    } else {
      this.charGeo = null;
      this.charMat = null;
      this.charMesh = null;
      this.charTotal = 0;
    }

    this.buildMs = performance.now() - t0;
  }

  private material(shared: SharedUniforms, opts: { bones?: THREE.Matrix4[]; receiveBlob?: boolean }) {
    // 方式 A のマテリアルと同じく、共有ユニフォームは同じオブジェクトを参照させる
    const uniforms: Record<string, THREE.IUniform> = { ...shared, ...this.own, uReceiveBlob: { value: opts.receiveBlob ? 1 : 0 } };
    const defines: Record<string, string> = {};
    if (opts.bones) {
      uniforms.uBones = { value: opts.bones };
      uniforms.uPivots = { value: BONE_PIVOTS.map((p) => new THREE.Vector3(...p)) };
      defines.USE_BONES = '';
    }
    return new THREE.ShaderMaterial({
      uniforms,
      defines,
      vertexShader: surfelVertex,
      fragmentShader: surfelFragment,
      side: THREE.DoubleSide, // 円盤は裏から見ても描く（方式 A の点に表裏が無いのと揃える）
      depthTest: true,
      depthWrite: true,
    });
  }

  /** 設定・キャラクターの姿勢を反映する */
  update(s: RenderSettings, rig: CharacterRig, densityComp: number, lowW: number, lowH: number) {
    this.worldGeo.instanceCount = Math.max(1, Math.round(this.worldTotal * s.density));
    this.drawn = this.worldGeo.instanceCount + this.charTotal;
    this.own.uSurfelRadius.value = 0.5 * s.surfelScale * densityComp;
    this.own.uBillboard.value = s.surfelBillboard ? 1 : 0;
    this.own.uSnap.value = s.pointSnap ? 1 : 0;
    this.own.uRes.value.set(lowW, lowH);
    if (this.charMesh) {
      this.charMesh.matrix.copy(rig.root);
      this.charMesh.matrixWorld.copy(rig.root);
    }
  }

  /** 低解像度ターゲットへ描く（ターゲットの大きさは方式 A と同じにする） */
  renderScene(renderer: THREE.WebGLRenderer, camera: THREE.Camera, canvasW: number, canvasH: number, scale: number) {
    this.pipeline.ensureSize(canvasW, canvasH, scale);
    this.pipeline.renderScene(renderer, this.scene, camera);
  }

  /**
   * 重ね塗り計測：計測用シェーダーに差し替え、深度テストなし・加算合成で 1 断片 = 1 として数える。
   * R にラスタライズされた断片数、G に実際に色を書く断片数が積算される。
   */
  renderCount(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget, clear = true) {
    const meshes = this.charMesh ? [this.worldMesh, this.charMesh] : [this.worldMesh];
    const saved = meshes.map((m) => m.material as THREE.ShaderMaterial);
    const counters = saved.map((m) => {
      const c = m.clone();
      c.uniforms = m.uniforms; // ユニフォームは共有のまま
      c.defines = { ...m.defines, COUNT_FRAGMENTS: '' };
      c.blending = THREE.AdditiveBlending;
      c.depthTest = false;
      c.depthWrite = false;
      c.transparent = true;
      return c;
    });
    meshes.forEach((m, i) => (m.material = counters[i]));
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

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.worldMesh);
    if (this.charMesh) this.scene.remove(this.charMesh);
    this.worldGeo.dispose();
    this.charGeo?.dispose();
    this.worldMat.dispose();
    this.charMat?.dispose();
    this.pipeline.dispose();
  }
}
