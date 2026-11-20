// 描画方式 B：Spark による Gaussian Splats 描画の一式（シーン・SparkRenderer・スプラットメッシュ・後処理）。
// 方式 A に切り替えたときは dispose() で GPU 資源をすべて解放し、戻したときに CPU 側の点群から作り直す。

import * as THREE from 'three';
import { SparkRenderer, SplatMesh, SplatSkinning, SplatSkinningMode } from '@sparkjsdev/spark';
import type { RenderSettings } from '../../settings';
import type { CharacterRig } from '../CharacterRig';
import type { SharedUniforms } from '../ParticleMaterial';
import type { PixelPipeline } from '../PixelPipeline';
import { BONE_COUNT, BONE_PIVOTS } from '../../visual/emitters/character';
import type { CharacterSplatSource } from '../../visual/sdf/sdfObjects';
import { attrTexture, packCharacter, packPointSet, type SplatPointSet } from './SplatData';
import { SplatPost } from './SplatPost';
import { createShadeModifier, createSplatUniforms } from './SplatShade';

export class SplatRenderer {
  readonly scene = new THREE.Scene();
  readonly spark: SparkRenderer;
  readonly world: SplatMesh;
  readonly character: SplatMesh;
  readonly skinning: SplatSkinning;
  readonly post: SplatPost;
  readonly worldTotal: number;
  readonly charTotal: number;
  readonly buildMs: number;
  private readonly attr: THREE.DataTexture;
  private readonly splatU = createSplatUniforms();
  private readonly worldDraw = { value: 0 };
  private readonly charDraw = { value: 1e9 };
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private disposed = false;
  /** 前回の陰影入力（変化した時だけスプラットを再生成するため） */
  private lastKey = '';

  constructor(
    renderer: THREE.WebGLRenderer,
    shared: SharedUniforms,
    pipeline: PixelPipeline,
    worldSet: SplatPointSet,
    charSrc: CharacterSplatSource,
  ) {
    const t0 = performance.now();
    this.spark = new SparkRenderer({ renderer, enableLod: false, premultipliedAlpha: true, sortRadial: false });
    this.scene.add(this.spark);

    // 浮き島（世界全体を 1 つのスプラットメッシュに）
    this.attr = attrTexture(worldSet);
    this.worldTotal = worldSet.count;
    this.world = new SplatMesh({
      packedSplats: packPointSet(worldSet),
      worldModifier: createShadeModifier({ shared, splat: this.splatU, drawCount: this.worldDraw, attr: this.attr, receiveBlob: true, role: 'world' }),
    });
    this.world.raycastable = false;
    this.scene.add(this.world);

    // キャラクター：Spark の SplatSkinning（デュアルクォータニオン）で既存のボーン行列をそのまま使う
    this.charTotal = charSrc.count;
    this.character = new SplatMesh({
      packedSplats: packCharacter(charSrc),
      worldModifier: createShadeModifier({ shared, splat: this.splatU, drawCount: this.charDraw, receiveBlob: false, role: 'char' }),
    });
    this.character.raycastable = false;
    this.character.matrixAutoUpdate = false;
    this.skinning = new SplatSkinning({ mesh: this.character, numSplats: charSrc.count, numBones: BONE_COUNT, mode: SplatSkinningMode.DUAL_QUATERNION });
    const ident = new THREE.Quaternion();
    for (let b = 0; b < BONE_COUNT; b++) this.skinning.setRestQuatPos(b, ident, new THREE.Vector3(...BONE_PIVOTS[b]));
    const bi = new THREE.Vector4(), bw = new THREE.Vector4();
    for (let i = 0; i < charSrc.count; i++) {
      const w0 = charSrc.weight0[i];
      bi.set(charSrc.bone0[i], charSrc.bone1[i], 0, 0);
      bw.set(w0, 1 - w0, 0, 0);
      this.skinning.setSplatBones(i, bi, bw);
    }
    this.skinning.skinTexture.needsUpdate = true;
    this.character.skinning = this.skinning;
    this.character.updateGenerator();
    this.scene.add(this.character);

    this.post = new SplatPost(pipeline);
    this.buildMs = performance.now() - t0;
  }

  /** 描いたスプラット数 */
  get drawn() {
    return Math.min(this.worldDraw.value, this.worldTotal) + this.charTotal;
  }

  /** ゲーム状態・設定をスプラットへ反映（毎フレーム） */
  update(s: RenderSettings, rig: CharacterRig, camera: THREE.Camera, densityComp: number) {
    // 密度：シャッフル済みの先頭から必要数だけ（残りはモディファイアで不透明度 0）
    this.worldDraw.value = Math.max(1, Math.round(this.worldTotal * s.density));
    const spread = s.splatScale * densityComp;
    this.splatU.spread.value.set(spread, spread * s.splatAniso, spread * s.splatFlat);
    this.splatU.opacity.value = s.splatOpacity;
    camera.getWorldPosition(this.splatU.camPos.value);
    camera.getWorldDirection(this.splatU.camDir.value);

    const sp = this.spark;
    sp.maxStdDev = s.splatStdDev;
    sp.falloff = s.splatFalloff;
    sp.sortRadial = s.projection === 'perspective';

    // キャラクター：ルート行列 + ボーン（静止姿勢からの相対はSpark側で計算）
    this.character.matrix.copy(rig.root);
    this.character.matrixWorldNeedsUpdate = true;
    for (let b = 0; b < BONE_COUNT; b++) {
      rig.bones[b].decompose(this.p, this.q, this.sc);
      this.skinning.setBoneQuatPos(b, this.q, this.p);
    }
    this.skinning.updateBones();

    // 浮き島：風が吹いている間は毎フレーム、そうでなければ陰影の入力が変わった時だけ再生成
    const key = [s.density, spread, s.splatAniso, s.splatFlat, s.splatOpacity, s.ambient, s.shadowStrength, s.lightSteps, s.fog,
      s.projection, s.fov, this.splatU.camPos.value.toArray().map((v) => v.toFixed(2)).join(), this.splatU.camDir.value.toArray().map((v) => v.toFixed(3)).join(),
      rig.root.elements[12].toFixed(3), rig.root.elements[13].toFixed(3), rig.root.elements[14].toFixed(3)].join('|');
    if (s.wind > 0 || key !== this.lastKey) {
      this.lastKey = key;
      this.world.updateVersion();
    }
    this.character.updateVersion();
  }

  /** 低解像度ターゲットへスプラットを描く */
  renderScene(renderer: THREE.WebGLRenderer, camera: THREE.Camera, lowW: number, lowH: number, ss: number) {
    const rt = this.post.ensureTarget(lowW, lowH, ss);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(null);
  }

  /** Spark の並べ替え（ワーカー）が進行中か */
  get busy() {
    return this.spark.sorting || this.spark.sortDirty;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.world, this.character, this.spark);
    this.world.dispose();
    this.character.dispose();
    this.skinning.skinTexture.dispose();
    this.skinning.boneTexture.dispose();
    this.attr.dispose();
    this.spark.dispose();
    this.post.dispose();
  }
}
