// 描画方式 F：ハイブリッド（E のピクセル化メッシュ + C のサーフェル）。Spark には依存しない。
// - E 側（三角形メッシュ）：地形・道・岩・島の下面・雲・キャラクター、幹・枝（設定で C 側へ切り替え可）。
//   樹冠は三角形化しない（MeshBuild の hybrid オプション）。草の葉・花の帯や星形の円盤も GPU へ上げない。
// - C 側（法線を向いた不透明な円盤）：草・花・つた（カテゴリ「草花」）と樹木の葉（「樹木」のうち風で揺れる粒）。
//   幹を C 側にしたときは「樹木」の粒をすべて円盤にする。
// - 両方を **同じ低解像度ターゲット・同じ深度バッファ** に続けて描くので、草花・葉と地形・岩・キャラクターの前後関係は
//   画素ごとの深度テストで決まる（別々に描いて重ねる合成ではない）。後処理（輪郭・ディザ・減色・拡大）もこの 1 枚に 1 回だけかける。
// - 光・影・風・霞は E・C とも同じ GLSL（LIGHTING_CHUNK）と同じ共有ユニフォームなので、陰影の段階・霞も揃う。

import * as THREE from 'three';
import type { RenderSettings } from '../../settings';
import type { CharacterRig } from '../CharacterRig';
import type { SharedUniforms } from '../ParticleMaterial';
import { PixelPipeline } from '../PixelPipeline';
import type { PixelMeshCharacter, PixelMeshWorld } from '../pixelmesh/MeshBuild';
import { PixelMeshRenderer } from '../pixelmesh/PixelMeshRenderer';
import { pointSetFromGeometry, type SplatPointSet } from '../shared/PointSet';
import { SurfelRenderer } from '../surfel/SurfelRenderer';

/**
 * C 側で描く粒を取り出す（既存の粒データから。並びは生成時のシャッフル順のままなので、密度は先頭から N 個で間引ける）。
 * trunk=true なら幹・枝（「樹木」のうち風の影響度 0 の粒）も含める。
 */
export function hybridSurfelSet(world: THREE.BufferGeometry, trunk: boolean): SplatPointSet {
  return pointSetFromGeometry(world, [], (cat, wind) => cat === '草花' || (cat === '樹木' && (trunk || wind > 0)));
}

export interface HybridStats {
  meshTris: number;
  surfels: number;
  /** C 側の円盤の内訳（総数） */
  surfelTotal: number;
  surfelBuildMs: number;
  trunk: 'mesh' | 'surfel';
}

export class HybridRenderer {
  /** E 側（地形・岩・幹・キャラクター） */
  readonly mesh: PixelMeshRenderer;
  /** C 側（草花・葉。幹を C にしたときは幹も）。作り直し中は null */
  surfel: SurfelRenderer | null = null;
  /** 方式 F 専用の低解像度ターゲットと後処理（E と C の両方をここに描く） */
  readonly pipeline = new PixelPipeline();
  private surfelKey = '';
  surfelBuildMs = 0;
  surfelRebuilds = 0;
  private disposed = false;
  drawnTris = 0;
  drawnSurfels = 0;

  constructor(private readonly shared: SharedUniforms, private readonly rig: CharacterRig) {
    this.mesh = new PixelMeshRenderer(shared, rig);
  }

  setWorld(data: PixelMeshWorld) {
    this.mesh.setWorld(data, { decor: false });
  }

  setCharacter(data: PixelMeshCharacter) {
    this.mesh.setCharacter(data);
  }

  /** C 側の円盤を用意する（key が変わったときだけ作り直す。前のものは GPU から解放する） */
  setSurfels(key: string, make: () => SplatPointSet) {
    if (key === this.surfelKey && this.surfel) return;
    this.surfelKey = key;
    this.surfel?.dispose();
    // 構築時間 = 粒の取り出し（初回のみ。以後は CPU 側の保持分を使う）+ GPU 用の属性の用意
    const t0 = performance.now();
    const set = make();
    this.surfel = new SurfelRenderer(this.shared, this.rig, set, null);
    this.surfelBuildMs = performance.now() - t0;
    this.surfelRebuilds++;
  }

  get stats(): HybridStats | null {
    if (!this.surfel) return null;
    return { meshTris: this.drawnTris, surfels: this.drawnSurfels, surfelTotal: this.surfel.worldTotal, surfelBuildMs: this.surfelBuildMs, trunk: this.mesh.trunksVisible ? 'mesh' : 'surfel' };
  }

  update(s: RenderSettings, rig: CharacterRig, densityComp: number, lowW: number, lowH: number) {
    this.mesh.trunksVisible = s.hybridTrunk === 'mesh';
    this.mesh.update(s, rig);
    this.drawnTris = this.mesh.drawnTris;
    this.drawnSurfels = 0;
    if (this.surfel) {
      this.surfel.update(s, rig, densityComp, lowW, lowH);
      this.drawnSurfels = this.surfel.drawn;
    }
  }

  /** 低解像度ターゲットへ E → C の順に描く（2 回目はクリアしないので、深度バッファを共有する） */
  renderScene(renderer: THREE.WebGLRenderer, camera: THREE.Camera, canvasW: number, canvasH: number, scale: number) {
    this.pipeline.ensureSize(canvasW, canvasH, scale);
    this.pipeline.renderScene(renderer, this.mesh.scene, camera);
    if (this.surfel) {
      renderer.setRenderTarget(this.pipeline.rt);
      renderer.render(this.surfel.scene, camera);
      renderer.setRenderTarget(null);
    }
  }

  /** 重ね塗り計測：E と C の断片数を同じターゲットに足し合わせる */
  renderCount(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget) {
    this.mesh.renderCount(renderer, camera, target, true);
    this.surfel?.renderCount(renderer, camera, target, false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.dispose();
    this.surfel?.dispose();
    this.surfel = null;
    this.pipeline.dispose();
  }
}
